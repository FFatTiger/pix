import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import { useEffect } from "react";
import { RuntimeProvider, useRuntimeStore } from "@/runtime/runtime-provider";import { FakeWebSocket, flush, lastFrame, snapshotPayload } from "@/runtime/testing/harness";
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

function mount(): void {
  render(
    <RuntimeProvider deps={fakeDeps()}>
      <Capture />
      <SessionActions />
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

async function driveAttach(ws: FakeWebSocket, capabilities?: string[], sessionId = "s1"): Promise<void> {
  const store = capturedStore!;
  await act(async () => {
    void store.openSession(sessionId);
    await flush();
    const attachFrame = lastFrame<{ type: string; id: string }>(ws, "attach")!;
    ws.serverSend({
      type: "snapshot",
      id: attachFrame.id,
      payload: snapshotPayload({ sessionId, ...(capabilities === undefined ? {} : { capabilities }) }),
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

describe("SessionActions — D2-P1 UI", () => {
  beforeEach(() => { vi.useFakeTimers(); SOCKETS.length = 0; capturedStore = null; });
  afterEach(() => { cleanup(); vi.useRealTimers(); });

  it("shows a hint and no action controls while not attached", async () => {
    mount();
    expect(screen.getByText(/attach a runtime session to inspect/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "State" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Rename" })).toBeNull();
  });

  it("gates stats/rename on the attach-snapshot capability set; baseline queries always show", async () => {
    mount();
    const ws = await driveReady();
    await driveAttach(ws, ["runtime.prompt", "runtime.abort"]);

    // Baseline queries are always available once attached.
    expect(screen.getByRole("button", { name: "State" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Commands" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Last text" })).toBeTruthy();
    // Capability-gated controls are HIDDEN without runtime.stats / runtime.session.rename.
    expect(screen.queryByRole("button", { name: "Stats" })).toBeNull();
    expect(screen.queryByLabelText("Session name")).toBeNull();
  });

  it("shows Stats and Rename when the runtime advertises runtime.stats + runtime.session.rename", async () => {
    mount();
    const ws = await driveReady();
    await driveAttach(ws, ["runtime.prompt", "runtime.abort", "runtime.stats", "runtime.session.rename"]);
    expect(screen.getByRole("button", { name: "Stats" })).toBeTruthy();
    expect(screen.getByLabelText("Session name")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Rename" })).toBeTruthy();
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
});
