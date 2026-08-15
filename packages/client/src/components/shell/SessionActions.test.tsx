import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect } from "react";
import { RuntimeProvider, useRuntimeStore } from "@/runtime/runtime-provider";
import { CapabilityProvider } from "@/features/capability/CapabilityProvider";
import { HttpClientProvider } from "@/app/http-context";
import { FakeWebSocket, flush, lastFrame, snapshotPayload } from "@/runtime/testing/harness";
import type { RuntimeSocketDeps } from "@/runtime/socket";
import type { SessionStore } from "@/runtime/session-store";
import type { HostInfo } from "@fffattiger/pix-protocol";
import { SessionActions } from "./SessionActions";

// Real SessionStore over a fake WebSocket — same honest wiring as the
// runtime-provider tests (no useRuntime mock, no `as any` on protocol payloads).

const SOCKETS: FakeWebSocket[] = [];
function fakeDeps(): RuntimeSocketDeps {
  return {
    createWebSocket: (url) => { const ws = new FakeWebSocket(url); SOCKETS.push(ws); return ws; },
    now: () => Date.now(),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    random: () => 0.5,
    location: { href: "https://pix.local/app/" },
    identity: { shell: "web", platform: "mac" },
    onOnline: () => () => undefined,
    onVisible: () => () => undefined,
  };
}

let capturedStore: SessionStore | null = null;
function Capture(): null {
  const store = useRuntimeStore();
  useEffect(() => { capturedStore = store; }, [store]);
  return null;
}

function json(body: unknown, status = 200) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  return new Response(JSON.stringify(body), { status, headers });
}

/**
 * Install a fetch mock that answers the read-only Models catalog for the
 * runtime cwd. Returns the call log so tests can assert zero-request honesty.
 */
function installModelsFetch(models: Array<{ id: string; provider: string; displayName?: string; thinking?: boolean }>) {
  const calls: string[] = [];
  const impl = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://pix.local");
    calls.push(`${url.pathname}${url.search}`);
    if (url.pathname === "/v1/models") {
      return json({ models, defaultModel: null });
    }
    return json({ message: "not found", code: "NOT_FOUND" }, 404);
  }) as unknown as typeof fetch;
  globalThis.fetch = impl;
  return { impl, calls };
}

function mount(live?: boolean, host?: Partial<HostInfo> | null) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // Default host override keeps existing tests bootstrap-fetch-free and honest:
  // agent capability only, no `models` catalog token.
  const resolvedHost: Partial<HostInfo> | null =
    host === undefined ? { mode: "local", capabilities: ["agent"] } : host;
  const tree = (nextLive?: boolean) => (
    <QueryClientProvider client={queryClient}>
      <HttpClientProvider>
        <CapabilityProvider host={resolvedHost}>
          <RuntimeProvider deps={fakeDeps()}>
            <Capture />
            {nextLive === undefined ? <SessionActions /> : <SessionActions live={nextLive} />}
          </RuntimeProvider>
        </CapabilityProvider>
      </HttpClientProvider>
    </QueryClientProvider>
  );
  const view = render(tree(live));
  return {
    view,
    // Same-root rerender preserves the RuntimeProvider store instance (React
    // reconciles the identical tree types) so attached state survives a `live`
    // flip — matching AppShell's capability/selection behavior.
    rerender: (nextLive?: boolean) => view.rerender(tree(nextLive)),
  };
}

function ack(caps: string[] = ["agent"]) {
  return { type: "handshake_ack", payload: { protocolVersion: 1, host: { mode: "local", capabilities: caps }, limits: { maxUpload: 0, maxOpenSessions: 4 }, sessionSnapshotSupport: true } };
}

async function driveReady(): Promise<FakeWebSocket> {
  const store = capturedStore!;
  await act(async () => {
    store.connect();
    const ws = SOCKETS[SOCKETS.length - 1]!;
    ws.serverOpen();
    ws.serverSend(ack());
    await flush();
  });
  return SOCKETS[SOCKETS.length - 1]!;
}

async function driveAttach(
  ws: FakeWebSocket,
  capabilities?: string[],
  sessionId = "s1",
  extra: { thinkingLevel?: string; thinkingLevelPinned?: boolean; model?: { provider: string; id: string } | null } = {},
): Promise<void> {
  const store = capturedStore!;
  await act(async () => {
    void store.openSession(sessionId);
    await flush();
    const attachFrame = lastFrame<{ type: string; id: string }>(ws, "attach")!;
    ws.serverSend({
      type: "snapshot",
      id: attachFrame.id,
      payload: snapshotPayload({
        sessionId,
        ...(capabilities === undefined ? {} : { capabilities }),
        ...extra,
      }),
    });
    await flush();
  });
}

async function serverSend(ws: FakeWebSocket, message: unknown): Promise<void> {
  await act(async () => {
    ws.serverSend(message);
    await flush();
  });
}

describe("SessionActions — D2-P1/D2-P2 UI", () => {
  let previousFetch: typeof fetch;
  beforeEach(() => { vi.useFakeTimers(); SOCKETS.length = 0; capturedStore = null; previousFetch = globalThis.fetch; });
  afterEach(() => { cleanup(); vi.useRealTimers(); globalThis.fetch = previousFetch; });

  it("shows a hint and no action controls while not attached", async () => {
    mount();
    expect(screen.getByText(/attach a runtime session to inspect/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "State" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Rename" })).toBeNull();
    expect(screen.queryByLabelText("Thinking level")).toBeNull();
  });

  it("hides entirely when live=false (history / mismatched selection)", async () => {
    mount(false);
    // Even after attach, the selection gate keeps the panel unmounted.
    const ws = await driveReady();
    await driveAttach(ws, ["runtime.prompt", "runtime.abort", "runtime.stats", "runtime.session.rename", "runtime.thinking.set"]);
    expect(screen.queryByLabelText("Session actions")).toBeNull();
    expect(screen.queryByRole("button", { name: "State" })).toBeNull();
    expect(screen.queryByLabelText("Thinking level")).toBeNull();
  });

  it("gates stats/rename/thinking on the attach-snapshot capability set; baseline queries always show", async () => {
    mount();
    const ws = await driveReady();
    await driveAttach(ws, ["runtime.prompt", "runtime.abort"]);

    // Baseline queries are always available once attached.
    expect(screen.getByRole("button", { name: "State" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Commands" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Last text" })).toBeTruthy();
    // Capability-gated controls are HIDDEN without their capabilities.
    expect(screen.queryByRole("button", { name: "Stats" })).toBeNull();
    expect(screen.queryByLabelText("Session name")).toBeNull();
    expect(screen.queryByLabelText("Thinking level")).toBeNull();
  });

  it("shows Stats and Thinking when the runtime advertises the D2 surface (no SessionActions rename — Sidebar owns rename)", async () => {
    mount();
    const ws = await driveReady();
    await driveAttach(
      ws,
      ["runtime.prompt", "runtime.abort", "runtime.stats", "runtime.session.rename", "runtime.thinking.set"],
      "s1",
      { thinkingLevel: "off", thinkingLevelPinned: false },
    );
    expect(screen.getByRole("button", { name: "Stats" })).toBeTruthy();
    expect(screen.getByLabelText("Thinking level")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Set thinking" })).toBeTruthy();
    expect(screen.getByText(/current: off/)).toBeTruthy();
    expect(screen.getByText(/not pinned/)).toBeTruthy();
    // The rename surface is intentionally NOT rendered here even though the
    // runtime advertises runtime.session.rename — the Sidebar is the single
    // visible rename product surface (D4 Host session.write PATCH).
    expect(screen.queryByRole("button", { name: "Rename" })).toBeNull();
    expect(screen.queryByLabelText("Session name")).toBeNull();
    // All Protocol levels are offered.
    const select = screen.getByLabelText("Thinking level") as HTMLSelectElement;
    const values = Array.from(select.options).map((option) => option.value).filter(Boolean);
    expect(values).toEqual(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
  });

  it("shows Loading while a query is in flight, then the success output", async () => {
    mount();
    const ws = await driveReady();
    await driveAttach(ws);
    fireEvent.click(screen.getByRole("button", { name: "State" }));
    // In-flight: honest busy indicator.
    await flush();
    expect(screen.getByRole("status").textContent).toBe("Loading…");
    const cmd = lastFrame<{ type: string; id: string; payload: { command: { type: string; commandId: string } } }>(ws, "command")!;
    expect(cmd.payload.command.type).toBe("get_state");
    await serverSend(ws, {
      type: "response",
      id: cmd.id,
      payload: { ok: true, result: { commandId: cmd.payload.command.commandId, result: { ok: true, type: "get_state", state: { sessionId: "s1", isStreaming: false, isPromptRunning: false, isBashRunning: false, isCompacting: false, model: null, messageCount: 4, sessionName: "Work" } } } },
    });
    expect(screen.getByText(/messageCount=4/)).toBeTruthy();
    expect(screen.getByText(/name="Work"/)).toBeTruthy();
    expect(screen.queryByText("Loading…")).toBeNull();
  });

  it("surfaces a runtime error instead of a fake success", async () => {
    mount();
    const ws = await driveReady();
    await driveAttach(ws);
    fireEvent.click(screen.getByRole("button", { name: "Last text" }));
    await flush();
    const cmd = lastFrame<{ type: string; id: string; payload: { command: { type: string; commandId: string } } }>(ws, "command")!;
    await serverSend(ws, {
      type: "response",
      id: cmd.id,
      payload: { ok: true, result: { commandId: cmd.payload.command.commandId, result: { ok: false, type: "get_last_assistant_text", error: { code: "external", message: "backend exploded", retryable: true } } } },
    });
    expect(screen.getByRole("alert").textContent).toBe("backend exploded");
    expect(screen.queryByText(/last assistant text/)).toBeNull();
  });

  it("never offers a rename control in SessionActions (Sidebar owns rename); no set_session_name is ever issued", async () => {
    mount();
    const ws = await driveReady();
    await driveAttach(ws, ["runtime.prompt", "runtime.abort", "runtime.session.rename"]);
    // Even with the runtime rename capability advertised, SessionActions renders
    // no rename input/button and issues no set_session_name command frame.
    expect(screen.queryByRole("button", { name: "Rename" })).toBeNull();
    expect(screen.queryByLabelText("Session name")).toBeNull();
    const commands = (ws.sent as { type: string; payload?: { command?: { type?: string } } }[]).filter(
      (frame) => frame.type === "command",
    );
    expect(commands.some((frame) => frame.payload?.command?.type === "set_session_name")).toBe(false);
  });

  it("thinking submit sends set_thinking_level, refreshes snapshot, shows current + pinned", async () => {
    mount();
    const ws = await driveReady();
    await driveAttach(
      ws,
      ["runtime.prompt", "runtime.abort", "runtime.thinking.set"],
      "s1",
      { thinkingLevel: "off", thinkingLevelPinned: false },
    );
    const select = screen.getByLabelText("Thinking level") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "high" } });
    fireEvent.click(screen.getByRole("button", { name: "Set thinking" }));
    await flush();
    const cmd = lastFrame<{ type: string; id: string; payload: { command: { type: string; commandId: string; level: string } } }>(ws, "command")!;
    expect(cmd.payload.command.type).toBe("set_thinking_level");
    expect(cmd.payload.command.level).toBe("high");
    await serverSend(ws, {
      type: "response",
      id: cmd.id,
      payload: { ok: true, result: { commandId: cmd.payload.command.commandId, result: { ok: true, type: "set_thinking_level" } } },
    });
    await flush();
    const snap = lastFrame<{ type: string; id: string }>(ws, "getSnapshot")!;
    expect(snap.type).toBe("getSnapshot");
    await serverSend(ws, {
      type: "response",
      id: snap.id,
      payload: {
        ok: true,
        result: snapshotPayload({
          sessionId: "s1",
          capabilities: ["runtime.prompt", "runtime.abort", "runtime.thinking.set"],
          thinkingLevel: "high",
          thinkingLevelPinned: true,
        }).snapshot,
      },
    });
    expect(screen.getByText(/Thinking level set to "high"/)).toBeTruthy();
    expect(screen.getByText(/current: high/)).toBeTruthy();
    expect(screen.getByText(/pinned/)).toBeTruthy();
  });

  it("thinking failure uses fixed safe copy and never renders the raw error", async () => {
    mount();
    const ws = await driveReady();
    await driveAttach(ws, ["runtime.prompt", "runtime.abort", "runtime.thinking.set"], "s1", {
      thinkingLevel: "off",
      thinkingLevelPinned: false,
    });
    fireEvent.change(screen.getByLabelText("Thinking level"), { target: { value: "max" } });
    fireEvent.click(screen.getByRole("button", { name: "Set thinking" }));
    await flush();
    const cmd = lastFrame<{ type: string; id: string; payload: { command: { type: string; commandId: string; level: string } } }>(ws, "command")!;
    await serverSend(ws, {
      type: "response",
      id: cmd.id,
      payload: {
        ok: true,
        result: {
          commandId: cmd.payload.command.commandId,
          result: {
            ok: false,
            type: "set_thinking_level",
            error: { code: "external", message: "secret backend detail leak", retryable: true },
          },
        },
      },
    });
    expect(screen.getByRole("alert").textContent).toBe("Failed to update thinking level.");
    expect(screen.queryByText(/secret backend detail leak/)).toBeNull();
    await flush();
    expect(lastFrame(ws, "getSnapshot")).toBeUndefined();
  });

  it("double-click thinking submit only issues one command (singleflight)", async () => {
    mount();
    const ws = await driveReady();
    await driveAttach(ws, ["runtime.prompt", "runtime.abort", "runtime.thinking.set"], "s1", {
      thinkingLevel: "off",
      thinkingLevelPinned: false,
    });
    fireEvent.change(screen.getByLabelText("Thinking level"), { target: { value: "medium" } });
    const button = screen.getByRole("button", { name: "Set thinking" });
    fireEvent.click(button);
    fireEvent.click(button);
    await flush();
    const commands = (ws.sent as { type: string; payload?: { command?: { type?: string } } }[]).filter(
      (frame) => frame.type === "command",
    );
    expect(commands).toHaveLength(1);
    expect(commands[0]?.payload?.command?.type).toBe("set_thinking_level");
  });

  it("late thinking settle after unmount does not throw into UI or issue getSnapshot", async () => {
    mount();
    const ws = await driveReady();
    await driveAttach(ws, ["runtime.prompt", "runtime.abort", "runtime.thinking.set"], "s1", {
      thinkingLevel: "off",
      thinkingLevelPinned: false,
    });
    fireEvent.change(screen.getByLabelText("Thinking level"), { target: { value: "high" } });
    fireEvent.click(screen.getByRole("button", { name: "Set thinking" }));
    await flush();
    const cmd = lastFrame<{ type: string; id: string; payload: { command: { type: string; commandId: string; level: string } } }>(ws, "command")!;
    expect(cmd.payload.command.level).toBe("high");

    // Unmount while the command is in flight — late settle must be fail-closed.
    // cleanup() disposes the RuntimeProvider store; the in-flight command promise
    // is rejected as unavailable and MUST be consumed by handleThinkingSubmit
    // (no unhandled rejection, no getSnapshot, no UI write).
    cleanup();
    expect(screen.queryByLabelText("Session actions")).toBeNull();

    // Allow the dispose rejection path to settle under act (no arbitrary sleep).
    await act(async () => {
      await flush(12);
    });
    // A late success frame (if any) must still not issue getSnapshot.
    await act(async () => {
      ws.serverSend({
        type: "response",
        id: cmd.id,
        payload: { ok: true, result: { commandId: cmd.payload.command.commandId, result: { ok: true, type: "set_thinking_level" } } },
      });
      await flush(12);
    });
    expect(lastFrame(ws, "getSnapshot")).toBeUndefined();
  });

  it("session switch while thinking is in flight fails closed: no s1 success status, no getSnapshot, s2 UI intact", async () => {
    mount();
    const ws = await driveReady();
    await driveAttach(ws, ["runtime.prompt", "runtime.abort", "runtime.thinking.set"], "s1", {
      thinkingLevel: "off",
      thinkingLevelPinned: false,
    });
    fireEvent.change(screen.getByLabelText("Thinking level"), { target: { value: "high" } });
    fireEvent.click(screen.getByRole("button", { name: "Set thinking" }));
    await flush();
    const cmd = lastFrame<{ type: string; id: string; payload: { command: { type: string; commandId: string; level: string } } }>(ws, "command")!;
    expect(cmd.payload.command.type).toBe("set_thinking_level");
    expect(cmd.payload.command.level).toBe("high");

    // AppShell-shaped live switch: detach A (store returns to ready), then open B.
    // All store promises are fire-and-forget + wire-driven; no await of store
    // promises and no arbitrary sleep (microtask flush only).
    await act(async () => {
      void capturedStore!.detach().catch(() => undefined);
      await flush();
    });
    const detachFrame = lastFrame<{ type: string; id: string }>(ws, "detach")!;
    expect(detachFrame).toBeTruthy();
    await serverSend(ws, {
      type: "response",
      id: detachFrame.id,
      payload: { ok: true, result: { sessionId: "s1", detached: true } },
    });

    await act(async () => {
      void capturedStore!.openSession("s2").catch(() => undefined);
      await flush();
    });
    const attachFrame = lastFrame<{ type: string; id: string }>(ws, "attach")!;
    expect(attachFrame).toBeTruthy();
    await act(async () => {
      ws.serverSend({
        type: "snapshot",
        id: attachFrame.id,
        payload: snapshotPayload({
          sessionId: "s2",
          capabilities: ["runtime.prompt", "runtime.abort", "runtime.thinking.set"],
          thinkingLevel: "low",
          thinkingLevelPinned: true,
        }),
      });
      await flush(12);
    });

    // s2 is the live selection now — thinking controls reflect s2 snapshot.
    expect(screen.getByText(/current: low/)).toBeTruthy();
    expect(screen.getByText(/ · pinned/)).toBeTruthy();

    // Stale s1 success must not write s1 status or issue getSnapshot for the old request.
    const getSnapshotCountBefore = (ws.sent as { type: string }[]).filter((frame) => frame.type === "getSnapshot").length;
    await act(async () => {
      ws.serverSend({
        type: "response",
        id: cmd.id,
        payload: { ok: true, result: { commandId: cmd.payload.command.commandId, result: { ok: true, type: "set_thinking_level" } } },
      });
      await flush(12);
    });
    expect(screen.queryByText(/Thinking level set to "high"/)).toBeNull();
    expect(screen.queryByText(/Failed to update thinking level/)).toBeNull();
    expect(screen.getByText(/current: low/)).toBeTruthy();
    expect(screen.getByText(/ · pinned/)).toBeTruthy();
    const getSnapshotCountAfter = (ws.sent as { type: string }[]).filter((frame) => frame.type === "getSnapshot").length;
    expect(getSnapshotCountAfter).toBe(getSnapshotCountBefore);
  });

  it("live true→false invalidates an in-flight thinking request even when runtime.sessionId is unchanged", async () => {
    const mounted = mount(true);
    const ws = await driveReady();
    await driveAttach(ws, ["runtime.prompt", "runtime.abort", "runtime.thinking.set"], "s1", {
      thinkingLevel: "off",
      thinkingLevelPinned: false,
    });
    fireEvent.change(screen.getByLabelText("Thinking level"), { target: { value: "high" } });
    fireEvent.click(screen.getByRole("button", { name: "Set thinking" }));
    await flush();
    const cmd = lastFrame<{ type: string; id: string; payload: { command: { commandId: string } } }>(ws, "command")!;
    const snapshotsBefore = (ws.sent as { type: string }[]).filter((frame) => frame.type === "getSnapshot").length;

    // AppShell selection leaves attached s1 but switches to read-only history.
    mounted.rerender(false);
    expect(screen.queryByLabelText("Session actions")).toBeNull();

    await act(async () => {
      ws.serverSend({
        type: "response",
        id: cmd.id,
        payload: { ok: true, result: { commandId: cmd.payload.command.commandId, result: { ok: true, type: "set_thinking_level" } } },
      });
      await flush(12);
    });
    expect((ws.sent as { type: string }[]).filter((frame) => frame.type === "getSnapshot").length).toBe(snapshotsBefore);

    // Returning to the same attached session starts clean; stale success/error is never restored.
    mounted.rerender(true);
    expect(screen.getByLabelText("Session actions")).toBeTruthy();
    expect(screen.queryByText(/Thinking level set to/)).toBeNull();
    expect(screen.queryByText(/Failed to update thinking level/)).toBeNull();
    expect(screen.queryByText("Loading…")).toBeNull();
    expect(screen.getByText(/current: off/)).toBeTruthy();
  });

  it("live=false identity gate stays fail-closed even while the runtime is attached with thinking cap", async () => {
    // Explicit selection mismatch: AppShell passes live={false} for history / non-selected sessions.
    mount(false);
    const ws = await driveReady();
    await driveAttach(ws, ["runtime.prompt", "runtime.abort", "runtime.thinking.set"], "s1", {
      thinkingLevel: "high",
      thinkingLevelPinned: true,
    });
    expect(screen.queryByLabelText("Session actions")).toBeNull();
    expect(screen.queryByLabelText("Thinking level")).toBeNull();
    expect(screen.queryByRole("button", { name: "Set thinking" })).toBeNull();
    // No thinking command is ever issued from a non-live selection.
    const commands = (ws.sent as { type: string }[]).filter((frame) => frame.type === "command");
    expect(commands).toHaveLength(0);
  });
});

/**
 * Settle a TanStack models query under vitest fake timers: flush the fetch
 * promise chain, tick a non-zero slice so notifyManager `setTimeout(0)`
 * delivers the data, then flush again.
 */
async function settleQuery() {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  await act(async () => { await vi.advanceTimersByTimeAsync(5); });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  await act(async () => { await vi.advanceTimersByTimeAsync(5); });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

const MODEL_CAPS = ["runtime.prompt", "runtime.abort", "runtime.model.set"];
const MODELS_HOST: Partial<HostInfo> = { mode: "local", capabilities: ["agent", "models"] };
const MODELS_NO_CATALOG: Partial<HostInfo> = { mode: "local", capabilities: ["agent"] };

const BASE_MODELS = [
  { id: "gpt-5", provider: "openai", displayName: "GPT-5", thinking: true },
  { id: "claude-opus-4", provider: "anthropic", displayName: "Claude Opus 4", thinking: true },
  { id: "gpt-5-mini", provider: "openai", displayName: "GPT-5 mini", thinking: false },
];

describe("SessionActions — D2-P3 Model control", () => {
  let previousFetch: typeof fetch;
  beforeEach(() => { vi.useFakeTimers(); SOCKETS.length = 0; capturedStore = null; previousFetch = globalThis.fetch; });
  afterEach(() => { cleanup(); vi.useRealTimers(); globalThis.fetch = previousFetch; });

  it("shows Model control only when live + runtime.model.set + Host models, queried at the RUNTIME snapshot cwd", async () => {
    const { calls } = installModelsFetch(BASE_MODELS);
    mount(true, MODELS_HOST);
    const ws = await driveReady();
    await driveAttach(ws, MODEL_CAPS, "s1", {
      model: { provider: "openai", id: "gpt-5" },
      thinkingLevel: "off",
      thinkingLevelPinned: false,
    });
    await settleQuery();

    expect(screen.getByLabelText("Model")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Set model" })).toBeTruthy();
    // Models query is keyed on the RUNTIME snapshot cwd (/x), never a hardcoded
    // or selected-history cwd.
    expect(calls.some((call) => call.startsWith("/v1/models?cwd=") && call.includes(encodeURIComponent("/x")))).toBe(true);
    const select = screen.getByLabelText("Model") as HTMLSelectElement;
    const values = Array.from(select.options).map((option) => option.textContent);
    expect(values).toContain("openai/gpt-5");
    expect(values).toContain("anthropic/claude-opus-4");
    // Current model in list is pre-selected (no empty placeholder).
    expect(select.value).not.toBe("");
  });

  it("hides Model control when the runtime does NOT advertise runtime.model.set (zero models requests)", async () => {
    const { calls } = installModelsFetch(BASE_MODELS);
    mount(true, MODELS_HOST);
    const ws = await driveReady();
    await driveAttach(ws, ["runtime.prompt", "runtime.abort"]);
    await settleQuery();
    expect(screen.queryByLabelText("Model")).toBeNull();
    expect(screen.queryByRole("button", { name: "Set model" })).toBeNull();
    expect(calls.filter((call) => call.startsWith("/v1/models")).length).toBe(0);
  });

  it("runtime.model.set without Host models capability shows fixed unavailable and issues ZERO models requests", async () => {
    const { calls } = installModelsFetch(BASE_MODELS);
    mount(true, MODELS_NO_CATALOG);
    const ws = await driveReady();
    await driveAttach(ws, MODEL_CAPS, "s1", { model: { provider: "openai", id: "gpt-5" } });
    await settleQuery();
    // Control is visible (runtime set capability) but read-only unavailable.
    expect(screen.getByLabelText("Model")).toBeTruthy();
    expect(screen.getByText("Model catalog is unavailable.")).toBeTruthy();
    const select = screen.getByLabelText("Model") as HTMLSelectElement;
    expect(select.disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Set model" }) as HTMLButtonElement).disabled).toBe(true);
    expect(calls.filter((call) => call.startsWith("/v1/models")).length).toBe(0);
  });

  it("current model NOT in the list shows a readonly placeholder and never a fabricated option", async () => {
    installModelsFetch(BASE_MODELS);
    mount(true, MODELS_HOST);
    const ws = await driveReady();
    await driveAttach(ws, MODEL_CAPS, "s1", { model: { provider: "legacy", id: "old-model" } });
    await settleQuery();
    const select = screen.getByLabelText("Model") as HTMLSelectElement;
    // Empty value with a disabled placeholder; current shown read-only in meta.
    expect(select.value).toBe("");
    expect(screen.getByText("Current model not listed")).toBeTruthy();
    expect(screen.getByText(/current: legacy\/old-model/)).toBeTruthy();
    // No option claims the legacy model.
    expect(Array.from(select.options).some((option) => option.textContent === "legacy/old-model")).toBe(false);
    expect((screen.getByRole("button", { name: "Set model" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("option encoding is collision-safe when provider/model id contain colons", async () => {
    installModelsFetch([
      { id: "b:c", provider: "a" },
      { id: "c", provider: "a:b" },
    ]);
    mount(true, MODELS_HOST);
    const ws = await driveReady();
    // Current = first model; select the second (whose naive `provider:model`
    // string would collide with the first: both are "a:b:c").
    await driveAttach(ws, MODEL_CAPS, "s1", { model: { provider: "a", id: "b:c" } });
    await settleQuery();
    const select = screen.getByLabelText("Model") as HTMLSelectElement;
    expect(select.options.length).toBe(2);
    const secondOption = Array.from(select.options).find((option) => option.textContent === "a:b/c");
    expect(secondOption).toBeTruthy();
    fireEvent.change(select, { target: { value: secondOption!.value } });
    fireEvent.click(screen.getByRole("button", { name: "Set model" }));
    await flush();
    const cmd = lastFrame<{ type: string; id: string; payload: { command: { commandId: string; type: string; provider: string; modelId: string } } }>(ws, "command")!;
    expect(cmd.payload.command.type).toBe("set_model");
    // Exact provider/modelId read back from the option by key — no colon join.
    expect(cmd.payload.command.provider).toBe("a:b");
    expect(cmd.payload.command.modelId).toBe("c");
  });

  it("submit sends exact provider/modelId then fetchSnapshot observes authoritative model + thinking clamp/pin", async () => {
    installModelsFetch(BASE_MODELS);
    mount(true, MODELS_HOST);
    const ws = await driveReady();
    await driveAttach(ws, [...MODEL_CAPS, "runtime.thinking.set"], "s1", {
      model: { provider: "openai", id: "gpt-5" },
      thinkingLevel: "off",
      thinkingLevelPinned: false,
    });
    await settleQuery();

    const select = screen.getByLabelText("Model") as HTMLSelectElement;
    const target = Array.from(select.options).find((option) => option.textContent === "anthropic/claude-opus-4");
    fireEvent.change(select, { target: { value: target!.value } });
    fireEvent.click(screen.getByRole("button", { name: "Set model" }));
    await flush();
    const cmd = lastFrame<{ type: string; id: string; payload: { command: { commandId: string; type: string; provider: string; modelId: string } } }>(ws, "command")!;
    expect(cmd.payload.command.type).toBe("set_model");
    expect(cmd.payload.command.provider).toBe("anthropic");
    expect(cmd.payload.command.modelId).toBe("claude-opus-4");

    await serverSend(ws, { type: "response", id: cmd.id, payload: { ok: true, result: { commandId: cmd.payload.command.commandId, result: { ok: true, type: "set_model" } } } });
    await flush();
    const snap = lastFrame<{ type: string; id: string }>(ws, "getSnapshot")!;
    expect(snap.type).toBe("getSnapshot");
    // Authoritative post-set snapshot: new model AND re-clamped/pinned thinking.
    await serverSend(ws, {
      type: "response",
      id: snap.id,
      payload: {
        ok: true,
        result: snapshotPayload({
          sessionId: "s1",
          capabilities: [...MODEL_CAPS, "runtime.thinking.set"],
          model: { provider: "anthropic", id: "claude-opus-4" },
          thinkingLevel: "high",
          thinkingLevelPinned: true,
        }).snapshot,
      },
    });
    expect(screen.getByText(/Model set to "anthropic\/claude-opus-4"/)).toBeTruthy();
    expect(screen.getByText(/current: anthropic\/claude-opus-4/)).toBeTruthy();
    // Thinking control coexists and reflects the re-clamped pin after model change.
    expect(screen.getByText(/current: high/)).toBeTruthy();
    expect(screen.getByText(/ · pinned/)).toBeTruthy();
  });

  it("unknown-model failure shows fixed copy and never renders raw; no getSnapshot on failure", async () => {
    installModelsFetch(BASE_MODELS);
    mount(true, MODELS_HOST);
    const ws = await driveReady();
    await driveAttach(ws, MODEL_CAPS, "s1", { model: { provider: "openai", id: "gpt-5" } });
    await settleQuery();
    const select = screen.getByLabelText("Model") as HTMLSelectElement;
    const target = Array.from(select.options).find((option) => option.textContent === "anthropic/claude-opus-4");
    fireEvent.change(select, { target: { value: target!.value } });
    fireEvent.click(screen.getByRole("button", { name: "Set model" }));
    await flush();
    const cmd = lastFrame<{ type: string; id: string; payload: { command: { commandId: string; type: string } } }>(ws, "command")!;
    await serverSend(ws, {
      type: "response",
      id: cmd.id,
      payload: { ok: true, result: { commandId: cmd.payload.command.commandId, result: { ok: false, type: "set_model", error: { code: "invalid_input", message: "unknown model: sk-SECRET-BACKEND", retryable: false } } } },
    });
    expect(screen.getByRole("alert").textContent).toBe("Model is unavailable.");
    expect(screen.queryByText(/sk-SECRET-BACKEND/)).toBeNull();
    await flush();
    expect(lastFrame(ws, "getSnapshot")).toBeUndefined();
  });

  it("auth failure maps to a fixed Provider is not authenticated. copy (no raw)", async () => {
    installModelsFetch(BASE_MODELS);
    mount(true, MODELS_HOST);
    const ws = await driveReady();
    await driveAttach(ws, MODEL_CAPS, "s1", { model: { provider: "openai", id: "gpt-5" } });
    await settleQuery();
    const select = screen.getByLabelText("Model") as HTMLSelectElement;
    const target = Array.from(select.options).find((option) => option.textContent === "anthropic/claude-opus-4");
    fireEvent.change(select, { target: { value: target!.value } });
    fireEvent.click(screen.getByRole("button", { name: "Set model" }));
    await flush();
    const cmd = lastFrame<{ type: string; id: string; payload: { command: { commandId: string; type: string } } }>(ws, "command")!;
    await serverSend(ws, {
      type: "response",
      id: cmd.id,
      payload: { ok: true, result: { commandId: cmd.payload.command.commandId, result: { ok: false, type: "set_model", error: { code: "external", message: "sk-leak-api-key not authorized", retryable: true, cause: { kind: "auth", detail: "authentication failed" } } } } },
    });
    expect(screen.getByRole("alert").textContent).toBe("Provider is not authenticated.");
    expect(screen.queryByText(/sk-leak-api-key/)).toBeNull();
  });

  it("same current model selection disables submit (no-op)", async () => {
    installModelsFetch(BASE_MODELS);
    mount(true, MODELS_HOST);
    const ws = await driveReady();
    await driveAttach(ws, MODEL_CAPS, "s1", { model: { provider: "openai", id: "gpt-5" } });
    await settleQuery();
    const select = screen.getByLabelText("Model") as HTMLSelectElement;
    // Select the CURRENT model explicitly — submit stays disabled.
    const current = Array.from(select.options).find((option) => option.textContent === "openai/gpt-5");
    fireEvent.change(select, { target: { value: current!.value } });
    expect((screen.getByRole("button", { name: "Set model" }) as HTMLButtonElement).disabled).toBe(true);
    expect(ws.sent.filter((frame) => (frame as { type?: string }).type === "command")).toHaveLength(0);
  });

  it("rapid double submit issues exactly one set_model command", async () => {
    installModelsFetch(BASE_MODELS);
    mount(true, MODELS_HOST);
    const ws = await driveReady();
    await driveAttach(ws, MODEL_CAPS, "s1", { model: { provider: "openai", id: "gpt-5" } });
    await settleQuery();
    const select = screen.getByLabelText("Model") as HTMLSelectElement;
    const target = Array.from(select.options).find((option) => option.textContent === "anthropic/claude-opus-4");
    fireEvent.change(select, { target: { value: target!.value } });
    const button = screen.getByRole("button", { name: "Set model" });
    fireEvent.click(button);
    fireEvent.click(button);
    await flush();
    const commands = (ws.sent as { type: string; payload?: { command?: { type?: string } } }[]).filter((frame) => frame.type === "command");
    expect(commands).toHaveLength(1);
    expect(commands[0]?.payload?.command?.type).toBe("set_model");
  });

  it("runtime.model.set revoke mid-flight hides control and late success issues no getSnapshot", async () => {
    installModelsFetch(BASE_MODELS);
    mount(true, MODELS_HOST);
    const ws = await driveReady();
    await driveAttach(ws, MODEL_CAPS, "s1", { model: { provider: "openai", id: "gpt-5" } });
    await settleQuery();
    const select = screen.getByLabelText("Model") as HTMLSelectElement;
    const target = Array.from(select.options).find((option) => option.textContent === "anthropic/claude-opus-4");
    fireEvent.change(select, { target: { value: target!.value } });
    fireEvent.click(screen.getByRole("button", { name: "Set model" }));
    await flush();
    const cmd = lastFrame<{ type: string; id: string; payload: { command: { commandId: string } } }>(ws, "command")!;
    const snapshotsBefore = (ws.sent as { type: string }[]).filter((frame) => frame.type === "getSnapshot").length;

    // Revoke runtime.model.set via a capabilities_changed event.
    await serverSend(ws, {
      type: "event",
      payload: { type: "runtime_capabilities_changed", sessionId: "s1", eventId: 1, epoch: "e1", capabilities: { capabilities: ["runtime.prompt", "runtime.abort"], version: 2 } },
    });
    expect(screen.queryByLabelText("Model")).toBeNull();
    expect(screen.queryByRole("button", { name: "Set model" })).toBeNull();

    // Late success must not fetch or write stale status for the revoked control.
    await serverSend(ws, { type: "response", id: cmd.id, payload: { ok: true, result: { commandId: cmd.payload.command.commandId, result: { ok: true, type: "set_model" } } } });
    await flush();
    expect((ws.sent as { type: string }[]).filter((frame) => frame.type === "getSnapshot").length).toBe(snapshotsBefore);
    expect(screen.queryByText(/Model set to/)).toBeNull();
  });

  it("live true→false mid-flight invalidates model submit: no getSnapshot, clean return", async () => {
    installModelsFetch(BASE_MODELS);
    const mounted = mount(true, MODELS_HOST);
    const ws = await driveReady();
    await driveAttach(ws, MODEL_CAPS, "s1", { model: { provider: "openai", id: "gpt-5" } });
    await settleQuery();
    const select = screen.getByLabelText("Model") as HTMLSelectElement;
    const target = Array.from(select.options).find((option) => option.textContent === "anthropic/claude-opus-4");
    fireEvent.change(select, { target: { value: target!.value } });
    fireEvent.click(screen.getByRole("button", { name: "Set model" }));
    await flush();
    const cmd = lastFrame<{ type: string; id: string; payload: { command: { commandId: string } } }>(ws, "command")!;
    const snapshotsBefore = (ws.sent as { type: string }[]).filter((frame) => frame.type === "getSnapshot").length;

    mounted.rerender(false);
    expect(screen.queryByLabelText("Session actions")).toBeNull();

    await serverSend(ws, { type: "response", id: cmd.id, payload: { ok: true, result: { commandId: cmd.payload.command.commandId, result: { ok: true, type: "set_model" } } } });
    await flush();
    expect((ws.sent as { type: string }[]).filter((frame) => frame.type === "getSnapshot").length).toBe(snapshotsBefore);
  });

  it("session switch A→B mid-flight: stale model success writes nothing for the new session", async () => {
    installModelsFetch(BASE_MODELS);
    mount(true, MODELS_HOST);
    const ws = await driveReady();
    await driveAttach(ws, MODEL_CAPS, "s1", { model: { provider: "openai", id: "gpt-5" } });
    await settleQuery();
    const select = screen.getByLabelText("Model") as HTMLSelectElement;
    const target = Array.from(select.options).find((option) => option.textContent === "anthropic/claude-opus-4");
    fireEvent.change(select, { target: { value: target!.value } });
    fireEvent.click(screen.getByRole("button", { name: "Set model" }));
    await flush();
    const cmd = lastFrame<{ type: string; id: string; payload: { command: { commandId: string } } }>(ws, "command")!;
    const snapshotsBefore = (ws.sent as { type: string }[]).filter((frame) => frame.type === "getSnapshot").length;

    // Switch to s2 (same cwd, same caps).
    await act(async () => {
      void capturedStore!.detach().catch(() => undefined);
      await flush();
    });
    const detachFrame = lastFrame<{ type: string; id: string }>(ws, "detach")!;
    await serverSend(ws, { type: "response", id: detachFrame.id, payload: { ok: true, result: { sessionId: "s1", detached: true } } });
    await act(async () => {
      void capturedStore!.openSession("s2").catch(() => undefined);
      await flush();
    });
    const attachFrame = lastFrame<{ type: string; id: string }>(ws, "attach")!;
    await act(async () => {
      ws.serverSend({ type: "snapshot", id: attachFrame.id, payload: snapshotPayload({ sessionId: "s2", capabilities: MODEL_CAPS, model: { provider: "openai", id: "gpt-5" } }) });
      await flush(12);
    });

    // Stale s1 success must not write s1 status or issue getSnapshot.
    await serverSend(ws, { type: "response", id: cmd.id, payload: { ok: true, result: { commandId: cmd.payload.command.commandId, result: { ok: true, type: "set_model" } } } });
    await flush();
    expect((ws.sent as { type: string }[]).filter((frame) => frame.type === "getSnapshot").length).toBe(snapshotsBefore);
    expect(screen.queryByText(/Model set to/)).toBeNull();
    expect(screen.queryByText(/Failed to change model/)).toBeNull();
  });

  it("unmount mid-flight: late model success never throws or fetches", async () => {
    installModelsFetch(BASE_MODELS);
    mount(true, MODELS_HOST);
    const ws = await driveReady();
    await driveAttach(ws, MODEL_CAPS, "s1", { model: { provider: "openai", id: "gpt-5" } });
    await settleQuery();
    const select = screen.getByLabelText("Model") as HTMLSelectElement;
    const target = Array.from(select.options).find((option) => option.textContent === "anthropic/claude-opus-4");
    fireEvent.change(select, { target: { value: target!.value } });
    fireEvent.click(screen.getByRole("button", { name: "Set model" }));
    await flush();
    const cmd = lastFrame<{ type: string; id: string; payload: { command: { commandId: string } } }>(ws, "command")!;
    const snapshotsBefore = (ws.sent as { type: string }[]).filter((frame) => frame.type === "getSnapshot").length;

    cleanup();
    expect(screen.queryByLabelText("Session actions")).toBeNull();
    await act(async () => { await flush(12); });
    await act(async () => {
      ws.serverSend({ type: "response", id: cmd.id, payload: { ok: true, result: { commandId: cmd.payload.command.commandId, result: { ok: true, type: "set_model" } } } });
      await flush(12);
    });
    expect((ws.sent as { type: string }[]).filter((frame) => frame.type === "getSnapshot").length).toBe(snapshotsBefore);
  });

  it("thinking control stays intact while a model change is pending/failed (coexistence)", async () => {
    installModelsFetch(BASE_MODELS);
    mount(true, MODELS_HOST);
    const ws = await driveReady();
    await driveAttach(ws, [...MODEL_CAPS, "runtime.thinking.set"], "s1", {
      model: { provider: "openai", id: "gpt-5" },
      thinkingLevel: "off",
      thinkingLevelPinned: false,
    });
    await settleQuery();
    expect(screen.getByLabelText("Thinking level")).toBeTruthy();
    expect(screen.getByLabelText("Model")).toBeTruthy();

    // Fail a model change.
    const select = screen.getByLabelText("Model") as HTMLSelectElement;
    const target = Array.from(select.options).find((option) => option.textContent === "anthropic/claude-opus-4");
    fireEvent.change(select, { target: { value: target!.value } });
    fireEvent.click(screen.getByRole("button", { name: "Set model" }));
    await flush();
    const cmd = lastFrame<{ type: string; id: string; payload: { command: { commandId: string } } }>(ws, "command")!;
    await serverSend(ws, {
      type: "response",
      id: cmd.id,
      payload: { ok: true, result: { commandId: cmd.payload.command.commandId, result: { ok: false, type: "set_model", error: { code: "external", message: "backend boom", retryable: true } } } } },
    );
    expect(screen.getByRole("alert").textContent).toBe("Failed to change model.");
    // Thinking control still present and interactive after the model error.
    expect(screen.getByLabelText("Thinking level")).toBeTruthy();
    const thinkingButton = screen.getByRole("button", { name: "Set thinking" }) as HTMLButtonElement;
    expect(thinkingButton.disabled).toBe(false);
    // A subsequent thinking submit works normally.
    fireEvent.change(screen.getByLabelText("Thinking level"), { target: { value: "high" } });
    fireEvent.click(screen.getByRole("button", { name: "Set thinking" }));
    await flush();
    const thinkingCmd = lastFrame<{ type: string; id: string; payload: { command: { type: string; level: string } } }>(ws, "command")!;
    expect(thinkingCmd.payload.command.type).toBe("set_thinking_level");
    expect(thinkingCmd.payload.command.level).toBe("high");
  });
});
