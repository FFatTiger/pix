/**
 * Assistant feature tests (adapter side):
 *  - catalog hiding: assistant-workspace sessions never appear in session or
 *    project pages (both the in-memory fallback and the SQLite projection);
 *  - findLatestSessionByCwd: the assistant-conversation exact-cwd lookup
 *    returns the newest root session in that directory (hidden or not) and
 *    null for an empty directory;
 *  - the assistant tools (search_sessions / read_session): registration
 *    surface, bounded output, exclusions (hidden workspaces, children, the
 *    assistant's own conversations) and honest error results.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { resolveAssistantWorkspaceDir } from "@fffattiger/pix-runtime-core";
import {
  ASSISTANT_TOOL_NAMES,
  assistantExtensionFactoriesForCwd,
  createAssistantToolsExtension,
  ensureAssistantToolsActive,
  isAssistantWorkspaceCwd,
  resetAssistantToolsListCacheForTests,
} from "../src/internal/assistant-tools.js";
import { createPiSdkSessionStore } from "../src/internal/session-store.js";
import { createPiSdkSessionCatalog } from "../src/sessions/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NOW = Date.now();
/**
 * Regular project cwds. Must NOT sit under tmpdir() (macOS /var/folders and
 * Linux /tmp are `session_only` workspaces by browse-kind policy, which would
 * hide them from project pages and break the regular-project assertions).
 */
const PROJECT_DIR = "/repos/pix-assistant-demo";
const QUANT_DIR = "/repos/quant";

interface Fixture {
  root: string;
  home: string;
  sessionDir: string;
  assistantDir: string;
  projectDir: string;
}

async function setup(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "pix-assistant-adapter-"));
  const home = join(root, "home");
  const sessionDir = join(root, "sessions");
  // A `.pi/pix/assistant` path under ANY home matches the workspace family
  // pattern used by browse-kind classification.
  const assistantDir = join(home, ".pi", "pix", "assistant");
  await mkdir(join(home, ".pi", "pix"), { recursive: true });
  await mkdir(assistantDir, { recursive: true });
  await mkdir(sessionDir, { recursive: true });
  return { root, home, sessionDir, assistantDir, projectDir: PROJECT_DIR };
}

function seedSession(cwd: string, sessionDir: string | undefined, userText: string, assistantText: string, at = NOW): string {
  const manager = SessionManager.create(cwd, sessionDir);
  if (sessionDir === undefined) mkdirSync(manager.getSessionDir(), { recursive: true });
  manager.appendMessage({ role: "user", content: userText, timestamp: at });
  manager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: assistantText }],
    api: "anthropic",
    provider: "anthropic",
    model: "test-model",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 } },
    stopReason: "stop",
    timestamp: at + 1,
  });
  return manager.getSessionId();
}

async function dispose(fixture: Fixture): Promise<void> {
  await rm(fixture.root, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Catalog hiding + findLatest
// ---------------------------------------------------------------------------

describe("assistant workspace catalog hiding", () => {
  for (const projection of [false, true] as const) {
    it(`assistant sessions are hidden from session and project pages (projection=${projection})`, async () => {
      const fixture = await setup();
      try {
        seedSession(fixture.projectDir, fixture.sessionDir, "project work", "project reply");
        seedSession(fixture.assistantDir, fixture.sessionDir, "assistant chat", "assistant reply");
        const store = createPiSdkSessionStore({ sessionDir: fixture.sessionDir, projection: { enabled: projection } });
        await store.prepare?.();
        const page = await store.listSessionPage!({ page: 1, pageSize: 50 });
        assert.equal(page.sessions.length, 1, "only the project session is listed");
        assert.equal(page.sessions[0]!.cwd, fixture.projectDir);
        assert.equal(page.total, 1);
        const projects = await store.listProjectPage!({ page: 1, pageSize: 50 });
        assert.equal(projects.projects.length, 1, "the assistant directory never becomes a project");
        assert.equal(projects.projects[0]!.projectRoot, fixture.projectDir);
      } finally {
        await dispose(fixture);
      }
    });
  }

  it("findLatestSessionByCwd returns the newest assistant session even though it is hidden", async () => {
    const fixture = await setup();
    try {
      const older = seedSession(fixture.assistantDir, fixture.sessionDir, "first", "one", NOW - 10_000);
      const newer = seedSession(fixture.assistantDir, fixture.sessionDir, "second", "two", NOW);
      const store = createPiSdkSessionStore({ sessionDir: fixture.sessionDir, projection: { enabled: true } });
      await store.prepare?.();
      assert.equal(store.findLatestSessionByCwd !== undefined, true);
      const latest = await store.findLatestSessionByCwd!(fixture.assistantDir);
      assert.equal(latest?.sessionId, newer);
      assert.notEqual(latest?.sessionId, older);
      // Empty directory → null (no invented session).
      assert.equal(await store.findLatestSessionByCwd!(join(fixture.root, "empty")), null);
      // The catalog port surface exposes the lookup too.
      const catalog = createPiSdkSessionCatalog(store);
      assert.equal((await catalog.findLatestSessionByCwd!(fixture.assistantDir))?.sessionId, newer);
    } finally {
      await dispose(fixture);
    }
  });

  it("findLatestSessionByCwd skips child (subagent) sessions", async () => {
    const fixture = await setup();
    try {
      const root = SessionManager.create(fixture.assistantDir, fixture.sessionDir);
      root.appendMessage({ role: "user", content: "root", timestamp: NOW - 5_000 });
      const child = SessionManager.create(fixture.assistantDir, fixture.sessionDir, { parentSession: root.getSessionFile()! });
      child.appendMessage({ role: "user", content: "child", timestamp: NOW });
      const store = createPiSdkSessionStore({ sessionDir: fixture.sessionDir, projection: { enabled: false } });
      const latest = await store.findLatestSessionByCwd!(fixture.assistantDir);
      assert.equal(latest?.sessionId, root.getSessionId());
    } finally {
      await dispose(fixture);
    }
  });
});

// ---------------------------------------------------------------------------
// Assistant tools
// ---------------------------------------------------------------------------

interface RegisteredTool {
  name: string;
  parameters?: unknown;
  execute: (id: string, params: Record<string, never>, signal?: AbortSignal) => Promise<{ content: Array<{ type: string; text?: string }>; isError?: boolean }>;
}

/** Register the extension against a capturing ExtensionAPI. */
type StatusItem = { sessionId: string; cwd: string; state: "busy" | "waitingUser" | "live" };

function realAssistantDirForTest(): string {
  return resolveAssistantWorkspaceDir(homedir());
}

function collectTools(sessionStatus?: () => Promise<readonly StatusItem[]>): Map<string, RegisteredTool> {
  const tools = new Map<string, RegisteredTool>();
  const api = {
    registerTool(tool: RegisteredTool) {
      tools.set(tool.name, tool);
    },
  };
  (createAssistantToolsExtension(sessionStatus as () => Promise<readonly never[]>) as (pi: unknown) => void)(api);
  return tools;
}

async function runTool(tools: Map<string, RegisteredTool>, name: string, params: Record<string, unknown>) {
  const tool = tools.get(name);
  assert.ok(tool, `tool ${name} registered`);
  return tool.execute("call-1", params as never, undefined);
}

describe("assistant tools (search_sessions / read_session)", () => {
  let fixture: Fixture;
  let previousAgentDir: string | undefined;
  let tools: Map<string, RegisteredTool>;

  beforeEach(async () => {
    fixture = await setup();
    previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = fixture.root;
    resetAssistantToolsListCacheForTests();
    tools = collectTools();
    seedSession(PROJECT_DIR, undefined, "修一下 OpenClash 的域名规则", "已经把域名加进自定义规则");
    seedSession(QUANT_DIR, undefined, "回测 R20 策略", "夏普 1.8");
    seedSession(fixture.assistantDir, undefined, "assistant internal", "assistant internal reply");
  });

  afterEach(async () => {
    if (previousAgentDir === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
    resetAssistantToolsListCacheForTests();
    await dispose(fixture);
  });

  it("registers exactly the two assistant tools with direct semantics", () => {
    assert.deepEqual([...tools.keys()].sort(), [...ASSISTANT_TOOL_NAMES].sort());
    assert.equal(tools.get("search_sessions")!.name, "search_sessions");
    assert.equal(tools.get("read_session")!.name, "read_session");
  });

  it("search_sessions matches message content with a bounded snippet and excludes hidden workspaces", async () => {
    const result = await runTool(tools, "search_sessions", { query: "OpenClash" });
    assert.equal(result.isError, undefined);
    const text = result.content[0]!.text!;
    assert.match(text, /共匹配 1 个会话/);
    assert.match(text, /OpenClash/);
    assert.match(text, /摘录/);
    // id present so read_session can follow up.
    assert.match(text, /id:/);
  });

  it("search_sessions filters by project and since, and clamps limit", async () => {
    const byProject = await runTool(tools, "search_sessions", { project: "quant" });
    assert.match(byProject.content[0]!.text!, /R20/);
    const none = await runTool(tools, "search_sessions", { project: "quant", query: "OpenClash" });
    assert.match(none.content[0]!.text!, /没有匹配/);
    const future = await runTool(tools, "search_sessions", { since: "2999-01-01" });
    assert.match(future.content[0]!.text!, /没有找到任何会话|没有匹配/);
    const badSince = await runTool(tools, "search_sessions", { since: "not-a-date" });
    assert.equal(badSince.isError, true);
    assert.match(badSince.content[0]!.text!, /since 日期无法解析/);
    const clamped = await runTool(tools, "search_sessions", { limit: 999 });
    assert.equal(clamped.isError, undefined);
  });

  it("search_sessions never lists the assistant's own conversations", async () => {
    const result = await runTool(tools, "search_sessions", { query: "assistant internal" });
    assert.match(result.content[0]!.text!, /没有匹配/);
    const all = await runTool(tools, "search_sessions", {});
    assert.doesNotMatch(all.content[0]!.text!, /assistant internal/);
  });

  it("read_session summarizes the tail by id: user text, assistant text, tool names only", async () => {
    // Seed a session with a tool call + result.
    const manager = SessionManager.create("/repos/tools-demo");
    manager.appendMessage({ role: "user", content: "查一下路由", timestamp: NOW });
    manager.appendMessage({
      role: "assistant",
      content: [{ type: "toolCall", id: "t1", name: "grep", arguments: { pattern: "openclash" } }],
      api: "anthropic",
      provider: "anthropic",
      model: "test-model",
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 } },
      stopReason: "toolUse",
      timestamp: NOW + 1,
    });
    manager.appendMessage({ role: "toolResult", toolCallId: "t1", toolName: "grep", content: [{ type: "text", text: "config/openclash.yaml:3" }], isError: false, timestamp: NOW + 2 });
    manager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "配置在 openclash.yaml" }],
      api: "anthropic",
      provider: "anthropic",
      model: "test-model",
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 } },
      stopReason: "stop",
      timestamp: NOW + 3,
    });
    const sessionId = manager.getSessionId();
    resetAssistantToolsListCacheForTests();
    const result = await runTool(tools, "read_session", { session: sessionId });
    assert.equal(result.isError, undefined);
    const text = result.content[0]!.text!;
    assert.match(text, /用户: 查一下路由/);
    assert.match(text, /助手调用工具: grep/);
    assert.match(text, /结果\(grep\): config\/openclash.yaml:3/);
    assert.match(text, /助手: 配置在 openclash.yaml/);
  });

  it("read_session resolves by title/first-message prefix and fails closed for unknown sessions", async () => {
    const byFirst = await runTool(tools, "read_session", { session: "回测" });
    assert.equal(byFirst.isError, undefined);
    assert.match(byFirst.content[0]!.text!, /用户: 回测 R20 策略/);
    const unknown = await runTool(tools, "read_session", { session: "不存在的会话" });
    assert.equal(unknown.isError, true);
    assert.match(unknown.content[0]!.text!, /没有找到会话/);
  });

  it("read_session tail is bounded", async () => {
    const manager = SessionManager.create("/repos/long");
    for (let index = 0; index < 80; index += 1) {
      manager.appendMessage({ role: "user", content: `消息 ${index}`, timestamp: NOW + index });
    }
    const sessionId = manager.getSessionId();
    resetAssistantToolsListCacheForTests();
    const capped = await runTool(tools, "read_session", { session: sessionId, tail: 999 });
    const text = capped.content[0]!.text!;
    assert.match(text, /显示最近 50 条/);
    assert.doesNotMatch(text, /消息 5\b/); // early messages dropped
    assert.match(text, /消息 79/);
  });

  it("read_session never reads the assistant's own conversations", async () => {
    const result = await runTool(tools, "read_session", { session: "assistant internal" });
    assert.equal(result.isError, true);
  });

  it("read_session fails closed when the JSONL identity does not match the listed id", async () => {
    // Two seeded sessions; the tool resolves the requested id but opens the
    // WRONG file (simulating a stale cached path): the identity fence must
    // refuse instead of summarizing another session's JSONL (AGENTS §6).
    const requested = SessionManager.create("/repos/real");
    mkdirSync(requested.getSessionDir(), { recursive: true });
    requested.appendMessage({ role: "user", content: "real session content", timestamp: NOW });
    const other = SessionManager.create("/repos/other");
    mkdirSync(other.getSessionDir(), { recursive: true });
    other.appendMessage({ role: "user", content: "other session content", timestamp: NOW });
    resetAssistantToolsListCacheForTests();
    await runTool(tools, "search_sessions", { query: "real session content" }); // prime the list cache
    const realOpen = SessionManager.open.bind(SessionManager);
    (SessionManager as { open: typeof SessionManager.open }).open = ((path: string) => {
      void path;
      return other;
    }) as typeof SessionManager.open;
    try {
      const result = await runTool(tools, "read_session", { session: requested.getSessionId() });
      assert.equal(result.isError, true);
      assert.match(result.content[0]!.text!, /身份校验失败/);
    } finally {
      (SessionManager as { open: typeof SessionManager.open }).open = realOpen;
    }
  });

  it("registration is scoped to the assistant workspace and survives narrow tool selections", async () => {
    const realAssistantDir = resolveAssistantWorkspaceDir(homedir());
    assert.equal(isAssistantWorkspaceCwd(realAssistantDir), true);
    assert.equal(isAssistantWorkspaceCwd(fixture.projectDir), false);
    assert.equal(assistantExtensionFactoriesForCwd(realAssistantDir).length, 1);
    assert.equal(assistantExtensionFactoriesForCwd(fixture.projectDir).length, 0);

    const session = {
      active: new Set(["read", "write"]),
      getActiveToolNames(this: { active: Set<string> }) { return [...this.active]; },
      setActiveToolsByName(this: { active: Set<string> }, names: readonly string[]) { this.active = new Set(names); },
    };
    ensureAssistantToolsActive(session, PROJECT_DIR);
    assert.deepEqual([...session.active].sort(), ["read", "write"]);
    ensureAssistantToolsActive(session, realAssistantDir);
    assert.deepEqual([...session.active].sort(), [...new Set([...ASSISTANT_TOOL_NAMES, "read", "write"])].sort());
    // Idempotent: a second application does not duplicate anything.
    ensureAssistantToolsActive(session, realAssistantDir);
    assert.equal(session.active.size, ASSISTANT_TOOL_NAMES.length + 2);
  });
});

describe("assistant tools survive explicit set_tools whitelists (driver)", () => {
  it("setTools keeps search_sessions/read_session active on an assistant session even when unnamed", async () => {
    // The driver's setTools is exercised through the REAL driver surface with a
    // scripted composition (same harness family as sdk-smoke): the exact
    // production selection code path, without network.
    const { SdkRuntimeDriverFactory } = await import("../src/internal/sdk-runtime.js");
    const { SessionManager, SettingsManager, ModelRuntime, createAgentSessionFromServices, createAgentSessionServices } = await import("@earendil-works/pi-coding-agent");
    const { resourceLoaderOptionsForBuiltIns } = await import("../src/internal/curated-plugins.js");
    const { assistantExtensionFactoriesForCwd } = await import("../src/internal/assistant-tools.js");
    const root = await mkdtemp(join(tmpdir(), "pix-assistant-settools-"));
    try {
      const realAssistantDir = resolveAssistantWorkspaceDir(homedir());
      const agentDir = join(root, "agent");
      await mkdir(agentDir, { recursive: true });
      const manager = SessionManager.inMemory(realAssistantDir);
      const modelRuntime = await ModelRuntime.create({ allowModelNetwork: false, authPath: join(agentDir, "auth.json"), modelsPath: null });
      const composition = {
        async openSession() { return { manager, cwd: realAssistantDir }; },
        initializeTheme() {},
        createServices: (cwd: string) => createAgentSessionServices({
          cwd,
          agentDir,
          settingsManager: SettingsManager.inMemory({}, { projectTrusted: true }),
          modelRuntime,
          // Mirror the production defaultComposition: the assistant tools
          // extension rides in the extensionFactories list for assistant cwds.
          resourceLoaderOptions: {
            ...resourceLoaderOptionsForBuiltIns(agentDir),
            extensionFactories: assistantExtensionFactoriesForCwd(cwd),
          },
        }),
        resolveProjectTrust: async () => true,
        prepareExtensionMode: async () => {},
        listVisibleModels: (services: { modelRuntime: { getModels(): unknown[] } }) => services.modelRuntime.getModels(),
        getDefaults: () => ({}),
        hasContinuation: () => false,
        createSession: (options: unknown) => createAgentSessionFromServices(options as never),
      };
      const factory = new SdkRuntimeDriverFactory(undefined, composition as never);
      const driver = await factory.create({ cwd: realAssistantDir, toolNames: ["read"], thinkingLevel: "off", thinkingLevelPinned: true }, {});
      try {
        // getState() is a per-call projection: re-read after every mutation.
        const active = () => new Set(driver.getState().tools.filter((tool) => tool.active).map((tool) => tool.name));
        // Explicit create-time whitelist already unions registration-activated
        // extension tools — the assistant pair must be present.
        assert.ok(active().has("search_sessions"), `search_sessions active; tools=${JSON.stringify(driver.getState().tools.map((t) => [t.name, t.active]))}`);
        assert.ok(active().has("read_session"));
        // An explicit runtime set_tools WITHOUT the assistant names must not
        // remove them (the assistant's defining capability).
        driver.setTools(["read"], true);
        assert.ok(active().has("search_sessions"));
        assert.ok(active().has("read_session"));
        // All-off clears everything including the assistant pair (a genuine
        // forced-empty is honest, and the empty-list path skips the union) —
        // the invariant is that a NARROW list never silently drops them.
        driver.setTools([], false);
        assert.equal(driver.getState().tools.every((tool) => !tool.active), true);
      } finally {
        await driver.close("user");
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Round 3: session capabilities (status / todos / activity / file changes /
// suggested actions)
// ---------------------------------------------------------------------------

describe("assistant session capabilities (round 3 tools)", () => {
  let fixture: Fixture;
  let previousAgentDir: string | undefined;
  let tools: Map<string, RegisteredTool>;

  const seedWithEntries = (cwd: string, append: (manager: ReturnType<typeof SessionManager.create>) => void): string => {
    const manager = SessionManager.create(cwd);
    mkdirSync(manager.getSessionDir(), { recursive: true });
    append(manager);
    return manager.getSessionId();
  };

  beforeEach(async () => {
    fixture = await setup();
    previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = fixture.root;
    resetAssistantToolsListCacheForTests();
    tools = collectTools();
  });
  afterEach(async () => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    resetAssistantToolsListCacheForTests();
    await dispose(fixture);
  });

  it("registers all nine assistant tools", () => {
    assert.deepEqual([...tools.keys()].sort(), [...ASSISTANT_TOOL_NAMES].sort());
  });

  it("session_status without the live channel reports unavailable instead of guessing", async () => {
    const result = await runTool(collectTools(), "session_status", {});
    assert.equal(result.isError, true);
    assert.match(result.content[0]!.text!, /实时会话状态通道不可用/);
  });

  it("session_status reports the AUTHORITATIVE channel states (busy/waitingUser/live), never JSONL inference", async () => {
    const deadIdRef = seedWithEntries("/repos/dead-worker", (m) => {
      m.appendMessage({ role: "user", content: "q", timestamp: NOW - 900 });
      m.appendMessage({
        role: "assistant", content: [{ type: "toolCall", id: "stuck", name: "bash", arguments: { cmd: "sleep 999" } }],
        api: "anthropic", provider: "anthropic", model: "m", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 } }, stopReason: "toolUse", timestamp: NOW - 800,
      });
      // NO toolResult: the JSONL tail looks "in flight", but sessiond says the
      // worker is gone. The tool must report the AUTHORITY, not the tail.
    });
    const erroredIdRef = seedWithEntries("/repos/errored", (m) => {
      m.appendMessage({ role: "user", content: "q", timestamp: NOW - 700 });
      m.appendMessage({
        role: "assistant", content: [{ type: "toolCall", id: "e2", name: "bash", arguments: { cmd: "x" } }],
        api: "anthropic", provider: "anthropic", model: "m", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 } }, stopReason: "toolUse", timestamp: NOW - 600,
      });
      m.appendMessage({ role: "toolResult", toolCallId: "e2", toolName: "bash", content: [{ type: "text", text: "EPERM denied" }], isError: true, timestamp: NOW - 500 });
    });
    resetAssistantToolsListCacheForTests();
    const deadId = deadIdRef;
    const erroredId = erroredIdRef;
    const channel = async () => [
      { sessionId: "fresh-not-yet-flushed", cwd: "/repos/fresh", state: "busy" as const },
      { sessionId: "waiting-card", cwd: "/repos/waiting", state: "waitingUser" as const },
      { sessionId: "idle-live", cwd: "/repos/idle", state: "live" as const },
      { sessionId: deadId, cwd: "/repos/dead-worker", state: "live" as const },
      { sessionId: erroredId, cwd: "/repos/errored", state: "live" as const },
    ];
    const result = await runTool(collectTools(channel), "session_status", {});
    assert.equal(result.isError, undefined);
    const text = result.content[0]!.text!;
    assert.match(text, /运行中/);
    assert.match(text, /等待用户/);
    assert.match(text, /在线空闲/);
    // Just-started session (not yet on disk) is reported running — from the channel.
    assert.match(text, /fresh-not-yet-flushed/);
    // Crashed/interrupted session whose JSONL tail looks in-flight is NOT "running".
    assert.doesNotMatch(text, /疑似进行中/);
    // The dead-worker session still shows (live per authority) but with no
    // inference labels; recent error from the record rides along.
    assert.match(text, /EPERM denied/);
  });

  it("session_status channel failure is an honest error, never a fallback to guessing", async () => {
    const failing = async () => { throw new Error("pipe closed"); };
    const result = await runTool(collectTools(failing), "session_status", {});
    assert.equal(result.isError, true);
    assert.match(result.content[0]!.text!, /查询实时会话状态失败/);
  });

  it("session_status hides the assistant's own sessions and honors the project filter", async () => {
    resetAssistantToolsListCacheForTests();
    const channel = async () => [
      { sessionId: "a1", cwd: "/repos/alpha", state: "busy" as const },
      { sessionId: "self", cwd: realAssistantDirForTest(), state: "live" as const },
    ];
    const all = await runTool(collectTools(channel), "session_status", {});
    assert.match(all.content[0]!.text!, /a1/);
    assert.doesNotMatch(all.content[0]!.text!, /self/);
    const scoped = await runTool(collectTools(channel), "session_status", { project: "alpha" });
    assert.match(scoped.content[0]!.text!, /a1/);
    const none = await runTool(collectTools(channel), "session_status", { project: "beta" });
    assert.match(none.content[0]!.text!, /没有活跃会话/);
  });

  it("list_open_todos groups open items by session and honors project filter", async () => {
    seedWithEntries("/repos/todo-a", (m) => {
      m.appendMessage({ role: "user", content: "go", timestamp: NOW - 5000 });
      m.appendMessage({
        role: "assistant", content: [{ type: "toolCall", id: "t1", name: "todo", arguments: { action: "list" } }],
        api: "anthropic", provider: "anthropic", model: "m", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 } }, stopReason: "toolUse", timestamp: NOW - 4000,
      });
      m.appendMessage({
        role: "toolResult", toolCallId: "t1", toolName: "todo", isError: false, timestamp: NOW - 3000,
        content: [{ type: "text", text: "listed" }],
        details: { action: "list", tasks: [
          { id: 1, subject: "修登录 bug", status: "in_progress" },
          { id: 2, subject: "写文档", status: "pending" },
          { id: 3, subject: "完成的", status: "completed" },
        ], nextId: 4 },
      });
    });
    resetAssistantToolsListCacheForTests();
    const result = await runTool(tools, "list_open_todos", {});
    const text = result.content[0]!.text!;
    assert.match(text, /共 2 项未完成待办/);
    assert.match(text, /进行中.*修登录 bug/);
    assert.match(text, /待办.*写文档/);
    assert.doesNotMatch(text, /完成的/);
    const scoped = await runTool(tools, "list_open_todos", { project: "other" });
    assert.match(scoped.content[0]!.text!, /没有未完成的待办/);
  });

  it("summarize_activity counts turns, written files and last text; rejects bad range", async () => {
    seedWithEntries("/repos/active", (m) => {
      m.appendMessage({ role: "user", content: "改一下配置", timestamp: NOW - 3000 });
      m.appendMessage({
        role: "assistant", content: [
          { type: "text", text: "我来改 nginx.conf" },
          { type: "toolCall", id: "w1", name: "edit", arguments: { path: "/etc/nginx/nginx.conf", edits: [] } },
        ],
        api: "anthropic", provider: "anthropic", model: "m", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 } }, stopReason: "toolUse", timestamp: NOW - 2000,
      });
      m.appendMessage({ role: "toolResult", toolCallId: "w1", toolName: "edit", content: [{ type: "text", text: "ok" }], isError: false, timestamp: NOW - 1000 });
      m.appendMessage({
        role: "assistant", content: [{ type: "text", text: "已把 worker_processes 改成 4" }],
        api: "anthropic", provider: "anthropic", model: "m", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 } }, stopReason: "stop", timestamp: NOW - 900,
      });
    });
    resetAssistantToolsListCacheForTests();
    const result = await runTool(tools, "summarize_activity", { range: "week" });
    const text = result.content[0]!.text!;
    assert.match(text, /1 个会话有活动/);
    assert.match(text, /1 轮/);
    assert.match(text, /nginx\.conf/);
    assert.match(text, /worker_processes 改成 4/);
    const bad = await runTool(tools, "summarize_activity", { range: "yesterday?" });
    assert.equal(bad.isError, true);
    assert.match(bad.content[0]!.text!, /range 无法解析/);
  });

  it("find_file_changes matches basenames and only successful writes", async () => {
    seedWithEntries("/repos/writer", (m) => {
      m.appendMessage({ role: "user", content: "改 nginx", timestamp: NOW - 3000 });
      m.appendMessage({
        role: "assistant", content: [
          { type: "text", text: "调整了反向代理超时" },
          { type: "toolCall", id: "ok1", name: "write", arguments: { path: "/etc/nginx/sites-enabled/app.conf", content: "x" } },
          { type: "toolCall", id: "fail1", name: "edit", arguments: { path: "/etc/nginx/nginx.conf", edits: [] } },
        ],
        api: "anthropic", provider: "anthropic", model: "m", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 } }, stopReason: "toolUse", timestamp: NOW - 2000,
      });
      m.appendMessage({ role: "toolResult", toolCallId: "ok1", toolName: "write", content: [{ type: "text", text: "written" }], isError: false, timestamp: NOW - 1500 });
      m.appendMessage({ role: "toolResult", toolCallId: "fail1", toolName: "edit", content: [{ type: "text", text: "conflict" }], isError: true, timestamp: NOW - 1400 });
    });
    resetAssistantToolsListCacheForTests();
    const hit = await runTool(tools, "find_file_changes", { path: "app.conf" });
    const text = hit.content[0]!.text!;
    assert.match(text, /1 条改动记录/);
    assert.match(text, /反向代理超时/);
    // The FAILED edit on nginx.conf is not reported as a change.
    const miss = await runTool(tools, "find_file_changes", { path: "nginx.conf" });
    assert.match(miss.content[0]!.text!, /没有会话记录写过/);
  });

  it("open_session resolves by title and fails closed for unknown targets", async () => {
    seedWithEntries("/repos/dest", (m) => {
      m.appendMessage({ role: "user", content: "目标会话", timestamp: NOW - 900 });
      m.appendMessage({
        role: "assistant", content: [{ type: "text", text: "好的" }],
        api: "anthropic", provider: "anthropic", model: "m", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 } }, stopReason: "stop", timestamp: NOW - 800,
      });
    });
    resetAssistantToolsListCacheForTests();
    const ok = await runTool(tools, "open_session", { session: "目标会话" });
    assert.equal(ok.isError, undefined);
    assert.match(ok.content[0]!.text!, /已建议打开会话/);
    const miss = await runTool(tools, "open_session", { session: "不存在的" });
    assert.equal(miss.isError, true);
    assert.match(miss.content[0]!.text!, /没有找到会话/);
  });

  it("organize_sessions validates rename requirements and resolves batch targets", async () => {
    const manager = SessionManager.create("/repos/batch", undefined);
    mkdirSync(manager.getSessionDir(), { recursive: true });
    manager.appendMessage({ role: "user", content: "批量会话一", timestamp: NOW - 900 });
    resetAssistantToolsListCacheForTools();
    async function resetAssistantToolsListCacheForTools() { resetAssistantToolsListCacheForTests(); }
    const renameNoTitle = await runTool(tools, "organize_sessions", { action: "rename", sessions: [{ session: "批量会话一" }] });
    assert.equal(renameNoTitle.isError, true);
    assert.match(renameNoTitle.content[0]!.text!, /rename 需要提供 title/);
    const renameTwo = await runTool(tools, "organize_sessions", { action: "rename", sessions: [{ session: "批量会话一" }, { session: "x" }], title: "新标题" });
    assert.equal(renameTwo.isError, true);
    assert.match(renameTwo.content[0]!.text!, /一次只支持一个/);
    const dedupe = await runTool(tools, "organize_sessions", { action: "delete", sessions: [{ session: "批量会话一" }, { session: "批量会话一" }] });
    assert.equal(dedupe.isError, undefined);
    assert.match(dedupe.content[0]!.text!, /已建议删除 1 个会话/); // deduped
    // pin/archive are no longer part of the tool's vocabulary: the parameter
    // schema itself rejects them before any execute.
    const organizeParameters = tools.get("organize_sessions")!.parameters;
    assert.ok(organizeParameters, "organize tool declares a schema");
    const { Check } = await import("typebox/value");
    const valid = (input: unknown) => Check(organizeParameters as never, input);
    for (const removed of ["pin", "unpin", "archive", "unarchive"]) {
      assert.equal(valid({ action: removed, sessions: [{ session: "x" }] }), false, removed);
    }
    assert.equal(valid({ action: "delete", sessions: [{ session: "x" }] }), true);
    assert.equal(valid({ action: "rename", sessions: [{ session: "x" }], title: "t" }), true);
    const miss = await runTool(tools, "organize_sessions", { action: "delete", sessions: [{ session: "ghost" }] });
    assert.equal(miss.isError, true);
    assert.match(miss.content[0]!.text!, /没有找到：ghost/);
  });

  it("draft_to_session resolves the target and echoes a bounded draft preview", async () => {
    seedWithEntries("/repos/dst", (m) => {
      m.appendMessage({ role: "user", content: "继续修 bug", timestamp: NOW - 900 });
    });
    resetAssistantToolsListCacheForTests();
    const ok = await runTool(tools, "draft_to_session", { session: "继续修", text: "接着修 bug：先跑 npm test，把失败的三个用例修好。" });
    assert.equal(ok.isError, undefined);
    assert.match(ok.content[0]!.text!, /已起草续话/);
    assert.match(ok.content[0]!.text!, /不会自动发送/);
    const miss = await runTool(tools, "draft_to_session", { session: "ghost", text: "hi" });
    assert.equal(miss.isError, true);
  });
});
