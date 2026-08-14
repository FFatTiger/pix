// X1 E2E test-only AgentRuntimeFactory.
//
// Loaded by worker-main through the PIX_AGENT_WORKER_FACTORY injection seam
// (never used in production). Network-free, deterministic streaming, and
// controllable long-prompt/abort behavior for the real-process runtime path:
// Browser → Host → sessiond → R2 child → R1 worker-main → this fixture.
//
// Control surface (prompt message):
//   - default / ordinary text  → cumulative "Hello" → "Hello world" stream
//   - message starts with "__block__" → hold until interrupt/abort or timeout
//   - message starts with "__crash__" → exit the worker process (new epoch)
//   - message starts with "__count__" → settle immediately; count only
//
// Protocol/Runtime Core separation is preserved: this module only implements
// the Runtime Core AgentRuntimeFactory / AgentRuntimePort surface.

import { randomUUID } from "node:crypto";

// D2-P1/D2-P2/P3/P4/P5: production light-command + queue + bash surface. Baseline
// queries (get_state / get_commands / get_last_assistant_text) are always
// available; runtime.stats (get_session_stats), runtime.session.rename
// (set_session_name), runtime.thinking.set (set_thinking_level), runtime.model.set
// (set_model), runtime.steer (steer), runtime.follow_up (follow_up), runtime.queue
// (clear_queue interrupt + set_auto_retry) and the D2-P5 bash pair
// runtime.bash (bash) / runtime.bash.abort (abort_bash) are the
// capability-gated unlocks.
const CAPABILITIES = {
  capabilities: [
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
  ],
  version: 1,
};

const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

// Deterministic no-network model catalog used by the fixture set_model path.
const MODELS = [
  { id: "claude-sonnet-4", provider: "anthropic", displayName: "Claude Sonnet 4", thinking: true },
  { id: "claude-opus-4", provider: "anthropic", displayName: "Claude Opus 4", thinking: true },
  { id: "gpt-5", provider: "openai", displayName: "GPT-5", thinking: true },
  { id: "gpt-5-mini", provider: "openai", displayName: "GPT-5 mini", thinking: false },
];

export default {
  async create(input) {
    const sessionId = `e2e-created-${randomUUID().slice(0, 8)}`;
    return makePort({
      cwd: input.cwd,
      sessionId,
      mode: "create",
    });
  },
  async open(input) {
    return makePort({
      cwd: input.cwd,
      sessionId: input.sessionId,
      mode: "open",
    });
  },
};

function makePort({ cwd, sessionId, mode }) {
  const listeners = new Set();
  let closed = false;
  let executeCount = 0;
  let interruptCount = 0;
  /** @type {{ resolve: (v: unknown) => void, reject: (e: unknown) => void, timer?: ReturnType<typeof setTimeout> } | null} */
  let blocked = null;
  let isPromptRunning = false;
  let isBashRunning = false;
  /** @type {{ resolve: (v: unknown) => void, reject: (e: unknown) => void, timer?: ReturnType<typeof setTimeout> } | null} */
  let blockedBash = null;
  let bashProjection = null;
  let sessionName = "";
  let messageCount = 0;
  let lastAssistantText = "";
  let thinkingLevel = "off";
  let thinkingLevelPinned = false;
  let model = { provider: "anthropic", id: "claude-sonnet-4" };
  let autoRetryEnabled = false;
  let queued = { steering: [], followUp: [] };

  const commands = [
    { name: "/compact", description: "Compact the session", source: "prompt" },
    { name: "/clear", source: "prompt" },
    { name: "skill:frontend", description: "Frontend codebase guidance", source: "skill" },
  ];

  const identity = {
    sessionId,
    sessionFile: `/sessions/${sessionId}.jsonl`,
  };

  function emit(event) {
    if (closed) return;
    for (const fn of [...listeners]) {
      try {
        fn(structuredClone(event));
      } catch {
        // listener errors must not break the fixture
      }
    }
  }

  function baseState() {
    return {
      sessionId,
      isStreaming: false,
      isPromptRunning,
      isBashRunning,
      isCompacting: false,
      model,
      messageCount,
      thinkingLevel,
      thinkingLevelPinned,
      autoRetryEnabled,
      queuedMessages: queued,
      pendingMessageCount: queued.steering.length + queued.followUp.length,
      ...(bashProjection === null ? {} : { bash: { ...bashProjection } }),
      ...(sessionName === "" ? {} : { sessionName }),
    };
  }

  return {
    identity,
    getCapabilities() {
      return structuredClone(CAPABILITIES);
    },
    async getSnapshot() {
      return {
        sessionId,
        state: baseState(),
        capabilities: structuredClone(CAPABILITIES),
      };
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    async execute(command) {
      executeCount += 1;
      switch (command.type) {
        case "get_state":
          return { ok: true, type: "get_state", state: baseState() };
        case "get_commands":
          return { ok: true, type: "get_commands", commands };
        case "get_last_assistant_text":
          return { ok: true, type: "get_last_assistant_text", text: lastAssistantText };
        case "get_session_stats":
          return {
            ok: true,
            type: "get_session_stats",
            stats: {
              messageCount,
              pendingMessageCount: 0,
              tokenCount: messageCount * 12,
            },
          };
        case "set_session_name": {
          const name = typeof command.name === "string" ? command.name.trim() : "";
          if (name === "") {
            return { ok: false, type: "set_session_name", error: { code: "invalid_input", message: "session name cannot be empty", retryable: false } };
          }
          sessionName = name;
          return { ok: true, type: "set_session_name" };
        }
        case "set_thinking_level": {
          const level = command.level;
          if (typeof level !== "string" || !THINKING_LEVELS.has(level)) {
            return {
              ok: false,
              type: "set_thinking_level",
              error: { code: "invalid_input", message: `unknown thinking level: ${String(level)}`, retryable: false },
            };
          }
          thinkingLevel = level;
          thinkingLevelPinned = true;
          return { ok: true, type: "set_thinking_level" };
        }
        case "set_model": {
          const provider = command.provider;
          const modelId = command.modelId;
          // Strictly non-empty: blank provider/modelId is invalid_input, never a
          // silently-ignored no-op (mirrors the production adapter gate).
          if (typeof provider !== "string" || provider.trim() === "" || typeof modelId !== "string" || modelId.trim() === "") {
            return {
              ok: false,
              type: "set_model",
              error: { code: "invalid_input", message: "model provider and modelId must be non-empty", retryable: false },
            };
          }
          const resolved = MODELS.find((m) => m.provider === provider && m.id === modelId);
          if (!resolved) {
            return {
              ok: false,
              type: "set_model",
              error: { code: "invalid_input", message: `unknown model: ${provider}/${modelId}`, retryable: false },
            };
          }
          model = { provider: resolved.provider, id: resolved.id };
          // set_model preserves the pinned thinking (mirrors the production
          // adapter's reapplyPinnedThinking); the snapshot carries both the new
          // model and the preserved pin.
          if (!thinkingLevelPinned) {
            thinkingLevel = "off";
            thinkingLevelPinned = false;
          }
          return { ok: true, type: "set_model" };
        }
        // Closed production surface: tools/reload must stay unsupported.
        case "set_tools":
          return { ok: false, type: "set_tools", error: { code: "unsupported_capability", message: "runtime.tools.write not available", retryable: false } };
        // keep toolNames accepted by protocol shape but still closed by capability
        case "reload":
          return { ok: false, type: "reload", error: { code: "unsupported_capability", message: "runtime.reload not available", retryable: false } };
        case "steer": {
          const steerText = typeof command.message === "string" ? command.message.trim() : "";
          if (steerText === "") {
            return { ok: false, type: "steer", error: { code: "invalid_input", message: "message cannot be empty", retryable: false } };
          }
          queued = { ...queued, steering: [...queued.steering, { message: steerText }] };
          emit({ type: "queue_update", sessionId, steering: queued.steering, followUp: queued.followUp });
          return { ok: true, type: "steer" };
        }
        case "follow_up": {
          const followText = typeof command.message === "string" ? command.message.trim() : "";
          if (followText === "") {
            return { ok: false, type: "follow_up", error: { code: "invalid_input", message: "message cannot be empty", retryable: false } };
          }
          queued = { ...queued, followUp: [...queued.followUp, { message: followText }] };
          emit({ type: "queue_update", sessionId, steering: queued.steering, followUp: queued.followUp });
          return { ok: true, type: "follow_up" };
        }
        case "set_auto_retry": {
          if (typeof command.enabled !== "boolean") {
            return { ok: false, type: "set_auto_retry", error: { code: "invalid_input", message: "enabled must be a boolean", retryable: false } };
          }
          autoRetryEnabled = command.enabled;
          return { ok: true, type: "set_auto_retry" };
        }
        case "bash": {
          const bashText = typeof command.command === "string" ? command.command : "";
          if (bashText.trim() === "") {
            return { ok: false, type: "bash", error: { code: "invalid_input", message: "command cannot be empty", retryable: false } };
          }
          if (isBashRunning) {
            return { ok: false, type: "bash", error: { code: "session_busy", message: "a bash command is already running", retryable: true } };
          }
          isBashRunning = true;
          const excludeFromContext = command.excludeFromContext === true;
          bashProjection = {
            command: bashText,
            output: "",
            excludeFromContext,
            truncated: false,
            cancelled: false,
            completed: false,
            updateCount: 1,
          };
          // Emit a start delta (empty output) so a consumer can observe the bash
          // has begun without polling (the long-running bash command sits on the
          // Host serial lane, so getSnapshot would HOL behind it — events do not).
          emit({ type: "bash_update", sessionId, command: bashText, output: "", ...(excludeFromContext ? { excludeFromContext } : {}) });
          // Deterministic delta stream (bash_update.output is a per-event DELTA,
          // the shared projection concatenates to the exact accumulated output).
          const pushChunk = (chunk) => {
            bashProjection = { ...bashProjection, output: `${bashProjection.output}${chunk}`, updateCount: bashProjection.updateCount + 1 };
            emit({ type: "bash_update", sessionId, command: bashText, output: chunk, ...(excludeFromContext ? { excludeFromContext } : {}) });
          };
          if (bashText.startsWith("__block__")) {
            // Controllable long bash: hold until abort_bash (or hard timeout).
            const holdMs = 30_000;
            const result = await new Promise((resolve, reject) => {
              const timer = setTimeout(() => {
                blockedBash = null;
                resolve({ kind: "timeout" });
              }, holdMs);
              blockedBash = {
                resolve: (value) => {
                  clearTimeout(timer);
                  blockedBash = null;
                  resolve(value);
                },
                reject: (error) => {
                  clearTimeout(timer);
                  blockedBash = null;
                  reject(error);
                },
                timer,
              };
            });
            if (result?.kind === "aborted") {
              bashProjection = { ...bashProjection, cancelled: true, completed: true, updateCount: bashProjection.updateCount + 1 };
              emit({ type: "bash_update", sessionId, command: bashText, cancelled: true, truncated: false });
              isBashRunning = false;
              return { ok: false, type: "bash", error: { code: "interrupted", message: "bash aborted", retryable: true } };
            }
            // Timeout fallback: still settle so the E2E never hangs.
            bashProjection = { ...bashProjection, exitCode: 0, completed: true, updateCount: bashProjection.updateCount + 1 };
            emit({ type: "bash_update", sessionId, command: bashText, exitCode: 0, truncated: false });
            isBashRunning = false;
            return { ok: true, type: "bash" };
          }
          pushChunk("line 1\n");
          await delay(10);
          pushChunk("line 2\n");
          await delay(10);
          bashProjection = { ...bashProjection, exitCode: 0, completed: true, updateCount: bashProjection.updateCount + 1 };
          emit({ type: "bash_update", sessionId, command: bashText, exitCode: 0, truncated: false });
          isBashRunning = false;
          return { ok: true, type: "bash" };
        }
        case "abort_bash":
          // Ordinary-command form of the abort_bash control (the Client sends it
          // over the independent interrupt path, but the Core command must also
          // preempt a running bash).
          if (blockedBash) {
            blockedBash.resolve({ kind: "aborted" });
          }
          return { ok: true, type: "abort_bash" };
        default:
          break;
      }
      if (command.type !== "prompt") {
        return { ok: true, type: command.type };
      }

      const message = typeof command.message === "string" ? command.message : "";
      if (message.startsWith("__crash__")) {
        // Fail the worker process so sessiond opens a new epoch.
        setTimeout(() => process.exit(17), 20);
        // Hang the command until the process dies.
        return await new Promise(() => {});
      }
      if (message.startsWith("__count__")) {
        return { ok: true, type: "prompt" };
      }

      isPromptRunning = true;
      emit({ type: "agent_start", sessionId });

      if (message.startsWith("__block__")) {
        // Controllable long prompt: wait for interrupt (or hard timeout).
        const holdMs = 30_000;
        const result = await new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            blocked = null;
            resolve({ kind: "timeout" });
          }, holdMs);
          blocked = {
            resolve: (value) => {
              clearTimeout(timer);
              blocked = null;
              resolve(value);
            },
            reject: (error) => {
              clearTimeout(timer);
              blocked = null;
              reject(error);
            },
            timer,
          };
        });

        isPromptRunning = false;
        if (result?.kind === "aborted") {
          emit({
            type: "prompt_error",
            sessionId,
            errorMessage: "interrupted",
            error: { code: "interrupted", message: "interrupted", retryable: false },
          });
          return {
            ok: false,
            type: "prompt",
            error: { code: "interrupted", message: "interrupted", retryable: false },
          };
        }
        // Timeout fallback: still settle so the E2E does not hang forever.
        emit({ type: "prompt_done", sessionId });
        return { ok: true, type: "prompt" };
      }

      // Deterministic cumulative partial stream. Mapper diffs into wire deltas.
      emit({
        type: "message_update",
        sessionId,
        message: { role: "assistant", content: [{ type: "text", text: "Hello" }] },
      });
      // Small yield so the stream is multi-frame on the wire.
      await delay(5);
      emit({
        type: "message_update",
        sessionId,
        message: { role: "assistant", content: [{ type: "text", text: "Hello world" }] },
      });
      await delay(5);
      emit({
        type: "message_end",
        sessionId,
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Hello world" }],
          model: "e2e-fixture",
          provider: "e2e",
        },
      });
      emit({ type: "prompt_done", sessionId });
      isPromptRunning = false;
      messageCount += 1;
      lastAssistantText = "Hello world";
      return { ok: true, type: "prompt" };
    },
    async interrupt(interrupt) {
      interruptCount += 1;
      if (interrupt.type === "abort" && blocked) {
        blocked.resolve({ kind: "aborted" });
      }
      if (interrupt.type === "abort_bash" && blockedBash) {
        blockedBash.resolve({ kind: "aborted" });
      }
      if (interrupt.type === "clear_queue") {
        queued = { steering: [], followUp: [] };
        emit({ type: "queue_update", sessionId, steering: [], followUp: [] });
      }
      return { ok: true, type: interrupt.type };
    },
    async close() {
      closed = true;
      if (blocked) {
        blocked.resolve({ kind: "closed" });
      }
      if (blockedBash) {
        blockedBash.resolve({ kind: "closed" });
      }
      listeners.clear();
    },
    // Diagnostics for tests that inspect the port (not used over the wire).
    get __e2e() {
      return { executeCount, interruptCount, cwd, mode, sessionId };
    },
  };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
