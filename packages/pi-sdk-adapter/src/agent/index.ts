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
 * Tool configuration, bash, fork, extension UI, compaction, navigation,
 * reload, the queue/retry knobs and `runtime.auto_name`
 * (generate_session_title) are all implemented by the adapter but gated out by
 * this set so composition (R1/R2) must explicitly opt into broader
 * capabilities. The constant is intentionally narrow and MUST NOT grow to
 * leak tools/bash/fork/extension-UI/queue/auto_name/reload capabilities by
 * default.
 */
export const PRODUCTION_AGENT_CAPABILITIES = [
  "runtime.prompt",
  "runtime.abort",
  "runtime.stats",
  "runtime.session.rename",
  "runtime.thinking.set",
  "runtime.model.set",
] as const;
