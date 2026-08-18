import assert from "node:assert/strict";
import test from "node:test";
import { delimiter } from "node:path";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemon } from "@fffattiger/pix-sessiond/daemon";
import {
  parseAllowedRootsEnv,
  createProductionResources,
  createProductionCapabilityResolver,
  SessiondWorktreeSafetyAdapter,
  InvalidAllowedRootsError,
  InvalidHostDirError,
  RootPrivilegeDeniedError,
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

test("createProductionResources default-denies uid 0 before opening host state", async () => {
  const cwd = temp("pi-root-policy-cwd-");
  await assert.rejects(
    () => createProductionResources({
      allowedRootsEnv: undefined,
      cwd,
      endpoint: "/tmp/unused.sock",
      secret: "x".repeat(32),
      processUid: 0,
    }),
    (error) => error instanceof RootPrivilegeDeniedError
      && error.code === "PRIVILEGED_PROCESS"
      && error.message === "Running as root is disabled unless PIX_ALLOW_ROOT=1 is set explicitly",
  );
});

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
    assert.deepEqual([...PRODUCTION_FULL_CAPABILITIES], ["agent", "sessions", "session.delete", "session.write", "files", "files.write", "files.watch", "files.upload", "git", "worktree", "worktree.write", "models", "auth.providers", "skills", "plugins", "themes", "project.trust"]);
    // sessions history requires the up authority; degraded never advertises it.
    assert.ok([...RESOURCE_DEGRADED_CAPABILITIES].includes("files"));
    assert.ok(![...RESOURCE_DEGRADED_CAPABILITIES].includes("sessions"));
    // session.delete is the D4 delete capability: full/sessiond-up only, and
    // NEVER advertised in degraded (the DELETE route is sessiond-guarded and
    // mounted only with the mutation seam).
    assert.ok((await resolver.resolve()).includes("session.delete"));
    assert.ok(![...RESOURCE_DEGRADED_CAPABILITIES].includes("session.delete"));
    // session.write is the D4 session-rename capability: full/sessiond-up only,
    // NEVER advertised in degraded (the PATCH route is sessiond-guarded and
    // mounted only with the rename seam).
    assert.ok((await resolver.resolve()).includes("session.write"));
    assert.ok(![...RESOURCE_DEGRADED_CAPABILITIES].includes("session.write"));
    // worktree is the read-only list token — present in both up and degraded.
    assert.ok((await resolver.resolve()).includes("worktree"));
    assert.ok([...RESOURCE_DEGRADED_CAPABILITIES].includes("worktree"));
    // worktree.write is the honest write capability: full/sessiond-up only.
    assert.ok((await resolver.resolve()).includes("worktree.write"));
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

/**
 * Minimal fake sessiond RPC endpoint speaking the real AUTH handshake, used to
 * exercise the Protocol v2 stale-daemon retraction WITHOUT a real v1 daemon.
 * `helloVersion` controls the negotiated system.hello protocolVersion.
 */
function startFakeRpc(helloVersion) {
  return new Promise((resolve) => {
    const socketPath = join(CANON_TMP, `pix-fake-rpc-${Date.now()}-${Math.random().toString(36).slice(2)}.sock`);
    const server = createServer((socket) => {
      socket.setNoDelay(true);
      let authenticated = false;
      let buffered = "";
      socket.on("data", (chunk) => {
        buffered += chunk.toString("utf8");
        let nl;
        while ((nl = buffered.indexOf("\n")) >= 0) {
          const line = buffered.slice(0, nl);
          buffered = buffered.slice(nl + 1);
          if (!authenticated) {
            authenticated = line.startsWith("AUTH ");
            if (!authenticated) { socket.destroy(); return; }
            socket.write("OK\n");
            continue;
          }
          let request;
          try { request = JSON.parse(line); } catch { socket.destroy(); return; }
          const method = request && request.method;
          if (method === "system.hello") {
            socket.write(JSON.stringify({ id: request.id, ok: true, method, result: { protocolVersion: helloVersion, capabilities: ["runtime.authority", "runtime.resume"] } }) + "\n");
          } else if (method === "system.ping") {
            socket.write(JSON.stringify({ id: request.id, ok: true, method, result: { pong: true } }) + "\n");
          } else {
            socket.write(JSON.stringify({ id: request.id, ok: false, method, error: { code: "unsupported_capability", message: "unsupported", retryable: false } }) + "\n");
          }
        }
      });
    });
    server.listen(socketPath, () => resolve({ socketPath, server }));
  });
}

test("resolver: a pingable but protocol-v1 daemon degrades (stale daemon fail-closed)", async () => {
  const fake = await startFakeRpc(1);
  try {
    const logs = [];
    const resolver = createProductionCapabilityResolver({
      endpoint: fake.socketPath,
      secret: "s",
      logger: { warn: (msg) => logs.push(msg) },
    });
    // The daemon answers ping AND hello, but at the stale v1 version.
    assert.equal(await resolver.isAvailable(), true);
    assert.deepEqual(await resolver.resolve(), [...RESOURCE_DEGRADED_CAPABILITIES]);
    assert.equal(logs.length, 1, "one sanitized incompatible-version warning");
    assert.equal(String(logs[0]).includes(fake.socketPath), false);
  } finally {
    fake.server.close();
    rmSync(fake.socketPath, { force: true });
  }
});

test("resolver: a compatible protocol-v2 daemon advertises the full surface", async () => {
  const fake = await startFakeRpc(2);
  try {
    const resolver = createProductionCapabilityResolver({
      endpoint: fake.socketPath,
      secret: "s",
      logger: {},
    });
    assert.equal(await resolver.isAvailable(), true);
    assert.deepEqual(await resolver.resolve(), [...PRODUCTION_FULL_CAPABILITIES]);
  } finally {
    fake.server.close();
    rmSync(fake.socketPath, { force: true });
  }
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

// ---------------------------------------------------------------------------
// D3A managed-worktree production composition (shared lease)
// ---------------------------------------------------------------------------

const MANAGED_DOC = "managed-worktrees.json";
const HOST_LOCK = "trusted-roots.lock";

test("production composition: ONE shared lease backs both sidecars; managed close is a no-op; trusted close releases once", async () => {
  const root = temp("pix-prod-shared-");
  const hostDir = temp("pix-prod-shared-host-");
  const base = { allowedRootsEnv: root, cwd: root, endpoint: "unix:/nonexistent-prod-shared", secret: "s".repeat(48), hostDirEnv: hostDir };
  const first = await createProductionResources(base);
  assert.equal(first.trustedRootsLedger.hostDir, first.managedWorktreesLedger.hostDir, "both ledgers share ONE host dir");
  assert.equal(first.trustedRootsLedger.lockPath, first.managedWorktreesLedger.lockPath, "both ledgers share ONE lifetime lock");
  assert.ok(first.managedWorktrees, "managed service wired");
  assert.equal(first.deps.managedWorktrees, first.managedWorktrees, "ResourceDeps carries the managed service");

  // Second Host on the same host dir fails before listen (ONE lock held).
  await assert.rejects(
    () => createProductionResources(base),
    (e) => e instanceof InvalidHostDirError && e.message === "PIX_HOST_DIR rejected (LEDGER_LOCK_BUSY)",
  );
  // Managed-ledger close is a no-op (lease owner is the trusted ledger).
  await first.managedWorktreesLedger.close();
  await assert.rejects(
    () => createProductionResources(base),
    (e) => e instanceof InvalidHostDirError && e.message === "PIX_HOST_DIR rejected (LEDGER_LOCK_BUSY)",
    "managed close must NOT release the shared lease",
  );
  // Trusted-ledger close releases the shared lease exactly once.
  await first.trustedRootsLedger.close();
  const second = await createProductionResources(base);
  assert.ok(second.managedWorktrees, "restart wires the managed service again");
  await second.trustedRootsLedger.close();
});

test("production composition: corrupt managed sidecar fails before listen and stays immutable", async () => {
  const root = temp("pix-prod-corrupt-");
  const hostDir = temp("pix-prod-corrupt-host-");
  const managedPath = join(hostDir, MANAGED_DOC);
  writeFileSync(managedPath, "{not-json", { mode: 0o600 });
  const before = readFileSync(managedPath);
  const base = { allowedRootsEnv: root, cwd: root, endpoint: "unix:/nonexistent-prod-corrupt", secret: "s".repeat(48), hostDirEnv: hostDir };
  await assert.rejects(
    () => createProductionResources(base),
    (e) => e instanceof InvalidHostDirError && e.message === "PIX_HOST_DIR rejected (MANAGED_CORRUPT)",
  );
  assert.deepEqual(readFileSync(managedPath), before, "corrupt managed sidecar must stay byte-identical (immutable)");
  assert.equal(existsSync(join(hostDir, HOST_LOCK)), false, "no lifetime lock created for a corrupt managed sidecar (validateBeforeLock)");
});

test("production composition: missing managed sidecar stays ABSENT after boot + rehydrate", async () => {
  const root = temp("pix-prod-absent-");
  const hostDir = temp("pix-prod-absent-host-");
  const production = await createProductionResources({
    allowedRootsEnv: root, cwd: root, endpoint: "unix:/nonexistent-prod-absent", secret: "s".repeat(48), hostDirEnv: hostDir,
  });
  assert.equal(existsSync(join(hostDir, MANAGED_DOC)), false, "managed sidecar stays absent until the first managed create");
  const read = await production.managedWorktreesLedger.read();
  assert.equal(read.records.length, 0, "missing sidecar reads as empty");
  assert.equal(read.warning, "MANAGED_MISSING", "read reports the missing warning");
  assert.equal(production.managedWorktreesLedger.hostDir, hostDir, "managed ledger attached to the shared lease");
  await production.trustedRootsLedger.close();
});
