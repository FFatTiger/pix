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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// D2-P1/D2-P2/P3/P4/P5/P6/P7: production light-command + queue + bash +
// tools/reload + manual-compact surface. Baseline queries
// (get_state / get_commands / get_last_assistant_text) are always available;
// runtime.stats (get_session_stats), runtime.session.rename (set_session_name),
// runtime.thinking.set (set_thinking_level), runtime.model.set (set_model),
// runtime.steer (steer), runtime.follow_up (follow_up), runtime.queue
// (clear_queue interrupt + set_auto_retry), the D2-P5 bash pair
// runtime.bash (bash) / runtime.bash.abort (abort_bash), the D2-P6 tools+
// reload triple runtime.tools.read (get_tools) / runtime.tools.write (set_tools)
// / runtime.reload (reload), the D2-P7 manual-compact pair
// runtime.compact (compact) / runtime.compact.abort (abort_compaction), the
// D2-P8 extension-UI token runtime.extension_ui (extension_ui_response /
// extension_ui_input), the D2 navigate token runtime.navigate (navigate_tree),
// the D2 fork token runtime.fork (fork) and the D2 auto_name token
// runtime.auto_name (generate_session_title) are the capability-gated unlocks —
// every runtime command is now open.
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
    "runtime.tools.read",
    "runtime.tools.write",
    "runtime.reload",
    "runtime.compact",
    "runtime.compact.abort",
    "runtime.extension_ui",
    "runtime.navigate",
    "runtime.fork",
    "runtime.auto_name",
  ],
  version: 1,
};

// Deterministic no-network builtin tool catalog used by the fixture get_tools /
// set_tools / reload paths. Mirrors the production SDK builtin names.
const TOOLS = [
  { name: "read", description: "Read a file", active: true },
  { name: "write", description: "Write a file", active: true },
  { name: "edit", description: "Edit a file", active: true },
  { name: "bash", description: "Run a shell command", active: true },
  { name: "grep", description: "Search file contents", active: true },
  { name: "find", description: "Find files", active: true },
  { name: "ls", description: "List a directory", active: true },
];
const TOOL_NAMES = new Set(TOOLS.map((tool) => tool.name));

// Fixture command → required capability gate (mirrors the production adapter's
// RUNTIME_COMMAND_CAPABILITIES). Commands whose required token is absent from
// the fixture CAPABILITIES are answered `unsupported_capability` (never a fake
// success), keeping closed surfaces honest.
const REQUIRED_CAP = {
  prompt: "runtime.prompt",
  abort: "runtime.abort",
  set_model: "runtime.model.set",
  fork: "runtime.fork",
  navigate_tree: "runtime.navigate",
  set_thinking_level: "runtime.thinking.set",
  compact: "runtime.compact",
  set_session_name: "runtime.session.rename",
  get_session_stats: "runtime.stats",
  set_auto_compaction: "runtime.compact",
  clear_queue: "runtime.queue",
  steer: "runtime.steer",
  follow_up: "runtime.follow_up",
  get_tools: "runtime.tools.read",
  set_tools: "runtime.tools.write",
  reload: "runtime.reload",
  abort_compaction: "runtime.compact.abort",
  extension_ui_response: "runtime.extension_ui",
  extension_ui_input: "runtime.extension_ui",
  set_auto_retry: "runtime.queue",
  bash: "runtime.bash",
  abort_bash: "runtime.bash.abort",
  generate_session_title: "runtime.auto_name",
};
const OPEN_CAPS = new Set(CAPABILITIES.capabilities);

// Fixture interrupt → required capability gate (mirrors the production
// adapter's RUNTIME_INTERRUPT_CAPABILITIES).
const INTERRUPT_REQUIRED_CAP = {
  abort: "runtime.abort",
  abort_compaction: "runtime.compact.abort",
  abort_bash: "runtime.bash.abort",
  clear_queue: "runtime.queue",
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
      toolNames: input.toolNames,
      thinkingLevel: input.thinkingLevel,
      thinkingLevelPinned: input.thinkingLevelPinned,
    });
  },
  async open(input) {
    // A forked session (created by a prior worker that has since exited) is
    // restored from the on-disk registry so its fork-point history survives the
    // client-driven attach into a fresh worker.
    const restored = loadForkedSession(input.cwd, input.sessionId);
    return makePort({
      cwd: input.cwd,
      sessionId: input.sessionId,
      mode: "open",
      ...(restored === null ? {} : { restored }),
    });
  },
};

// Persist a forked session under the project dir so a NEW worker (spawned for
// client-driven attach after the fork returns) can restore its fork-point
// history. The old worker process that performed the fork exits (sessiond
// identity-lane stop), so the forked session data must survive on the shared
// filesystem keyed by the session id. Mirrors the production SDK writing a new
// JSONL session file that the read-only catalog later resolves.
function persistForkedSession(cwd, data) {
  const dir = join(cwd, ".pix-e2e-sessions");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${data.sessionId}.json`), JSON.stringify(data), "utf8");
}

function loadForkedSession(cwd, sessionId) {
  const file = join(cwd, ".pix-e2e-sessions", `${sessionId}.json`);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function makePort({ cwd, sessionId, mode, toolNames: initialToolNames, thinkingLevel: initialThinkingLevel, thinkingLevelPinned: initialThinkingLevelPinned, restored }) {
  const listeners = new Set();
  let closed = false;
  let executeCount = 0;
  let interruptCount = 0;
  /** @type {{ resolve: (v: unknown) => void, reject: (e: unknown) => void, timer?: ReturnType<typeof setTimeout> } | null} */
  let blocked = null;
  let isPromptRunning = false;
  let isBashRunning = false;
  let isCompacting = false;
  /** @type {{ reason: string, status: string, customInstructions?: string, startedAt?: number } | null} */
  let compaction = null;
  /** @type {{ resolve: (v: unknown) => void, reject: (e: unknown) => void, timer?: ReturnType<typeof setTimeout> } | null} */
  let blockedCompact = null;
  /** @type {{ resolve: (v: unknown) => void, reject: (e: unknown) => void, timer?: ReturnType<typeof setTimeout> } | null} */
  let blockedBash = null;
  let bashProjection = null;
  let sessionName = "";
  let messageCount = 0;
  // D2-P7 deterministic message history + context usage (compact trims both).
  /** @type {{ role: string, content: unknown }[]} */
  let messages = [];
  // D2 navigate deterministic session-tree model: every prompt appends one
  // assistant entry whose parent is the current leaf; navigate moves the leaf
  // pointer and rebuilds the visible history from root→leaf. D2 fork forks at
  // an entry: the forked session's tree is the root→fork-point path.
  /** @type {{ id: string, parentId: string | null, text: string }[]} */
  let entries = [];
  /** @type {string | null} */
  let leafId = null;
  let entrySeq = 0;
  let contextUsage = { percent: 0, contextWindow: 200_000, tokens: 0 };
  let lastAssistantText = "";
  let thinkingLevel = "off";
  let thinkingLevelPinned = false;
  let model = { provider: "anthropic", id: "claude-sonnet-4" };
  let autoCompactionEnabled = false;
  let autoRetryEnabled = false;
  // Restore a forked session's fork-point history + state (client-driven attach
  // after fork returns spawns a NEW worker; the data was persisted on disk by
  // the forking worker).
  if (restored) {
    messageCount = restored.messageCount ?? 0;
    messages = structuredClone(restored.messages ?? []);
    entries = structuredClone(restored.entries ?? []);
    leafId = restored.leafId ?? (entries.at(-1)?.id ?? null);
    entrySeq = Math.max(0, ...entries.map((entry) => Number(/^entry-(\d+)$/.exec(entry.id)?.[1] ?? 0)));
    if (restored.contextUsage) contextUsage = structuredClone(restored.contextUsage);
    if (restored.sessionName) sessionName = restored.sessionName;
    if (typeof restored.thinkingLevel === "string") thinkingLevel = restored.thinkingLevel;
    if (typeof restored.thinkingLevelPinned === "boolean") thinkingLevelPinned = restored.thinkingLevelPinned;
    if (restored.model) model = structuredClone(restored.model);
    if (typeof restored.autoRetryEnabled === "boolean") autoRetryEnabled = restored.autoRetryEnabled;
    if (typeof restored.autoCompactionEnabled === "boolean") autoCompactionEnabled = restored.autoCompactionEnabled;
  }
  let queued = { steering: [], followUp: [] };
  // D2-P8 extension UI state. Each pending request carries the published
  // request, its settle promise, and the accumulated incremental input.
  /** @type {{ request: object, resolve: (v: { cancelled: boolean, abort: boolean, data: string }) => void, timer?: ReturnType<typeof setTimeout>, data: string, settled: boolean }[]} */
  let pendingUi = [];
  let extensionStatuses = [{ key: "model", text: "e2e-fixture" }];
  let extensionWidgets = [{ key: "summary", lines: ["line1", "line2"], placement: "belowEditor" }];
  // D2-P6 tools state: active tool names (mirrors the SDK getActiveToolNames).
  let activeToolNames = TOOLS.map((tool) => tool.name);
  /** Last configured tool selection (reload re-applies it). */
  let configuredToolNames = null;
  let systemPrompt = "fixture system prompt";
  // Apply create-time inputs (toolNames / thinkingLevel / thinkingLevelPinned).
  if (Array.isArray(initialToolNames)) {
    const trimmed = [];
    const seen = new Set();
    for (const value of initialToolNames) {
      const name = typeof value === "string" ? value.trim() : "";
      if (name !== "" && !seen.has(name)) { seen.add(name); trimmed.push(name); }
    }
    activeToolNames = [...trimmed];
    configuredToolNames = [...trimmed];
    if (trimmed.length === 0) systemPrompt = "";
  }
  if (typeof initialThinkingLevel === "string" && THINKING_LEVELS.has(initialThinkingLevel)) thinkingLevel = initialThinkingLevel;
  if (initialThinkingLevelPinned === true) thinkingLevelPinned = true;

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

  // D2 navigate deterministic branch helpers. `branchPath` walks the parent
  // chain from a target entry to the root (the visible history of that leaf);
  // `rebuildMessages` rewrites the authoritative `messages`/`messageCount` to
  // the selected leaf's path so getSnapshot / get_state / detach/reattach all
  // converge to the navigated state.
  function branchPath(targetId) {
    const byId = new Map(entries.map((entry) => [entry.id, entry]));
    const path = [];
    const seen = new Set();
    let current = targetId;
    while (current !== null && current !== undefined && !seen.has(current)) {
      seen.add(current);
      const entry = byId.get(current);
      if (!entry) break;
      path.unshift(entry);
      current = entry.parentId;
    }
    return path;
  }

  function rebuildMessages(targetId) {
    messages = branchPath(targetId).map((entry) => ({
      role: "assistant",
      content: [{ type: "text", text: entry.text }],
      model: "e2e-fixture",
      provider: "e2e",
    }));
    messageCount = messages.length;
  }

  // Protocol v2: commit a message entry to the session tree (append as child of
  // the current leaf, advance the leaf) and return its persisted identity.
  function commitEntry(text) {
    entrySeq += 1;
    const entry = { id: `entry-${entrySeq}`, parentId: leafId, text };
    entries = [...entries, entry];
    leafId = entry.id;
    return entry;
  }

  function baseState() {
    return {
      sessionId,
      isStreaming: false,
      isPromptRunning,
      isBashRunning,
      isCompacting,
      ...(leafId === null ? {} : { leafId }),
      ...(compaction === null ? {} : { compaction: { ...compaction } }),
      model,
      messageCount,
      ...(contextUsage === null ? {} : { contextUsage: { ...contextUsage } }),
      autoCompactionEnabled,
      thinkingLevel,
      thinkingLevelPinned,
      autoRetryEnabled,
      queuedMessages: queued,
      pendingMessageCount: queued.steering.length + queued.followUp.length,
      systemPrompt,
      tools: TOOLS.map((tool) => ({ ...tool, active: activeToolNames.includes(tool.name) })),
      ...(bashProjection === null ? {} : { bash: { ...bashProjection } }),
      ...(sessionName === "" ? {} : { sessionName }),
      extensionStatuses: structuredClone(extensionStatuses),
      extensionWidgets: structuredClone(extensionWidgets),
      pendingExtensionUi: pendingUi.map((entry) => ({ ...entry.request })),
    };
  }

  // D2-P8 extension UI machinery (mirrors the real adapter's canonical close
  // semantics + exact-method correlation):
  //  - publish emits extension_ui_request; settle emits EXACTLY ONE close
  //    tombstone (closed:true) and removes the request;
  //  - wrong-method response/input is structured invalid_input and the request
  //    stays pending/usable (never settled); unknown id is not_found;
  //  - a hard ≤30s failsafe settles a stuck request so the E2E can never hang
  //    (it never converts a real failure into a pass — the E2E always settles
  //    correctly first).
  function settleUi(entry, { cancelled, abort }, data = "") {
    if (entry.settled) return;
    entry.settled = true;
    if (entry.timer !== undefined) clearTimeout(entry.timer);
    pendingUi = pendingUi.filter((item) => item !== entry);
    // Canonical close tombstone for the SAME request — the projection removes
    // it and never stores the tombstone (replay cannot resurrect).
    emit({ type: "extension_ui_request", sessionId, request: { ...entry.request, closed: true } });
    emit({ type: "runtime_state_changed", sessionId });
    entry.resolve({ cancelled, abort, data });
  }

  function waitForUi(request) {
    return new Promise((resolve) => {
      const entry = { request, resolve, data: "", settled: false, baseLines: Array.isArray(request.lines) ? [...request.lines] : undefined, updates: 0 };
      pendingUi = [...pendingUi, entry];
      emit({ type: "extension_ui_request", sessionId, request });
      emit({ type: "runtime_state_changed", sessionId });
      // Hard failsafe (≤30s) purely to prevent hangs; never converts failure to pass.
      entry.timer = setTimeout(() => settleUi(entry, { cancelled: true, abort: false }), 30_000);
    });
  }

  function cancelAllUi(abort) {
    for (const entry of [...pendingUi]) settleUi(entry, { cancelled: true, abort });
  }

  function buildUiRequest(method, message) {
    const base = { id: `ui-${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${method}` };
    switch (method) {
      case "select": return { ...base, method, title: "Choose", options: ["opt-a", "opt-b"] };
      case "confirm": return { ...base, method, title: "Confirm", message: "Continue?" };
      case "input": return { ...base, method, title: "Enter", placeholder: "value" };
      case "editor": return { ...base, method, title: "Edit", prefill: "prefill" };
      case "custom": return { ...base, method, lines: ["Custom UI lines"] };
      default: throw new Error(`unknown ui method: ${method}`);
    }
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
        // Protocol v2: the snapshot is control/reconnect state only — it never
        // carries completed transcript history.
      };
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    async read(request) {
      const required = REQUIRED_CAP[request.type];
      if (required !== undefined && !OPEN_CAPS.has(required)) {
        return { ok: false, type: request.type, error: { code: "unsupported_capability", message: `${required} not available`, retryable: false } };
      }
      switch (request.type) {
        case "get_state": return { ok: true, type: "get_state", state: baseState() };
        case "get_commands": return { ok: true, type: "get_commands", commands };
        case "get_last_assistant_text": return { ok: true, type: "get_last_assistant_text", text: lastAssistantText };
        case "get_session_stats": return { ok: true, type: "get_session_stats", stats: { messageCount, pendingMessageCount: 0, tokenCount: messageCount * 12 } };
        case "get_tools": return { ok: true, type: "get_tools", tools: TOOLS.map((tool) => ({ ...tool, active: activeToolNames.includes(tool.name) })) };
      }
    },
    async submitTurn(input) {
      const snapshotNow = () => ({
        sessionId,
        state: baseState(),
        capabilities: { capabilities: [...OPEN_CAPS], version: 1 },
        streaming: { active: isPromptRunning, phase: isPromptRunning ? "waiting_model" : "idle" },
      });
      const reject = async (error) => {
        const snapshot = snapshotNow();
        return { admission: { ok: false, error, snapshot }, completion: Promise.resolve({ ok: false, error, snapshot }) };
      };
      if (isPromptRunning) {
        return reject({ code: "session_busy", message: "a prompt is already in progress", retryable: true });
      }
      if (typeof input.prompt !== "string" || input.prompt.trim().length === 0) {
        return reject({ code: "invalid_input", message: "prompt must be non-empty", retryable: false });
      }
      if (input.activationOverrides?.model !== undefined) {
        const selector = input.activationOverrides.model;
        if (typeof selector.provider !== "string" || !selector.provider.trim() || typeof selector.modelId !== "string" || !selector.modelId.trim()) {
          return reject({ code: "invalid_input", message: "model selector is invalid", retryable: false });
        }
        model = selector;
      }
      if (input.activationOverrides?.thinkingLevel !== undefined) {
        const levels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
        if (!levels.includes(input.activationOverrides.thinkingLevel)) {
          return reject({ code: "invalid_input", message: "thinking level is invalid", retryable: false });
        }
        thinkingLevel = input.activationOverrides.thinkingLevel;
        thinkingLevelPinned = true;
      }
      isPromptRunning = true;
      const completion = (async () => {
        try {
          const result = await this.execute({
            type: "prompt",
            message: input.prompt,
            ...(input.images === undefined || input.images.length === 0 ? {} : { images: input.images }),
          });
          const snapshot = snapshotNow();
          return result.ok
            ? { ok: true, snapshot }
            : { ok: false, error: result.error, snapshot };
        } finally {
          isPromptRunning = false;
        }
      })();
      return { admission: { ok: true, snapshot: snapshotNow() }, completion };
    },
    async execute(command) {
      executeCount += 1;
      // Capability gate: a closed command answers unsupported_capability exactly
      // like the production adapter gate (never a fake success).
      const required = REQUIRED_CAP[command.type];
      if (required !== undefined && !OPEN_CAPS.has(required)) {
        return { ok: false, type: command.type, error: { code: "unsupported_capability", message: `${required} not available`, retryable: false } };
      }
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
        case "generate_session_title": {
          // Mirrors the production adapter seam: derives a deterministic title
          // from the last assistant text (or a session-id fallback), applies it
          // as the session name, emits session_title, and returns it in the RPC
          // result — sessiond publishes the §51 title overlay from the result
          // (single source of truth).
          const text = typeof lastAssistantText === "string" ? lastAssistantText.trim() : "";
          const title = text ? text.slice(0, 80) : `Session ${sessionId.slice(0, 8)}`;
          sessionName = title;
          emit({ type: "session_title", sessionId, name: title });
          return { ok: true, type: "generate_session_title", title };
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
        // D2-P6 tools + reload: capability-gated unlocks with strict
        // trim/dedupe/nonempty and unknown-tool structured failure.
        case "get_tools":
          return {
            ok: true,
            type: "get_tools",
            tools: TOOLS.map((tool) => ({ ...tool, active: activeToolNames.includes(tool.name) })),
          };
        case "set_tools": {
          const raw = Array.isArray(command.toolNames) ? command.toolNames : [];
          const trimmed = [];
          const seen = new Set();
          for (const value of raw) {
            const name = typeof value === "string" ? value.trim() : "";
            if (name === "") {
              return { ok: false, type: "set_tools", error: { code: "invalid_input", message: "tool names must be non-empty", retryable: false } };
            }
            if (!seen.has(name)) { seen.add(name); trimmed.push(name); }
          }
          const unknown = trimmed.find((name) => !TOOL_NAMES.has(name));
          if (unknown !== undefined) {
            return { ok: false, type: "set_tools", error: { code: "invalid_input", message: `unknown tool: ${unknown}`, retryable: false } };
          }
          activeToolNames = [...trimmed];
          configuredToolNames = [...trimmed];
          // All-tools-off clears the system prompt (mirrors production).
          if (trimmed.length === 0) systemPrompt = "";
          return { ok: true, type: "set_tools" };
        }
        case "reload": {
          // Reload re-applies the configured tools (or all-off), restores the
          // non-empty system prompt unless all tools are off, and bumps the
          // capability version. Never broadens beyond the fixed production set.
          if (configuredToolNames !== null) {
            activeToolNames = [...configuredToolNames];
            if (configuredToolNames.length === 0) systemPrompt = "";
            else if (systemPrompt === "") systemPrompt = "fixture system prompt";
          }
          CAPABILITIES.version += 1;
          return { ok: true, type: "reload" };
        }
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
        case "set_auto_compaction": {
          if (typeof command.enabled !== "boolean") {
            return { ok: false, type: "set_auto_compaction", error: { code: "invalid_input", message: "enabled must be a boolean", retryable: false } };
          }
          autoCompactionEnabled = command.enabled;
          return { ok: true, type: "set_auto_compaction" };
        }
        case "fork": {
          // D2 fork busy guard (mirrors the production adapter): reject with a
          // structured session_busy while a prompt (incl. one blocked on an
          // extension request), bash command, or compaction is in flight — the
          // in-flight turn is never corrupted and the runtime is NOT closed.
          if (isPromptRunning || isBashRunning || isCompacting) {
            return { ok: false, type: "fork", error: { code: "session_busy", message: "a prompt, bash command, or compaction is already in progress", retryable: true } };
          }
          const forkEntryId = typeof command.entryId === "string" ? command.entryId : "";
          const forkIndex = entries.findIndex((entry) => entry.id === forkEntryId);
          if (forkEntryId === "" || forkIndex < 0) {
            // The fork point never echoes the entry id (fixed sanitized error).
            return { ok: false, type: "fork", error: { code: "invalid_input", message: "fork point not found", retryable: false } };
          }
          const forkedSessionId = `e2e-forked-${randomUUID().slice(0, 8)}`;
          // Fork-point history: the root→fork-point path (mirrors the production
          // SDK createBranchedSession + pix-fork-provenance entry — full
          // provenance: parent session + fork point).
          const forkedPath = branchPath(forkEntryId);
          const forkedHistory = forkedPath.map((entry) => ({
            role: "assistant",
            content: [{ type: "text", text: entry.text }],
            model: "e2e-fixture",
            provider: "e2e",
          }));
          persistForkedSession(cwd, {
            sessionId: forkedSessionId,
            cwd,
            messageCount: forkedHistory.length,
            messages: structuredClone(forkedHistory),
            entries: structuredClone(forkedPath),
            leafId: forkEntryId,
            forkPointEntryId: forkEntryId,
            parentSessionId: sessionId,
            contextUsage: { ...contextUsage },
            sessionName,
            thinkingLevel,
            thinkingLevelPinned,
            model: { ...model },
            autoRetryEnabled,
            autoCompactionEnabled,
          });
          return { ok: true, type: "fork", forkedSessionId, forkPointEntryId: forkEntryId };
        }
        case "abort_compaction":
          if (blockedCompact) {
            blockedCompact.resolve({ kind: "aborted" });
          }
          return { ok: true, type: "abort_compaction" };
        case "compact": {
          // D2-P7 deterministic manual compact (mirrors the real SDK contract):
          // reject while already compacting; otherwise emit compaction_start(manual),
          // hold when customInstructions starts with __block__ until abort_compaction
          // (or a hard ≤30s test-infrastructure failsafe — not an acceptance
          // timeout), then deterministically trim the message/history count and
          // context usage, emit compaction_end success, and answer ok:true. On an
          // abort the command answers `interrupted` with a compaction_end(aborted)
          // event and clears compaction state (no orphan hold).
          const custom = typeof command.customInstructions === "string" ? command.customInstructions : undefined;
          if (isCompacting) {
            return { ok: false, type: "compact", error: { code: "session_busy", message: "a compaction is already running", retryable: true } };
          }
          isCompacting = true;
          compaction = {
            reason: "manual",
            status: "running",
            ...(custom === undefined ? {} : { customInstructions: custom }),
            startedAt: Date.now(),
          };
          emit({ type: "compaction_start", sessionId, reason: "manual" });
          if (custom !== undefined && custom.startsWith("__block__")) {
            const holdMs = 30_000;
            const result = await new Promise((resolve, reject) => {
              const timer = setTimeout(() => {
                blockedCompact = null;
                resolve({ kind: "timeout" });
              }, holdMs);
              blockedCompact = {
                resolve: (value) => {
                  clearTimeout(timer);
                  blockedCompact = null;
                  resolve(value);
                },
                reject: (error) => {
                  clearTimeout(timer);
                  blockedCompact = null;
                  reject(error);
                },
                timer,
              };
            });
            if (result?.kind === "aborted") {
              isCompacting = false;
              compaction = null;
              emit({ type: "compaction_end", sessionId, reason: "manual", aborted: true });
              // Phase 5A parity: compaction terminal publishes the authoritative
              // current leaf (unchanged by an aborted compaction).
              if (leafId !== null) emit({ type: "session_changed", sessionId, cwd, leafId });
              return { ok: false, type: "compact", error: { code: "interrupted", message: "compaction aborted", retryable: true } };
            }
            // Hard failsafe timeout: still settle so the E2E never hangs.
          }
          // Deterministic trim: remove the first two messages, shrink context usage.
          const trimmed = messages.length <= 2 ? [] : messages.slice(2);
          messages = trimmed;
          messageCount = trimmed.length;
          // Keep the D2 navigate branch model consistent with the trimmed
          // history: the surviving tree is the CURRENT LEAF's root→leaf path
          // (messages are the navigated path, NOT the insertion tail — a
          // slice(-N) of the insertion order would desync leafId from the
          // visible history after a navigate). Trim the path's oldest two
          // entries to mirror the message trim, keep the leaf as the path's
          // last entry, and rebuild messages from the surviving path so
          // leafId ↔ visible history stay mutually consistent.
          const pathBefore = leafId === null ? [] : branchPath(leafId);
          const survivingPath = pathBefore.length <= 2 ? [] : pathBefore.slice(2);
          entries = survivingPath;
          leafId = survivingPath.length === 0 ? null : survivingPath.at(-1).id;
          if (leafId !== null) rebuildMessages(leafId);
          contextUsage = {
            percent: Math.max(0, contextUsage.percent - 30),
            contextWindow: contextUsage.contextWindow,
            tokens: Math.max(0, contextUsage.tokens - 40_000),
          };
          isCompacting = false;
          compaction = null;
          emit({ type: "compaction_end", sessionId, reason: "manual", aborted: false });
          // Phase 5A parity: the compact terminal publishes the post-compaction
          // authoritative leaf (omitted when the trimmed path has no entries).
          if (leafId !== null) emit({ type: "session_changed", sessionId, cwd, leafId });
          return { ok: true, type: "compact" };
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
              const abortedEntry = commitEntry(bashText);
              emit({ type: "bash_update", sessionId, command: bashText, cancelled: true, truncated: false, entryId: abortedEntry.id, ...(abortedEntry.parentId === null ? {} : { parentEntryId: abortedEntry.parentId }) });
              isBashRunning = false;
              return { ok: false, type: "bash", error: { code: "interrupted", message: "bash aborted", retryable: true } };
            }
            // Timeout fallback: still settle so the E2E never hangs.
            bashProjection = { ...bashProjection, exitCode: 0, completed: true, updateCount: bashProjection.updateCount + 1 };
            const timeoutEntry = commitEntry(bashText);
            emit({ type: "bash_update", sessionId, command: bashText, exitCode: 0, truncated: false, entryId: timeoutEntry.id, ...(timeoutEntry.parentId === null ? {} : { parentEntryId: timeoutEntry.parentId }) });
            isBashRunning = false;
            return { ok: true, type: "bash" };
          }
          pushChunk("line 1\n");
          await delay(10);
          pushChunk("line 2\n");
          await delay(10);
          bashProjection = { ...bashProjection, exitCode: 0, completed: true, updateCount: bashProjection.updateCount + 1 };
          const bashEntry = commitEntry(bashText);
          emit({ type: "bash_update", sessionId, command: bashText, exitCode: 0, truncated: false, entryId: bashEntry.id, ...(bashEntry.parentId === null ? {} : { parentEntryId: bashEntry.parentId }) });
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
        case "navigate_tree": {
          // D2 navigate (mirrors the production adapter guard): reject with
          // session_busy while a prompt/bash/compaction is in flight BEFORE any
          // mutation, reject blank/missing targets as invalid_input, and reject
          // unknown leaf references as invalid_input (never a fake success). On
          // success move the leaf and rebuild the authoritative history.
          const targetId = typeof command.targetId === "string" ? command.targetId : "";
          if (targetId.trim() === "") {
            return { ok: false, type: "navigate_tree", error: { code: "invalid_input", message: "navigation target is required", retryable: false } };
          }
          if (isPromptRunning || isBashRunning || isCompacting) {
            return { ok: false, type: "navigate_tree", error: { code: "session_busy", message: "a prompt, bash command, or compaction is already in progress", retryable: true } };
          }
          if (!entries.some((entry) => entry.id === targetId)) {
            return { ok: false, type: "navigate_tree", error: { code: "invalid_input", message: "navigation target is invalid", retryable: false } };
          }
          leafId = targetId;
          rebuildMessages(targetId);
          // Phase 5A parity with the production adapter: a successful navigate
          // publishes the canonical session_changed event (cwd + moved leaf) —
          // the worker mapper projects it onto the Protocol frame and sessiond
          // journals/forwards it, so consumers leaf-fence rebase end-to-end.
          emit({ type: "session_changed", sessionId, cwd, leafId });
          emit({ type: "runtime_state_changed", sessionId });
          return { ok: true, type: "navigate_tree" };
        }
        case "extension_ui_response": {
          const entry = pendingUi.find((item) => item.request.id === command.id);
          if (!entry) {
            return { ok: false, type: "extension_ui_response", error: { code: "not_found", message: `no pending extension UI request: ${command.id}`, retryable: false } };
          }
          // Exact method correlation: wrong method is invalid_input and the
          // request stays pending/usable (no settle, no close).
          if (entry.request.method !== command.method) {
            return { ok: false, type: "extension_ui_response", error: { code: "invalid_input", message: `extension response method mismatch for request ${command.id}`, retryable: false } };
          }
          const cancelled = command.responseKind === "cancelled";
          settleUi(entry, { cancelled, abort: false }, entry.data);
          return { ok: true, type: "extension_ui_response" };
        }
        case "extension_ui_input": {
          const entry = pendingUi.find((item) => item.request.id === command.id);
          if (!entry) {
            return { ok: false, type: "extension_ui_input", error: { code: "not_found", message: `no pending extension UI input: ${command.id}`, retryable: false } };
          }
          // Exact method correlation: only input/editor/custom carry incremental
          // input (select/confirm are final-response-only and reject at the
          // Protocol schema before ever reaching here).
          if (entry.request.method !== command.method) {
            return { ok: false, type: "extension_ui_input", error: { code: "invalid_input", message: `extension input method mismatch for request ${command.id}`, retryable: false } };
          }
          entry.data = `${entry.data}${command.data}`;
          // E15: a custom panel re-publishes the SAME request id with updated
          // lines (canonical upsert — the shared projection replaces by id, so
          // live/replay observers see incremental updates; a close tombstone
          // still removes it and can never be resurrected by replay).
          if (entry.request.method === "custom") {
            entry.updates += 1;
            entry.request = {
              ...entry.request,
              lines: [
                ...(entry.baseLines ?? []),
                `seq:${entry.updates} chunk=${JSON.stringify(command.data)} buf=${JSON.stringify(entry.data)}`,
              ],
            };
            emit({ type: "extension_ui_request", sessionId, request: structuredClone(entry.request) });
            emit({ type: "runtime_state_changed", sessionId });
          }
          return { ok: true, type: "extension_ui_input" };
        }
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

      // D2-P8 extension UI control surface. Deterministic prompt tokens emit a
      // pending request and BLOCK until the correct response settles it (or the
      // hard ≤30s failsafe fires purely to prevent hangs). The prompt command
      // stays in-flight on the worker while the request is pending — the Host
      // interleaving lane delivers the response/input on the SAME socket while
      // the serial lane is HOL-blocked by this prompt.
      const uiToken = message.startsWith("__confirm__") ? "confirm"
        : message.startsWith("__input__") ? "input"
          : message.startsWith("__select__") ? "select"
            : message.startsWith("__editor__") ? "editor"
              : message.startsWith("__custom__") ? "custom"
                : message.startsWith("__status__") ? "status"
                  : message.startsWith("__widget__") ? "widget"
                    : message.startsWith("__title__") ? "title"
                      : message.startsWith("__notify__") ? "notify"
                        : null;
      if (uiToken !== null) {
        if (uiToken === "status") {
          extensionStatuses = [{ key: "model", text: "e2e-fixture" }, { key: "branch", text: "main" }];
          emit({ type: "extension_statuses", sessionId, statuses: structuredClone(extensionStatuses) });
          emit({ type: "runtime_state_changed", sessionId });
          isPromptRunning = false;
          return { ok: true, type: "prompt" };
        }
        if (uiToken === "widget") {
          extensionWidgets = [{ key: "summary", lines: ["line1", "line2"], placement: "belowEditor" }];
          emit({ type: "extension_widgets", sessionId, widgets: structuredClone(extensionWidgets) });
          emit({ type: "runtime_state_changed", sessionId });
          isPromptRunning = false;
          return { ok: true, type: "prompt" };
        }
        if (uiToken === "title") {
          sessionName = "Extension Title";
          emit({ type: "session_title", sessionId, name: "Extension Title" });
          emit({ type: "runtime_state_changed", sessionId });
          isPromptRunning = false;
          return { ok: true, type: "prompt" };
        }
        if (uiToken === "notify") {
          // Mirrors the real SDK notify → extension_error event.
          emit({ type: "extension_error", sessionId, error: "[info] notification", details: { sanitized: true } });
          isPromptRunning = false;
          return { ok: true, type: "prompt" };
        }
        const request = buildUiRequest(uiToken, message);
        const outcome = await waitForUi(request);
        // isPromptRunning is cleared in settleUi paths only on abort; a normal
        // (response/cancel/failsafe) settle ends the turn normally.
        if (outcome.abort) {
          isPromptRunning = false;
          emit({ type: "prompt_error", sessionId, errorMessage: "interrupted", error: { code: "interrupted", message: "interrupted", retryable: false } });
          return { ok: false, type: "prompt", error: { code: "interrupted", message: "interrupted", retryable: false } };
        }
        isPromptRunning = false;
        emit({ type: "agent_end", sessionId });
        emit({ type: "agent_settled", sessionId });
        emit({ type: "prompt_done", sessionId });
        return { ok: true, type: "prompt" };
      }

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
      // Protocol v2: commit the assistant entry (append as child of the current
      // leaf, advance the leaf) and publish message_end WITH the exact persisted
      // entryId/parentEntryId — never an unkeyed completion.
      const promptEntry = commitEntry("Hello world");
      emit({
        type: "message_end",
        sessionId,
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Hello world" }],
          model: "e2e-fixture",
          provider: "e2e",
        },
        entryId: promptEntry.id,
        ...(promptEntry.parentId === null ? {} : { parentEntryId: promptEntry.parentId }),
      });
      emit({ type: "prompt_done", sessionId });
      isPromptRunning = false;
      rebuildMessages(leafId);      contextUsage = {
        percent: Math.min(100, contextUsage.percent + 10),
        contextWindow: contextUsage.contextWindow,
        tokens: contextUsage.tokens + 20_000,
      };
      lastAssistantText = "Hello world";
      return { ok: true, type: "prompt" };
    },
    async interrupt(interrupt) {
      interruptCount += 1;
      const requiredCap = INTERRUPT_REQUIRED_CAP[interrupt.type];
      if (requiredCap !== undefined && !OPEN_CAPS.has(requiredCap)) {
        return { ok: false, type: interrupt.type, error: { code: "unsupported_capability", message: `${requiredCap} not available`, retryable: false } };
      }
      if (interrupt.type === "abort" && blocked) {
        blocked.resolve({ kind: "aborted" });
      }
      if (interrupt.type === "abort_bash" && blockedBash) {
        blockedBash.resolve({ kind: "aborted" });
      }
      if (interrupt.type === "abort_compaction" && blockedCompact) {
        blockedCompact.resolve({ kind: "aborted" });
      }
      if (interrupt.type === "abort") {
        // D2-P8: abort cancels every pending extension request, emitting one
        // canonical close tombstone per request (the blocked prompt resumes as
        // interrupted, mirroring the real adapter's prompt-interruption path).
        cancelAllUi(true);
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
      if (blockedCompact) {
        blockedCompact.resolve({ kind: "closed" });
      }
      // D2-P8: settle every still-pending request as aborted (the prompt
      // resumes interrupted rather than reporting a false success on shutdown).
      cancelAllUi(true);
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
