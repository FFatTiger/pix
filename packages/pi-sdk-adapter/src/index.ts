// Public surface of the pix Pi SDK Agent Adapter (A1).
//
// A1 ships only the agent runtime surface: the AgentRuntimeFactory backed by
// the Pi SDK and the M2 capability constant. Session/model/credential/
// resource/trust ports are deferred to later milestones and are intentionally
// NOT re-exported here.
export * from "./agent/index.js";
