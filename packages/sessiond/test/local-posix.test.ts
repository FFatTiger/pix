import assert from "node:assert/strict";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { lstat, mkdir, mkdtemp, open, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test, { afterEach } from "node:test";
import {
  isOwnedByCurrentUser,
  LocalAuthorityError,
  type PosixFileIdentity,
} from "@fffattiger/pix-local-authority/state";
import {
  ensureSessiondPrivateDirectory,
  ensureSessiondPrivateDirectoryWithFs,
  reverifySessiondPrivateDirectory,
} from "../src/local-posix.js";

const HERE = dirname(fileURLToPath(import.meta.url));
// Compiled tests live at dist-test/test/*.js → the real package root is two
// levels up; the static source audit reads the actual `src/local-posix.ts`.
const PACKAGE_ROOT = resolve(HERE, "..", "..");

// Seam tests walk the lexical path (no canonicalization), so the temp base must
// be realpath-resolved — otherwise the macOS `/var` → `/private/var` system
// alias would be seen as a symlink intermediate and false-rejected.
const CANON_TMP = realpathSync(tmpdir());
const temporary: string[] = [];
function temp(prefix: string): string {
  const value = mkdtempSync(join(CANON_TMP, prefix));
  temporary.push(value);
  return value;
}
afterEach(() => {
  while (temporary.length) {
    const value = temporary.pop()!;
    rmSync(value, { recursive: true, force: true });
  }
});

function realFs(ownerCheck: (identity: PosixFileIdentity) => boolean = isOwnedByCurrentUser) {
  return { lstat, mkdir, realpath, open, isOwnedByCurrentUser: ownerCheck };
}

async function expectReject(fn: () => Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(fn, (e: unknown) => e instanceof LocalAuthorityError && e.code === code, `expected reject with ${code}`);
}

/** Assert a rejected error is a fixed sanitized LocalAuthorityError with no raw
 * path / errno / marker leakage. */
function assertSanitized(error: unknown, code: string, marker: string): void {
  assert.ok(error instanceof LocalAuthorityError, "must be LocalAuthorityError");
  assert.equal(error.code, code, "fixed code");
  assert.ok(!error.message.includes(marker), `no marker/path in message (got "${error.message}")`);
  assert.ok(!/EACCES|ENOTDIR|ELOOP|permission denied|error: /i.test(error.message), `no raw os text (got "${error.message}")`);
}

/**
 * Real fs with narrow injected behavior that deterministically forces the exact
 * race the walk must classify safely:
 *   - the FIRST lstat of each `enoentPath` reports ENOENT (observed missing),
 *     every later lstat is real;
 *   - mkdir of each `eexistPath` reports EEXIST (a racer/preplanter planted it);
 * all other operations delegate to the real fs.
 */
function racedFs(options: {
  enoentPaths?: string[];
  eexistPaths?: string[];
  ownerCheck?: (identity: PosixFileIdentity) => boolean;
}) {
  const enoent = new Set(options.enoentPaths ?? []);
  const eexist = new Set(options.eexistPaths ?? []);
  const seenEnoent = new Set<string>();
  return {
    async lstat(p: string) {
      if (enoent.has(p) && !seenEnoent.has(p)) {
        seenEnoent.add(p);
        const error = new Error("ENOENT") as NodeJS.ErrnoException;
        error.code = "ENOENT";
        throw error;
      }
      return lstat(p);
    },
    async mkdir(p: string, opts: { recursive: false; mode: number }) {
      if (eexist.has(p)) {
        const error = new Error("EEXIST") as NodeJS.ErrnoException;
        error.code = "EEXIST";
        throw error;
      }
      return mkdir(p, opts);
    },
    realpath: (p: string) => realpath(p),
    open: (p: string, flags: number) => open(p, flags),
    isOwnedByCurrentUser: options.ownerCheck ?? isOwnedByCurrentUser,
  };
}

// ---------------------------------------------------------------------------
// Existing-leaf validate-only: exact private mode + owner, NEVER chmod'd
// ---------------------------------------------------------------------------

test("existing 0755 directory fails closed NOT_PRIVATE, mode untouched, no mutation", async () => {
  const dir = temp("posix-0755-");
  const leaf = join(dir, "leaf");
  mkdirSync(leaf, { mode: 0o755 });
  chmodSync(leaf, 0o755);
  const marker = join(leaf, "marker.txt");
  writeFileSync(marker, "payload", { mode: 0o600 });

  await expectReject(() => ensureSessiondPrivateDirectoryWithFs(leaf, realFs()), "NOT_PRIVATE");
  assert.equal(lstatSync(leaf).mode & 0o777, 0o755, "existing leaf must never be chmod'd");
  assert.equal(lstatSync(dir).mode & 0o777, 0o700, "parent unchanged");
  assert.equal(readFileSync(marker, "utf8"), "payload", "content untouched");
});

test("production entry fails closed on an existing 0755 directory (no partial mutation)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "posix-prod-0755-"));
  temporary.push(dir);
  chmodSync(dir, 0o755);
  await expectReject(() => ensureSessiondPrivateDirectory(dir), "NOT_PRIVATE");
  assert.equal(lstatSync(dir).mode & 0o777, 0o755, "mode untouched (never silently chmod'd)");
  assert.deepEqual(await import("node:fs/promises").then((m) => m.readdir(dir)), [], "no partial artifacts created");
});

test("existing 0700 wrong-owner (injected owner check) fails closed NOT_OWNED", async () => {
  const dir = temp("posix-owner-");
  const leaf = join(dir, "leaf");
  mkdirSync(leaf, { mode: 0o700 });
  await expectReject(() => ensureSessiondPrivateDirectoryWithFs(leaf, realFs(() => false)), "NOT_OWNED");
  assert.equal(lstatSync(leaf).mode & 0o777, 0o700, "never chmod'd");
});

test("existing 0700 current-user directory validates and is never chmod'd (created:false)", async () => {
  const dir = temp("posix-ok-");
  const leaf = join(dir, "leaf");
  mkdirSync(leaf, { mode: 0o700 });
  const result = await ensureSessiondPrivateDirectoryWithFs(leaf, realFs());
  assert.equal(result.created, false, "existing leaf is never reported created");
  assert.equal(lstatSync(leaf).mode & 0o777, 0o700);
});

// ---------------------------------------------------------------------------
// Symlink rejection (seam-level walk sees the symlink directly)
// ---------------------------------------------------------------------------

test("symlink leaf fails closed SYMLINK, target untouched", async () => {
  const dir = temp("posix-sym-");
  const external = join(dir, "external");
  mkdirSync(external, { mode: 0o700 });
  const payload = join(external, "content.txt");
  writeFileSync(payload, "payload", { mode: 0o600 });
  const leaf = join(dir, "leaf");
  symlinkSync(external, leaf);

  await expectReject(() => ensureSessiondPrivateDirectoryWithFs(leaf, realFs()), "SYMLINK");
  assert.equal(lstatSync(external).mode & 0o777, 0o700, "external target untouched");
  assert.equal(readFileSync(payload, "utf8"), "payload", "external content untouched");
});

test("symlink intermediate fails closed SYMLINK, target untouched", async () => {
  const dir = temp("posix-sym-int-");
  const external = join(dir, "external");
  mkdirSync(external, { mode: 0o700 });
  const link = join(dir, "link");
  symlinkSync(external, link);

  await expectReject(() => ensureSessiondPrivateDirectoryWithFs(join(link, "leaf"), realFs()), "SYMLINK");
  assert.equal(lstatSync(external).mode & 0o777, 0o700, "external target untouched");
});

test("production entry rejects a symlink LEAF (fixed SYMLINK, target untouched)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "posix-prod-sym-"));
  temporary.push(dir);
  const real = join(dir, "real");
  mkdirSync(real, { mode: 0o700 });
  const payload = join(real, "content.txt");
  writeFileSync(payload, "payload", { mode: 0o600 });
  const link = join(dir, "link");
  symlinkSync(real, link);

  await expectReject(() => ensureSessiondPrivateDirectory(link), "SYMLINK");
  if (process.platform !== "win32") {
    assert.equal(lstatSync(real).mode & 0o777, 0o700, "target untouched");
  }
  assert.equal(readFileSync(payload, "utf8"), "payload", "target content untouched");
});

// ---------------------------------------------------------------------------
// Raced EEXIST leaf (planted between lstat-ENOENT and mkdir): existing-leaf
// validate-only, NEVER created, NEVER chmod'd
// ---------------------------------------------------------------------------

test("raced EEXIST final leaf 0755: NOT_PRIVATE, never chmod, never created:true", async () => {
  const dir = temp("posix-race-leaf-");
  const leaf = join(dir, "leaf");
  mkdirSync(leaf, { mode: 0o755 });
  chmodSync(leaf, 0o755);
  const fs = racedFs({ enoentPaths: [leaf], eexistPaths: [leaf] });

  await expectReject(() => ensureSessiondPrivateDirectoryWithFs(leaf, fs), "NOT_PRIVATE");
  assert.equal(lstatSync(leaf).mode & 0o777, 0o755, "raced existing leaf must never be chmod'd");
  assert.equal(lstatSync(dir).mode & 0o777, 0o700, "parent unchanged");
});

test("raced EEXIST final leaf 0700: validate-only passes, created:false, never chmod'd", async () => {
  const dir = temp("posix-race-ok-");
  const leaf = join(dir, "leaf");
  mkdirSync(leaf, { mode: 0o700 });
  const marker = join(leaf, "marker.txt");
  writeFileSync(marker, "untouched", { mode: 0o600 });

  const fs = racedFs({ enoentPaths: [leaf], eexistPaths: [leaf] });
  const result = await ensureSessiondPrivateDirectoryWithFs(leaf, fs);
  assert.equal(result.created, false, "raced EEXIST leaf is never reported created");
  assert.equal(lstatSync(leaf).mode & 0o777, 0o700, "raced leaf never chmod'd");
  assert.equal(readFileSync(marker, "utf8"), "untouched", "marker unchanged");
});

// ---------------------------------------------------------------------------
// Created path: nested all-missing → 0700 leaves, created:true, fd-pinned fchmod
// ---------------------------------------------------------------------------

test("nested all-missing path created 0700, created:true, identity-pinned fchmod", async () => {
  const dir = temp("posix-create-");
  const leaf = join(dir, "a", "b", "leaf");
  const result = await ensureSessiondPrivateDirectoryWithFs(leaf, realFs());
  assert.equal(result.created, true);
  assert.equal(lstatSync(leaf).mode & 0o777, 0o700, "leaf 0700 via fd");
  assert.equal(lstatSync(join(dir, "a", "b")).mode & 0o777, 0o700, "intermediate leaves 0700");
});

test("production entry creates a missing runtime directory 0700 (created:true, canonical/operational split)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "posix-prod-create-"));
  temporary.push(dir);
  const leaf = join(dir, "missing", "sessiond");
  const ctx = await ensureSessiondPrivateDirectory(leaf);
  assert.equal(ctx.created, true);
  assert.equal(ctx.operationalPath, leaf);
  if (process.platform === "win32") {
    assert.equal(ctx.identity.kind, "windows");
    assert.equal(ctx.identity.isDirectory, true);
    assert.equal(ctx.identity.isReparsePoint, false);
  } else {
    assert.equal(lstatSync(leaf).mode & 0o777, 0o700);
    // The canonical path resolves the macOS /var system alias (no symlink components).
    assert.equal(lstatSync(ctx.canonicalPath).dev, lstatSync(leaf).dev);
    assert.equal(lstatSync(ctx.canonicalPath).ino, lstatSync(leaf).ino);
  }
});

// ---------------------------------------------------------------------------
// fd-identity hardening: a created leaf swapped at open must fail closed with
// zero chmod (O_NOFOLLOW alone cannot stop a real-directory swap)
// ---------------------------------------------------------------------------

test("created leaf swapped at open to a real 0755 replacement dir: UNSAFE_COMPONENT, zero chmod", async () => {
  const dir = temp("posix-open-swap-");
  const leaf = join(dir, "leaf");
  const backup = join(dir, "leaf.original");

  const fs = {
    lstat: (p: string) => lstat(p),
    mkdir: (p: string, opts: { recursive: false; mode: number }) => mkdir(p, opts),
    realpath: (p: string) => realpath(p),
    open: async (p: string, flags: number) => {
      if (p === leaf) {
        renameSync(leaf, backup);
        mkdirSync(leaf, { mode: 0o755 });
        chmodSync(leaf, 0o755);
        writeFileSync(join(leaf, "marker.txt"), "payload", { mode: 0o600 });
        return open(leaf, flags);
      }
      return open(p, flags);
    },
    isOwnedByCurrentUser,
  };

  await expectReject(() => ensureSessiondPrivateDirectoryWithFs(leaf, fs), "UNSAFE_COMPONENT");
  assert.equal(lstatSync(leaf).mode & 0o777, 0o755, "replacement dir must never be chmod'd");
  assert.equal(readFileSync(join(leaf, "marker.txt"), "utf8"), "payload", "replacement content untouched");
  assert.equal(lstatSync(backup).mode & 0o777, 0o700, "original created inode unchanged");
});

// ---------------------------------------------------------------------------
// Bounded re-verify: the operational directory must still be the preflighted one
// ---------------------------------------------------------------------------

test("reverify detects a directory identity swap (fail closed)", async () => {
  const dir = temp("posix-rv-swap-");
  const leaf = join(dir, "leaf");
  const ctx = await ensureSessiondPrivateDirectory(leaf);
  assert.equal(ctx.created, true);

  // Swap: rename the preflighted dir aside, plant a fresh replacement.
  renameSync(leaf, join(dir, "leaf.original"));
  mkdirSync(leaf, { mode: 0o700 });
  await expectReject(() => reverifySessiondPrivateDirectory(ctx), "UNSAFE_COMPONENT");
});

test("reverify detects a missing directory (fail closed)", async () => {
  const dir = temp("posix-rv-missing-");
  const leaf = join(dir, "leaf");
  const ctx = await ensureSessiondPrivateDirectory(leaf);
  rmSync(leaf, { recursive: true, force: true });
  await expectReject(() => reverifySessiondPrivateDirectory(ctx), "UNSAFE_COMPONENT");
});

test("reverify detects a swapped-in symlink leaf (fail closed, target untouched)", async () => {
  const dir = temp("posix-rv-sym-");
  const leaf = join(dir, "leaf");
  const ctx = await ensureSessiondPrivateDirectory(leaf);
  const external = join(dir, "external");
  mkdirSync(external, { mode: 0o700 });
  const payload = join(external, "content.txt");
  writeFileSync(payload, "payload", { mode: 0o600 });

  // Swap the real dir away and replace the path with a symlink to external.
  renameSync(leaf, join(dir, "leaf.original"));
  symlinkSync(external, leaf);
  await expectReject(() => reverifySessiondPrivateDirectory(ctx), "UNSAFE_COMPONENT");
  assert.equal(readFileSync(payload, "utf8"), "payload", "external target untouched");
});

test("reverify passes when the directory is unchanged", async () => {
  const dir = temp("posix-rv-ok-");
  const leaf = join(dir, "leaf");
  const ctx = await ensureSessiondPrivateDirectory(leaf);
  await reverifySessiondPrivateDirectory(ctx); // must not throw
});

// ---------------------------------------------------------------------------
// Raw leak / marker probes: fixed sanitized errors, no path/errno/marker
// ---------------------------------------------------------------------------

test("marker probes: no raw path/errno leakage in any thrown error", async () => {
  const dir = temp("posix-leak-");
  const leaf = join(dir, "leaf-secret-marker-xyz");
  mkdirSync(leaf, { mode: 0o755 });
  chmodSync(leaf, 0o755);
  try {
    await ensureSessiondPrivateDirectoryWithFs(leaf, realFs());
    assert.fail("expected rejection for 0755 leaf");
  } catch (error) {
    assertSanitized(error, "NOT_PRIVATE", leaf);
  }

  const symLeaf = join(dir, "sym-secret-marker-xyz");
  symlinkSync(join(dir, "elsewhere"), symLeaf);
  try {
    await ensureSessiondPrivateDirectoryWithFs(symLeaf, realFs());
    assert.fail("expected rejection for symlink leaf");
  } catch (error) {
    assertSanitized(error, "SYMLINK", symLeaf);
  }

  const ctxDir = temp("posix-leak-ctx-");
  const ctx = await ensureSessiondPrivateDirectory(ctxDir);
  rmSync(ctxDir, { recursive: true, force: true });
  try {
    await reverifySessiondPrivateDirectory(ctx);
    assert.fail("expected rejection for missing dir");
  } catch (error) {
    assertSanitized(error, "UNSAFE_COMPONENT", ctxDir);
  }
});

// ---------------------------------------------------------------------------
// Static source audit: leafCreated is assigned ONLY from a fulfilled mkdir
// (never from pathname equality), mirroring the Local Authority §55 guard.
// ---------------------------------------------------------------------------

test("static source audit: leafCreated gated by the fulfilled-mkdir flag", async () => {
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(join(PACKAGE_ROOT, "src", "local-posix.ts"), "utf8");
  // Old defect pattern (pathname equality): must not exist.
  assert.ok(
    !/current\s*===\s*normalized\s*\)\s*leafCreated\s*=\s*true/.test(src),
    "leafCreated must never be assigned from pathname equality alone",
  );
  assert.ok(/mkdirFulfilled\s*=\s*true/.test(src), "mkdirFulfilled is set only when mkdir resolves");
  assert.ok(/if\s*\(\s*mkdirFulfilled\s*\)/.test(src), "leafCreated is gated by the mkdir-result flag");
  const assignments = src.match(/leafCreated\s*=\s*true/g) ?? [];
  assert.equal(assignments.length, 1, "exactly one leafCreated=true assignment, inside the mkdir-success branch");
});
