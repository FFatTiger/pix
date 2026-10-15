import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  PRODUCTION_FULL_CAPABILITIES,
  RESOURCE_DEGRADED_CAPABILITIES,
  createHostApp,
  resolveCapabilities,
} from "../dist/index.js";

const temporary = [];
const gate = { config: { read: () => ({ status: "disabled", source: "test" }) } };
const savedAttachmentsDir = process.env.PIX_ATTACHMENTS_DIR;

function temp(prefix) {
  const value = mkdtempSync(join(tmpdir(), prefix));
  temporary.push(value);
  return value;
}

afterEach(() => {
  if (savedAttachmentsDir === undefined) delete process.env.PIX_ATTACHMENTS_DIR;
  else process.env.PIX_ATTACHMENTS_DIR = savedAttachmentsDir;
  while (temporary.length) rmSync(temporary.pop(), { recursive: true, force: true });
});

function appWith(limits) {
  const root = temp("pi-attachments-");
  process.env.PIX_ATTACHMENTS_DIR = root;
  const host = createHostApp({
    logger: {},
    gate,
    attachments: limits ? { limits } : {},
  });
  return { root, app: host.app };
}

function headers(extra = {}) {
  return { host: "localhost", ...extra };
}

function upload(app, { sessionId, name = "notes.txt", body = "hello", field = "file", contentType } = {}) {
  const query = sessionId === undefined ? "" : `?sessionId=${encodeURIComponent(sessionId)}`;
  if (contentType !== undefined) {
    return app.request(`http://localhost/v1/attachments${query}`, {
      method: "POST",
      headers: headers({ "content-type": contentType }),
      body: "not-a-file",
    });
  }
  const form = new FormData();
  if (field) form.append(field, new File([body], name));
  return app.request(`http://localhost/v1/attachments${query}`, {
    method: "POST",
    headers: headers(),
    body: form,
  });
}

function modeOf(path) {
  return statSync(path).mode & 0o777;
}

test("upload with sessionId stores one sanitized file under the scope", async () => {
  const { root, app } = appWith();
  const res = await upload(app, { sessionId: "s1", name: "a/b\\c report .pdf", body: "pdf-bytes" });
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.size, Buffer.byteLength("pdf-bytes"));
  assert.match(body.name, /^\d{8}-\d{6}-[0-9a-f]{6}-c report \.pdf$/);
  assert.equal(body.path, join(root, "s1", body.name));
  assert.equal(readFileSync(body.path, "utf8"), "pdf-bytes");
  assert.deepEqual(readdirSync(join(root, "s1")), [body.name]);
  if (process.platform !== "win32") {
    assert.equal(modeOf(join(root, "s1")), 0o700);
    assert.equal(modeOf(body.path), 0o600);
  }
});

test("missing sessionId lands under unfiled", async () => {
  const { root, app } = appWith();
  const res = await upload(app, { name: "draft.md", body: "x" });
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(basename(body.path), body.name);
  assert.equal(body.path, join(root, "unfiled", body.name));
  assert.match(body.name, /^\d{8}-\d{6}-[0-9a-f]{6}-draft\.md$/);
  assert.equal(readFileSync(body.path, "utf8"), "x");
});

test("unsafe sessionId is rejected and writes nothing", async () => {
  const { root, app } = appWith();
  for (const sessionId of ["../x", "a/b", ".", "..", "a".repeat(129), "has space"]) {
    const res = await upload(app, { sessionId, name: "nope.txt", body: "no" });
    assert.equal(res.status, 400, sessionId);
    const body = await res.json();
    assert.equal(body.code, "ATTACHMENT_SCOPE_INVALID");
    assert.equal(body.message, "Invalid sessionId for attachments");
  }
  assert.equal(readdirSync(root).length, 0);
});

test("missing file field and wrong content-type fail closed", async () => {
  const { root, app } = appWith();
  const missing = await upload(app, { sessionId: "s1", field: "" });
  assert.equal(missing.status, 400);
  assert.equal((await missing.json()).code, "NO_FILE");

  const wrongField = await upload(app, { sessionId: "s1", field: "files" });
  assert.equal(wrongField.status, 400);
  assert.equal((await wrongField.json()).code, "NO_FILE");

  const typed = await upload(app, { sessionId: "s1", contentType: "application/json" });
  assert.equal(typed.status, 415);
  assert.equal((await typed.json()).code, "UNSUPPORTED_MEDIA_TYPE");
  assert.equal(readdirSync(root).length, 0);
});

test("oversize attachment is 413 before a store write", async () => {
  const { root, app } = appWith({ maxUploadFileBytes: 4 });
  const res = await upload(app, { sessionId: "s1", name: "big.bin", body: "12345" });
  assert.equal(res.status, 413);
  const body = await res.json();
  assert.equal(body.code, "ATTACHMENT_TOO_LARGE");
  assert.equal(body.message, "Attachment is too large");
  assert.equal(readdirSync(root).length, 0);
});

test("the same original name uploaded twice stores two distinct files", async () => {
  const { app } = appWith();
  const first = await (await upload(app, { sessionId: "s1", name: "same.txt", body: "one" })).json();
  const second = await (await upload(app, { sessionId: "s1", name: "same.txt", body: "two" })).json();
  assert.notEqual(first.path, second.path);
  assert.equal(readFileSync(first.path, "utf8"), "one");
  assert.equal(readFileSync(second.path, "utf8"), "two");
});

test("PIX_ATTACHMENTS_DIR override is the only store root", async () => {
  const override = temp("pi-attachments-override-");
  process.env.PIX_ATTACHMENTS_DIR = override;
  const host = createHostApp({ logger: {}, gate, attachments: {} });
  const res = await upload(host.app, { sessionId: "s9", name: "where.txt", body: "here" });
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.path, join(override, "s9", body.name));
  assert.equal(readFileSync(body.path, "utf8"), "here");
});

test("attachments.upload is advertised only while the seam is mounted, in both sessiond states", async () => {
  const withSeam = {
    logger: {},
    gate,
    attachments: {},
    sessiond: { isAvailable: async () => true },
    capabilities: {
      full: [...PRODUCTION_FULL_CAPABILITIES],
      readonly: [...RESOURCE_DEGRADED_CAPABILITIES],
    },
  };
  const up = await resolveCapabilities(withSeam);
  assert.equal(up.sessiond, "up");
  assert.ok(up.capabilities.includes("attachments.upload"));

  const down = await resolveCapabilities({ ...withSeam, sessiond: { isAvailable: async () => false } });
  assert.equal(down.sessiond, "down");
  assert.ok(down.capabilities.includes("attachments.upload"));

  const absent = await resolveCapabilities({
    ...withSeam,
    attachments: undefined,
  });
  assert.ok(!absent.capabilities.includes("attachments.upload"));
  const absentDown = await resolveCapabilities({
    ...withSeam,
    attachments: undefined,
    sessiond: { isAvailable: async () => false },
  });
  assert.ok(!absentDown.capabilities.includes("attachments.upload"));

  const mounted = createHostApp(withSeam).app;
  const health = await (await mounted.request("http://localhost/v1/health", { headers: headers() })).json();
  assert.ok(health.capabilities.includes("attachments.upload"));
  const unmounted = createHostApp({ ...withSeam, attachments: undefined }).app;
  const hidden = await (await unmounted.request("http://localhost/v1/health", { headers: headers() })).json();
  assert.ok(!hidden.capabilities.includes("attachments.upload"));
  assert.equal((await unmounted.request("http://localhost/v1/attachments", { method: "POST", headers: headers() })).status, 404);
});
