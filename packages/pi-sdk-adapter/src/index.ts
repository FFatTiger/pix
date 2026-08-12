// Public surface of the pix Pi SDK Agent Adapter.
//
// The root entry ships the agent runtime surface (A1): the
// AgentRuntimeFactory backed by the Pi SDK and the explicit production capability set.
// The read-only sessions catalog/locator (D1A-1) is published as its own
// subpath `@fffattiger/pix-pi-sdk-adapter/sessions`. Model/credential/
// resource/trust ports are deferred to later milestones and are intentionally
// NOT re-exported from the root entry.
export * from "./agent/index.js";
