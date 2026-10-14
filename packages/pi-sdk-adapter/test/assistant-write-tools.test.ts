/**
 * Assistant write tools (round 7): send / create / stop / rename ride the
 * injected AssistantOpsChannel. No channel → honest error, never a guessed
 * success. Delete stays a confirmation card and never calls the channel.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { AssistantOpsChannel, WorkerAssistantCompletionPayload, WorkerAssistantOpResultPayload } from "@fffattiger/pix-protocol";
import {
  ASSISTANT_TOOL_NAMES,
  createAssistantToolsExtension,
  resetAssistantToolsListCacheForTests,
} from "../src/internal/assistant-tools.js";

const NOW = Date.now();

interface RegisteredTool {
  name: string;
  label?: string;
  promptSnippet?: string;
  execute: (
    id: string,
    params: Record<string, never>,
    signal?: AbortSignal,
  ) => Promise<{ content: Array<{ type: string; text?: string }>; isError?: boolean }>;
}

function seedSession(cwd: string, userText: string, name?: string): string {
  const manager = SessionManager.create(cwd);
  mkdirSync(manager.getSessionDir(), { recursive: true });
  manager.appendMessage({ role: "user", content: userText, timestamp: NOW });
  if (name !== undefined) manager.appendSessionInfo(name);
  return manager.getSessionId();
}

interface FakeChannel extends AssistantOpsChannel {
  calls: Array<{ method: string; args: unknown[] }>;
  sendResult: WorkerAssistantOpResultPayload;
  createResult: WorkerAssistantOpResultPayload;
  stopResult: WorkerAssistantOpResultPayload;
  renameResult: WorkerAssistantOpResultPayload;
  completion: WorkerAssistantCompletionPayload | null | "hang";
  resolveCompletion?: (value: WorkerAssistantCompletionPayload | null) => void;
}

function fakeChannel(overrides: Partial<FakeChannel> = {}): FakeChannel {
  const calls: FakeChannel["calls"] = [];
  const channel: FakeChannel = {
    calls,
    sendResult: { ok: true, sessionId: "assistant", kind: "send", targetSessionId: "t", delivery: "follow_up", note: "已排队" },
    createResult: { ok: true, sessionId: "assistant", kind: "create", targetSessionId: "new-1", note: "已创建" },
    stopResult: { ok: true, sessionId: "assistant", kind: "stop", stopped: true, note: "已请求停止" },
    renameResult: { ok: true, sessionId: "assistant", kind: "rename", targetSessionId: "t", note: "已改名" },
    completion: null,
    async send(input) {
      calls.push({ method: "send", args: [input] });
      return channel.sendResult;
    },
    async create(input) {
      calls.push({ method: "create", args: [input] });
      return channel.createResult;
    },
    async stop(targetSessionId) {
      calls.push({ method: "stop", args: [targetSessionId] });
      return channel.stopResult;
    },
    async rename(targetSessionId, name) {
      calls.push({ method: "rename", args: [targetSessionId, name] });
      return channel.renameResult;
    },
    waitForCompletion(delegationId, timeoutMs) {
      calls.push({ method: "waitForCompletion", args: [delegationId, timeoutMs] });
      if (channel.completion === "hang") {
        return new Promise((resolve) => {
          channel.resolveCompletion = resolve;
        });
      }
      return Promise.resolve(channel.completion);
    },
    cancelWait(delegationId) {
      calls.push({ method: "cancelWait", args: [delegationId] });
      channel.resolveCompletion?.(null);
    },
    ...overrides,
  };
  return channel;
}

function collect(assistantOps?: AssistantOpsChannel): Map<string, RegisteredTool> {
  const tools = new Map<string, RegisteredTool>();
  const api = {
    registerTool(tool: RegisteredTool) {
      tools.set(tool.name, tool);
    },
    on() {
      return () => {};
    },
  };
  (createAssistantToolsExtension(undefined, assistantOps) as (pi: unknown) => void)(api);
  return tools;
}

async function run(tools: Map<string, RegisteredTool>, name: string, params: Record<string, unknown>, signal?: AbortSignal) {
  const tool = tools.get(name);
  assert.ok(tool, `tool ${name} registered`);
  return tool.execute("call-1", params as never, signal);
}

describe("assistant write tools", () => {
  let root: string;
  let previousAgentDir: string | undefined;
  let assistantDir: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "pix-assistant-write-"));
    previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = root;
    assistantDir = join(root, "home", ".pi", "pix", "assistant");
    await mkdir(assistantDir, { recursive: true });
    resetAssistantToolsListCacheForTests();
  });

  afterEach(async () => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    resetAssistantToolsListCacheForTests();
    await rm(root, { recursive: true, force: true });
  });

  it("registers the write tool names", () => {
    const tools = collect();
    assert.deepEqual([...tools.keys()].sort(), [...ASSISTANT_TOOL_NAMES].sort());
    assert.equal(tools.get("send_to_session")!.label, "给会话发消息");
    assert.equal(tools.get("create_session")!.label, "新建会话");
    assert.equal(tools.get("stop_session")!.label, "停止会话");
    assert.match(tools.get("send_to_session")!.promptSnippet ?? "", /steer/);
    assert.match(tools.get("organize_sessions")!.promptSnippet ?? "", /直接生效/);
  });

  it("refuses every write when the channel is missing", async () => {
    seedSession("/repos/pix", "修登录", "修登录");
    const tools = collect();
    for (const name of ["send_to_session", "create_session", "stop_session"] as const) {
      const result = await run(tools, name, name === "create_session"
        ? { project: "pix", message: "做完" }
        : name === "send_to_session"
          ? { session: "修登录", message: "继续" }
          : { session: "修登录" });
      assert.equal(result.isError, true, name);
      assert.match(result.content[0]!.text!, /会话操作通道不可用/);
    }
  });

  it("clamps wait_minutes above 15 down to 15 and sends 0 when not waiting", async () => {
    const id = seedSession("/repos/pix", "修登录");
    const channel = fakeChannel();
    const tools = collect(channel);
    const waiting = await run(tools, "send_to_session", { session: id, message: "继续", wait: true, wait_minutes: 16 });
    assert.equal(waiting.isError, undefined);
    assert.deepEqual(channel.calls[0], {
      method: "send",
      args: [{ targetSessionId: id, message: "继续", delivery: "follow_up", waitMinutes: 15 }],
    });
    const notWaiting = await run(tools, "send_to_session", { session: id, message: "再来", wait_minutes: 16 });
    const sent = channel.calls.find((call) => call.method === "send" && (call.args[0] as { message: string }).message === "再来");
    assert.equal((sent!.args[0] as { waitMinutes: number }).waitMinutes, 0);
    assert.match(notWaiting.content[0]!.text!, /已发送/);
    assert.match(notWaiting.content[0]!.text!, /它结束时你会收到通知/);
  });

  it("rejects the assistant's own workspace and lists ambiguous substring matches", async () => {
    seedSession(assistantDir, "助手自己", "助手自己");
    seedSession("/repos/alpha", "修登录页", "登录一");
    seedSession("/repos/beta", "修登录框", "登录二");
    const channel = fakeChannel();
    const tools = collect(channel);
    const self = await run(tools, "send_to_session", { session: "助手自己", message: "别发" });
    assert.equal(self.isError, true);
    assert.match(self.content[0]!.text!, /不能对助手会话发送消息/);
    assert.equal(channel.calls.length, 0);
    const ambiguous = await run(tools, "send_to_session", { session: "登录", message: "做" });
    assert.equal(ambiguous.isError, true);
    assert.match(ambiguous.content[0]!.text!, /匹配到多个会话/);
    assert.match(ambiguous.content[0]!.text!, /登录一/);
    assert.match(ambiguous.content[0]!.text!, /登录二/);
    assert.equal(channel.calls.filter((call) => call.method === "send").length, 0);
  });

  it("formats a completed wait and cancels on timeout", async () => {
    const id = seedSession("/repos/pix", "修登录", "修登录");
    const done = fakeChannel({
      sendResult: {
        ok: true, sessionId: "assistant", kind: "send", targetSessionId: id,
        delivery: "new_turn", delegationId: "d-1", note: "已开始",
      },
      completion: {
        sessionId: "assistant", delegationId: "d-1", targetSessionId: id, outcome: "completed",
        lastText: "修好了", writtenFiles: ["src/login.ts"],
      },
    });
    const ok = await run(collect(done), "send_to_session", { session: id, message: "修登录", wait: true, wait_minutes: 0 });
    assert.equal(ok.isError, undefined);
    assert.match(ok.content[0]!.text!, /已发送并完成/);
    assert.match(ok.content[0]!.text!, /结果: 完成/);
    assert.match(ok.content[0]!.text!, /最后回复: 修好了/);
    assert.match(ok.content[0]!.text!, /写过的文件: src\/login\.ts/);

    const slow = fakeChannel({
      sendResult: {
        ok: true, sessionId: "assistant", kind: "send", targetSessionId: id,
        delivery: "follow_up", delegationId: "d-2", note: "已排队",
      },
      completion: "hang",
    });
    const timedOut = await run(collect(slow), "send_to_session", { session: id, message: "慢慢来", wait: true, wait_minutes: 0 });
    assert.equal(timedOut.isError, undefined);
    assert.match(timedOut.content[0]!.text!, /仍在处理这条消息/);
    assert.ok(slow.calls.some((call) => call.method === "cancelWait" && call.args[0] === "d-2"));
  });

  it("cancels the wait when the tool is aborted", async () => {
    const id = seedSession("/repos/pix", "修登录", "修登录");
    const channel = fakeChannel({
      sendResult: {
        ok: true, sessionId: "assistant", kind: "send", targetSessionId: id,
        delivery: "steer", delegationId: "d-3", note: "已引导",
      },
      completion: "hang",
    });
    const controller = new AbortController();
    const pending = run(collect(channel), "send_to_session", {
      session: id, message: "改方向", delivery: "steer", wait: true, wait_minutes: 10,
    }, controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();
    await assert.rejects(pending);
    assert.ok(channel.calls.some((call) => call.method === "cancelWait" && call.args[0] === "d-3"));
  });

  it("create_session resolves a project by basename and waits the same way", async () => {
    seedSession("/repos/pix", "已有");
    seedSession("/repos/other", "别的");
    const channel = fakeChannel({
      createResult: {
        ok: true, sessionId: "assistant", kind: "create", targetSessionId: "new-9",
        delegationId: "d-c", note: "已创建",
      },
      completion: {
        sessionId: "assistant", delegationId: "d-c", targetSessionId: "new-9", outcome: "failed",
        error: "编译失败",
      },
    });
    const result = await run(collect(channel), "create_session", {
      project: "pix", message: "把登录修好", title: "修登录", wait: true, wait_minutes: 0,
    });
    assert.equal(result.isError, undefined);
    assert.match(result.content[0]!.text!, /新会话: new-9/);
    assert.match(result.content[0]!.text!, /结果: 出错/);
    assert.match(result.content[0]!.text!, /错误: 编译失败/);
    const created = channel.calls.find((call) => call.method === "create");
    assert.deepEqual(created!.args[0], { cwd: "/repos/pix", message: "把登录修好", title: "修登录", waitMinutes: 0 });
  });

  it("create_session reports an unknown project without calling the channel", async () => {
    seedSession("/repos/pix", "已有");
    const channel = fakeChannel();
    const result = await run(collect(channel), "create_session", { project: "ghost", message: "做" });
    assert.equal(result.isError, true);
    assert.match(result.content[0]!.text!, /没有找到项目「ghost」/);
    assert.equal(channel.calls.length, 0);
  });

  it("stop_session stops the resolved target", async () => {
    const id = seedSession("/repos/pix", "正在跑", "正在跑");
    const channel = fakeChannel();
    const result = await run(collect(channel), "stop_session", { session: "正在跑" });
    assert.equal(result.isError, undefined);
    assert.match(result.content[0]!.text!, /已停止/);
    assert.deepEqual(channel.calls[0], { method: "stop", args: [id] });
  });

  it("organize rename executes through the channel; delete stays a card and does not call it", async () => {
    const id = seedSession("/repos/pix", "旧标题", "旧标题");
    const channel = fakeChannel();
    const tools = collect(channel);
    const renamed = await run(tools, "organize_sessions", {
      action: "rename", sessions: [{ session: "旧标题" }], title: "新标题",
    });
    assert.equal(renamed.isError, undefined);
    assert.match(renamed.content[0]!.text!, /已改名/);
    assert.match(renamed.content[0]!.text!, /新标题/);
    assert.deepEqual(channel.calls[0], { method: "rename", args: [id, "新标题"] });
    const deleted = await run(tools, "organize_sessions", {
      action: "delete", sessions: [{ session: id }],
    });
    assert.equal(deleted.isError, undefined);
    assert.match(deleted.content[0]!.text!, /已建议删除 1 个会话/);
    assert.match(deleted.content[0]!.text!, /确认删除/);
    assert.equal(channel.calls.filter((call) => call.method !== "rename").length, 0);
  });

  it("organize rename without a channel is an honest error", async () => {
    seedSession("/repos/pix", "旧标题", "旧标题");
    const result = await run(collect(), "organize_sessions", {
      action: "rename", sessions: [{ session: "旧标题" }], title: "新标题",
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0]!.text!, /会话操作通道不可用/);
  });
});
