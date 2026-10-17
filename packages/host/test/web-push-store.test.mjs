import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { mkdtempSync, readFileSync, writeFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createWebPushStoreFromLease,
  parseWebPushDocument,
  serializeWebPushDocument,
  validateWebPushDocumentBeforeLock,
  WEB_PUSH_FILE_NAME,
  WEB_PUSH_KIND,
  WEB_PUSH_VERSION,
  MAX_PUSH_SUBSCRIPTIONS,
  WebPushStoreError,
} from "../dist/resources/web-push-store.js";
import { openHostStateDirectoryLease } from "../dist/resources/host-state-directory.js";
import { openTrustedRootsLedger, LEDGER_FILE_NAME } from "../dist/resources/trusted-roots-ledger.js";

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

const KEYS = { publicKey: "B".repeat(87), privateKey: "A".repeat(120) };
const SUB = (overrides = {}) => ({
  endpoint: overrides.endpoint ?? "https://fcm.googleapis.com/fcm/send/abc",
  p256dh: overrides.p256dh ?? "K".repeat(87),
  auth: overrides.auth ?? "a".repeat(16),
  createdAt: overrides.createdAt ?? "2020-01-01T00:00:00.000Z",
  ...(overrides.deviceName === undefined ? {} : { deviceName: overrides.deviceName }),
});

function document(subscriptions = [], vapid = KEYS) {
  return { kind: WEB_PUSH_KIND, version: WEB_PUSH_VERSION, vapid, subscriptions };
}

// ---------------------------------------------------------------------------
// parse / serialize
// ---------------------------------------------------------------------------

test("push store: parse/serialize round-trip; deterministic endpoint sort", () => {
  const a = SUB({ endpoint: "https://push.example/b" });
  const b = SUB({ endpoint: "https://push.example/a", deviceName: "iPhone" });
  const text = serializeWebPushDocument(document([a, b]));
  const parsed = parseWebPushDocument(text);
  assert.equal(parsed.warning, undefined);
  assert.deepEqual(parsed.document.subscriptions.map((s) => s.endpoint), [b.endpoint, a.endpoint]);
  assert.equal(parsed.document.vapid.publicKey, KEYS.publicKey);
});

test("push store: missing vapid is a valid document (subscriptions only)", () => {
  const text = serializeWebPushDocument({ kind: WEB_PUSH_KIND, version: WEB_PUSH_VERSION, subscriptions: [] });
  const parsed = parseWebPushDocument(text);
  assert.equal(parsed.warning, undefined);
  assert.equal(parsed.document.vapid, undefined);
  assert.deepEqual(parsed.document.subscriptions, []);
});

test("push store: corrupt/unknown-version/wrong-kind/duplicate/sparse fail closed with codes", () => {
  assert.equal(parseWebPushDocument("{nope").warning, "PUSH_DOC_CORRUPT");
  assert.equal(parseWebPushDocument(JSON.stringify({ kind: "other", version: 1, subscriptions: [] })).warning, "PUSH_DOC_WRONG_KIND");
  assert.equal(parseWebPushDocument(JSON.stringify({ kind: WEB_PUSH_KIND, version: 2, subscriptions: [] })).warning, "PUSH_DOC_UNKNOWN_VERSION");
  const dup = document([SUB(), SUB()]);
  assert.equal(parseWebPushDocument(serializeWebPushDocument(dup)).warning, "PUSH_DOC_DUPLICATE");
  // sparse: plain-http endpoint
  const sparse = document([SUB({ endpoint: "http://push.example/abc" })]);
  assert.equal(parseWebPushDocument(serializeWebPushDocument(sparse)).warning, "PUSH_DOC_SPARSE");
  // sparse: malformed key
  const badKeys = document([SUB({ p256dh: "short" })]);
  assert.equal(parseWebPushDocument(serializeWebPushDocument(badKeys)).warning, "PUSH_DOC_SPARSE");
  // unknown extra field
  const extra = JSON.stringify({ kind: WEB_PUSH_KIND, version: 1, vapid: KEYS, subscriptions: [], extra: true });
  assert.equal(parseWebPushDocument(extra).warning, "PUSH_DOC_CORRUPT");
  // oversize
  const many = document(Array.from({ length: MAX_PUSH_SUBSCRIPTIONS + 1 }, (_, i) => SUB({ endpoint: `https://push.example/${i}` })));
  assert.equal(parseWebPushDocument(serializeWebPushDocument(many)).warning, "PUSH_DOC_OVERSIZE");
});

// ---------------------------------------------------------------------------
// store over a real shared lease (atomic write, dedupe, persistence)
// ---------------------------------------------------------------------------

async function openStore(dir) {
  const lease = await openHostStateDirectoryLease({ hostDir: dir, recognizedDocuments: [LEDGER_FILE_NAME, WEB_PUSH_FILE_NAME] });
  return { lease, store: createWebPushStoreFromLease(lease) };
}

test("push store: missing document reads empty; keys generate once and persist; file is 0600-shaped JSON", async () => {
  const dir = temp("pix-push-empty-");
  const { lease, store } = await openStore(dir);
  try {
    const first = await store.read();
    assert.deepEqual(first.subscriptions, []);
    assert.equal(first.vapid, undefined);

    const generated = [];
    const keys = await store.getOrCreateVapidKeys(() => {
      generated.push(1);
      return { publicKey: "B".repeat(87), privateKey: "A".repeat(120) };
    });
    assert.equal(generated.length, 1);
    assert.equal(keys.publicKey, "B".repeat(87));
    // second call returns the persisted pair without invoking the generator
    const again = await store.getOrCreateVapidKeys(() => {
      generated.push(1);
      return { publicKey: "C".repeat(87), privateKey: "D".repeat(120) };
    });
    assert.equal(generated.length, 1);
    assert.deepEqual(again, keys);

    const raw = JSON.parse(readFileSync(join(dir, WEB_PUSH_FILE_NAME), "utf8"));
    assert.equal(raw.kind, WEB_PUSH_KIND);
    assert.equal(raw.vapid.publicKey, keys.publicKey);
  } finally {
    await lease.close();
  }
});

test("push store: upsert dedupes by endpoint; remove is a no-op for unknown endpoints", async () => {
  const dir = temp("pix-push-dedupe-");
  const { lease, store } = await openStore(dir);
  try {
    await store.getOrCreateVapidKeys(() => KEYS);
    await store.upsertSubscription(SUB({ deviceName: "first" }));
    await store.upsertSubscription(SUB({ deviceName: "renamed" }));
    const after = await store.read();
    assert.equal(after.subscriptions.length, 1);
    assert.equal(after.subscriptions[0].deviceName, "renamed");
    await store.removeSubscription("https://push.example/none");
    const unchanged = await store.read();
    assert.equal(unchanged.subscriptions.length, 1);
    await store.removeSubscription(SUB().endpoint);
    const empty = await store.read();
    assert.equal(empty.subscriptions.length, 0);
  } finally {
    await lease.close();
  }
});

test("push store: corrupt document fails every read/mutation honestly (never rewritten)", async () => {
  const dir = temp("pix-push-corrupt-");
  const lease = await openHostStateDirectoryLease({ hostDir: dir, recognizedDocuments: [LEDGER_FILE_NAME, WEB_PUSH_FILE_NAME] });
  const store = createWebPushStoreFromLease(lease);
  try {
    await store.upsertSubscription(SUB());
    const path = join(dir, WEB_PUSH_FILE_NAME);
    const before = readFileSync(path, "utf8");
    writeFileSync(path, "{corrupt");
    await assert.rejects(() => store.read(), (error) => error instanceof WebPushStoreError);
    await assert.rejects(() => store.upsertSubscription(SUB({ endpoint: "https://push.example/2" })), (error) => error instanceof WebPushStoreError);
    // immutable evidence: bytes unchanged
    assert.equal(readFileSync(path, "utf8"), before.length > 0 ? "{corrupt" : before);
  } finally {
    await lease.close();
  }
});

test("push store: validateWebPushDocumentBeforeLock passes missing + valid, rejects corrupt", async () => {
  const dir = temp("pix-push-prelock-");
  const lease = await openHostStateDirectoryLease({ hostDir: dir, recognizedDocuments: [LEDGER_FILE_NAME, WEB_PUSH_FILE_NAME] });
  try {
    await validateWebPushDocumentBeforeLock((name) => lease.readDocument(name));
    const store = createWebPushStoreFromLease(lease);
    await store.upsertSubscription(SUB());
    await validateWebPushDocumentBeforeLock((name) => lease.readDocument(name));
    writeFileSync(join(dir, WEB_PUSH_FILE_NAME), "[]");
    await assert.rejects(
      () => validateWebPushDocumentBeforeLock((name) => lease.readDocument(name)),
      (error) => error instanceof WebPushStoreError,
    );
  } finally {
    await lease.close();
  }
});

test("push store: trusts only through the shared trusted-roots lock (single lease reuse)", async () => {
  const dir = temp("pix-push-shared-");
  const ledger = await openTrustedRootsLedger({ hostDir: dir });
  try {
    // The production composition opens the trusted ledger over the SAME lease
    // policy; a second direct lease on the same dir must fail with LOCK_BUSY.
    await assert.rejects(
      () => openHostStateDirectoryLease({ hostDir: dir }),
      (error) => error.code === "LOCK_BUSY",
    );
  } finally {
    await ledger.close();
  }
});
