import { spawn } from "node:child_process";
import { HttpError } from "../errors.js";

export interface ProcessRequest {
  command: string;
  args: readonly string[];
  cwd?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  signal?: AbortSignal;
}

export interface ProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  truncated: boolean;
}

export interface ProcessRunner {
  run(request: ProcessRequest): Promise<ProcessResult>;
}

function appendBounded(chunks: Buffer[], chunk: Buffer, state: { bytes: number }, limit: number): boolean {
  if (state.bytes >= limit) return true;
  const remaining = limit - state.bytes;
  chunks.push(chunk.subarray(0, remaining));
  state.bytes += Math.min(chunk.byteLength, remaining);
  return chunk.byteLength > remaining;
}

export function createProcessRunner(defaults: {
  timeoutMs?: number;
  maxOutputBytes?: number;
  allowedCommands?: readonly string[];
} = {}): ProcessRunner {
  const defaultTimeout = defaults.timeoutMs ?? 10_000;
  const defaultMaxOutput = defaults.maxOutputBytes ?? 8 * 1024 * 1024;
  const allowed = new Set(defaults.allowedCommands ?? ["git"]);

  return {
    run(request) {
      if (!allowed.has(request.command)) {
        return Promise.reject(new HttpError(500, "PROCESS_POLICY", "Command is not allowed"));
      }
      const timeoutMs = request.timeoutMs ?? defaultTimeout;
      const maxOutputBytes = request.maxOutputBytes ?? defaultMaxOutput;
      if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || !Number.isInteger(maxOutputBytes) || maxOutputBytes < 1) {
        return Promise.reject(new HttpError(500, "PROCESS_POLICY", "Invalid process limits"));
      }
      return new Promise<ProcessResult>((resolve, reject) => {
        if (request.signal?.aborted) {
          reject(new HttpError(499, "PROCESS_ABORTED", "Process aborted"));
          return;
        }
        const child = spawn(request.command, [...request.args], {
          ...(request.cwd ? { cwd: request.cwd } : {}),
          shell: false,
          windowsHide: true,
          env: { ...process.env, LC_ALL: "C", LANG: "C" },
          stdio: ["ignore", "pipe", "pipe"],
        });
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        const state = { bytes: 0 };
        let truncated = false;
        let settled = false;
        let termination: "abort" | "timeout" | "output" | null = null;
        const stop = () => {
          if (!child.killed) child.kill("SIGKILL");
        };
        const timer = setTimeout(() => {
          if (!termination) termination = "timeout";
          stop();
        }, timeoutMs);
        timer.unref?.();
        const onAbort = () => {
          if (!termination) termination = "abort";
          stop();
        };
        request.signal?.addEventListener("abort", onAbort, { once: true });
        child.stdout.on("data", (chunk: Buffer) => {
          truncated = appendBounded(stdout, chunk, state, maxOutputBytes) || truncated;
          if (truncated) {
            if (!termination) termination = "output";
            stop();
          }
        });
        child.stderr.on("data", (chunk: Buffer) => {
          truncated = appendBounded(stderr, chunk, state, maxOutputBytes) || truncated;
          if (truncated) {
            if (!termination) termination = "output";
            stop();
          }
        });
        child.once("error", (error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          request.signal?.removeEventListener("abort", onAbort);
          reject(new HttpError(503, "PROCESS_UNAVAILABLE", error.message));
        });
        child.once("close", (code, signal) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          request.signal?.removeEventListener("abort", onAbort);
          if (termination === "abort") {
            reject(new HttpError(499, "PROCESS_ABORTED", "Process aborted"));
            return;
          }
          if (termination === "timeout") {
            reject(new HttpError(504, "PROCESS_TIMEOUT", "Process timed out"));
            return;
          }
          if (termination === "output") {
            reject(new HttpError(413, "PROCESS_OUTPUT_LIMIT", "Process output exceeded the configured limit"));
            return;
          }
          resolve({
            stdout: Buffer.concat(stdout).toString("utf8"),
            stderr: Buffer.concat(stderr).toString("utf8"),
            exitCode: code ?? (signal ? 128 : 1),
            truncated: false,
          });
        });
      });
    },
  };
}

export async function runChecked(runner: ProcessRunner, request: ProcessRequest): Promise<string> {
  const result = await runner.run(request);
  if (result.exitCode !== 0) {
    const message = result.stderr.trim() || `Command exited with code ${result.exitCode}`;
    throw new HttpError(400, "COMMAND_FAILED", message.slice(0, 4_096));
  }
  return result.stdout;
}
