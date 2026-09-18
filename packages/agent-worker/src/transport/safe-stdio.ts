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

import type { Readable } from "node:stream";

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

// ---------------------------------------------------------------------------
// parent-death watchdog (ppid reparenting)
// ---------------------------------------------------------------------------

export interface ParentDeathWatchdog {
  /** Stop polling. Idempotent. */
  cancel(): void;
  /** True while the poll timer is still active. */
  readonly armed: boolean;
}

export interface ParentDeathWatchdogOptions {
  /** Override process exit (tests). Defaults to `process.exit`. */
  readonly exit?: (code: number) => void;
  /** Poll interval ms (default 250). */
  readonly pollMs?: number;
}

/**
 * Detect parent-process death via ppid reparenting and force a bounded exit.
 *
 * Installed **synchronously before any async composition work** so a worker
 * whose parent (sessiond) dies during factory resolution / transport boot
 * cannot become an orphan reparented to PID 1. The check is independent of
 * stdin EOF (which Node defers until a `data` consumer attaches) and of
 * stdout/stderr pipes (which break together on parent death).
 *
 * On Unix, when the parent dies the child is reparented to init/launchd (PID 1
 * or a subreaper), so `process.ppid` changes from the recorded initial value.
 * PID reuse within the short poll window is astronomically unlikely and is
 * further covered by the stdin EOF path once the transport boots.
 *
 * IMPORTANT: never logs or flushes on fire — stderr may already be broken.
 * Directly calls `exit(1)`.
 */
export function installParentDeathWatchdog(
  options: ParentDeathWatchdogOptions = {},
): ParentDeathWatchdog {
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const pollMs = options.pollMs ?? 250;
  const initialPpid = process.ppid;
  let cancelled = false;
  let timer: ReturnType<typeof setInterval> | undefined = setInterval(() => {
    if (cancelled) return;
    // Parent died → child reparented (ppid changed, typically to 1).
    if (process.ppid !== initialPpid) {
      if (timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
      }
      try {
        exit(1);
      } catch {
        try {
          process.exit(1);
        } catch {
          // exhausted
        }
      }
    }
  }, pollMs);
  return {
    get armed() {
      return timer !== undefined;
    },
    cancel() {
      cancelled = true;
      if (timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// early stdin EOF latch
// ---------------------------------------------------------------------------

export interface StdinEofLatch {
  /** True if EOF/close/error was observed OR the stream is already ended/destroyed. */
  readonly eofSeen: boolean;
  /** Remove the early listeners once the transport owns stdin. */
  release(): void;
}

/**
 * Synchronously latch stdin end/close/error so an EOF arriving during the
 * async composition boot gap (before the transport attaches its consumer) is
 * never lost. Node defers pipe EOF until a `data` consumer attaches, so the
 * getter also reports `readableEnded / destroyed / closed` directly as a
 * fallback for streams that already reached a terminal state.
 */
export function createStdinEofLatch(stdin: Readable = process.stdin): StdinEofLatch {
  let eventSeen = false;
  let released = false;
  const mark = (): void => {
    eventSeen = true;
  };
  stdin.once("end", mark);
  stdin.once("close", mark);
  stdin.once("error", mark);
  return {
    get eofSeen(): boolean {
      return (
        eventSeen ||
        stdin.readableEnded ||
        stdin.destroyed ||
        stdin.closed
      );
    },
    release(): void {
      if (released) return;
      released = true;
      stdin.off("end", mark);
      stdin.off("close", mark);
      stdin.off("error", mark);
    },
  };
}
