import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  acquireLifetimeLock,
  canonicalizeAbsolutePath,
  ensurePrivateDirectory,
  LocalAuthorityError,
  posixFileIdentity,
  readLifetimeLock,
  writeStateDocument,
} from "../dist/state/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(HERE, "..");

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

const MAX = 1024 * 1024;

function isRoot() {
  return typeof process.getuid === "function" && process.getuid() === 0;
}

function lockPayload(pid, instanceId, createdAt = 1) {
  return `${JSON.stringify({ pid, instanceId, createdAt })}\n`;
}

/**
 * Assert a rejected error is a FIXED sanitized LocalAuthorityError whose
 * message contains neither the temp path, an errno code, nor a raw os message.
 */
function assertSanitized(e, code, message, path) {
  assert.equal(e instanceof LocalAuthorityError, true, "must be LocalAuthorityError");
  assert.equal(e.code, code, "fixed code");
  if (message !== undefined) assert.equal(e.message, message, "fixed message");
  assert.ok(!e.message.includes(path), `no temp path in message (got "${e.message}")`);
  assert.ok(!e.message.includes("EACCES"), `no errno text in message (got "${e.message}")`);
  assert.ok(!e.message.includes("ENOTDIR"), `no errno text in message (got "${e.message}")`);
  assert.ok(!e.message.includes("ELOOP"), `no errno text in message (got "${e.message}")`);
  assert.ok(!/eacces|permission denied|error: /i.test(e.message), `no raw os text in message (got "${e.message}")`);
  return true;
}

// ---------------------------------------------------------------------------
// Deterministic EACCES (chmod-000) — no raw os error/path may ever escape
// ---------------------------------------------------------------------------

test("posixFileIdentity: EACCES → fixed sanitized UNSAFE_COMPONENT (no raw path/os leak)", async (t) => {
  if (isRoot()) { t.skip("root bypasses permission checks"); return; }
  const dir = temp("leak-ident-");
  const child = join(dir, "child");
  writeFileSync(child, "x", { mode: 0o600 });
  chmodSync(dir, 0o000);
  try {
    await assert.rejects(
      () => posixFileIdentity(child),
      (e) => assertSanitized(e, "UNSAFE_COMPONENT", "Path component cannot be inspected", dir),
    );
  } finally {
    chmodSync(dir, 0o700);
  }
});

test("readLifetimeLock: EACCES → {kind:'unsafe',reason:'LOCK_UNSAFE'} (return union, no throw)", async (t) => {
  if (isRoot()) { t.skip("root bypasses permission checks"); return; }
  const dir = temp("leak-lock-");
  writeFileSync(join(dir, "host.lock"), lockPayload(process.pid, "instance-rll-01"), { mode: 0o600 });
  chmodSync(dir, 0o000);
  try {
    // Never rejects/throws — returns the fail-closed union without a raw error.
    const result = await readLifetimeLock(join(dir, "host.lock"));
    assert.deepEqual(result, { kind: "unsafe", reason: "LOCK_UNSAFE" });
  } finally {
    chmodSync(dir, 0o700);
  }
});

test("acquireLifetimeLock: unreadable existing lock (EEXIST → read EACCES) → LOCK_UNSAFE", async (t) => {
  if (isRoot()) { t.skip("root bypasses permission checks"); return; }
  const dir = temp("leak-acquire-");
  const lockPath = join(dir, "host.lock");
  writeFileSync(lockPath, lockPayload(process.pid, "instance-acq-01"), { mode: 0o600 });
  // File exists (open O_EXCL → EEXIST) but is unreadable → the EEXIST/read
  // classification path sees EACCES and must yield a fixed LOCK_UNSAFE.
  chmodSync(lockPath, 0o000);
  try {
    await assert.rejects(
      () => acquireLifetimeLock(lockPath, { payload: lockPayload(process.pid, "instance-acq-02"), isPidAlive: () => true }),
      (e) => assertSanitized(e, "LOCK_UNSAFE", "Existing lifetime lock is unsafe", dir),
    );
  } finally {
    chmodSync(lockPath, 0o600);
  }
});

test("canonicalizeAbsolutePath: EACCES on an existing component → fixed UNSAFE_COMPONENT", async (t) => {
  if (isRoot()) { t.skip("root bypasses permission checks"); return; }
  const dir = temp("leak-canon-");
  const child = join(dir, "child");
  chmodSync(dir, 0o000);
  try {
    await assert.rejects(
      () => canonicalizeAbsolutePath(child),
      (e) => assertSanitized(e, "UNSAFE_COMPONENT", undefined, dir),
    );
  } finally {
    chmodSync(dir, 0o700);
  }
});

test("ensurePrivateDirectory: EACCES → fixed UNSAFE_COMPONENT (no raw leak)", async (t) => {
  if (isRoot()) { t.skip("root bypasses permission checks"); return; }
  const dir = temp("leak-priv-");
  const child = join(dir, "leaf");
  chmodSync(dir, 0o000);
  try {
    await assert.rejects(
      () => ensurePrivateDirectory(child),
      (e) => assertSanitized(e, "UNSAFE_COMPONENT", "Directory path is unsafe", dir),
    );
  } finally {
    chmodSync(dir, 0o700);
  }
});

test("writeStateDocument: unreadable lock revalidation → fixed LOCK_LOST (not raw, not WRITE_FAILED)", async (t) => {
  if (isRoot()) { t.skip("root bypasses permission checks"); return; }
  const docDir = temp("leak-doc-");
  const lockDir = temp("leak-lockdir-");
  const lockPath = join(lockDir, "host.lock");
  const owned = await acquireLifetimeLock(lockPath, { payload: lockPayload(process.pid, "instance-doc-01"), isPidAlive: () => true });
  // Lock lives in a chmod-000 parent → lockCheck inspection fails with EACCES.
  chmodSync(lockDir, 0o000);
  try {
    await assert.rejects(
      () => writeStateDocument(join(docDir, "state.json"), "{}", { maxBytes: MAX, lockCheck: { path: lockPath, ownership: owned } }),
      (e) => assertSanitized(e, "LOCK_LOST", "Lifetime lock ownership lost before publish", lockDir),
    );
    // No partial document was published.
    assert.equal(await import("node:fs/promises").then((m) => m.lstat(join(docDir, "state.json")).then(() => true, () => false)), false);
  } finally {
    chmodSync(lockDir, 0o700);
  }
});

// ---------------------------------------------------------------------------
// Candidate-vs-base classification parity: filesystem-authority failures stay
// UNSAFE_COMPONENT (base HOST_DIR_UNSAFE), not the syntactic INVALID_PATH.
// ---------------------------------------------------------------------------

test("canonicalize: broken symlink intermediate fails closed (UNSAFE_COMPONENT)", async () => {
  const dir = temp("leak-broken-");
  const link = join(dir, "broken");
  symlinkSync(join(dir, "does-not-exist"), link);
  await assert.rejects(
    () => canonicalizeAbsolutePath(join(link, "child")),
    (e) => e instanceof LocalAuthorityError && e.code === "UNSAFE_COMPONENT",
  );
  // The broken symlink itself (no tail) also fails closed.
  await assert.rejects(
    () => canonicalizeAbsolutePath(link),
    (e) => e instanceof LocalAuthorityError && e.code === "UNSAFE_COMPONENT",
  );
});

test("canonicalize: parent-is-file fails closed (UNSAFE_COMPONENT)", async () => {
  const dir = temp("leak-parentfile-");
  const file = join(dir, "plain");
  writeFileSync(file, "x", { mode: 0o600 });
  await assert.rejects(
    () => canonicalizeAbsolutePath(join(file, "child")),
    (e) => e instanceof LocalAuthorityError && e.code === "UNSAFE_COMPONENT",
  );
});

test("ensurePrivateDirectory: symlink/non-dir intermediate stays SYMLINK/NOT_DIRECTORY", async () => {
  const dir = temp("leak-symdir-");
  const real = join(dir, "real");
  const { mkdirSync, writeFileSync: write } = await import("node:fs");
  mkdirSync(real);
  const link = join(dir, "link");
  symlinkSync(real, link);
  await assert.rejects(
    () => ensurePrivateDirectory(join(link, "leaf")),
    (e) => e instanceof LocalAuthorityError && e.code === "SYMLINK",
  );
  // parent-is-file: the component walk hits the file itself → NOT_DIRECTORY
  // (base HOST_DIR_UNSAFE), never the syntactic INVALID_PATH.
  const file = join(dir, "plain");
  write(file, "x", { mode: 0o600 });
  await assert.rejects(
    () => ensurePrivateDirectory(join(file, "leaf")),
    (e) => e instanceof LocalAuthorityError && e.code === "NOT_DIRECTORY",
  );
  // canonicalize lstat's the FULL path (ENOTDIR) → UNSAFE_COMPONENT.
  await assert.rejects(
    () => canonicalizeAbsolutePath(join(file, "leaf")),
    (e) => e instanceof LocalAuthorityError && e.code === "UNSAFE_COMPONENT",
  );
});

// ---------------------------------------------------------------------------
// Static source audit: no raw re-throw may exist anywhere in the backend
// ---------------------------------------------------------------------------

test("posix source audit: every throw is a fixed LocalAuthorityError (or its passthrough)", () => {
  const src = readFileSync(join(PACKAGE_ROOT, "src", "state", "posix.ts"), "utf8");
  const offenders = [];
  for (const line of src.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("throw")) continue;
    const ok = t.startsWith("throw new LocalAuthorityError")
      || t === "if (error instanceof LocalAuthorityError) throw error;";
    if (!ok) offenders.push(t);
  }
  assert.deepEqual(offenders, [], "posix.ts must only throw fixed LocalAuthorityError (or its own passthrough)");
});
