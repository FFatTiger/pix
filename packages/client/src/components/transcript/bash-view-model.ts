/**
 * Shared bash projector / view-model for history BashExecutionMessage rows and
 * live `runtime.snapshot.state.bash`. History, live completed messages, and the
 * live state row all use this shape so status copy never drifts.
 *
 * Never includes `fullOutputPath` (must not reach DOM/title/data attrs/logs).
 * `excludeFromContext` is ignored for visibility.
 */

/**
 * Fields both BashExecutionMessage and BashProjection can supply.
 * Optional properties explicitly allow `undefined` so exactOptionalPropertyTypes
 * accepts protocol types where optional keys may be present-as-undefined.
 */
export interface BashSourceFields {
  readonly command?: string | undefined;
  readonly output?: string | undefined;
  readonly exitCode?: number | undefined;
  readonly cancelled?: boolean | undefined;
  readonly truncated?: boolean | undefined;
  /**
   * Present on protocol messages / projections but intentionally omitted from
   * the view-model — never rendered, linked, or logged.
   */
  readonly fullOutputPath?: string | undefined;
  readonly excludeFromContext?: boolean | undefined;
  readonly timestamp?: number | undefined;
}

/** Live-only lifecycle flags from BashProjection / isBashRunning. */
export interface BashLiveFlags {
  /** True while the runtime reports an incomplete bash projection. */
  readonly running?: boolean;
  readonly completed?: boolean;
}

export interface BashViewModel {
  readonly command: string;
  /** Display output; empty sources become the fixed sentinel `(no output)`. */
  readonly output: string;
  readonly exitCode?: number;
  readonly cancelled: boolean;
  readonly truncated: boolean;
  readonly running: boolean;
  readonly completed: boolean;
  /** Short status chips for the meta row (order is stable). */
  readonly statusLabels: readonly string[];
}

export const BASH_EMPTY_OUTPUT = "(no output)";

/** Stable live state row id — never depends on updateCount or content. */
export const LIVE_BASH_ROW_ID = "row:state:bash";

/**
 * Project history / live bash fields into a single display model.
 * Pure: no I/O, no logging of command/output (secrets may be present).
 */
export function projectBashViewModel(
  source: BashSourceFields,
  live: BashLiveFlags = {},
): BashViewModel {
  const command = source.command ?? "";
  const rawOutput = source.output ?? "";
  const cancelled = source.cancelled === true;
  const truncated = source.truncated === true;
  const exitCode = source.exitCode;

  // Live flags are authoritative when provided; history messages omit them and
  // are always treated as settled (completed).
  const hasLiveFlags = live.running !== undefined || live.completed !== undefined;
  const running = hasLiveFlags
    ? live.running === true || live.completed === false
    : false;
  const completed = hasLiveFlags ? !running : true;

  const statusLabels: string[] = [];
  if (running) statusLabels.push("running");
  if (cancelled) statusLabels.push("cancelled");
  if (exitCode !== undefined) statusLabels.push(`exit ${exitCode}`);
  if (truncated) statusLabels.push("truncated");

  return {
    command,
    output: rawOutput.length === 0 ? BASH_EMPTY_OUTPUT : rawOutput,
    ...(exitCode === undefined ? {} : { exitCode }),
    cancelled,
    truncated,
    running,
    completed,
    statusLabels,
  };
}

/** Flatten bash view-model into the plain-text estimate / a11y body. */
export function flattenBashViewModel(bash: BashViewModel): string {
  const lines = [`$ ${bash.command}`, bash.output];
  if (bash.statusLabels.length > 0) {
    lines.push(bash.statusLabels.join(" · "));
  }
  return lines.join("\n");
}

/**
 * Live mapping policy (frozen):
 *
 * `state.bash` and trailing `runtime.messages` bashExecution share no
 * authoritative execution id. Without identity, NEVER dedupe/hide either side
 * based on content, role, or list position — duplicates may appear, and that is
 * preferred over silently swallowing a distinct execution.
 */
