import { spawn } from "node:child_process";
import { resolvePixHostDir } from "@fffattiger/pix-host";
import {
  inspectSecureStateBackend,
  readLastStartRecord,
  unixSocketPathBudgetBytes,
  type LastStartRead,
} from "@fffattiger/pix-sessiond/control";
import { pixErr, pixLog } from "../log.js";
import { inspectSessiond, type SessiondStatus } from "../supervise.js";

export const DOCTOR_SCHEMA_VERSION = 1 as const;
const GIT_TIMEOUT_MS = 2_000;
const SECURE_CONTEXT_GUIDANCE =
  "Web UI is ordinary on localhost or HTTPS. HTTP LAN is insecure-origin and not an installable PWA.";

export type DoctorBackendKind = "windows" | "posix" | "unavailable";
export type DoctorSessiondState = "running" | "not-running" | "stale-lock" | "obstructed";
export type DoctorEndpointKind = "named-pipe" | "unix-socket";

export interface DoctorReport {
  schemaVersion: typeof DOCTOR_SCHEMA_VERSION;
  os: string;
  arch: string;
  node: string;
  engines: string;
  backendKind: DoctorBackendKind;
  sessiondDirectory: string;
  hostDirectory: string;
  endpointKind: DoctorEndpointKind;
  endpoint: string;
  pathBudgetBytes: number | null;
  gitVersion: string | null;
  sessiond: {
    state: DoctorSessiondState;
    pingable: boolean;
    pid: number | null;
    obstruction: string | null;
  };
  lastStart: {
    state: "ok" | "failed" | "missing" | "corrupt";
    code: string | null;
    message: string | null;
  };
  secureContext: string;
}

export interface DoctorCollectors {
  platform?: NodeJS.Platform;
  arch?: string;
  nodeVersion?: string;
  inspect?: () => Promise<SessiondStatus>;
  resolveBackend?: () => { kind: DoctorBackendKind };
  gitVersion?: () => Promise<string | null>;
  lastStart?: () => Promise<LastStartRead>;
  hostDirectory?: string;
}

export function classifySessiondState(status: SessiondStatus): DoctorSessiondState {
  if (status.obstructed) return "obstructed";
  if (status.pid !== undefined && !status.alive) return "stale-lock";
  if (status.alive) return "running";
  return "not-running";
}

export async function collectDoctorReport(collectors: DoctorCollectors = {}): Promise<DoctorReport> {
  const platform = collectors.platform ?? process.platform;
  const status = await (collectors.inspect ?? inspectSessiond)();
  const backend = collectors.resolveBackend
    ? collectors.resolveBackend()
    : inspectSecureStateBackend();
  const gitVersion = collectors.gitVersion ? await collectors.gitVersion() : await readGitVersion();
  const lastStart = await (collectors.lastStart ?? (() => readLastStartRecord(status.directory)))();
  return {
    schemaVersion: DOCTOR_SCHEMA_VERSION,
    os: platform,
    arch: collectors.arch ?? process.arch,
    node: collectors.nodeVersion ?? process.version,
    engines: ">=22.19.0",
    backendKind: backend.kind,
    sessiondDirectory: status.directory,
    hostDirectory: collectors.hostDirectory ?? resolvePixHostDir(process.env.PIX_HOST_DIR),
    endpointKind: platform === "win32" ? "named-pipe" : "unix-socket",
    endpoint: status.endpoint,
    pathBudgetBytes: unixSocketPathBudgetBytes(platform),
    gitVersion,
    sessiond: {
      state: classifySessiondState(status),
      pingable: status.pingable,
      pid: status.pid ?? null,
      obstruction: status.obstruction ?? null,
    },
    lastStart: summarizeLastStart(lastStart),
    secureContext: SECURE_CONTEXT_GUIDANCE,
  };
}

function summarizeLastStart(read: LastStartRead): DoctorReport["lastStart"] {
  if (read.kind === "missing") return { state: "missing", code: null, message: null };
  if (read.kind === "corrupt") return { state: "corrupt", code: null, message: null };
  return {
    state: read.record.ok ? "ok" : "failed",
    code: read.record.code,
    message: read.record.message,
  };
}

export function formatDoctorText(report: DoctorReport): string[] {
  return [
    `os: ${report.os} ${report.arch}`,
    `node: ${report.node} (engines ${report.engines})`,
    `backend: ${report.backendKind}`,
    `sessiond-dir: ${report.sessiondDirectory}`,
    `host-dir: ${report.hostDirectory}`,
    `endpoint: ${report.endpointKind} ${report.endpoint}`,
    `path-budget-bytes: ${report.pathBudgetBytes === null ? "n/a" : String(report.pathBudgetBytes)}`,
    `git: ${report.gitVersion ?? "unavailable"}`,
    `sessiond: ${report.sessiond.state}${report.sessiond.pingable ? " (healthy)" : ""}`,
    ...(report.sessiond.pid !== null ? [`sessiond-pid: ${report.sessiond.pid}`] : []),
    ...(report.sessiond.obstruction ? [`obstruction: ${report.sessiond.obstruction}`] : []),
    `last-start: ${report.lastStart.state}${report.lastStart.code ? ` (${report.lastStart.code})` : ""}`,
    ...(report.lastStart.message ? [`last-start-message: ${report.lastStart.message}`] : []),
    `secure-context: ${report.secureContext}`,
  ];
}

export function doctorExitCode(report: DoctorReport): number {
  if (report.backendKind === "unavailable" || report.sessiond.state === "obstructed") return 1;
  return 0;
}

/**
 * `pix doctor` — read-only platform diagnosis. Never starts sessiond/Host and
 * never prints secrets. `--platform` is accepted as the documented alias for
 * the same report; `--json` emits the stable schema for CI.
 */
export function parseDoctorFlags(argv: string[]): { json: boolean } {
  let json = false;
  for (const arg of argv) {
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--platform") continue;
    throw new Error(`unknown flag: ${arg}`);
  }
  return { json };
}

export async function doctorCommand(
  argv: string[],
  collectors: DoctorCollectors = {},
): Promise<number> {
  let parsed;
  try {
    parsed = parseDoctorFlags(argv);
  } catch (error) {
    pixErr((error as Error).message);
    return 2;
  }
  const report = await collectDoctorReport(collectors);
  if (parsed.json) {
    pixLog(JSON.stringify(report));
  } else {
    for (const line of formatDoctorText(report)) pixLog(line);
  }
  return doctorExitCode(report);
}

function readGitVersion(): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn("git", ["--version"], {
      stdio: ["ignore", "pipe", "ignore"],
      shell: false,
      windowsHide: true,
    });
    let stdout = "";
    const timer = setTimeout(() => {
      child.kill();
      resolve(null);
    }, GIT_TIMEOUT_MS);
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.length > 256) stdout = stdout.slice(0, 256);
    });
    child.once("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        resolve(null);
        return;
      }
      const match = /^git version ([0-9][0-9A-Za-z.+-]*)$/mu.exec(stdout.trim());
      resolve(match?.[1] ?? null);
    });
  });
}
