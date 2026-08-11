// Test-only fixture factory for the real-child-process composition smoke.
//
// Loaded by worker-main through the PIX_AGENT_WORKER_FACTORY injection seam
// (never used in production). Implements the Runtime Core AgentRuntimeFactory
// surface with deterministic, network-free behavior: create returns a real
// session id (`sess-created-real`) so the smoke asserts the rekey path, and
// prompt emits a full assistant stream then settles.
export default {
  async create(input) {
    return makePort(input.cwd, "sess-created-real");
  },
  async open(input) {
    return makePort(input.cwd, input.sessionId);
  },
};

function makePort(cwd, sessionId) {
  let listeners = new Set();
  return {
    identity: { sessionId, sessionFile: `/sessions/${sessionId}.jsonl` },
    getCapabilities() {
      return { capabilities: ["runtime.prompt", "runtime.abort"], version: 1 };
    },
    async getSnapshot() {
      return {
        sessionId,
        state: {
          sessionId,
          isStreaming: false,
          isPromptRunning: false,
          isBashRunning: false,
          isCompacting: false,
          model: null,
          messageCount: 0,
        },
        capabilities: { capabilities: ["runtime.prompt", "runtime.abort"], version: 1 },
      };
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    emit(event) {
      for (const fn of [...listeners]) fn(structuredClone(event));
    },
    async execute(command) {
      if (command.type === "prompt") {
        this.emit({ type: "agent_start", sessionId });
        this.emit({
          type: "message_update",
          sessionId,
          message: { role: "assistant", content: [{ type: "text", text: "Hello" }] },
        });
        this.emit({
          type: "message_update",
          sessionId,
          message: { role: "assistant", content: [{ type: "text", text: "Hello world" }] },
        });
        this.emit({
          type: "message_end",
          sessionId,
          message: { role: "assistant", content: [{ type: "text", text: "Hello world" }], model: "m", provider: "p" },
        });
        this.emit({ type: "prompt_done", sessionId });
        return { ok: true, type: "prompt" };
      }
      return { ok: true, type: command.type };
    },
    async interrupt(interrupt) {
      return { ok: true, type: interrupt.type };
    },
    async close() {
      listeners.clear();
    },
  };
}
