import assert from "node:assert/strict";
import test from "node:test";
import { delimiter } from "node:path";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemon } from "@fffattiger/pix-sessiond/daemon";
import {
  parseAllowedRootsEnv,
  createProductionResources,
  createProductionCapabilityResolver,
  SessiondWorktreeSafetyAdapter,
  InvalidAllowedRootsError,
  HttpError,
  PRODUCTION_MAX_UPLOAD_BYTES,
  PRODUCTION_PING_TIMEOUT_MS,
  PRODUCTION_RESOURCE_LIMITS,
  PRODUCTION_FULL_CAPABILITIES,
  RESOURCE_DEGRADED_CAPABILITIES,
} from "../dist/index.js";

const temporary = [];
// Canonicalize temp roots: ensurePixHostDir refuses intermediate path symlinks
// (macOS `/var` → `/private/var`). Callers must pass canonical absolute hostDir.
const CANON_TMP = realpathSync(tmpdir());
function temp(prefix) {
  const value = mkdtempSync(join(CANON_TMP, prefix));
  temporary.push(value);
  return value;
}
test.afterEach(() => {
  while (temporary.length) rmSync(temporary.pop(), { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// parseAllowedRootsEnv — frozen parsing rules
// ---------------------------------------------------------------------------

test("parseAllowedRootsEnv: unset ⇒ a single root equal to cwd", () => {
  assert.deepEqual(parseAllowedRootsEnv(undefined, "/some/cwd"), ["/some/cwd"]);
});

test("parseAllowedRootsEnv: empty raw value ⇒ single safe error", () => {
  assert.throws(() => parseAllowedRootsEnv("", "/cwd"), (e) => {
    return e instanceof InvalidAllowedRootsError && /empty/i.test(e.message);
  });
});

test("parseAllowedRootsEnv: empty segment ⇒ single safe error", () => {
  const raw = `/a${delimiter}${delimiter}/b`;
  assert.throws(() => parseAllowedRootsEnv(raw, "/cwd"), (e) => {
    return e instanceof InvalidAllowedRootsError && /empty segment/i.test(e.message);
  });
});

test("parseAllowedRootsEnv: trailing delimiter is an empty segment, not ignored", () => {
  assert.throws(() => parseAllowedRootsEnv(`/a${delimiter}`, "/cwd"), InvalidAllowedRootsError);
});

test("parseAllowedRootsEnv: relative segment ⇒ single safe error (no resolve, no ~)", () => {
  assert.throws(() => parseAllowedRootsEnv(`relative${delimiter}/b`, "/cwd"), (e) => {
    return e instanceof InvalidAllowedRootsError && /not an absolute path/i.test(e.message);
  });
  assert.throws(() => parseAllowedRootsEnv(`~/x`, "/cwd"), (e) => {
    return e instanceof InvalidAllowedRootsError && /not an absolute path/i.test(e.message);
  });
});

test("parseAllowedRootsEnv: NUL byte ⇒ single safe error", () => {
  assert.throws(() => parseAllowedRootsEnv(`/a\0b`, "/cwd"), (e) => {
    return e instanceof InvalidAllowedRootsError && /NUL/i.test(e.message);
  });
});

test("parseAllowedRootsEnv: valid segments returned verbatim (no canonicalization here)", () => {
  const raw = `/a${delimiter}/b${delimiter}/c`;
  assert.deepEqual(parseAllowedRootsEnv(raw, "/cwd"), ["/a", "/b", "/c"]);
  assert.deepEqual(parseAllowedRootsEnv("/single", "/cwd"), ["/single"]);
});

// ---------------------------------------------------------------------------
// createProductionResources — roots canonicalization / deps assembly
// ---------------------------------------------------------------------------

test("createProductionResources: unset env ⇒ single root = canonical cwd, defaultCwd = cwd", async () => {
  const cwd = temp("pix-prod-cwd-");
  const { deps, adapter, resolver } = await createProductionResources({
    allowedRootsEnv: undefined,
    cwd,
    endpoint: "unix:/nonexistent-prod-unset",
    secret: "s",
    hostDirEnv: temp("pix-prod-hostdir-"),
  });
  const canonicalCwd = await realpath(cwd);
  assert.deepEqual(deps.allowedRoots.roots(), [canonicalCwd]);
  assert.equal(deps.defaultCwd, canonicalCwd);
  assert.equal(deps.defaultCwdFactory, undefined);
  assert.equal(deps.busyPreflight, adapter);
  assert.equal(deps.mutationGuard, adapter);
  assert.equal(deps.processRunner !== undefined, true);
  assert.deepEqual(deps.limits, { ...PRODUCTION_RESOURCE_LIMITS });
  assert.equal(typeof resolver.isAvailable, "function");
});

test("createProductionResources: defaultCwd is the canonical of the FIRST configured segment", async () => {
  const first = temp("pix-prod-first-");
  const second = temp("pix-prod-second-");
  // Build a symlinked alias for `first` so canonical != requested, proving
  // defaultCwd is canonicalized rather than copied verbatim.
  const alias = join(first, "..", "prod-first-alias");
  symlinkSync(first, alias);
  temporary.push(alias);
  const { deps } = await createProductionResources({
    allowedRootsEnv: `${alias}${delimiter}${second}`,
    cwd: "/cwd",
    endpoint: "unix:/nonexistent-prod-order",
    secret: "s",
    hostDirEnv: temp("pix-prod-hostdir-"),
  });
  const canonicalFirst = await realpath(first);
  assert.equal(deps.defaultCwd, canonicalFirst);
  assert.ok(deps.allowedRoots.roots().includes(canonicalFirst));
});

test("createProductionResources: missing root ⇒ InvalidAllowedRootsError before listen", async () => {
  const missing = join(tmpdir(), "pix-prod-missing-" + process.pid);
  await assert.rejects(
    () => createProductionResources({
      allowedRootsEnv: missing,
      cwd: "/cwd",
      endpoint: "unix:/nonexistent-prod-missing",
      secret: "s",
      hostDirEnv: temp("pix-prod-hostdir-"),
    }),
    (e) => e instanceof InvalidAllowedRootsError && /PIX_ALLOWED_ROOTS/i.test(e.message),
  );
});

test("createProductionResources: file (not a directory) root ⇒ InvalidAllowedRootsError", async () => {
  const dir = temp("pix-prod-filedir-");
  const file = join(dir, "afile");
  writeFileSync(file, "x");
  await assert.rejects(
    () => createProductionResources({
      allowedRootsEnv: file,
      cwd: "/cwd",
      endpoint: "unix:/nonexistent-prod-file",
      secret: "s",
      hostDirEnv: temp("pix-prod-hostdir-"),
    }),
    (e) => e instanceof InvalidAllowedRootsError && /PIX_ALLOWED_ROOTS/i.test(e.message),
  );
});

test("createProductionResources: local expansion enabled, LAN expansion disabled", async () => {
  const root = temp("pix-prod-policy-");
  const { deps } = await createProductionResources({
    allowedRootsEnv: root,
    cwd: root,
    endpoint: "unix:/nonexistent-prod-policy",
    secret: "s",
    hostDirEnv: temp("pix-prod-hostdir-"),
  });
  // Local expansion of a brand-new sibling directory succeeds.
  const localTarget = temp("pix-prod-local-target-");
  const localExpansion = await deps.allowedRoots.expandRoots([localTarget], "local");
  assert.ok(localExpansion.paths.includes(await realpath(localTarget)));
  // LAN expansion of a brand-new sibling directory is rejected.
  const lanTarget = temp("pix-prod-lan-target-");
  await assert.rejects(
    () => deps.allowedRoots.expandRoots([lanTarget], "lan"),
    (e) => e instanceof HttpError && e.code === "ROOT_EXPANSION_DISABLED",
  );
});

test("createProductionResources: a symlinked root is canonicalized to its real target (identity-pinned)", async () => {
  const real = temp("pix-prod-real-");
  const link = join(real, "..", "prod-symlink-root");
  symlinkSync(real, link);
  temporary.push(link);
  const { deps } = await createProductionResources({
    allowedRootsEnv: link,
    cwd: "/cwd",
    endpoint: "unix:/nonexistent-prod-symlink",
    secret: "s",
    hostDirEnv: temp("pix-prod-hostdir-"),
  });
  const canonicalReal = await realpath(real);
  assert.deepEqual(deps.allowedRoots.roots(), [canonicalReal]);
  assert.equal(deps.defaultCwd, canonicalReal);
});

// ---------------------------------------------------------------------------
// createProductionCapabilityResolver — shared capability projection
// ---------------------------------------------------------------------------

async function withDaemon(fn) {
  const dir = temp("pix-prod-daemon-");
  const daemon = await startDaemon({ directory: dir, serviceOptions: { idleTimeoutMs: 0 } });
  try {
    await fn(daemon);
  } finally {
    await daemon.shutdown();
  }
}

test("resolver: up ⇒ PRODUCTION_FULL_CAPABILITIES, down ⇒ RESOURCE_DEGRADED_CAPABILITIES", async () => {
  await withDaemon(async (daemon) => {
    const resolver = createProductionCapabilityResolver({
      endpoint: daemon.endpoint,
      secret: daemon.secret,
      logger: {},
    });
    assert.equal(await resolver.isAvailable(), true);
    assert.deepEqual(await resolver.resolve(), [...PRODUCTION_FULL_CAPABILITIES]);
    assert.deepEqual([...PRODUCTION_FULL_CAPABILITIES], ["agent", "sessions", "files", "files.write", "files.watch", "files.upload", "git", "worktree", "models", "auth.providers", "skills", "plugins"]);
    // sessions history requires the up authority; degraded never advertises it.
    assert.ok([...RESOURCE_DEGRADED_CAPABILITIES].includes("files"));
    assert.ok(![...RESOURCE_DEGRADED_CAPABILITIES].includes("sessions"));
    // worktree is the read-only list token — present in both up and degraded.
    assert.ok((await resolver.resolve()).includes("worktree"));
    assert.ok([...RESOURCE_DEGRADED_CAPABILITIES].includes("worktree"));
    // No write token is negotiated; POST/DELETE stay sessiond-guarded.
    assert.ok(!(await resolver.resolve()).includes("worktree.write"));
    assert.ok(![...RESOURCE_DEGRADED_CAPABILITIES].includes("worktree.write"));
  });
});

test("resolver: a stopped daemon ⇒ degraded, never throws", async () => {
  await withDaemon(async (daemon) => {
    const resolver = createProductionCapabilityResolver({
      endpoint: daemon.endpoint,
      secret: daemon.secret,
      logger: {},
    });
    assert.equal(await resolver.isAvailable(), true);
    await daemon.shutdown();
    assert.equal(await resolver.isAvailable(), false);
    assert.deepEqual(await resolver.resolve(), [...RESOURCE_DEGRADED_CAPABILITIES]);
  });
});

test("resolver: wrong secret ⇒ auth failure degrades to degraded (secret read once, no silent re-read)", async () => {
  await withDaemon(async (daemon) => {
    const resolver = createProductionCapabilityResolver({
      endpoint: daemon.endpoint,
      secret: "wrong-secret",
      logger: {},
    });
    assert.equal(await resolver.isAvailable(), false);
    assert.deepEqual(await resolver.resolve(), [...RESOURCE_DEGRADED_CAPABILITIES]);
  });
});

test("resolver: RPC error ⇒ degraded capabilities + one sanitized log line", async () => {
  const logs = [];
  const resolver = createProductionCapabilityResolver({
    endpoint: "unix:/nonexistent-prod-resolver-fail",
    secret: "s",
    logger: { warn: (msg) => logs.push(msg) },
  });
  const caps = await resolver.resolve();
  assert.deepEqual(caps, [...RESOURCE_DEGRADED_CAPABILITIES]);
  assert.equal(logs.length, 1, "exactly one sanitized warning is emitted");
  const line = String(logs[0]);
  // The log must not leak the endpoint path or the secret.
  assert.equal(line.includes("nonexistent-prod-resolver-fail"), false);
  assert.equal(line.includes("secret"), false);
  assert.equal(await resolver.isAvailable(), false);
});

test("resolver PRODUCTION_PING_TIMEOUT_MS is the frozen 2s", () => {
  assert.equal(PRODUCTION_PING_TIMEOUT_MS, 2_000);
});

test("PRODUCTION_MAX_UPLOAD_BYTES is the frozen 25 MiB and matches the resource limit", () => {
  assert.equal(PRODUCTION_MAX_UPLOAD_BYTES, 25 * 1024 * 1024);
  assert.equal(PRODUCTION_RESOURCE_LIMITS.maxUploadFileBytes, PRODUCTION_MAX_UPLOAD_BYTES);
});

// ---------------------------------------------------------------------------
// SessiondWorktreeSafetyAdapter — busy preflight + mutation guard
// ---------------------------------------------------------------------------

test("adapter: assertAvailable resolves while the daemon is up", async () => {
  await withDaemon(async (daemon) => {
    const adapter = new SessiondWorktreeSafetyAdapter({ endpoint: daemon.endpoint, secret: daemon.secret });
    await adapter.assertAvailable(); // does not throw
  });
});

test("adapter: assertAvailable throws sanitized 503 when the authority is down", async () => {
  await withDaemon(async (daemon) => {
    const adapter = new SessiondWorktreeSafetyAdapter({ endpoint: daemon.endpoint, secret: daemon.secret });
    await daemon.shutdown();
    await assert.rejects(
      () => adapter.assertAvailable(),
      (e) => e instanceof HttpError && e.status === 503 && /Runtime authority unavailable/i.test(e.message),
    );
  });
});

test("adapter: assertAvailable throws sanitized 503 on a bad endpoint (no secret/endpoint leak)", async () => {
  const adapter = new SessiondWorktreeSafetyAdapter({ endpoint: "unix:/nonexistent-prod-adapter", secret: "topsecret" });
  await assert.rejects(
    () => adapter.assertAvailable(),
    (e) => {
      return e instanceof HttpError && e.status === 503 &&
        !String(e.message).includes("topsecret") &&
        !String(e.message).includes("nonexistent-prod-adapter");
    },
  );
});

test("adapter: busy preflight reports not-busy for an idle cwd while up", async () => {
  await withDaemon(async (daemon) => {
    const adapter = new SessiondWorktreeSafetyAdapter({ endpoint: daemon.endpoint, secret: daemon.secret });
    const cwd = temp("pix-prod-busy-");
    const result = await adapter.check(cwd);
    assert.equal(result.busy, false);
  });
});

test("adapter: busy preflight throws sanitized 503 when the authority is down", async () => {
  await withDaemon(async (daemon) => {
    const adapter = new SessiondWorktreeSafetyAdapter({ endpoint: daemon.endpoint, secret: daemon.secret });
    await daemon.shutdown();
    await assert.rejects(
      () => adapter.check("/some/cwd"),
      (e) => e instanceof HttpError && e.status === 503 && /Cannot determine worktree busy state/i.test(e.message),
    );
  });
});
