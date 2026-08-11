/**
 * Safe stdio helpers for the R2 worker process.
 *
 * When the parent dies (crash / SIGKILL / abrupt exit) stdin, stdout and stderr
 * close together. A naive `process.stderr.write` can then throw or emit EPIPE;
 * without a listener that becomes an uncaughtException, whose handler may write
 * stderr again and hang or recurse. These helpers:
 *
 * - install once-only minimal `error` listeners on process.stdout/stderr so
 *   EPIPE never becomes uncaught;
 * - provide a logger that never throws and never blocks shutdown;
 * - provide an exit watchdog so EOF shutdown still terminates even if
 *   runtime.close / logger / stdout flush misbehave.
 */

const GUARD_FLAG = Symbol.for("pix.agentWorker.stdioGuards");

type GuardedProcess = NodeJS.Process & {
  [GUARD_FLAG]?: boolean;
};

/** Install swallow-only error handlers on process.stdout/stderr. Idempotent. */
export function installProcessStdioGuards(): void {
  const proc = process as GuardedProcess;
  if (proc[GUARD_FLAG]) return;
  proc[GUARD_FLAG] = true;
  // Minimal handlers: presence alone prevents uncaughtException on EPIPE.
  process.stdout.on("error", () => {});
  process.stderr.on("error", () => {});
}

/**
 * Write one diagnostic line to process.stderr. Never throws, never re-enters
 * fatal handlers. Safe under broken / half-closed stderr (parent death).
 */
export function safeStderrWrite(line: string): void {
  installProcessStdioGuards();
  try {
    const payload = line.endsWith("\n") ? line : `${line}\n`;
    process.stderr.write(payload, (error) => {
      // Callback form still surfaces write failures without throwing.
      void error;
    });
  } catch {
    // ERR_STREAM_DESTROYED / sync EPIPE — swallow.
  }
}

/** Default production logger: one line → safe stderr. */
export function createSafeStderrLogger(): (line: string) => void {
  return (line: string) => {
    safeStderrWrite(line);
  };
}

/**
 * True when stdout or stderr is no longer writable — the typical parent-death
 * condition (all pipes closed together). Live-parent stdin.end leaves them open.
 */
export function isProcessStdioBroken(): boolean {
  try {
    const out = process.stdout;
    const err = process.stderr;
    return (
      out.destroyed ||
      err.destroyed ||
      out.writableEnded ||
      err.writableEnded ||
      !out.writable ||
      !err.writable
    );
  } catch {
    return true;
  }
}

export interface ExitWatchdog {
  /** Arm (or re-arm with a tighter deadline). First fire wins. */
  arm(ms: number, code: number): void;
  /** Cancel if the process already exited via the normal path. */
  cancel(): void;
  readonly fired: boolean;
}

/**
 * Hard process.exit deadline independent of Promise chains. Used so a stuck
 * runtime.close / logger / flush cannot leave an orphan reparented to PID 1.
 */
export function createExitWatchdog(
  exitFn: (code: number) => void = (code) => process.exit(code),
): ExitWatchdog {
  let timer: NodeJS.Timeout | undefined;
  let fired = false;
  let cancelled = false;

  return {
    get fired() {
      return fired;
    },
    arm(ms: number, code: number): void {
      if (fired || cancelled) return;
      if (timer !== undefined) clearTimeout(timer);
      // Keep the timer ref'd: under a hung async chain an unref'd timer would
      // let Node exit 0 without ever forcing the deadline.
      timer = setTimeout(() => {
        if (fired || cancelled) return;
        fired = true;
        try {
          safeStderrWrite(`[worker-main] exit watchdog fired after ${ms}ms; forcing exit ${code}`);
        } catch {
          // ignore
        }
        try {
          exitFn(code);
        } catch {
          try {
            process.exit(code);
          } catch {
            // last resort exhausted
          }
        }
      }, Math.max(0, ms));
    },
    cancel(): void {
      cancelled = true;
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
    },
  };
}

/** Default EOF → hard-exit budget when stdio still looks healthy (live parent). */
export const DEFAULT_EOF_WATCHDOG_MS = 8_000;
/**
 * Faster budget when stdin EOF arrives with broken stdout/stderr (parent death).
 * Ordered close still runs first; this only caps the hang window.
 */
export const BROKEN_STDIO_EOF_WATCHDOG_MS = 1_000;
/** Max time requestExit will wait on stdout flush before raw exit. */
export const DEFAULT_EXIT_FLUSH_TIMEOUT_MS = 500;
