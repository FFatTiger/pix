export {
  PiSdkAgentRuntimeFactory,
  createPiSdkAgentRuntimeFactory,
  type PiSdkAgentRuntimeFactoryOptions,
} from "./factory.js";

/**
 * M2 capability surface — the only capabilities the A1 adapter advertises.
 *
 * Precisely `runtime.prompt` and `runtime.abort`: a minimal happy-path turn
 * and its cancellation. Model switching, tool configuration, bash, fork,
 * extension UI, compaction, navigation, reload and the queue/retry knobs are
 * all implemented by the adapter but gated out by this capability set so that
 * composition (R1/R2) must explicitly opt into broader capabilities. The
 * constant is intentionally narrow and MUST NOT grow to leak model/tools/bash/
 * fork/extension-UI capabilities by default.
 */
export const M2_AGENT_CAPABILITIES = ["runtime.prompt", "runtime.abort"] as const;
