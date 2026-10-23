/**
 * Background Host lifecycle for `pix start --detach` / `stop` / `restart` /
 * `status` / `logs`.
 *
 * The Host is the thin web layer; sessiond (the session authority) is managed
 * separately by `supervise.ts`. A background Host is a detached
 * `pix host --no-open` child whose stdout/stderr go to a log file. The CLI
 * keeps one runtime record per CLI state directory (`host.json`, 0600) with
 * the pid, bind address and log path so later commands can find it.
 *
 * Identity before any signal: a recorded pid is only treated as "our Host"
 * when it is alive AND the Host-dir lifetime lock (written by the Host itself)
 * names the same pid. A recycled pid that is not the lock holder is never
 * signalled. Health (`GET /v1/health` → `service: "pix-host"`) separates a
 * serving Host from a hung one.
 *
 * The record lives in the CLI's own directory, never in the Host dir: the
 * Host dir lease rejects unrecognized entries.
 */
import { spawn, type ChildProcess } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { resolvePixHostDir } from "@fffattiger/pix-host";
import type { BindOptions } from "./args.js";
import { resolveCliPackageRoot } from "./paths.js";

/** Environment variable overriding the CLI state directory. */
export const CLI_DIR_ENV = "PIX_CLI_DIR";
const RECORD_FILE = "host.json";
const LOG_FILE = "host.log";
/** The Host-dir lifetime lock written by the Host (pid + instanceId). */
const HOST_LOCK_FILE = "trusted-roots.lock";
/** Rotate the log to `host.log.1` at start once it passes this size. */
const LOG_ROTATE_BYTES = 10 * 1024 * 1024;

const READY_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 10_000;
const KILL_TIMEOUT_MS = 3_000;
const POLL_MS = 200;
const HEALTH_TIMEOUT_MS = 1_500;

export interface HostRecord {
  pid: number;
  hostname: string;
  port: number;
  url: string;
  logFile: string;
  startedAt: number;
}

export type HostState =
  | { kind: "not-running" }
  /** A record whose pid is gone (crash / reboot); safe to discard. */
  | { kind: "stale"; record: HostRecord }
  /** Alive, lock-verified and answering health. */
  | { kind: "running"; record: HostRecord }
  /** Alive and lock-verified but not answering health (hung / starting). */
  | { kind: "unresponsive"; record: HostRecord }
  /** Pid alive but not the Host-dir lock holder: never signalled. */
  | { kind: "unverified"; record: HostRecord; reason: string }
  /** The record itself is unreadable / malformed. */
  | { kind: "corrupt"; path: string };

/** Injectable side effects (tests). */
export interface HostDaemonDeps {
  env: NodeJS.ProcessEnv;
  isPidAlive: (pid: number) => boolean;
  kill: (pid: number, signal: NodeJS.Signals) => void;
  fetchHealth: (url: string) => Promise<boolean>;
  /** argv (after the node executable) of the background Host child. */
  hostArgv: (options: BindOptions) => string[];
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the pid exists but belongs to another user.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function defaultFetchHealth(url: string): Promise<boolean> {
  try {
    const response = await fetch(new URL("/v1/health", url), {
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
      redirect: "manual",
    });
    if (!response.ok) return false;
    const body = (await response.json()) as { service?: unknown };
    return body.service === "pix-host";
  } catch {
    return false;
  }
}

function defaultHostArgv(options: BindOptions): string[] {
  return [
    join(resolveCliPackageRoot(), "bin", "pix.mjs"),
    "host",
    "--hostname",
    options.hostname,
    "--port",
    String(options.port),
    "--no-open",
  ];
}

export function defaultHostDaemonDeps(): HostDaemonDeps {
  return {
    env: process.env,
    isPidAlive: defaultIsPidAlive,
    kill: (pid, signal) => process.kill(pid, signal),
    fetchHealth: defaultFetchHealth,
    hostArgv: defaultHostArgv,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
  };
}

/** CLI state directory: `PIX_CLI_DIR` (absolute) or `~/.pi/pix/cli`. */
export function resolveCliDir(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env[CLI_DIR_ENV];
  if (raw !== undefined) {
    if (raw === "" || raw.includes("\0") || !isAbsolute(raw)) {
      throw new Error(`${CLI_DIR_ENV} must be a non-empty absolute path`);
    }
    return raw;
  }
  return join(homedir(), ".pi", "pix", "cli");
}

export function hostLogPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveCliDir(env), LOG_FILE);
}

/** Browser-facing URL for a bind address (wildcards are reached via loopback). */
export function hostUrl(hostname: string, port: number): string {
  const reachable = hostname === "0.0.0.0" ? "127.0.0.1" : hostname === "::" || hostname === "[::]" ? "::1" : hostname;
  const authority = reachable.includes(":") && !reachable.startsWith("[") ? `[${reachable}]` : reachable;
  return `http://${authority}:${port}`;
}

function ensureCliDir(env: NodeJS.ProcessEnv): string {
  const dir = resolveCliDir(env);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function isRecord(value: unknown): value is HostRecord {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    Number.isInteger(v.pid) && (v.pid as number) > 0 &&
    typeof v.hostname === "string" && v.hostname.length > 0 &&
    Number.isInteger(v.port) && (v.port as number) > 0 && (v.port as number) <= 65535 &&
    typeof v.url === "string" && v.url.length > 0 &&
    typeof v.logFile === "string" && v.logFile.length > 0 &&
    typeof v.startedAt === "number"
  );
}

type RecordRead = { kind: "missing" } | { kind: "corrupt"; path: string } | { kind: "ok"; record: HostRecord };

export function readHostRecord(env: NodeJS.ProcessEnv = process.env): RecordRead {
  const path = join(resolveCliDir(env), RECORD_FILE);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
    return { kind: "corrupt", path };
  }
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? { kind: "ok", record: parsed } : { kind: "corrupt", path };
  } catch {
    return { kind: "corrupt", path };
  }
}

/** Atomic 0600 write (temp + rename in the same directory). */
function writeHostRecord(record: HostRecord, env: NodeJS.ProcessEnv): void {
  const dir = ensureCliDir(env);
  const path = join(dir, RECORD_FILE);
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  renameSync(temp, path);
}

export function clearHostRecord(env: NodeJS.ProcessEnv = process.env): void {
  rmSync(join(resolveCliDir(env), RECORD_FILE), { force: true });
}

/** Pid recorded in the Host-dir lifetime lock, or undefined when absent/unreadable. */
function readHostLockPid(env: NodeJS.ProcessEnv): number | undefined {
  try {
    const lockPath = join(resolvePixHostDir(env.PIX_HOST_DIR), HOST_LOCK_FILE);
    const parsed = JSON.parse(readFileSync(lockPath, "utf8")) as { pid?: unknown };
    return Number.isInteger(parsed.pid) ? (parsed.pid as number) : undefined;
  } catch {
    return undefined;
  }
}

/** Classify the recorded background Host (see {@link HostState}). */
export async function inspectHost(deps: HostDaemonDeps = defaultHostDaemonDeps()): Promise<HostState> {
  const read = readHostRecord(deps.env);
  if (read.kind === "missing") return { kind: "not-running" };
  if (read.kind === "corrupt") return { kind: "corrupt", path: read.path };
  const { record } = read;
  if (!deps.isPidAlive(record.pid)) return { kind: "stale", record };
  const lockPid = readHostLockPid(deps.env);
  if (lockPid !== record.pid) {
    return {
      kind: "unverified",
      record,
      reason: lockPid === undefined
        ? "the Host-dir lock is missing"
        : `the Host-dir lock is held by pid ${lockPid}`,
    };
  }
  return (await deps.fetchHealth(record.url)) ? { kind: "running", record } : { kind: "unresponsive", record };
}

function rotateLog(logFile: string): void {
  try {
    if (statSync(logFile).size >= LOG_ROTATE_BYTES) renameSync(logFile, `${logFile}.1`);
  } catch {
    // no log yet
  }
}

/** Last `lines` lines of a text file ("" when absent). */
export function tailFile(path: string, lines: number): string {
  if (!existsSync(path)) return "";
  const text = readFileSync(path, "utf8");
  const all = text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n");
  return all.slice(Math.max(0, all.length - lines)).join("\n");
}

export type StartHostResult =
  | { action: "started"; record: HostRecord }
  | { action: "already-running"; record: HostRecord }
  /** `logFile` is set when its tail explains the failure. */
  | { action: "failed"; reason: string; logFile?: string };

/**
 * Start the Host in the background (sessiond must already be pingable).
 * Resolves once the child holds the Host-dir lock and answers health, or
 * fails with the child's exit / timeout — a child that never became healthy
 * is terminated, never left running behind a failure. The record is written
 * as soon as the child exists, so a launcher interrupted during the wait
 * leaves a Host that `pix stop` / `pix status` can still find.
 */
export async function startHostBackground(
  options: BindOptions,
  deps: HostDaemonDeps = defaultHostDaemonDeps(),
): Promise<StartHostResult> {
  const url = hostUrl(options.hostname, options.port);
  const state = await inspectHost(deps);
  if (state.kind === "running") {
    if (state.record.hostname === options.hostname && state.record.port === options.port) {
      return { action: "already-running", record: state.record };
    }
    return {
      action: "failed",
      reason: `a background host is already running at ${state.record.url}; `
        + `move it with \`pix restart --hostname ${options.hostname} --port ${options.port}\``,
    };
  }
  if (state.kind === "unresponsive") {
    return {
      action: "failed",
      reason: `a background host (pid ${state.record.pid}) is running but not responding; run \`pix stop\` first`,
      logFile: state.record.logFile,
    };
  }
  // stale / corrupt / unverified: the record does not describe a live Host of
  // ours (an unverified pid is not the Host-dir lock holder — e.g. a recycled
  // pid), so it is discarded. A different Host that really holds the lock
  // makes the new child fail with its own lock error, reported from the log.
  if (state.kind !== "not-running") clearHostRecord(deps.env);
  // With no live record of ours, a pix host already answering here is a
  // foreground `pix start` or another instance; a child would only die on
  // the port or the lock.
  if (await deps.fetchHealth(url)) {
    return {
      action: "failed",
      reason: `${url} is already served by a pix host not started with --detach `
        + "(a foreground `pix start` or another instance); stop it or use another --port",
    };
  }

  const dir = ensureCliDir(deps.env);
  const logFile = join(dir, LOG_FILE);
  rotateLog(logFile);
  const fd = openSync(logFile, "a", 0o600);
  let child: ChildProcess;
  try {
    child = spawn(process.execPath, deps.hostArgv(options), {
      env: deps.env,
      stdio: ["ignore", fd, fd],
      detached: true,
      windowsHide: true,
    });
  } finally {
    closeSync(fd);
  }
  let exited: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  let spawnError: Error | undefined;
  child.once("exit", (code, signal) => {
    exited = { code, signal };
  });
  child.once("error", (error) => {
    spawnError = error;
  });
  child.unref();

  const record: HostRecord | undefined = child.pid === undefined ? undefined : {
    pid: child.pid,
    hostname: options.hostname,
    port: options.port,
    url,
    logFile,
    startedAt: deps.now(),
  };
  if (record !== undefined) writeHostRecord(record, deps.env);
  const fail = (reason: string): StartHostResult => {
    clearHostRecord(deps.env);
    return { action: "failed", reason, logFile };
  };
  const deadline = deps.now() + READY_TIMEOUT_MS;
  while (true) {
    if (spawnError !== undefined) return fail(`could not spawn the host: ${spawnError.message}`);
    if (exited !== undefined) {
      return fail(`host exited before becoming ready (${exited.signal ?? `code ${exited.code}`})`);
    }
    // Ready = the child holds the Host-dir lock AND answers health: health
    // alone may come from a Host that started serving this port after the
    // check above while the child dies on the lock.
    // ponytail: a Host with ANOTHER PIX_HOST_DIR that starts serving this port inside the
    // child's lock-then-listen window still passes; closing it needs an identity in /v1/health.
    if (record !== undefined && readHostLockPid(deps.env) === record.pid && (await deps.fetchHealth(url))) {
      return { action: "started", record };
    }
    if (deps.now() >= deadline) {
      if (record !== undefined) {
        try {
          deps.kill(record.pid, "SIGTERM");
        } catch {
          // already gone
        }
      }
      return fail(`host did not become ready within ${READY_TIMEOUT_MS / 1000}s`);
    }
    await deps.sleep(POLL_MS);
  }
}

export type StopHostResult =
  | { action: "not-running" }
  | { action: "stopped"; pid: number; forced: boolean }
  | { action: "refused"; reason: string }
  | { action: "failed"; pid: number; reason: string };

async function waitForExit(pid: number, timeoutMs: number, deps: HostDaemonDeps): Promise<boolean> {
  const deadline = deps.now() + timeoutMs;
  while (deps.isPidAlive(pid)) {
    if (deps.now() >= deadline) return false;
    await deps.sleep(POLL_MS);
  }
  return true;
}

/**
 * Stop the recorded background Host: SIGTERM (the Host closes and releases
 * its Host-dir lock; sessiond keeps running), escalating to SIGKILL only after
 * a bounded wait. Only a lock-verified pid is ever signalled.
 */
export async function stopHostBackground(deps: HostDaemonDeps = defaultHostDaemonDeps()): Promise<StopHostResult> {
  const state = await inspectHost(deps);
  switch (state.kind) {
    case "not-running":
      return { action: "not-running" };
    case "stale":
    case "corrupt":
      clearHostRecord(deps.env);
      return { action: "not-running" };
    case "unverified":
      // Not our Host (the lock does not name it): never signal it, and drop
      // the record so it cannot be mistaken for one later.
      clearHostRecord(deps.env);
      return {
        action: "refused",
        reason: `recorded pid ${state.record.pid} is alive but ${state.reason}; not signalling it (record cleared)`,
      };
    case "running":
    case "unresponsive":
      break;
  }
  const { pid } = state.record;
  try {
    deps.kill(pid, "SIGTERM");
  } catch (error) {
    if (deps.isPidAlive(pid)) {
      return { action: "failed", pid, reason: (error as Error).message };
    }
  }
  let forced = false;
  if (!(await waitForExit(pid, STOP_TIMEOUT_MS, deps))) {
    forced = true;
    try {
      deps.kill(pid, "SIGKILL");
    } catch {
      // raced with exit
    }
    if (!(await waitForExit(pid, KILL_TIMEOUT_MS, deps))) {
      return { action: "failed", pid, reason: "host did not exit after SIGKILL" };
    }
  }
  clearHostRecord(deps.env);
  return { action: "stopped", pid, forced };
}
