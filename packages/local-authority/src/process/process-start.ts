/**
 * Process-start identity for lock liveness.
 *
 * PID reuse is real on every OS. A lock may only be treated as stale when the
 * recorded start identity is absent from a *dead* pid, or when a live pid's
 * start identity is readable and does not match. A live pid whose start
 * identity cannot be proven is obstructed, never auto-reclaimed.
 *
 * This is not Job Object / descendant cleanup.
 */
import { readFileSync } from "node:fs";
import { loadNativeWindowsBinding } from "../state/native-windows.js";

export type ProcessStartKind = "linux-startticks" | "windows-creation-time";

export interface ProcessStartIdentity {
  readonly kind: ProcessStartKind;
  readonly value: string;
}

export type ProcessLiveness =
  | { kind: "dead" }
  | { kind: "live"; start?: ProcessStartIdentity }
  | { kind: "obstructed"; reason: string };

function pidAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readLinuxStartTicks(pid: number): ProcessStartIdentity | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = stat.lastIndexOf(")");
    if (close < 0) return undefined;
    const fields = stat.slice(close + 2).split(" ");
    const startTicks = fields[19];
    if (!startTicks || !/^[0-9]+$/u.test(startTicks)) return undefined;
    return { kind: "linux-startticks", value: startTicks };
  } catch {
    return undefined;
  }
}

function readWindowsCreationTime(pid: number): ProcessStartIdentity | undefined {
  try {
    const inspection = loadNativeWindowsBinding().inspectProcess(pid);
    if (!inspection || !/^[0-9]+$/u.test(inspection.creationTime)) return undefined;
    return { kind: "windows-creation-time", value: inspection.creationTime };
  } catch {
    return undefined;
  }
}

export function inspectProcessLiveness(
  pid: number,
  platform: NodeJS.Platform = process.platform,
): ProcessLiveness {
  if (!Number.isSafeInteger(pid) || pid <= 0) return { kind: "dead" };
  const alive = pidAlive(pid);
  if (!alive) return { kind: "dead" };
  if (platform === "linux") {
    const start = readLinuxStartTicks(pid);
    return start ? { kind: "live", start } : { kind: "obstructed", reason: "linux process start identity is unavailable" };
  }
  if (platform === "win32") {
    const start = readWindowsCreationTime(pid);
    return start ? { kind: "live", start } : { kind: "obstructed", reason: "windows process start identity is unavailable" };
  }
  return { kind: "live" };
}

export function currentProcessStartIdentity(
  platform: NodeJS.Platform = process.platform,
): ProcessStartIdentity | undefined {
  const liveness = inspectProcessLiveness(process.pid, platform);
  return liveness.kind === "live" ? liveness.start : undefined;
}

export function sameProcessStartIdentity(
  left: ProcessStartIdentity | undefined,
  right: ProcessStartIdentity | undefined,
): boolean {
  if (!left || !right) return false;
  return left.kind === right.kind && left.value === right.value;
}

/**
 * Classify a lock-named pid. Missing recorded start identity is tolerated only
 * when the pid is dead (legacy debris). A live pid without a matching start
 * identity is never treated as stale.
 */
export function classifyLockProcess(input: {
  pid: number;
  start?: ProcessStartIdentity;
  platform?: NodeJS.Platform;
}): "live" | "stale" | "obstructed" {
  const liveness = inspectProcessLiveness(input.pid, input.platform ?? process.platform);
  if (liveness.kind === "dead") return "stale";
  if (liveness.kind === "obstructed") return "obstructed";
  if (!input.start) return liveness.start ? "obstructed" : "live";
  if (!liveness.start) return "obstructed";
  return sameProcessStartIdentity(input.start, liveness.start) ? "live" : "stale";
}
