import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import { RuntimeProvider, useRuntimeStore, useRuntime } from "./runtime-provider";
import { CapabilityProvider } from "@/features/capability/CapabilityProvider";
import { I18nProvider } from "@/hooks/useI18n";
import { HttpClientProvider } from "@/app/http-context";
import { Composer } from "@/components/shell/Composer";
import { TranscriptList } from "@/components/transcript/TranscriptList";
import { ErrorBoundary } from "@/app/ErrorBoundary";
import { FakeWebSocket, flush, lastFrame, snapshotPayload } from "./testing/harness";
import type { RuntimeSocketDeps } from "./socket";
import type { HostInfo } from "@fffattiger/pix-protocol";
import type { SessionStore } from "./session-store";
import { useEffect, type ReactNode } from "react";

// RuntimeProvider mounts TranscriptList, which uses the hand-rolled virtualizer
// (src/lib/virtual-list). jsdom has no ResizeObserver, so it renders every row
// (render-all fallback) — no mock needed.

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

// jsdom has no ResizeObserver; the exact chat minimap needs a permissive
// no-op stub (multiple instances, no callbacks).
class ResizeObserverStub {
  observe(): void { /* jsdom no-op */ }
  unobserve(): void { /* jsdom no-op */ }
  disconnect(): void { /* jsdom no-op */ }
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= ResizeObserverStub;

let capturedStore: SessionStore | null = null;
function Capture(): null {
  const store = useRuntimeStore();
  useEffect(() => { capturedStore = store; }, [store]);
  return null;
}

function ConnectionProbe(): ReactNode {
  const rt = useRuntime();
  return <span data-testid="connection">{rt.connection}</span>;
}

function mount(children: ReactNode, host: Partial<HostInfo> | null | undefined = { mode: "local", capabilities: ["agent"] }): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <ErrorBoundary>
      <QueryClientProvider client={qc}>
        <HttpClientProvider>
          <CapabilityProvider {...(host === undefined ? {} : { host })}>
            <RuntimeProvider deps={fakeDeps()}>
              <I18nProvider>
                <Capture />
                {children}
              </I18nProvider>
            </RuntimeProvider>
          </CapabilityProvider>
        </HttpClientProvider>
      </QueryClientProvider>
    </ErrorBoundary>,
  );
}

function ack(caps: string[] = ["agent"]) {
  return { type: "handshake_ack", payload: { protocolVersion: 1, host: { mode: "local", capabilities: caps }, limits: { maxUpload: 0, maxOpenSessions: 4 }, sessionSnapshotSupport: true } };
}

async function driveReady(): Promise<FakeWebSocket> {
  const store = capturedStore!;
  let ws: FakeWebSocket | undefined;
  await act(async () => {
    store.connect();
    ws = SOCKETS[SOCKETS.length - 1]!;
    ws.serverOpen();
    ws.serverSend(ack());
    await flush();
  });
  return ws!;
}

async function driveAttach(ws: FakeWebSocket, sessionId = "s1"): Promise<void> {
  const store = capturedStore!;
  await act(async () => {
    void store.openSession(sessionId);
    await flush();
    const attachFrame = lastFrame<{ type: string; id: string }>(ws, "attach")!;
    ws.serverSend({ type: "snapshot", id: attachFrame.id, payload: snapshotPayload({ sessionId }) });
    await flush();
  });
}

async function serverSend(ws: FakeWebSocket, message: unknown): Promise<void> {
  await act(async () => {
    ws.serverSend(message);
    await flush();
  });
}

describe("RuntimeProvider / useSyncExternalStore", () => {
  beforeEach(() => { vi.useFakeTimers(); SOCKETS.length = 0; capturedStore = null; });
  afterEach(() => { cleanup(); vi.useRealTimers(); });

  it("reactively reflects connection state via useSyncExternalStore", async () => {
    mount(<ConnectionProbe />);
    expect(screen.getByTestId("connection").textContent).toBe("idle");
    await driveReady();
    expect(screen.getByTestId("connection").textContent).toBe("ready");
  });
});

describe("RuntimeProvider — D2-P3 setModel exposure", () => {
  beforeEach(() => { vi.useFakeTimers(); SOCKETS.length = 0; capturedStore = null; });
  afterEach(() => { cleanup(); vi.useRealTimers(); });

  it("exposes setModel on the RuntimeApi and sends an exact set_model command", async () => {
    let exposed!: ReturnType<typeof useRuntime>;
    function Probe(): null {
      exposed = useRuntime();
      return null;
    }
    mount(<Probe />);
    expect(typeof exposed.setModel).toBe("function");

    const ws = await driveReady();
    const store = capturedStore!;
    await act(async () => {
      void store.openSession("s1");
      await flush();
      const attachFrame = lastFrame<{ type: string; id: string }>(ws, "attach")!;
      ws.serverSend({ type: "snapshot", id: attachFrame.id, payload: snapshotPayload({ sessionId: "s1", capabilities: ["runtime.prompt", "runtime.abort", "runtime.model.set"] }) });
      await flush();
    });

    let settled = false;
    let rejection: unknown = null;
    const p = exposed.setModel("anthropic", "claude-opus-4");
    p.then(() => { settled = true; }, (error: unknown) => { rejection = error; });
    await flush();
    const cmd = lastFrame<{ type: string; id: string; payload: { command: { commandId: string; type: string; provider: string; modelId: string } } }>(ws, "command")!;
    expect(cmd.payload.command.type).toBe("set_model");
    expect(cmd.payload.command.provider).toBe("anthropic");
    expect(cmd.payload.command.modelId).toBe("claude-opus-4");
    await serverSend(ws, { type: "response", id: cmd.id, payload: { ok: true, result: { commandId: cmd.payload.command.commandId, result: { ok: true, type: "set_model" } } } });
    expect(settled).toBe(true);
    expect(rejection).toBeNull();
  });
});

describe("RuntimeProvider — D2-P4 steer/followUp/clearQueue exposure", () => {
  beforeEach(() => { vi.useFakeTimers(); SOCKETS.length = 0; capturedStore = null; });
  afterEach(() => { cleanup(); vi.useRealTimers(); });

  it("exposes steer/followUp/clearQueue on the RuntimeApi", async () => {
    let exposed!: ReturnType<typeof useRuntime>;
    function Probe(): null {
      exposed = useRuntime();
      return null;
    }
    mount(<Probe />);
    expect(typeof exposed.steer).toBe("function");
    expect(typeof exposed.followUp).toBe("function");
    expect(typeof exposed.clearQueue).toBe("function");
  });

  it("steer sends an exact steer command and followUp an exact follow_up command", async () => {
    let exposed!: ReturnType<typeof useRuntime>;
    function Probe(): null {
      exposed = useRuntime();
      return null;
    }
    mount(<Probe />);
    const ws = await driveReady();
    const store = capturedStore!;
    await act(async () => {
      void store.openSession("s1");
      await flush();
      const attachFrame = lastFrame<{ type: string; id: string }>(ws, "attach")!;
      ws.serverSend({ type: "snapshot", id: attachFrame.id, payload: snapshotPayload({ sessionId: "s1", capabilities: ["runtime.prompt", "runtime.abort", "runtime.steer", "runtime.follow_up", "runtime.queue"] }) });
      await flush();
    });

    let steerSettled = false;
    const steerP = exposed.steer("steer now");
    steerP.then(() => { steerSettled = true; }, () => {});
    await flush();
    const steerCmd = lastFrame<{ type: string; id: string; payload: { command: { commandId: string; type: string; message: string } } }>(ws, "command")!;
    expect(steerCmd.payload.command.type).toBe("steer");
    expect(steerCmd.payload.command.message).toBe("steer now");
    await serverSend(ws, { type: "response", id: steerCmd.id, payload: { ok: true, result: { commandId: steerCmd.payload.command.commandId, result: { ok: true, type: "steer" } } } });
    expect(steerSettled).toBe(true);

    let followSettled = false;
    const followP = exposed.followUp("follow now");
    followP.then(() => { followSettled = true; }, () => {});
    await flush();
    const followCmd = lastFrame<{ type: string; id: string; payload: { command: { commandId: string; type: string; message: string } } }>(ws, "command")!;
    expect(followCmd.payload.command.type).toBe("follow_up");
    expect(followCmd.payload.command.message).toBe("follow now");
    await serverSend(ws, { type: "response", id: followCmd.id, payload: { ok: true, result: { commandId: followCmd.payload.command.commandId, result: { ok: true, type: "follow_up" } } } });
    expect(followSettled).toBe(true);

    let clearSettled = false;
    const clearP = exposed.clearQueue();
    clearP.then(() => { clearSettled = true; }, () => {});
    await flush();
    const intr = lastFrame<{ type: string; id: string; payload: { commandId: string; interrupt: { type: string } } }>(ws, "interrupt")!;
    expect(intr.payload.interrupt.type).toBe("clear_queue");
    await serverSend(ws, { type: "interrupt_result", id: intr.id, payload: { sessionId: "s1", commandId: intr.payload.commandId, interruptType: "clear_queue", result: { ok: true, type: "clear_queue" } } });
    expect(clearSettled).toBe(true);
  });
});

describe("Composer — capability honesty + send/abort", () => {
  beforeEach(() => { vi.useFakeTimers(); SOCKETS.length = 0; capturedStore = null; });
  afterEach(() => { cleanup(); vi.useRealTimers(); });

  it("is disabled when the host has no agent capability", () => {
    mount(<Composer />, { mode: "local", capabilities: ["files"] });
    const textarea = document.querySelector("textarea.composer-input") as HTMLTextAreaElement;
    expect(textarea.disabled).toBe(true);
    expect(screen.getByText(/no agent capability|readonly/)).toBeTruthy();
  });

  it("sends a prompt when attached + canAgent, and offers Abort while streaming", async () => {
    mount(<Composer />);
    const ws = await driveReady();
    await driveAttach(ws);
    const textarea = document.querySelector("textarea.chat-input-textarea") as HTMLTextAreaElement;
    expect(textarea.disabled).toBe(false);
    fireEvent.change(textarea, { target: { value: "hello world" } });
    fireEvent.click(screen.getByLabelText("Send message"));
    await flush();
    const cmd = lastFrame<{ type: string; payload: { command: { type: string; message: string } } }>(ws, "command")!;
    expect(cmd.payload.command.message).toBe("hello world");
    // start streaming → Abort control appears
    await serverSend(ws, { type: "event", payload: { type: "message_start", sessionId: "s1", streamId: "st", messageId: "m", message: { role: "assistant", model: "m", provider: "p" }, eventId: 1, epoch: "e1" } });
    const abortBtn = screen.getByLabelText("Stop agent");
    fireEvent.click(abortBtn);
    await flush();
    const interrupt = lastFrame<{ type: string; payload: { interrupt: { type: string } } }>(ws, "interrupt")!;
    expect(interrupt.payload.interrupt.type).toBe("abort");
  });

  it("never surfaces a non-selected session's stream: live=false stays disabled/readonly with no Abort", async () => {
    mount(<Composer live={false} />);
    const ws = await driveReady();
    await driveAttach(ws);
    // The runtime (A) starts streaming…
    await serverSend(ws, { type: "event", payload: { type: "message_start", sessionId: "s1", streamId: "st", messageId: "m", message: { role: "assistant", model: "m", provider: "p" }, eventId: 1, epoch: "e1" } });
    // …but the selected session is NOT live, so this composer must stay honest:
    // no stale streaming state, no Abort for another session, input disabled.
    const textarea = document.querySelector("textarea.composer-input") as HTMLTextAreaElement;
    expect(textarea.disabled).toBe(true);
    expect(screen.queryByLabelText("Stop agent")).toBeNull();
    expect(screen.queryByText("streaming")).toBeNull();
    expect(screen.getByText(/selected session is not live/)).toBeTruthy();
  });
});

describe("TranscriptList — runtime messages", () => {
  beforeEach(() => { vi.useFakeTimers(); SOCKETS.length = 0; capturedStore = null; });
  afterEach(() => { cleanup(); vi.useRealTimers(); });

  it("renders rows from the SessionStore projection", async () => {
    mount(<TranscriptList sessionId="s1" />);
    const ws = await driveReady();
    await driveAttach(ws);
    // full stream lifecycle commits a user message
    await serverSend(ws, { type: "event", payload: { type: "message_start", sessionId: "s1", streamId: "st", messageId: "m", message: { role: "user", content: "hi there" }, eventId: 1, epoch: "e1" } });
    await serverSend(ws, { type: "event", payload: { type: "message_end", sessionId: "s1", streamId: "st", messageId: "m", message: { role: "user", content: "hi there" }, eventId: 2, epoch: "e1" } });
    expect(screen.getByText("hi there")).toBeTruthy();
  });

  it("renders the active streaming partial", async () => {
    mount(<TranscriptList sessionId="s1" />);
    const ws = await driveReady();
    await driveAttach(ws);
    await serverSend(ws, { type: "event", payload: { type: "message_start", sessionId: "s1", streamId: "st", messageId: "m", message: { role: "assistant", content: [{ type: "text", text: "part" }], model: "m", provider: "p" }, eventId: 1, epoch: "e1" } });
    expect(screen.getByText("part")).toBeTruthy();
  });
});

describe("RuntimeProvider — D2-P5 runBash/abortBash exposure", () => {
  beforeEach(() => { vi.useFakeTimers(); SOCKETS.length = 0; capturedStore = null; });
  afterEach(() => { cleanup(); vi.useRealTimers(); });

  it("exposes runBash and abortBash on the RuntimeApi", async () => {
    let exposed!: ReturnType<typeof useRuntime>;
    function Probe(): null {
      exposed = useRuntime();
      return null;
    }
    mount(<Probe />);
    expect(typeof exposed.runBash).toBe("function");
    expect(typeof exposed.abortBash).toBe("function");
  });

  it("runBash sends an exact bash command and abortBash an exact abort_bash interrupt", async () => {
    let exposed!: ReturnType<typeof useRuntime>;
    function Probe(): null {
      exposed = useRuntime();
      return null;
    }
    mount(<Probe />);
    const ws = await driveReady();
    const store = capturedStore!;
    await act(async () => {
      void store.openSession("s1");
      await flush();
      const attachFrame = lastFrame<{ type: string; id: string }>(ws, "attach")!;
      ws.serverSend({ type: "snapshot", id: attachFrame.id, payload: snapshotPayload({ sessionId: "s1", capabilities: ["runtime.prompt", "runtime.abort", "runtime.bash", "runtime.bash.abort"] }) });
      await flush();
    });

    let bashSettled = false;
    const bashP = exposed.runBash("echo hello", { excludeFromContext: true });
    bashP.then(() => { bashSettled = true; }, () => {});
    await flush();
    const bashCmd = lastFrame<{ type: string; id: string; payload: { command: { commandId: string; type: string; command: string; excludeFromContext?: boolean } } }>(ws, "command")!;
    expect(bashCmd.payload.command.type).toBe("bash");
    expect(bashCmd.payload.command.command).toBe("echo hello");
    expect(bashCmd.payload.command.excludeFromContext).toBe(true);
    await serverSend(ws, { type: "response", id: bashCmd.id, payload: { ok: true, result: { commandId: bashCmd.payload.command.commandId, result: { ok: true, type: "bash" } } } });
    expect(bashSettled).toBe(true);

    let abortSettled = false;
    const abortP = exposed.abortBash();
    abortP.then(() => { abortSettled = true; }, () => {});
    await flush();
    const intr = lastFrame<{ type: string; id: string; payload: { commandId: string; interrupt: { type: string } } }>(ws, "interrupt")!;
    expect(intr.payload.interrupt.type).toBe("abort_bash");
    await serverSend(ws, { type: "interrupt_result", id: intr.id, payload: { sessionId: "s1", commandId: intr.payload.commandId, interruptType: "abort_bash", result: { ok: true, type: "abort_bash" } } });
    expect(abortSettled).toBe(true);
  });
});

describe("RuntimeProvider — D2-P6 getTools/setTools/reload exposure", () => {
  beforeEach(() => { vi.useFakeTimers(); SOCKETS.length = 0; capturedStore = null; });
  afterEach(() => { cleanup(); vi.useRealTimers(); });

  it("exposes getTools, setTools and reload on the RuntimeApi", async () => {
    let exposed!: ReturnType<typeof useRuntime>;
    function Probe(): null {
      exposed = useRuntime();
      return null;
    }
    mount(<Probe />);
    expect(typeof exposed.getTools).toBe("function");
    expect(typeof exposed.setTools).toBe("function");
    expect(typeof exposed.reload).toBe("function");
  });

  it("getTools sends an exact get_tools query and resolves typed tools", async () => {
    let exposed!: ReturnType<typeof useRuntime>;
    function Probe(): null {
      exposed = useRuntime();
      return null;
    }
    mount(<Probe />);
    const ws = await driveReady();
    const store = capturedStore!;
    await act(async () => {
      void store.openSession("s1");
      await flush();
      const attachFrame = lastFrame<{ type: string; id: string }>(ws, "attach")!;
      ws.serverSend({ type: "snapshot", id: attachFrame.id, payload: snapshotPayload({ sessionId: "s1", capabilities: ["runtime.prompt", "runtime.abort", "runtime.tools.read"] }) });
      await flush();
    });

    let resolved: unknown = null;
    const p = exposed.getTools().then((value) => { resolved = value; });
    await flush();
    const cmd = lastFrame<{ type: string; id: string; payload: { command: { commandId: string; type: string } } }>(ws, "command")!;
    expect(cmd.payload.command.type).toBe("get_tools");
    await serverSend(ws, { type: "response", id: cmd.id, payload: { ok: true, result: { commandId: cmd.payload.command.commandId, result: { ok: true, type: "get_tools", tools: [{ name: "read", active: true }] } } } });
    await p;
    expect(resolved).toEqual([{ name: "read", active: true }]);
  });

  it("setTools sends an exact set_tools command and reload an exact reload command", async () => {
    let exposed!: ReturnType<typeof useRuntime>;
    function Probe(): null {
      exposed = useRuntime();
      return null;
    }
    mount(<Probe />);
    const ws = await driveReady();
    const store = capturedStore!;
    await act(async () => {
      void store.openSession("s1");
      await flush();
      const attachFrame = lastFrame<{ type: string; id: string }>(ws, "attach")!;
      ws.serverSend({ type: "snapshot", id: attachFrame.id, payload: snapshotPayload({ sessionId: "s1", capabilities: ["runtime.prompt", "runtime.abort", "runtime.tools.write", "runtime.reload"] }) });
      await flush();
    });

    let setSettled = false;
    const setP = exposed.setTools(["read", "  write  "]);
    setP.then(() => { setSettled = true; }, () => {});
    await flush();
    const setCmd = lastFrame<{ type: string; id: string; payload: { command: { commandId: string; type: string; toolNames?: string[] } } }>(ws, "command")!;
    expect(setCmd.payload.command.type).toBe("set_tools");
    expect(setCmd.payload.command.toolNames).toEqual(["read", "write"]);
    await serverSend(ws, { type: "response", id: setCmd.id, payload: { ok: true, result: { commandId: setCmd.payload.command.commandId, result: { ok: true, type: "set_tools" } } } });
    expect(setSettled).toBe(true);

    let reloadSettled = false;
    const reloadP = exposed.reload();
    reloadP.then(() => { reloadSettled = true; }, () => {});
    await flush();
    const reloadCmd = lastFrame<{ type: string; id: string; payload: { command: { commandId: string; type: string } } }>(ws, "command")!;
    expect(reloadCmd.payload.command.type).toBe("reload");
    await serverSend(ws, { type: "response", id: reloadCmd.id, payload: { ok: true, result: { commandId: reloadCmd.payload.command.commandId, result: { ok: true, type: "reload" } } } });
    expect(reloadSettled).toBe(true);
  });
});

describe("RuntimeProvider — sendPrompt images + navigateTree detached", () => {
  beforeEach(() => { vi.useFakeTimers(); SOCKETS.length = 0; capturedStore = null; });
  afterEach(() => { cleanup(); vi.useRealTimers(); });

  it("sendPrompt with images sends an exact prompt command carrying the image attachments", async () => {
    let exposed!: ReturnType<typeof useRuntime>;
    function Probe(): null {
      exposed = useRuntime();
      return null;
    }
    mount(<Probe />);
    const ws = await driveReady();
    await driveAttach(ws);

    let settled = false;
    let rejection: unknown = null;
    const p = exposed.sendPrompt("look at this", [{ type: "image", data: "AAAA", mimeType: "image/png" }]);
    p.then(() => { settled = true; }, (error: unknown) => { rejection = error; });
    await flush();
    const cmd = lastFrame<{ type: string; id: string; payload: { command: { commandId: string; type: string; message: string; images?: unknown[] } } }>(ws, "command")!;
    expect(cmd.payload.command.type).toBe("prompt");
    expect(cmd.payload.command.message).toBe("look at this");
    expect(cmd.payload.command.images).toEqual([{ type: "image", data: "AAAA", mimeType: "image/png" }]);
    await serverSend(ws, { type: "response", id: cmd.id, payload: { ok: true, result: { commandId: cmd.payload.command.commandId, result: { ok: true, type: "prompt" } } } });
    expect(settled).toBe(true);
    expect(rejection).toBeNull();
  });

  it("navigateTree is exposed and rejects without sending when detached", async () => {
    let exposed!: ReturnType<typeof useRuntime>;
    function Probe(): null {
      exposed = useRuntime();
      return null;
    }
    mount(<Probe />);
    expect(typeof exposed.navigateTree).toBe("function");
    // Socket ready but NOT attached to any session — navigating must fail
    // closed (reject) and never put a navigate_tree frame on the wire.
    const ws = await driveReady();
    await expect(exposed.navigateTree("leaf-1")).rejects.toMatchObject({ code: "unavailable" });
    expect(ws.sent.filter((f) => (f as { payload?: { command?: { type?: string } } }).payload?.command?.type === "navigate_tree")).toHaveLength(0);
  });

  it("navigateTree sends an exact navigate_tree command when attached + runtime.navigate", async () => {
    let exposed!: ReturnType<typeof useRuntime>;
    function Probe(): null {
      exposed = useRuntime();
      return null;
    }
    mount(<Probe />);
    const ws = await driveReady();
    const store = capturedStore!;
    await act(async () => {
      void store.openSession("s1");
      await flush();
      const attachFrame = lastFrame<{ type: string; id: string }>(ws, "attach")!;
      ws.serverSend({ type: "snapshot", id: attachFrame.id, payload: snapshotPayload({ sessionId: "s1", capabilities: ["runtime.prompt", "runtime.abort", "runtime.navigate"] }) });
      await flush();
    });

    let settled = false;
    const p = exposed.navigateTree("leaf-1");
    p.then(() => { settled = true; }, () => {});
    await flush();
    const cmd = lastFrame<{ type: string; id: string; payload: { command: { commandId: string; type: string; targetId: string } } }>(ws, "command")!;
    expect(cmd.payload.command.type).toBe("navigate_tree");
    expect(cmd.payload.command.targetId).toBe("leaf-1");
    await serverSend(ws, { type: "response", id: cmd.id, payload: { ok: true, result: { commandId: cmd.payload.command.commandId, result: { ok: true, type: "navigate_tree" } } } });
    expect(settled).toBe(true);
  });
});

describe("RuntimeProvider — D2-P7 compact/abortCompaction exposure", () => {
  beforeEach(() => { vi.useFakeTimers(); SOCKETS.length = 0; capturedStore = null; });
  afterEach(() => { cleanup(); vi.useRealTimers(); });

  it("exposes compact and abortCompaction on the RuntimeApi", async () => {
    let exposed!: ReturnType<typeof useRuntime>;
    function Probe(): null {
      exposed = useRuntime();
      return null;
    }
    mount(<Probe />);
    expect(typeof exposed.compact).toBe("function");
    expect(typeof exposed.abortCompaction).toBe("function");
  });

  it("compact sends an exact compact command and abortCompaction an exact abort_compaction interrupt", async () => {
    let exposed!: ReturnType<typeof useRuntime>;
    function Probe(): null {
      exposed = useRuntime();
      return null;
    }
    mount(<Probe />);
    const ws = await driveReady();
    const store = capturedStore!;
    await act(async () => {
      void store.openSession("s1");
      await flush();
      const attachFrame = lastFrame<{ type: string; id: string }>(ws, "attach")!;
      ws.serverSend({ type: "snapshot", id: attachFrame.id, payload: snapshotPayload({ sessionId: "s1", capabilities: ["runtime.prompt", "runtime.abort", "runtime.compact", "runtime.compact.abort"] }) });
      await flush();
    });

    let compactSettled = false;
    const compactP = exposed.compact("keep decisions");
    compactP.then(() => { compactSettled = true; }, () => {});
    await flush();
    const compactCmd = lastFrame<{ type: string; id: string; payload: { command: { commandId: string; type: string; customInstructions?: string } } }>(ws, "command")!;
    expect(compactCmd.payload.command.type).toBe("compact");
    expect(compactCmd.payload.command.customInstructions).toBe("keep decisions");
    await serverSend(ws, { type: "response", id: compactCmd.id, payload: { ok: true, result: { commandId: compactCmd.payload.command.commandId, result: { ok: true, type: "compact" } } } });
    expect(compactSettled).toBe(true);

    let abortSettled = false;
    const abortP = exposed.abortCompaction();
    abortP.then(() => { abortSettled = true; }, () => {});
    await flush();
    const intr = lastFrame<{ type: string; id: string; payload: { commandId: string; interrupt: { type: string } } }>(ws, "interrupt")!;
    expect(intr.payload.interrupt.type).toBe("abort_compaction");
    await serverSend(ws, { type: "interrupt_result", id: intr.id, payload: { sessionId: "s1", commandId: intr.payload.commandId, interruptType: "abort_compaction", result: { ok: true, type: "abort_compaction" } } });
    expect(abortSettled).toBe(true);
  });
});

describe("Composer — F9 stats late-settle generation on session switch", () => {
  beforeEach(() => { vi.useFakeTimers(); SOCKETS.length = 0; capturedStore = null; });
  afterEach(() => { cleanup(); vi.useRealTimers(); });

  function statsFrame(ws: FakeWebSocket): { id: string; payload: { sessionId: string; command: { commandId: string; type: string } } } {
    const frame = lastFrame<{ type: string; id: string; payload: { sessionId: string; command: { commandId: string; type: string } } }>(ws, "command")!;
    expect(frame.payload.command.type).toBe("get_session_stats");
    return frame;
  }

  function statsAck(ws: FakeWebSocket, frame: { id: string; payload: { command: { commandId: string; type: string } } }, tokenCount: number): Promise<void> {
    return serverSend(ws, {
      type: "response",
      id: frame.id,
      payload: { ok: true, result: { commandId: frame.payload.command.commandId, result: { ok: true, type: "get_session_stats", stats: { messageCount: 1, tokenCount } } } },
    });
  }

  it("a new session never shows the OLD session's stats: a late old ack is dropped and the own fetch wins", async () => {
    mount(<Composer />);
    const ws = await driveReady();
    const store = capturedStore!;
    const caps = ["runtime.prompt", "runtime.abort", "runtime.stats"];

    // Attach s1 (runtime.stats) → the Composer stats effect fires a fetch. The
    // fetch is left UNACKED so it is genuinely in-flight (pending slot) at the
    // switch — the exact F9 scenario.
    await act(async () => {
      const p = store.openSession("s1");
      await flush();
      const attachFrame = lastFrame<{ type: string; id: string }>(ws, "attach")!;
      ws.serverSend({ type: "snapshot", id: attachFrame.id, payload: snapshotPayload({ sessionId: "s1", capabilities: caps }) });
      await flush();
      await p;
    });
    const s1Stats = statsFrame(ws);

    // Switch to s2 (detach-then-open, the AppShell path). With the store fix the
    // pending s1 get_session_stats is settled on detach and the s2 attach fires
    // a FRESH fetch bound to s2. A resent OLD commandId/sessionId frame here
    // would mean the F9 slot leak is back.
    await act(async () => {
      const detachP = store.detach();
      await flush();
      const detachFrame = lastFrame<{ type: string; id: string }>(ws, "detach")!;
      ws.serverSend({ type: "response", id: detachFrame.id, payload: { ok: true, result: { sessionId: "s1", detached: true } } });
      await detachP;
    });
    await act(async () => {
      const p = store.openSession("s2");
      await flush();
      const attachFrame = lastFrame<{ type: string; id: string }>(ws, "attach")!;
      ws.serverSend({ type: "snapshot", id: attachFrame.id, payload: snapshotPayload({ sessionId: "s2", capabilities: caps }) });
      await flush();
      await p;
    });
    const s2Stats = statsFrame(ws);
    // The new fetch is a FRESH command on s2 — never the old s1 sessionId/commandId.
    expect(s2Stats.payload.sessionId).toBe("s2");
    expect(s2Stats.id).not.toBe(s1Stats.id);
    expect(s2Stats.payload.command.commandId).not.toBe(s1Stats.payload.command.commandId);

    // Deliver the OLD s1 stats ack LATE — must not pollute the new session.
    await statsAck(ws, s1Stats, 99999);
    expect(screen.queryByLabelText("Session info")).toBeNull();

    // Ack s2's OWN fetch → the new session shows ITS tokens (222), never s1's.
    await statsAck(ws, s2Stats, 222);
    const btn = screen.getByLabelText("Session info");
    fireEvent.click(btn);
    expect(screen.getAllByText("222").length).toBeGreaterThan(0);
    expect(screen.queryByText("99,999")).toBeNull();
  });
});
