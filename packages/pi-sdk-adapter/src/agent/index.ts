export {
  PiSdkAgentRuntimeFactory,
  createPiSdkAgentRuntimeFactory,
  type PiSdkAgentRuntimeFactoryOptions,
} from "./factory.js";

/**
 * Production capability surface — the capabilities the A1 adapter advertises
 * in the product runtime (composed by worker-main).
 *
 * D2-P1 unlocked `runtime.stats` (get_session_stats) and
 * `runtime.session.rename` (set_session_name) on top of the minimal M2 surface
 * (`runtime.prompt` + `runtime.abort`). D2-P2 precisely adds
 * `runtime.thinking.set` (set_thinking_level). D2-P3 precisely adds
 * `runtime.model.set` (set_model) — the single real `set_model` vertical slice.
 * D2-P4 precisely adds `runtime.steer` (steer), `runtime.follow_up`
 * (follow_up) and `runtime.queue` (clear_queue interrupt + set_auto_retry) —
 * the single real queue-control vertical slice. D2-P5 precisely adds
 * `runtime.bash` (bash) and `runtime.bash.abort` (abort_bash) — the single
 * real bash runtime-control slice. D2-P6 precisely adds
 * `runtime.tools.read` (get_tools), `runtime.tools.write` (set_tools) and
 * `runtime.reload` (reload) — the single real tools+reload slice. D2-P7
 * precisely adds `runtime.compact` (compact) and `runtime.compact.abort`
 * (abort_compaction) — the single real manual-compact slice. D2-P8 precisely
 * adds `runtime.extension_ui` (extension_ui_response / extension_ui_input) —
 * the single real extension-UI slice. The existing
 * semantic mapping also makes `set_auto_compaction` wire-open under
 * `runtime.compact` (honest, because the implementation exists), but D2-P7
 * deliberately adds NO Client helper/UI for auto compaction. Fork,
 * navigation and `runtime.auto_name`
 * (generate_session_title) are all implemented by the adapter but gated out by
 * this set so composition (R1/R2) must explicitly opt into broader
 * capabilities. The constant is intentionally narrow and MUST NOT grow to
 * leak fork/navigate/auto_name capabilities by default.
 */
export const PRODUCTION_AGENT_CAPABILITIES = [
  "runtime.prompt",
  "runtime.abort",
  "runtime.stats",
  "runtime.session.rename",
  "runtime.thinking.set",
  "runtime.model.set",
  "runtime.steer",
  "runtime.follow_up",
  "runtime.queue",
  "runtime.bash",
  "runtime.bash.abort",
  "runtime.tools.read",
  "runtime.tools.write",
  "runtime.reload",
  "runtime.compact",
  "runtime.compact.abort",
  "runtime.extension_ui",
] as const;
