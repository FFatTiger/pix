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
  execute: (id: string, params: Record<string, never>, signal?: AbortSignal) => Promise<{ content: Array<{ type: string; text?: string }>; isError?: boolean }>;
}

/** Register the extension against a capturing ExtensionAPI. */
function collectTools(): Map<string, RegisteredTool> {
  const tools = new Map<string, RegisteredTool>();
  const api = {
    registerTool(tool: RegisteredTool) {
      tools.set(tool.name, tool);
    },
  };
  (createAssistantToolsExtension() as (pi: unknown) => void)(api);
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
    assert.deepEqual([...session.active].sort(), ["read", "read_session", "search_sessions", "write"]);
    // Idempotent: a second application does not duplicate anything.
    ensureAssistantToolsActive(session, realAssistantDir);
    assert.equal(session.active.size, 4);
  });
});
