import { spawn } from "node:child_process";
import { join } from "node:path";
import { resolveCliPackageRoot } from "./paths.js";

export interface LegacyWindowsTerminationInput {
  endpoint: string;
  lockFile: string;
  expectedPid: number;
  expectedInstanceId: string;
  secret: string;
  timeoutMs: number;
}

export type LegacyWindowsTerminationResult =
  | { ok: true; pid: number }
  | { ok: false; reason: string };

interface HelperResponse {
  ok?: unknown;
  pid?: unknown;
  reason?: unknown;
}

const MAX_HELPER_OUTPUT_BYTES = 16 * 1024;

function helperPath(): string {
  return join(resolveCliPackageRoot(), "bin", "windows-legacy-sessiond.ps1");
}

function powershellPath(): string | undefined {
  const root = process.env.SystemRoot;
  if (!root) return undefined;
  return join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

function sanitizedReason(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 500) {
    return "legacy sessiond verification failed";
  }
  const sanitized = value
    .replace(/[\r\n\t\x00-\x1f\x7f]+/g, " ")
    .replace(/AUTH\s+\S+/gi, "AUTH [redacted]")
    .replace(/(secret|token|bearer|api[_-]?key)\s*[:=]\s*\S+/gi, "$1=[redacted]");
  return sanitized.slice(0, 500);
}

/**
 * Terminate an old Windows daemon only after a native helper binds the exact
 * authenticated Named Pipe server to stable process and lock handles. The
 * secret travels over stdin, never argv/environment, and helper diagnostics are
 * deliberately bounded and sanitized.
 */
export async function terminateLegacyWindowsSessiond(
  input: LegacyWindowsTerminationInput,
): Promise<LegacyWindowsTerminationResult> {
  if (process.platform !== "win32") {
    return { ok: false, reason: "legacy Windows sessiond termination is unavailable on this platform" };
  }
  const executable = powershellPath();
  if (!executable) {
    return { ok: false, reason: "Windows PowerShell is unavailable for verified legacy sessiond shutdown" };
  }
  const child = spawn(executable, [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    helperPath(),
  ], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });

  let stdout = "";
  let stderr = "";
  const append = (current: string, chunk: Buffer): string => {
    const next = current + chunk.toString("utf8");
    return Buffer.byteLength(next) <= MAX_HELPER_OUTPUT_BYTES ? next : next.slice(-MAX_HELPER_OUTPUT_BYTES);
  };
  child.stdout.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk); });
  child.stderr.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk); });

  const timeoutMs = Math.max(1, Math.min(input.timeoutMs, 60_000));
  const timer = setTimeout(() => {
    try { child.kill(); } catch { /* already exited */ }
  }, timeoutMs + 5_000);
  timer.unref?.();

  const exit = new Promise<{ code: number | null; error?: Error }>((resolve) => {
    child.once("error", (error) => resolve({ code: null, error }));
    child.once("exit", (code) => resolve({ code }));
  });
  child.stdin.end(`${JSON.stringify({ ...input, timeoutMs })}\n`);
  const outcome = await exit;
  clearTimeout(timer);

  if (outcome.error) {
    return { ok: false, reason: "could not start verified legacy sessiond shutdown helper" };
  }
  let response: HelperResponse;
  try {
    response = JSON.parse(stdout.trim()) as HelperResponse;
  } catch {
    void stderr;
    return { ok: false, reason: "verified legacy sessiond shutdown helper returned an invalid response" };
  }
  if (outcome.code === 0 && response.ok === true && response.pid === input.expectedPid) {
    return { ok: true, pid: input.expectedPid };
  }
  return { ok: false, reason: sanitizedReason(response.reason) };
}
