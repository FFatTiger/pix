/**
 * Shared process-tree controller.
 *
 * sessiond owns Worker lifecycle policy and Host owns Git command policy.
 * Neither may invent its own descendant-kill logic. This module is the single
 * owner for "how do we terminate a supervised child and, when supported, its
 * descendants?"
 *
 * Frozen first slice:
 * - POSIX: isolated process group (`detached: true` + `process.kill(-pid)`).
 * - Windows: direct-child TerminateProcess only. `supportsDescendants` is
 *   false. No Job Object, no `taskkill`, no PowerShell.
 */
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";

export type ProcessTreeSignal = "SIGTERM" | "SIGKILL";

export interface ProcessTreeSpawnOptions {
  argv: readonly string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdio: SpawnOptions["stdio"];
  windowsHide?: boolean;
}

export interface ProcessTreeController {
  readonly kind: "posix" | "windows";
  /** True when terminate() also covers descendants of the supervised child. */
  readonly supportsDescendants: boolean;
  spawn(options: ProcessTreeSpawnOptions): ChildProcess;
  /**
   * Best-effort terminate. Missing / already-reaped pids are a no-op.
   * Windows ignores the signal name and uses TerminateProcess.
   */
  terminate(pid: number, signal: ProcessTreeSignal): boolean;
}

class PosixProcessTreeController implements ProcessTreeController {
  readonly kind = "posix" as const;
  readonly supportsDescendants = true;

  spawn(options: ProcessTreeSpawnOptions): ChildProcess {
    const [command, ...args] = options.argv;
    if (!command) throw new Error("Process tree spawn requires a command");
    return spawn(command, args, {
      ...(options.cwd ? { cwd: options.cwd } : {}),
      ...(options.env ? { env: options.env } : {}),
      stdio: options.stdio,
      detached: true,
      windowsHide: options.windowsHide ?? true,
    });
  }

  terminate(pid: number, signal: ProcessTreeSignal): boolean {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
      process.kill(-pid, signal);
      return true;
    } catch {
      try {
        process.kill(pid, signal);
        return true;
      } catch {
        return false;
      }
    }
  }
}

class WindowsProcessTreeController implements ProcessTreeController {
  readonly kind = "windows" as const;
  readonly supportsDescendants = false;

  spawn(options: ProcessTreeSpawnOptions): ChildProcess {
    const [command, ...args] = options.argv;
    if (!command) throw new Error("Process tree spawn requires a command");
    return spawn(command, args, {
      ...(options.cwd ? { cwd: options.cwd } : {}),
      ...(options.env ? { env: options.env } : {}),
      stdio: options.stdio,
      detached: false,
      windowsHide: options.windowsHide ?? true,
    });
  }

  terminate(pid: number, _signal: ProcessTreeSignal): boolean {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
      process.kill(pid, "SIGKILL");
      return true;
    } catch {
      return false;
    }
  }
}

export interface ProcessTreeControllerFactoryOptions {
  platform?: NodeJS.Platform;
}

export function createProcessTreeController(
  options: ProcessTreeControllerFactoryOptions = {},
): ProcessTreeController {
  const platform = options.platform ?? process.platform;
  return platform === "win32" ? new WindowsProcessTreeController() : new PosixProcessTreeController();
}
