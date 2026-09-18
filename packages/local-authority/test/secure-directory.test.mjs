import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createPosixSecureStateBackend,
  ensurePrivateDirectory,
  LocalAuthorityError,
} from "../dist/state/index.js";

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

async function expectReject(fn, code) {
  await assert.rejects(
    fn,
    (e) => e instanceof LocalAuthorityError && e.code === code,
    `expected reject with ${code}`,
  );
}

test("ensurePrivateDirectory: creates missing nested components 0700 via fd; no chmod of existing", async () => {
  const dir = temp("priv-create-");
  const target = join(dir, "a", "b", "leaf");
  const result = await ensurePrivateDirectory(target);
  assert.equal(result.path, target);
  assert.equal(result.created, true);
  // Leaf is 0700 (created via fd-based fchmod).
  assert.equal(lstatSync(target).mode & 0o777, 0o700);
  // Existing temp root was NOT chmod'd (it keeps its original mkdtemp 0700).
  assert.equal(lstatSync(dir).mode & 0o777, 0o700);
});

test("ensurePrivateDirectory: existing leaf is validate-only — exact 0700 + owner pass, wrong mode rejects", async () => {
  const dir = temp("priv-existing-");
  chmodSync(dir, 0o700);
  const result = await ensurePrivateDirectory(dir);
  assert.equal(result.created, false);
  assert.equal(result.path, dir);

  // Wrong mode (0755) → NOT_PRIVATE, never chmod'd.
  const lax = temp("priv-lax-");
  chmodSync(lax, 0o755);
  await expectReject(() => ensurePrivateDirectory(lax), "NOT_PRIVATE");
  assert.equal(lstatSync(lax).mode & 0o777, 0o755, "existing dir must never be silently chmod'd");
});

test("ensurePrivateDirectory: intermediate symlink component fails closed", async () => {
  const dir = temp("priv-sym-");
  const real = join(dir, "real");
  mkdirSync(real);
  const link = join(dir, "link");
  symlinkSync(real, link);
  await expectReject(() => ensurePrivateDirectory(join(link, "leaf")), "SYMLINK");
  // Nothing was created behind the symlink.
  assert.equal(await import("node:fs/promises").then((m) => m.lstat(join(real, "leaf")).then(() => true, () => false)), false);
});

test("ensurePrivateDirectory: validates the existing leaf via Host policy hook (entries allowlist)", async () => {
  const dir = temp("priv-hook-");
  chmodSync(dir, 0o700);
  let calls = 0;
  const result = await ensurePrivateDirectory(dir, {
    validateExistingLeaf: async ({ path, identity }) => {
      calls += 1;
      assert.equal(path, dir);
      assert.equal(identity.isDirectory, true);
      assert.equal(identity.ino, lstatSync(dir).ino);
    },
  });
  assert.equal(result.created, false);
  assert.equal(calls, 1);

  // A Host policy rejection is a Host error, never wrapped into LocalAuthorityError.
  await assert.rejects(
    () => ensurePrivateDirectory(dir, {
      validateExistingLeaf: async () => { throw new Error("entries rejected"); },
    }),
    /entries rejected/,
  );

  // Hook is NOT called for a newly created leaf.
  const fresh = temp("priv-hook-fresh-");
  let hookCalls = 0;
  const created = await ensurePrivateDirectory(join(fresh, "newleaf"), {
    validateExistingLeaf: async () => { hookCalls += 1; },
  });
  assert.equal(created.created, true);
  assert.equal(hookCalls, 0);
});

test("ensurePrivateDirectory: reject roots and parent escapes before any mutation", async () => {
  await expectReject(() => ensurePrivateDirectory("/"), "ROOT_PATH");
  await expectReject(() => ensurePrivateDirectory("relative"), "INVALID_PATH");
  await expectReject(() => ensurePrivateDirectory(`/a\u0000b`), "INVALID_PATH");
});

test("backend.ensurePrivateDirectory: factory delegates with Host policy hook", async () => {
  const dir = temp("priv-backend-");
  chmodSync(dir, 0o700);
  const backend = createPosixSecureStateBackend();
  let hookCalls = 0;
  const result = await backend.ensurePrivateDirectory(dir, {
    validateExistingLeaf: async () => { hookCalls += 1; },
  });
  assert.equal(result.created, false);
  assert.equal(hookCalls, 1);
});

test("backend identity/principal helpers", async () => {
  const dir = temp("priv-ident-");
  const backend = createPosixSecureStateBackend();
  const identity = await backend.fileIdentity(dir);
  assert.ok(identity);
  assert.equal(identity.ino, lstatSync(dir).ino);
  const principal = backend.principal();
  if (typeof process.getuid === "function") {
    assert.equal(principal.uid, process.getuid());
    assert.equal(backend.isOwnedByCurrentUser(identity), true);
  }
  assert.equal(await backend.fileIdentity(join(dir, "missing")), null);
});
