/**
 * Shared process-tree controller.
 *
 * sessiond owns Worker lifecycle policy and Host owns Git command policy.
 * Neither may invent its own descendant-kill logic. This module is the single
 * owner for "how do we terminate a supervised child and, when supported, its
 * descendants?"
 *
 * - POSIX: isolated process group (`detached: true` + `process.kill(-pid)`).
 * - Windows: VS Code `killTree` — `%WINDIR%\System32\taskkill.exe /T /F /PID`.
 *   SIGTERM and SIGKILL both force-kill the tree because unforced taskkill
 *   ignores detached/windowless Node children. No Job Object, no PATH lookup,
 *   no PowerShell, no npm tree-kill.
 */
import { spawn, spawnSync, type ChildProcess, type SpawnOptions } from "node:child_process";
import { join } from "node:path";

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
   * Windows uses System32 taskkill /T /F. Signal names are not POSIX
   * two-level semantics on Windows.
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

/** VS Code processes.ts: `%WINDIR%\System32\taskkill.exe`. Never PATH. */
export function windowsTaskkillPath(env: NodeJS.ProcessEnv = process.env): string {
  const windir = env.WINDIR || env.SystemRoot || "C:\\Windows";
  if (windir.includes("\0") || windir.includes("/") || /[<>"|?*]/.test(windir)) {
    return "C:\\Windows\\System32\\taskkill.exe";
  }
  return join(windir, "System32", "taskkill.exe");
}

class WindowsProcessTreeController implements ProcessTreeController {
  readonly kind = "windows" as const;
  readonly supportsDescendants = true;

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

  terminate(pid: number, signal: ProcessTreeSignal): boolean {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    void signal;
    const args = ["/T", "/F", "/PID", String(pid)];
    try {
      const result = spawnSync(windowsTaskkillPath(), args, {
        encoding: "utf8",
        windowsHide: true,
        shell: false,
        timeout: 5_000,
      });
      if (result.error) throw result.error;
      if (result.status === 0) return true;
      const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
      if (/not found|not running|not exist/i.test(output)) return false;
      return false;
    } catch {
      try {
        process.kill(pid, 0);
      } catch {
        return false;
      }
      try {
        process.kill(pid, "SIGKILL");
        return true;
      } catch {
        return false;
      }
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
