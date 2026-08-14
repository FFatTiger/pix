import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LocalAuthorityError } from "../dist/state/index.js";
// Private/internal test seam: reachable ONLY through the direct module path
// `dist/state/posix.js` — never from the public `state/index` or package
// surfaces (the package-surface test enforces the exact public export set).
import { ensurePrivateDirectoryWithFs, isOwnedByCurrentUser } from "../dist/state/posix.js";

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

async function expectReject(fn, code) {
  await assert.rejects(
    fn,
    (e) => e instanceof LocalAuthorityError && e.code === code,
    `expected reject with ${code}`,
  );
}

async function exists(p) {
  return lstat(p).then(() => true, () => false);
}

/**
 * Real fs with narrow injected behavior that deterministically forces the exact
 * race the old implementation mis-classified:
 *   - the FIRST lstat of each `enoentPath` reports ENOENT (as if observed
 *     missing), every later lstat is real;
 *   - mkdir of each `eexistPath` reports EEXIST (as if a racer/preplanter
 *     planted the component between the lstat and the mkdir);
 * all other operations delegate to the real fs.
 * `ownerCheck` lets tests force the current-user-ownership verdict without root.
 */
function racedFs({ enoentPaths = [], eexistPaths = [], ownerCheck = isOwnedByCurrentUser }) {
  const enoent = new Set(enoentPaths);
  const eexist = new Set(eexistPaths);
  const seenEnoent = new Set();
  return {
    async lstat(p) {
      if (enoent.has(p) && !seenEnoent.has(p)) {
        seenEnoent.add(p);
        const error = new Error("ENOENT");
        error.code = "ENOENT";
        throw error;
      }
      return lstat(p);
    },
    async mkdir(p, opts) {
      if (eexist.has(p)) {
        const error = new Error("EEXIST");
        error.code = "EEXIST";
        throw error;
      }
      return mkdir(p, opts);
    },
    realpath: (p) => realpath(p),
    open: (p, flags) => open(p, flags),
    isOwnedByCurrentUser: ownerCheck,
  };
}

// ---------------------------------------------------------------------------
// EEXIST raced FINAL leaf: must take the existing-leaf validate-only path and
// NEVER be treated as created (the confirmed defect) and NEVER be chmod'd.
// ---------------------------------------------------------------------------

test("EEXIST raced final leaf 0755: rejects NOT_PRIVATE, mode unchanged, never created", async () => {
  const dir = temp("race-leaf-0755-");
  const leaf = join(dir, "leaf");
  mkdirSync(leaf, { mode: 0o755 });
  chmodSync(leaf, 0o755);
  const fs = racedFs({ enoentPaths: [leaf], eexistPaths: [leaf] });

  await expectReject(
    () => ensurePrivateDirectoryWithFs(leaf, { requireMode: 0o700 }, fs),
    "NOT_PRIVATE",
  );
  // The raced existing leaf must never be silently chmod'd to 0700.
  assert.equal(lstatSync(leaf).mode & 0o777, 0o755, "raced existing leaf must never be chmod'd");
  assert.equal(lstatSync(dir).mode & 0o777, 0o700, "parent unchanged");
});

test("EEXIST raced final 0700 leaf: validateExistingLeaf runs, created:false, marker unchanged", async () => {
  const dir = temp("race-leaf-0700-");
  const leaf = join(dir, "leaf");
  mkdirSync(leaf, { mode: 0o700 });
  const marker = join(leaf, "marker.txt");
  writeFileSync(marker, "untouched", { mode: 0o600 });

  let hookCalls = 0;
  const result = await ensurePrivateDirectoryWithFs(leaf, {
    requireMode: 0o700,
    validateExistingLeaf: async ({ path, identity }) => {
      hookCalls += 1;
      assert.equal(path, leaf);
      assert.equal(identity.isDirectory, true);
      assert.equal(identity.ino, lstatSync(leaf).ino);
    },
  }, racedFs({ enoentPaths: [leaf], eexistPaths: [leaf] }));
  assert.equal(result.created, false, "raced EEXIST leaf is never reported created");
  assert.equal(result.path, leaf);
  assert.equal(hookCalls, 1, "existing-leaf validation hook must run for a raced leaf");
  assert.equal(readFileSync(marker, "utf8"), "untouched", "marker unchanged");
  assert.equal(lstatSync(leaf).mode & 0o777, 0o700, "raced leaf not chmod'd");

  // A Host policy rejection is preserved verbatim (never wrapped), and the
  // marker/file stay untouched. Uses a fresh raced fs so this also exercises
  // the raced EEXIST path.
  await assert.rejects(
    () => ensurePrivateDirectoryWithFs(leaf, {
      requireMode: 0o700,
      validateExistingLeaf: async () => { throw new Error("entries rejected"); },
    }, racedFs({ enoentPaths: [leaf], eexistPaths: [leaf] })),
    /entries rejected/,
  );
  assert.equal(readFileSync(marker, "utf8"), "untouched", "marker unchanged after hook rejection");
});

test("EEXIST raced final symlink to external 0755 dir: SYMLINK, external mode/content unchanged", async () => {
  const dir = temp("race-leaf-sym-");
  const external = join(dir, "external");
  mkdirSync(external, { mode: 0o755 });
  chmodSync(external, 0o755);
  const externalFile = join(external, "content.txt");
  writeFileSync(externalFile, "payload", { mode: 0o600 });
  const leaf = join(dir, "leaf");
  symlinkSync(external, leaf);

  const fs = racedFs({ enoentPaths: [leaf], eexistPaths: [leaf] });
  await expectReject(
    () => ensurePrivateDirectoryWithFs(leaf, { requireMode: 0o700 }, fs),
    "SYMLINK",
  );
  // No mutation inside or outside the symlink target.
  assert.equal(lstatSync(external).mode & 0o777, 0o755, "external dir mode unchanged");
  assert.equal(readFileSync(externalFile, "utf8"), "payload", "external content unchanged");
});

// ---------------------------------------------------------------------------
// EEXIST raced INTERMEDIATE: never blindly create descendants inside an
// untrusted newly-planted directory. Strong policy permits only a real
// non-symlink dir that is current-user owned with the exact private mode.
// ---------------------------------------------------------------------------

test("EEXIST raced intermediate 0755: NOT_PRIVATE, no descendant created, never chmod'd", async () => {
  const dir = temp("race-int-0755-");
  const inter = join(dir, "inter");
  mkdirSync(inter, { mode: 0o755 });
  chmodSync(inter, 0o755);
  const leaf = join(inter, "leaf");

  const fs = racedFs({ enoentPaths: [inter], eexistPaths: [inter] });
  await expectReject(
    () => ensurePrivateDirectoryWithFs(leaf, { requireMode: 0o700 }, fs),
    "NOT_PRIVATE",
  );
  assert.equal(await exists(leaf), false, "no descendant created under a lax raced intermediate");
  assert.equal(lstatSync(inter).mode & 0o777, 0o755, "raced intermediate never chmod'd");
});

test("EEXIST raced intermediate owned by another user: NOT_OWNED, no descendant created", async () => {
  const dir = temp("race-int-owner-");
  const inter = join(dir, "inter");
  mkdirSync(inter, { mode: 0o700 });
  chmodSync(inter, 0o700);
  const leaf = join(inter, "leaf");

  const fs = racedFs({ enoentPaths: [inter], eexistPaths: [inter], ownerCheck: () => false });
  await expectReject(
    () => ensurePrivateDirectoryWithFs(leaf, { requireMode: 0o700 }, fs),
    "NOT_OWNED",
  );
  assert.equal(await exists(leaf), false, "no descendant created under a foreign raced intermediate");
  assert.equal(lstatSync(inter).mode & 0o777, 0o700, "raced intermediate never chmod'd");
});

test("EEXIST raced intermediate 0700 current-user: strong policy permits; descendants created 0700, created:true", async () => {
  const dir = temp("race-int-safe-");
  const inter = join(dir, "inter");
  mkdirSync(inter, { mode: 0o700 });
  chmodSync(inter, 0o700);
  const leaf = join(inter, "leaf");

  const fs = racedFs({ enoentPaths: [inter], eexistPaths: [inter] });
  const result = await ensurePrivateDirectoryWithFs(leaf, { requireMode: 0o700 }, fs);
  assert.equal(result.created, true, "the leaf created by THIS call is created:true");
  assert.equal(result.path, leaf);
  assert.equal(lstatSync(leaf).mode & 0o777, 0o700, "leaf created by this call is 0700 via fd");
  // The raced intermediate was never chmod'd (it kept its own planted 0700).
  assert.equal(lstatSync(inter).mode & 0o777, 0o700, "raced intermediate unchanged (no chmod)");
});

// ---------------------------------------------------------------------------
// Ordinary successful-mkdir behavior through the same internal walk (real fs).
// ---------------------------------------------------------------------------

test("internal walk with real fs: all-missing nested path created 0700, created:true", async () => {
  const dir = temp("race-create-ok-");
  const leaf = join(dir, "a", "b", "leaf");
  const fs = { lstat, mkdir, realpath, open, isOwnedByCurrentUser };
  const result = await ensurePrivateDirectoryWithFs(leaf, {}, fs);
  assert.equal(result.created, true);
  assert.equal(result.path, leaf);
  assert.equal(lstatSync(leaf).mode & 0o777, 0o700);
  assert.equal(lstatSync(join(dir, "a", "b")).mode & 0o777, 0o700);
});

// ---------------------------------------------------------------------------
// Static source audit: leafCreated is assigned ONLY from the successful mkdir
// result, never from pathname equality alone (the old `if (current ===
// normalized) leafCreated = true` defect).
// ---------------------------------------------------------------------------

test("static source audit: leafCreated only from fulfilled mkdir, never pathname equality", () => {
  const src = readFileSync(join(PACKAGE_ROOT, "src", "state", "posix.ts"), "utf8");
  // Old defect: `if (current === normalized) leafCreated = true;` — a raced
  // EEXIST leaf was treated as created and fd-fchmod'd. This pattern must not
  // exist.
  assert.ok(
    !/current\s*===\s*normalized\s*\)\s*leafCreated\s*=\s*true/.test(src),
    "leafCreated must never be assigned from pathname equality alone",
  );
  // The mkdir-result flag must exist and gate the assignment.
  assert.ok(/mkdirFulfilled\s*=\s*true/.test(src), "mkdirFulfilled is set only when mkdir resolves");
  assert.ok(/if\s*\(\s*mkdirFulfilled\s*\)/.test(src), "leafCreated is gated by the mkdir result flag");
  const assignments = src.match(/leafCreated\s*=\s*true/g) ?? [];
  assert.equal(assignments.length, 1, "exactly one leafCreated=true assignment, inside the mkdir-success branch");
});
