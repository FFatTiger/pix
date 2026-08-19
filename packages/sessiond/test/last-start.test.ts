import assert from "node:assert/strict";
import test from "node:test";
import { LocalAuthorityError } from "@fffattiger/pix-local-authority/state";
import { SessiondError } from "../src/errors.js";
import {
  classifyLastStartError,
  lastStartRecordFromError,
  parseLastStartRecord,
} from "../src/last-start.js";

test("classifyLastStartError maps sanitized startup failures", () => {
  assert.equal(classifyLastStartError(new LocalAuthorityError("NOT_PRIVATE", "x")), "private_directory");
  assert.equal(classifyLastStartError(new SessiondError("conflict", "another sessiond instance is running")), "lock_conflict");
  assert.equal(classifyLastStartError(new SessiondError("forbidden", "sessiond socket path too long (200 > 108 bytes)")), "socket_length");
  assert.equal(classifyLastStartError(new SessiondError("forbidden", "sessiond private directory is unsafe")), "private_directory");
  assert.equal(classifyLastStartError(new SessiondError("unavailable", "sessiond secure state is unavailable on this platform")), "listen_failed");
  assert.equal(classifyLastStartError(new Error("ENOENT module")), "unknown");
});

test("last-start records never echo raw paths or secrets", () => {
  const record = lastStartRecordFromError(
    new SessiondError("forbidden", "sessiond socket path too long (C:\\\\Users\\\\secret\\\\sessiond > 107 bytes)"),
    "2026-01-01T00:00:00.000Z",
  );
  assert.equal(record.message, "sessiond socket path is too long");
  assert.equal(JSON.stringify(record).includes("Users"), false);
  assert.equal(JSON.stringify(record).includes("secret"), false);
});

test("parseLastStartRecord fail-closes unknown versions and oversized payloads", () => {
  const valid = parseLastStartRecord(JSON.stringify({
    kind: "pix.sessiond.last-start",
    version: 1,
    ok: false,
    code: "lock_conflict",
    message: "another sessiond instance is running",
    at: "2026-01-01T00:00:00.000Z",
  }));
  assert.equal(valid?.code, "lock_conflict");
  assert.equal(valid?.message, "another sessiond instance is running");
  assert.equal(parseLastStartRecord(JSON.stringify({ kind: "pix.sessiond.last-start", version: 2, ok: true, code: "ok", message: "x", at: "2026-01-01T00:00:00.000Z" })), undefined);
  assert.equal(parseLastStartRecord(`{"kind":"nope"}`), undefined);
  assert.equal(parseLastStartRecord("x".repeat(2000)), undefined);
});
