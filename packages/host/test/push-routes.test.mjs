import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHostApp } from "../dist/index.js";
import { createWebPushStoreFromLease } from "../dist/resources/web-push-store.js";
import { createWebPushSender } from "../dist/resources/web-push-sender.js";
import { openHostStateDirectoryLease } from "../dist/resources/host-state-directory.js";

const temporary = [];
const CANON_TMP = realpathSync(tmpdir());
function temp(prefix) {
  const value = mkdtempSync(join(CANON_TMP, prefix));
  temporary.push(value);
  return value;
}
afterEach(() => {
  while (temporary.length) {
    const value = temporary.pop();
    rmSync(value, { recursive: true, force: true });
  }
});

const KEYS = { publicKey: "B".repeat(87), privateKey: "A".repeat(43) };
const SUB_BODY = {
  endpoint: "https://fcm.googleapis.com/fcm/send/abc",
  keys: { p256dh: "K".repeat(87), auth: "a".repeat(16) },
};

function fakeSender(outcomes = new Map()) {
  return {
    generateVapidKeys: () => KEYS,
    async send(subscription, keys, payload) {
      const outcome = outcomes.get(subscription.endpoint);
      if (outcome === "gone") return "gone";
      if (outcome === "throw") throw new Error("network down");
      this.sent.push({ endpoint: subscription.endpoint, keys, payload });
      return "delivered";
    },
    sent: [],
  };
}

async function pushApp(options = {}) {
  const dir = temp("pix-push-routes-");
  const lease = await openHostStateDirectoryLease({ hostDir: dir });
  const store = createWebPushStoreFromLease(lease);
  const sender = options.sender ?? fakeSender();
  const app = createHostApp({
    logger: {},
    exposureMode: "local",
    gate: { config: { read: () => ({ status: "disabled", source: "test" }) } },
    push: { store, sender, sendTest: options.sendTest ?? (async () => "sent") },
  }).app;
  return { app, store, sender, lease, dir };
}

const HOST = { host: "localhost" };
const JSON_HEADERS = { ...HOST, "content-type": "application/json" };

test("GET /v1/push/config generates the keypair once and returns the public key", async () => {
  const { app, lease } = await pushApp({ sender: fakeSender() });
  try {
    const first = await app.request("http://localhost/v1/push/config", { headers: HOST });
    assert.equal(first.status, 200);
    const body = await first.json();
    assert.equal(body.supported, true);
    assert.equal(body.publicKey, KEYS.publicKey);
  } finally {
    await lease.close();
  }
});

test("POST /v1/push/subscriptions accepts a valid subscription and dedupes by endpoint", async () => {
  const { app, store, lease } = await pushApp();
  try {
    const post1 = await app.request("http://localhost/v1/push/subscriptions", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ ...SUB_BODY, deviceName: "Mac" }),
    });
    assert.equal(post1.status, 200);
    assert.deepEqual(await post1.json(), { ok: true });
    const post2 = await app.request("http://localhost/v1/push/subscriptions", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ ...SUB_BODY, deviceName: "Renamed" }),
    });
    assert.equal(post2.status, 200);
    const document = await store.read();
    assert.equal(document.subscriptions.length, 1);
    assert.equal(document.subscriptions[0].deviceName, "Renamed");
    assert.equal(document.vapid.publicKey, KEYS.publicKey);
  } finally {
    await lease.close();
  }
});

test("POST /v1/push/subscriptions fails closed on invalid payloads", async () => {
  const { app, lease } = await pushApp();
  try {
    const cases = [
      { endpoint: "http://push.example/abc", keys: SUB_BODY.keys }, // plain http
      { endpoint: "https://user:pass@push.example/abc", keys: SUB_BODY.keys }, // credentials
      { endpoint: "https://push.example/abc", keys: { p256dh: "short", auth: "a".repeat(16) } }, // bad key
      { endpoint: "https://push.example/" + "x".repeat(3_000), keys: SUB_BODY.keys }, // oversize endpoint
      { endpoint: "https://push.example/abc", keys: SUB_BODY.keys, deviceName: "" }, // empty device name
      { endpoint: "https://push.example/abc" }, // missing keys
      { ...SUB_BODY, extra: 1 }, // unknown field
    ];
    for (const body of cases) {
      const response = await app.request("http://localhost/v1/push/subscriptions", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify(body),
      });
      assert.equal(response.status, 400, JSON.stringify(body));
    }
    // wrong content type
    const text = await app.request("http://localhost/v1/push/subscriptions", {
      method: "POST",
      headers: { ...HOST, "content-type": "text/plain" },
      body: "{}",
    });
    assert.equal(text.status, 415);
    // malformed json
    const bad = await app.request("http://localhost/v1/push/subscriptions", {
      method: "POST",
      headers: JSON_HEADERS,
      body: "{nope",
    });
    assert.equal(bad.status, 400);
  } finally {
    await lease.close();
  }
});

test("DELETE /v1/push/subscriptions removes by endpoint; unknown endpoints are a no-op ok", async () => {
  const { app, store, lease } = await pushApp();
  try {
    await app.request("http://localhost/v1/push/subscriptions", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(SUB_BODY),
    });
    const response = await app.request("http://localhost/v1/push/subscriptions", {
      method: "DELETE",
      headers: JSON_HEADERS,
      body: JSON.stringify({ endpoint: "https://push.example/none" }),
    });
    assert.equal(response.status, 200);
    assert.equal((await store.read()).subscriptions.length, 1);
    const gone = await app.request("http://localhost/v1/push/subscriptions", {
      method: "DELETE",
      headers: JSON_HEADERS,
      body: JSON.stringify({ endpoint: SUB_BODY.endpoint }),
    });
    assert.equal(gone.status, 200);
    assert.equal((await store.read()).subscriptions.length, 0);
  } finally {
    await lease.close();
  }
});

test("real sendTest seam: sent / gone / throw map to 200 / 410 / 502", async () => {
  const outcomes = new Map();
  const sender = fakeSender(outcomes);
  const dir = temp("pix-push-test-seam-");
  const lease = await openHostStateDirectoryLease({ hostDir: dir });
  const store = createWebPushStoreFromLease(lease);
  const { sendTestNotification } = await import("../dist/composition/push-notifier.js");
  const seam = (endpoint) => sendTestNotification({ store, sender, locale: () => "en", logger: {} }, endpoint);
  const app = createHostApp({
    logger: {},
    exposureMode: "local",
    gate: { config: { read: () => ({ status: "disabled", source: "test" }) } },
    push: { store, sender, sendTest: seam },
  }).app;
  try {
    await app.request("http://localhost/v1/push/subscriptions", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(SUB_BODY),
    });
    const sent = await app.request("http://localhost/v1/push/test", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ endpoint: SUB_BODY.endpoint }),
    });
    assert.equal(sent.status, 200);
    assert.equal(sender.sent.length, 1);
    assert.equal(sender.sent[0].payload.title, "Test notification");

    outcomes.set(SUB_BODY.endpoint, "gone");
    const gone = await app.request("http://localhost/v1/push/test", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ endpoint: SUB_BODY.endpoint }),
    });
    assert.equal(gone.status, 410);
    assert.equal((await store.read()).subscriptions.length, 0);

    await app.request("http://localhost/v1/push/subscriptions", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(SUB_BODY),
    });
    outcomes.set(SUB_BODY.endpoint, "throw");
    const failed = await app.request("http://localhost/v1/push/test", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ endpoint: SUB_BODY.endpoint }),
    });
    assert.equal(failed.status, 502);
  } finally {
    await lease.close();
  }
});

test("push routes are not mounted without the seam (404, no capability advertised)", async () => {
  const app = createHostApp({
    logger: {},
    exposureMode: "local",
    gate: { config: { read: () => ({ status: "disabled", source: "test" }) } },
  }).app;
  const response = await app.request("http://localhost/v1/push/config", { headers: HOST });
  assert.equal(response.status, 404);
});
