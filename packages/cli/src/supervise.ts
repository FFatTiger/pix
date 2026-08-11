import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import {
  instanceAlive,
  readInstanceLock,
  resolveRuntimeDir,
  sessiondPaths,
  type InstanceLockRecord,
  type SessiondPaths,
} from "@fffattiger/pix-sessiond/control";
import { readLocalSecret } from "./secret.js";
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
 */
export async function inspectSessiond(directory?: string): Promise<SessiondStatus> {
  const { directory: dir, endpoint, paths } = locateSessiond(directory);
  const lock: InstanceLockRecord | undefined = await readInstanceLock(paths);
  if (lock === undefined) {
    return { alive: false, pingable: false, pid: undefined, instanceId: undefined, directory: dir, endpoint };
  }
  const alive = pidAlive(lock.pid);
  if (!alive) {
    return { alive: false, pingable: false, pid: lock.pid, instanceId: lock.instanceId, directory: dir, endpoint };
  }
  const secret = await readLocalSecret(paths.secretFile);
  const pingable = secret !== undefined ? await pingSessiond(endpoint, secret) : false;
  return { alive: true, pingable, pid: lock.pid, instanceId: lock.instanceId, directory: dir, endpoint };
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
  log(`starting sessiond at ${dir}`);
  const child = spawnSessiond(dir);
  const readiness = await waitForReadiness(paths, child);
  if (!readiness.ok) {
    throw readiness.error ?? new Error("[pix] sessiond did not become ready");
  }
  const lock = await readInstanceLock(paths);
  log(`sessiond ready (pid ${lock?.pid}) at ${dir}`);
  return { directory: dir, endpoint, pid: lock?.pid, instanceId: lock?.instanceId, reused: false };
}

/**
 * Stop the sessiond named by `directory`'s lock via SIGTERM, then wait until the
 * pid, lock file and socket are all cleared. Idempotent: a missing/stale lock is
 * a no-op returning "already-down". If the process does not clean up within the
 * timeout it returns `{ action: "failed", reason: "timeout" }` rather than
 * pretending success — a stuck authority must be visible to the operator.
 */
export async function shutdownSessiond(
  directory?: string,
  options: ShutdownOptions = {},
): Promise<ShutdownResult> {
  const { paths } = locateSessiond(directory);
  const lock = await readInstanceLock(paths);
  if (lock === undefined || !pidAlive(lock.pid)) {
    return { action: "already-down", pid: lock?.pid };
  }
  try {
    process.kill(lock.pid, "SIGTERM");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
  const deadline = Date.now() + (options.timeoutMs ?? SHUTDOWN_TIMEOUT_MS);
  while (Date.now() < deadline) {
    // instanceAlive reads the lock each poll; once the daemon releases it the
    // lock file is gone and instanceAlive returns false.
    if (!(await instanceAlive(paths)) && !existsSync(paths.endpoint)) {
      return { action: "terminated", pid: lock.pid };
    }
    await sleep(50);
  }
  return { action: "failed", pid: lock.pid, reason: "timeout" };
}
