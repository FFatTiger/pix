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
import { readLocalSecret, UnsafeSecretError } from "./secret.js";
import { pingSessiond } from "./probe.js";
import { resolveSessiondBin } from "./paths.js";

const READINESS_TIMEOUT_MS = 10_000;
const SHUTDOWN_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 100;

export interface ShutdownOptions {
  /** Override the SIGTERM cleanup wait (default 10s). Useful for tests. */
  timeoutMs?: number;
}

export type ShutdownResult =
  | { action: "already-down"; pid: number | undefined }
  | { action: "obstructed"; pid: number | undefined; reason: string }
  | { action: "terminated"; pid: number }
  | { action: "failed"; pid: number; reason: "timeout" };

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
  const pingable = secret !== undefined ? await pingSessiond(endpoint, secret) : false;
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
 * Ensure a pingable sessiond is running for `directory`. Reuses an existing,
 * reachable instance; otherwise spawns a detached daemon and waits for it to
 * answer a ping. Never returns until the daemon is pingable or startup fails.
 */
export async function ensureSessiond(
  directory?: string,
  log: Logger = (): void => {},
): Promise<EnsureResult> {
  const { directory: dir, endpoint, paths } = locateSessiond(directory);
  const existing = await inspectSessiond(dir);
  if (existing.pingable) {
    log(`reusing sessiond (pid ${existing.pid}) at ${dir}`);
    return { directory: dir, endpoint, pid: existing.pid, instanceId: existing.instanceId, reused: true };
  }
  if (existing.obstructed) {
    // Fail closed: never spawn over a live listener without a lock, an unsafe
    // lock, or a live-but-unreachable pid.
    throw new Error(`[pix] cannot start sessiond: ${existing.obstruction ?? "sessiond state is unsafe"}`);
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
 * Stop the sessiond named by `directory`'s lock via SIGTERM, then wait until the
 * pid, lock file and socket are all cleared. Idempotent: a missing/stale lock is
 * a no-op returning "already-down". If the process does not clean up within the
 * timeout it returns `{ action: "failed", reason: "timeout" }` rather than
 * pretending success — a stuck authority must be visible to the operator.
 *
 * Fail-closed: an unsafe lock, a live listener without a lock, or a
 * live-but-unreachable pid is never SIGTERM'd — the daemon state is not safely
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
  try {
    process.kill(status.pid, "SIGTERM");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
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
