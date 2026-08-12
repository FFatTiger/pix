export {
  PiSdkAgentRuntimeFactory,
  createPiSdkAgentRuntimeFactory,
  type PiSdkAgentRuntimeFactoryOptions,
} from "./factory.js";

/**
 * Production capability surface — the capabilities the A1 adapter advertises
 * in the product runtime (composed by worker-main).
 *
 * D2-P1 precisely extends the minimal M2 surface (`runtime.prompt` +
 * `runtime.abort`) with the two light, honest capabilities now unlocked:
 * `runtime.stats` (get_session_stats) and `runtime.session.rename`
 * (set_session_name). Model switching, tool configuration, bash, fork,
 * extension UI, compaction, navigation, reload, the queue/retry knobs and
 * `runtime.auto_name` (generate_session_title) are all implemented by the
 * adapter but gated out by this set so composition (R1/R2) must explicitly opt
 * into broader capabilities. The constant is intentionally narrow and MUST
 * NOT grow to leak model/tools/bash/fork/extension-UI/auto_name capabilities
 * by default.
 */
export const PRODUCTION_AGENT_CAPABILITIES = [
  "runtime.prompt",
  "runtime.abort",
  "runtime.stats",
  "runtime.session.rename",
] as const;
