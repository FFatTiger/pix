import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import {
  instanceAlive,
  listPrivateSocketAliases,
  probeSocket,
  readInstanceLockStrict,
  resolveRuntimeDir,
  sessiondPaths,
  type InstanceLockRead,
  type SessiondPaths,
} from "@fffattiger/pix-sessiond/control";
import { SessiondRpcClient } from "@fffattiger/pix-sessiond/client";
import { SessiondError } from "@fffattiger/pix-sessiond";
import { readLocalSecret, UnsafeSecretError } from "./secret.js";
import {
  probeSessiondCompatibility,
  pingLegacyV1Sessiond,
  pingSessiond,
  shutdownLegacyV1Sessiond,
} from "./probe.js";
import { resolveSessiondBin } from "./paths.js";

const READINESS_TIMEOUT_MS = 10_000;
const SHUTDOWN_TIMEOUT_MS = 10_000;
const SHUTDOWN_RPC_TIMEOUT_MS = 5_000;
const POLL_INTERVAL_MS = 100;
const REVALIDATE_PING_TIMEOUT_MS = 1_000;
/** Bounded probe→reuse revalidation attempts (Phase 7A race fence). */
const MAX_ENSURE_ATTEMPTS = 2;

export interface ShutdownOptions {
  /** Override the bounded shutdown wait (default 10s). Useful for tests. */
  timeoutMs?: number;
}

export type ShutdownResult =
  | { action: "already-down"; pid: number | undefined }
  | { action: "obstructed"; pid: number | undefined; reason: string }
  | { action: "terminated"; pid: number }
  | { action: "failed"; pid: number; reason: string };

export interface SessiondLocation {
  directory: string;
  endpoint: string;
  paths: SessiondPaths;
}

export interface SessiondStatus {
  /** A lock file names a live pid. */
  alive: boolean;
  /** That live instance also answers an RPC ping. */
  pingable: boolean;
  /**
   * When true, a daemon must NOT be spawned for this directory: some live or
   * unsafe state blocks ownership (a live listener without a lock, an unsafe
   * lock, or a live-but-unreachable pid).
   */
  obstructed: boolean;
  /** Human-readable reason when {@link obstructed} is true. */
  obstruction: string | undefined;
  pid: number | undefined;
  instanceId: string | undefined;
  directory: string;
  endpoint: string;
}

export interface EnsureResult {
  directory: string;
  endpoint: string;
  pid: number | undefined;
  instanceId: string | undefined;
  reused: boolean;
}

export type Logger = (message: string) => void;

/** Resolve the sessiond location for a (possibly env-overridden) directory. */
export function locateSessiond(directory?: string): SessiondLocation {
  const dir = resolveRuntimeDir(directory);
  const paths = sessiondPaths(dir);
  return { directory: dir, endpoint: paths.endpoint, paths };
}

function pidAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Inspect a (possibly running) sessiond without side effects. Reuse decisions
 * must NOT rely on pid-aliveness alone: a recycled pid or a hung daemon would
 * look "alive" but be unusable, so reachability is confirmed by a real ping.
 * Fail-closed for spawn decisions: an unsafe lock, a live listener without a
 * lock, an unsafe secret file, or a live-but-unreachable pid marks the
 * directory as obstructed so callers never spawn a second daemon over it.
 */
export async function inspectSessiond(directory?: string): Promise<SessiondStatus> {
  const { directory: dir, endpoint, paths } = locateSessiond(directory);
  const lock: InstanceLockRead = await readInstanceLockStrict(paths);
  if (lock.kind === "unsafe") {
    // Never treat an unsafe lock as absent and never auto-remove it.
    return {
      alive: false,
      pingable: false,
      obstructed: true,
      obstruction: lock.reason,
      pid: undefined,
      instanceId: undefined,
      directory: dir,
      endpoint,
    };
  }
  if (lock.kind === "missing") {
    // No lock: a live public/private listener is an orphan that lost its lock;
    // spawning another daemon would create a second authority over it.
    if (await anyLiveSocket(paths)) {
      return {
        alive: false,
        pingable: false,
        obstructed: true,
        obstruction: "a live sessiond socket exists without an instance lock",
        pid: undefined,
        instanceId: undefined,
        directory: dir,
        endpoint,
      };
    }
    return { alive: false, pingable: false, obstructed: false, obstruction: undefined, pid: undefined, instanceId: undefined, directory: dir, endpoint };
  }
  const alive = pidAlive(lock.record.pid);
  if (!alive) {
    return {
      alive: false,
      pingable: false,
      obstructed: false,
      obstruction: undefined,
      pid: lock.record.pid,
      instanceId: lock.record.instanceId,
      directory: dir,
      endpoint,
    };
  }
  // An unsafe secret (symlink / non-regular / too-short) means this live pid
  // cannot be confirmed as ours: classify as obstructed with a fixed reason
  // instead of letting the read error escape to the CLI as a stack trace.
  let secret: string | undefined;
  try {
    secret = await readLocalSecret(paths.secretFile);
  } catch (error) {
    if (!(error instanceof UnsafeSecretError)) throw error;
    return {
      alive: true,
      pingable: false,
      obstructed: true,
      obstruction: "sessiond secret file is unsafe",
      pid: lock.record.pid,
      instanceId: lock.record.instanceId,
      directory: dir,
      endpoint,
    };
  }
  const pingable = secret !== undefined
    ? (await pingSessiond(endpoint, secret)) || (await pingLegacyV1Sessiond(endpoint, secret))
    : false;
  // A live pid that is unreachable is authoritative until it dies or is
  // explicitly downed: never spawn a replacement over it.
  return {
    alive: true,
    pingable,
    obstructed: !pingable,
    obstruction: !pingable ? "sessiond pid is alive but not reachable" : undefined,
    pid: lock.record.pid,
    instanceId: lock.record.instanceId,
    directory: dir,
    endpoint,
  };
}

/** True when any Pix-named Unix socket in the directory answers a connect. */
async function anyLiveSocket(paths: SessiondPaths): Promise<boolean> {
  if ((await probeSocket(paths.endpoint)) === "live") return true;
  for (const alias of await listPrivateSocketAliases(paths.directory)) {
    if ((await probeSocket(alias)) === "live") return true;
  }
  return false;
}

/**
 * Detached, unref'd spawn of the foreground `pix-sessiond` bin so the daemon
 * survives the supervisor (host) process exiting. `stdio: "ignore"` +
 * `windowsHide` keep it headless; `unref()` ensures the supervisor's event loop
 * is not kept alive by the child handle.
 */
export function spawnSessiond(directory: string): ChildProcess {
  const bin = resolveSessiondBin();
  const child = spawn(process.execPath, [bin], {
    env: { ...process.env, PIX_SESSIOND_DIR: directory },
    stdio: "ignore",
    detached: true,
    windowsHide: true,
  });
  child.unref();
  return child;
}

interface ReadinessOutcome {
  ok: boolean;
  error: Error | undefined;
}

/**
 * Poll a freshly-spawned daemon until it answers a ping. Detects early child
 * exit (so a crash-on-start is reported immediately, not after the full
 * timeout) and enforces a hard {@link READINESS_TIMEOUT_MS} ceiling.
 */
async function waitForReadiness(paths: SessiondPaths, child: ChildProcess): Promise<ReadinessOutcome> {
  const deadline = Date.now() + READINESS_TIMEOUT_MS;
  let exitCode: number | null = null;
  child.once("exit", (code) => {
    exitCode = code ?? -1;
  });
  while (Date.now() < deadline) {
    if (exitCode !== null) {
      return {
        ok: false,
        error: new Error(`sessiond exited early (code ${exitCode}) before becoming ready`),
      };
    }
    // A transient FS error (e.g. mid-bootstrap) must not abort readiness; treat
    // it as "not ready yet" and rely on exit detection + the hard timeout.
    let secret: string | undefined;
    try {
      secret = await readLocalSecret(paths.secretFile);
    } catch {
      secret = undefined;
    }
    if (secret !== undefined && (await pingSessiond(paths.endpoint, secret, 1_000))) {
      return { ok: true, error: undefined };
    }
    await sleep(POLL_INTERVAL_MS);
  }
  return { ok: false, error: new Error(`sessiond did not become ready within ${READINESS_TIMEOUT_MS}ms`) };
}

/**
 * Fixed operator instruction when a running sessiond's protocol version cannot
 * be positively verified (transient hello timeout, auth failure, malformed or
 * unparseable response, secret unreadable). The daemon is ALWAYS preserved — an
 * unverified daemon is never shut down or replaced on a guess. Never echoes the
 * endpoint, pid, instance id or raw error.
 */
const UNVERIFIABLE_INSTRUCTION =
  "[pix] could not verify the running sessiond's protocol version; it was left untouched. Wait a moment and run `pix start` again, or stop it with `pix down --all` if it is genuinely stale";

/**
 * Fixed operator instruction when a stale (protocol-v1) sessiond cannot be
 * safely replaced. Ordinary start/ensure never auto-stops it. The only CLI
 * stop path is the explicit `pix down --all` command, which ends sessions and
 * must be a deliberate maintenance action. Never echoes the endpoint, pid,
 * instance id or raw error.
 */
const STALE_DAEMON_INSTRUCTION =
  "[pix] a sessiond with an incompatible protocol version is running and was left untouched; `pix down --all` is the explicit maintenance stop and will end sessions, then run `pix start` again";

/**
 * Fixed operator instruction when a running sessiond FAILS the explicit Phase
 * 7A build compatibility matrix (missing/old/mismatched build identity — the
 * same protocol major alone never proves implementation compatibility) and
 * could not be safely replaced via the authenticated, instance-fenced
 * shutdown path. Never echoes the endpoint, pid, instance id, build values, or
 * raw error.
 */
const STALE_BUILD_INSTRUCTION =
  "[pix] the running sessiond is a different, incompatible pix build and was left untouched; `pix down --all` is the explicit maintenance stop and will end sessions, then update the pix installation so all pix dists come from the same build and run `pix start` again";

/**
 * Fixed operator instruction when the probe→reuse decision could not be
 * revalidated: the daemon observed by the compatibility probe is not provably
 * the exact instance that owns the directory at commit time (it was replaced
 * or exited mid-probe on every bounded attempt). Nothing is ever spawned or
 * destroyed on a guess.
 */
const PROBE_REUSE_RACE_INSTRUCTION =
  "[pix] the running sessiond changed while its build was being verified; it was left untouched. Run `pix start` again";

/**
 * Revalidate the probe→reuse decision (Phase 7A race fence): the EXACT
 * instance the compatibility probe authenticated (pid + instanceId) must still
 * own the lock and still answer a bounded authenticated ping at commit time.
 * Deterministic and never throws: `false` means the observed instance is not
 * provably current — the caller must re-decide (bounded) or fail closed; it
 * must NEVER reuse or spawn over the directory on that guess.
 */
export async function revalidateSessiondInstance(
  paths: SessiondPaths,
  observed: { pid: number | undefined; instanceId: string | undefined },
  secret: string,
): Promise<boolean> {
  if (observed.pid === undefined || observed.instanceId === undefined) return false;
  const lock = await readInstanceLockStrict(paths);
  if (lock.kind !== "ok") return false;
  if (lock.record.pid !== observed.pid || lock.record.instanceId !== observed.instanceId) return false;
  if (!pidAlive(lock.record.pid)) return false;
  return pingSessiond(paths.endpoint, secret, REVALIDATE_PING_TIMEOUT_MS);
}

/**
 * Ensure a pingable sessiond is running for `directory`. Reuses an existing,
 * reachable instance ONLY when it is POSITIVELY authenticated AND passes the
 * explicit Phase 7A build compatibility matrix (product, protocol, sessiond /
 * Worker / adapter contract generations, and the deterministic capability
 * fingerprint — the same protocol major is NEVER sufficient to reuse).
 *
 * Compatibility is classified into explicit states ({@link probeSessiondCompatibility}):
 *  - `current` ⇒ reuse as-is, but only after the probe→reuse decision is
 *    REVALIDATED against the exact lock instance (bounded race fence: a daemon
 *    replaced between probe and commit is never silently reused; at most
 *    {@link MAX_ENSURE_ATTEMPTS} bounded re-decisions, then a fixed operator
 *    error — never a spawn over unverifiable state).
 *  - `staleBuild` (current protocol, missing/failing build identity) and
 *    `knownLegacy` (positively authenticated protocol v1) ⇒ ordinary start/
 *    ensure MUST leave the live incompatible daemon intact (busy or idle;
 *    occupancy is never guessed from a client snapshot) and fail closed with
 *    the fixed operator instruction. There is no auto-maintenance/quiescent
 *    replacement API in this path. Explicit `shutdownSessiond` / `pix down
 *    --all` remain the authorized lifecycle methods.
 *  - `unverifiable` (transient hello timeout, auth failure, malformed or
 *    unparseable response — including a malformed build block — or secret
 *    unreadable) ⇒ the running daemon is PRESERVED and a retryable/fixed
 *    operator error is returned — authority is never destroyed on a guess.
 */
export async function ensureSessiond(
  directory?: string,
  log: Logger = (): void => {},
): Promise<EnsureResult> {
  const { directory: dir, endpoint, paths } = locateSessiond(directory);
  let spawnFresh = false;
  for (let attempt = 1; ; attempt += 1) {
    const existing = await inspectSessiond(dir);
    if (existing.pingable) {
      // Re-read the secret strictly. A missing or unsafe secret means we cannot
      // authenticate the running daemon: it is unverifiable and MUST be preserved
      // (a secret-read failure must never destroy authority).
      let secret: string | undefined;
      try {
        secret = await readLocalSecret(paths.secretFile);
      } catch (error) {
        if (error instanceof UnsafeSecretError) {
          throw new Error(UNVERIFIABLE_INSTRUCTION);
        }
        throw error;
      }
      if (secret === undefined) {
        throw new Error(UNVERIFIABLE_INSTRUCTION);
      }
      // Classify the daemon explicitly. Reuse only a positively authenticated,
      // protocol-CURRENT, BUILD-COMPATIBLE daemon.
      const compat = await probeSessiondCompatibility(endpoint, secret);
      if (compat.state === "current") {
        // Probe→reuse race fence: the exact authenticated instance must still
        // own the directory when we commit to reuse. A daemon replaced or lost
        // mid-probe triggers a bounded re-decision, never a silent reuse.
        const stillOwned = await revalidateSessiondInstance(
          paths,
          { pid: existing.pid, instanceId: existing.instanceId },
          secret,
        );
        if (stillOwned) {
          log(`reusing sessiond (pid ${existing.pid}) at ${dir}`);
          return { directory: dir, endpoint, pid: existing.pid, instanceId: existing.instanceId, reused: true };
        }
        if (attempt >= MAX_ENSURE_ATTEMPTS) {
          throw new Error(PROBE_REUSE_RACE_INSTRUCTION);
        }
        continue;
      }
      if (compat.state === "unverifiable") {
        // Transient hello timeout / auth failure / malformed or unparseable
        // response: preserve the running daemon and return a fixed operator
        // error — never shut it down on a guess.
        throw new Error(UNVERIFIABLE_INSTRUCTION);
      }
      // staleBuild / knownLegacy: a positively authenticated live daemon this
      // build must not silently reuse AND must not be auto-replaced. Ordinary
      // start/ensure leaves it intact even when it appears idle — occupancy is
      // not a client-side guess, and this slice has no auto-maintenance fence.
      throw new Error(compat.state === "staleBuild" ? STALE_BUILD_INSTRUCTION : STALE_DAEMON_INSTRUCTION);
    } else if (existing.obstructed) {
      // Fail closed: never spawn over a live listener without a lock, an unsafe
      // lock, or a live-but-unreachable pid.
      throw new Error(`[pix] cannot start sessiond: ${existing.obstruction ?? "sessiond state is unsafe"}`);
    } else {
      spawnFresh = true;
    }
    break;
  }
  if (!spawnFresh) {
    // Unreachable: every loop iteration either returns, throws, or sets spawnFresh.
    throw new Error(PROBE_REUSE_RACE_INSTRUCTION);
  }
  log(`starting sessiond at ${dir}`);
  const child = spawnSessiond(dir);
  const readiness = await waitForReadiness(paths, child);
  if (!readiness.ok) {
    throw readiness.error ?? new Error("[pix] sessiond did not become ready");
  }
  const lock = await readInstanceLockStrict(paths);
  const record = lock.kind === "ok" ? lock.record : undefined;
  log(`sessiond ready (pid ${record?.pid}) at ${dir}`);
  return { directory: dir, endpoint, pid: record?.pid, instanceId: record?.instanceId, reused: false };
}

/**
 * Stop the sessiond named by `directory`'s lock via its authenticated RPC
 * control method (`system.shutdown`), then wait boundedly until the pid, lock
 * file and socket are all cleared. Idempotent: a missing/stale lock is a no-op
 * returning "already-down".
 *
 * RPC-only production authority (no SIGTERM/PID fallback): the AUTH secret and
 * the exact lock instance identity are read from the local secure state, the
 * request is authenticated and instance-fenced by the daemon, and the daemon
 * ACKs the response to the client BEFORE beginning its shutdown transition. The
 * pid is used only as a final observation that the authenticated instance
 * exited — never to signal/kill. Any wrong secret / wrong instance / unsupported
 * / timeout / connection failure returns a sanitized failure and leaves the
 * target process untouched (old daemons without the control method are not
 * killable via a fallback).
 *
 * Fail-closed: an unsafe lock, a live listener without a lock, or a
 * live-but-unreachable pid is never touched — the daemon state is not safely
 * owned, so the caller is told it is obstructed instead of being reported as
 * already-down (which would hide a live authority from the operator).
 */
export async function shutdownSessiond(
  directory?: string,
  options: ShutdownOptions = {},
): Promise<ShutdownResult> {
  const { paths } = locateSessiond(directory);
  const status = await inspectSessiond(directory);
  if (status.obstructed) {
    return {
      action: "obstructed",
      pid: status.pid,
      reason: status.obstruction ?? "sessiond state is unsafe",
    };
  }
  if (status.pid === undefined || !status.alive) {
    return { action: "already-down", pid: status.pid };
  }
  // The exact authenticated instance identity comes from the strict lock read;
  // without it we can never authorize a shutdown of this instance.
  if (status.instanceId === undefined) {
    return { action: "failed", pid: status.pid, reason: "sessiond instance identity is unknown" };
  }
  // The AUTH secret is mandatory and read strictly (never created). A missing
  // or unsafe secret means we cannot authenticate and must fail closed.
  let secret: string | undefined;
  try {
    secret = await readLocalSecret(paths.secretFile);
  } catch (error) {
    if (error instanceof UnsafeSecretError) {
      return { action: "failed", pid: status.pid, reason: "sessiond secret is unsafe" };
    }
    throw error;
  }
  if (secret === undefined) {
    return { action: "failed", pid: status.pid, reason: "sessiond secret is unavailable" };
  }
  // Authenticate + instance-fence, then call system.shutdown with the exact
  // instance id. The daemon ACKs the response before it begins to shut down, so
  // a successful call means the transition was authorized and accepted.
  const rpcTimeoutMs = options.timeoutMs ?? SHUTDOWN_RPC_TIMEOUT_MS;
  const client = new SessiondRpcClient({ endpoint: paths.endpoint, secret, timeoutMs: rpcTimeoutMs });
  let accepted = false;
  let currentFailure: unknown;
  try {
    const result = await client.call("system.shutdown", { instanceId: status.instanceId });
    accepted = result.accepted === true;
  } catch (error) {
    currentFailure = error;
  }
  if (!accepted) {
    // Coordinated v1→v2 rollout: a current client cannot schema-parse a v1
    // control response. Retry exactly once with the narrow legacy envelope,
    // still authenticated and fenced by the SAME strict-lock instance id.
    accepted = await shutdownLegacyV1Sessiond(
      paths.endpoint,
      secret,
      status.instanceId,
      rpcTimeoutMs,
    );
  }
  if (!accepted) {
    // Never echo the secret, endpoint, instance id, or a raw error/stack.
    return {
      action: "failed",
      pid: status.pid,
      reason: currentFailure === undefined
        ? "sessiond did not accept shutdown"
        : sanitizeShutdownFailure(currentFailure),
    };
  }
  // Wait boundedly for the authenticated instance to exit: the owned socket and
  // lock disappear and the pid (final observation only) dies.
  const deadline = Date.now() + (options.timeoutMs ?? SHUTDOWN_TIMEOUT_MS);
  while (Date.now() < deadline) {
    // instanceAlive reads the lock each poll; once the daemon releases it the
    // lock file is gone and instanceAlive returns false.
    if (!(await instanceAlive(paths)) && !existsSync(paths.endpoint)) {
      return { action: "terminated", pid: status.pid };
    }
    await sleep(50);
  }
  return { action: "failed", pid: status.pid, reason: "timeout" };
}

/** Map an RPC shutdown failure onto a fixed sanitized reason (never secret/endpoint/instance/stack). */
function sanitizeShutdownFailure(error: unknown): string {
  if (error instanceof SessiondError) {
    switch (error.code) {
      case "unauthorized": return "sessiond refused shutdown (unauthorized)";
      case "forbidden": return "sessiond refused shutdown (instance mismatch)";
      case "unsupported_capability": return "sessiond does not support remote shutdown";
      case "timeout": return "timeout waiting for sessiond shutdown response";
      case "invalid_request": return "sessiond rejected the shutdown request";
      default: return "sessiond refused shutdown";
    }
  }
  return "sessiond refused shutdown";
}
