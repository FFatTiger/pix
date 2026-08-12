import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import { useEffect } from "react";
import { RuntimeProvider, useRuntimeStore } from "@/runtime/runtime-provider";
import { FakeWebSocket, flush, lastFrame, snapshotPayload } from "@/runtime/testing/harness";
import type { RuntimeSocketDeps } from "@/runtime/socket";
import type { SessionStore } from "@/runtime/session-store";
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

function mount(live?: boolean) {
  return render(
    <RuntimeProvider deps={fakeDeps()}>
      <Capture />
      {live === undefined ? <SessionActions /> : <SessionActions live={live} />}
    </RuntimeProvider>,
  );
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
  extra: { thinkingLevel?: string; thinkingLevelPinned?: boolean } = {},
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
  beforeEach(() => { vi.useFakeTimers(); SOCKETS.length = 0; capturedStore = null; });
  afterEach(() => { cleanup(); vi.useRealTimers(); });

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

  it("shows Stats, Rename and Thinking when the runtime advertises the D2 surface", async () => {
    mount();
    const ws = await driveReady();
    await driveAttach(
      ws,
      ["runtime.prompt", "runtime.abort", "runtime.stats", "runtime.session.rename", "runtime.thinking.set"],
      "s1",
      { thinkingLevel: "off", thinkingLevelPinned: false },
    );
    expect(screen.getByRole("button", { name: "Stats" })).toBeTruthy();
    expect(screen.getByLabelText("Session name")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Rename" })).toBeTruthy();
    expect(screen.getByLabelText("Thinking level")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Set thinking" })).toBeTruthy();
    expect(screen.getByText(/current: off/)).toBeTruthy();
    expect(screen.getByText(/not pinned/)).toBeTruthy();
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

  it("rename resolves on the command result, refreshes the snapshot, and never fakes a catalog write", async () => {
    mount();
    const ws = await driveReady();
    await driveAttach(ws, ["runtime.prompt", "runtime.abort", "runtime.session.rename"]);
    const input = screen.getByLabelText("Session name") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "  New Name  " } });
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    await flush();
    const cmd = lastFrame<{ type: string; id: string; payload: { command: { type: string; commandId: string; name: string } } }>(ws, "command")!;
    expect(cmd.payload.command.type).toBe("set_session_name");
    expect(cmd.payload.command.name).toBe("New Name");
    await serverSend(ws, {
      type: "response",
      id: cmd.id,
      payload: { ok: true, result: { commandId: cmd.payload.command.commandId, result: { ok: true, type: "set_session_name" } } },
    });
    // fetchSnapshot issues a getSnapshot envelope; answer it with the refreshed state.
    await flush();
    const snap = lastFrame<{ type: string; id: string }>(ws, "getSnapshot")!;
    expect(snap.type).toBe("getSnapshot");
    await serverSend(ws, {
      type: "response",
      id: snap.id,
      payload: { ok: true, result: snapshotPayload({ sessionId: "s1", capabilities: ["runtime.prompt", "runtime.abort", "runtime.session.rename"] }).snapshot },
    });
    expect(screen.getByText(/Renamed session to "New Name"/)).toBeTruthy();
    expect((screen.getByLabelText("Session name") as HTMLInputElement).value).toBe("");
    // No history/catalog write is ever attempted: only command + getSnapshot frames.
    const nonControl = (ws.sent as { type: string }[]).filter((frame) => frame.type !== "handshake" && frame.type !== "attach" && frame.type !== "command" && frame.type !== "getSnapshot");
    expect(nonControl).toHaveLength(0);
  });

  it("rename surfaces an unsupported_capability error when the runtime rejects it", async () => {
    mount();
    const ws = await driveReady();
    await driveAttach(ws, ["runtime.prompt", "runtime.abort", "runtime.session.rename"]);
    const input = screen.getByLabelText("Session name") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Blocked" } });
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    await flush();
    const cmd = lastFrame<{ type: string; id: string; payload: { command: { type: string; commandId: string; name: string } } }>(ws, "command")!;
    await serverSend(ws, {
      type: "response",
      id: cmd.id,
      payload: { ok: true, result: { commandId: cmd.payload.command.commandId, result: { ok: false, type: "set_session_name", error: { code: "unsupported_capability", message: "runtime.session.rename not available", retryable: false } } } },
    });
    expect(screen.getByRole("alert").textContent).toBe("runtime.session.rename not available");
    // fetchSnapshot is NOT issued on failure (no fake success + no refresh).
    await flush();
    expect(lastFrame(ws, "getSnapshot")).toBeUndefined();
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
    const view = mount(true);
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
    view.rerender(
      <RuntimeProvider deps={fakeDeps()}>
        <Capture />
        <SessionActions live={false} />
      </RuntimeProvider>,
    );
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
    view.rerender(
      <RuntimeProvider deps={fakeDeps()}>
        <Capture />
        <SessionActions live={true} />
      </RuntimeProvider>,
    );
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
