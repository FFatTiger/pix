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
 * the single real extension-UI slice. D2 navigate precisely adds
 * `runtime.navigate` (navigate_tree) and D2 fork precisely adds `runtime.fork`
 * (fork) — the two real session-tree slices (backend-first; no Client UI).
 * D2 auto_name precisely adds `runtime.auto_name` (generate_session_title) —
 * the LAST closed runtime command (backend-first; no Client UI). With it every
 * runtime command is open; the E2E closed-cap loops become an explicit
 * every-command-open assertion.
 * The existing
 * semantic mapping also makes `set_auto_compaction` wire-open under
 * `runtime.compact` (honest, because the implementation exists), but D2-P7
 * deliberately adds NO Client helper/UI for auto compaction.
 * This set is the FULL frozen command surface — every runtime command is open.
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
  "runtime.navigate",
  "runtime.fork",
  "runtime.auto_name",
] as const;
