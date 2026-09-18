import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, fireEvent, cleanup, act, waitFor } from "@testing-library/react";
import { RuntimeProvider, useRuntime, useRuntimeConnection } from "./runtime-provider";
import { CapabilityProvider } from "@/features/capability/CapabilityProvider";
import { I18nProvider } from "@/hooks/useI18n";
import { HttpClientProvider } from "@/app/http-context";
import { Composer } from "@/components/shell/Composer";
import { TranscriptList } from "@/components/transcript/TranscriptList";
import { ErrorBoundary } from "@/app/ErrorBoundary";
import { SessionStagingProvider } from "@/features/composer/session-staging-provider";
import { FakeWebSocket, flush, lastFrame, snapshotPayload } from "./testing/harness";
import { CaptureTestRuntime } from "./testing/capture-test-runtime";
import type { TestRuntimeStore } from "./testing/test-runtime-store";
import type { RuntimeSocketDeps } from "./socket";
import type { HostInfo } from "@fffattiger/pix-protocol";
import { useState, type ReactNode } from "react";
import { clearDraft } from "@/lib/draft-store";
import { queryKeys } from "@/api/query-keys";
import type { SessionHeader } from "@fffattiger/pix-protocol";

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

let capturedStore: TestRuntimeStore | null = null;

function ConnectionProbe(): ReactNode {
  const connection = useRuntimeConnection();
  return <span data-testid="connection">{connection.state}</span>;
}

function requireExact(runtime: ReturnType<typeof useRuntime>): NonNullable<ReturnType<typeof useRuntime>> {
  if (runtime === null) throw new Error("expected exact runtime for s1");
  return runtime;
}

const AUTHORIZED_WORKSPACE = { state: "authorized" as const, reason: "allowed_root" as const };

function seedAuthorizedSessionFixtures(qc: QueryClient): void {
  const sessions: SessionHeader[] = ["s1", "s2", "ghost", "live-detached"].map((sessionId) => ({
    sessionId,
    cwd: "/x",
    projectRoot: "/x",
    createdAt: 1,
    updatedAt: 1,
    messageCount: 0,
    workspaceAccess: AUTHORIZED_WORKSPACE,
  }));
  qc.setQueryData(queryKeys.sessions.page(1, 50), {
    sessions,
    page: 1,
    pageSize: 50,
    total: sessions.length,
    totalPages: 1,
    catalogRevision: 0,
  });
  for (const session of sessions) {
    qc.setQueryData(queryKeys.sessions.detail(session.sessionId), { session });
  }
}

function mount(children: ReactNode, host: Partial<HostInfo> | null | undefined = { mode: "local", capabilities: ["agent"] }): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // These are Phase4 runtime lifecycle tests, not workspace-authorization
  // tests. Preserve their established authorized-session premise explicitly;
  // Phase6 fail-closed missing/error coverage lives in workspace-access tests.
  seedAuthorizedSessionFixtures(qc);
  render(
    <ErrorBoundary>
      <QueryClientProvider client={qc}>
        <HttpClientProvider>
          <CapabilityProvider {...(host === undefined ? {} : { host })}>
            <RuntimeProvider deps={fakeDeps()}>
              <SessionStagingProvider>
              <I18nProvider>
                <CaptureTestRuntime onStore={(store) => { capturedStore = store; }} />
                {children}
              </I18nProvider>
              </SessionStagingProvider>
            </RuntimeProvider>
          </CapabilityProvider>
        </HttpClientProvider>
      </QueryClientProvider>
    </ErrorBoundary>,
  );
}

/** Mount a Composer targeting a SELECTED session with a rerender handle (session switch). */
function mountComposerRerender(initialSessionId: string, live = false): { rerender: (sessionId: string, live?: boolean) => void } {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  seedAuthorizedSessionFixtures(qc);
  const Tree = ({ sessionId, live: isLive }: { sessionId: string; live: boolean }) => (
    <ErrorBoundary>
      <QueryClientProvider client={qc}>
        <HttpClientProvider>
          <CapabilityProvider host={{ mode: "local", capabilities: ["agent"] }}>
            <RuntimeProvider deps={fakeDeps()}>
              <SessionStagingProvider>
              <I18nProvider>
                <CaptureTestRuntime onStore={(store) => { capturedStore = store; }} />
                <Composer sessionId={sessionId} live={isLive} />
              </I18nProvider>
              </SessionStagingProvider>
            </RuntimeProvider>
          </CapabilityProvider>
        </HttpClientProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  );
  const view = render(<Tree sessionId={initialSessionId} live={live} />);
  return { rerender: (sessionId: string, nextLive = live) => view.rerender(<Tree sessionId={sessionId} live={nextLive} />) };
}

function ack(caps: string[] = ["agent"], acceptedFeatures: string[] = []) {
  return { type: "handshake_ack", payload: { protocolVersion: 2, host: { mode: "local", capabilities: caps }, limits: { maxUpload: 0, maxOpenSessions: 4 }, sessionSnapshotSupport: true, acceptedFeatures } };
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

  it("constructs one connection/socket and keeps public method references stable across transport updates", async () => {
    const samples: NonNullable<ReturnType<typeof useRuntime>>[] = [];
    function Probe(): null {
      samples.push(requireExact(useRuntime("s1")));
      return null;
    }
    mount(<Probe />);
    const ws = await driveReady();
    const initial = samples.at(-1)!;
    await serverSend(ws, { type: "runtime_unavailable", payload: { error: { code: "runtime_unavailable", message: "temporarily down", retryable: true } } });
    const updated = samples.at(-1)!;
    expect(SOCKETS).toHaveLength(1);
    expect(updated.createSession).toBe(initial.createSession);
    expect(updated.acquire).toBe(initial.acquire);
    expect(updated.submitTurn).toBe(initial.submitTurn);
    expect(updated.sendCommand).toBe(initial.sendCommand);
  });
});

describe("RuntimeProvider — D2-P3 setModel exposure", () => {
  beforeEach(() => { vi.useFakeTimers(); SOCKETS.length = 0; capturedStore = null; });
  afterEach(() => { cleanup(); vi.useRealTimers(); });

  it("exposes setModel on the exact runtime and sends an exact set_model command", async () => {
    let exposed!: NonNullable<ReturnType<typeof useRuntime>>;
    function Probe(): null {
      exposed = requireExact(useRuntime("s1"));
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

  it("exposes steer/followUp/clearQueue on the exact runtime", async () => {
    let exposed!: NonNullable<ReturnType<typeof useRuntime>>;
    function Probe(): null {
      exposed = requireExact(useRuntime("s1"));
      return null;
    }
    mount(<Probe />);
    expect(typeof exposed.steer).toBe("function");
    expect(typeof exposed.followUp).toBe("function");
    expect(typeof exposed.clearQueue).toBe("function");
  });

  it("steer sends an exact steer command and followUp an exact follow_up command", async () => {
    let exposed!: NonNullable<ReturnType<typeof useRuntime>>;
    function Probe(): null {
      exposed = requireExact(useRuntime("s1"));
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

describe("Composer — first prompt creates and sends in one transaction", () => {
  beforeEach(() => { vi.useFakeTimers(); SOCKETS.length = 0; capturedStore = null; });
  afterEach(() => { cleanup(); vi.useRealTimers(); });

  it("reserves the first prompt before promotion remounts the new session Composer", async () => {
    function Harness() {
      const runtime = useRuntimeConnection();
      const [sessionId, setSessionId] = useState<string | null>(null);
      if (sessionId) {
        return <div key="session"><Composer sessionId={sessionId} live /></div>;
      }
      return (
        <div key="home">
          <Composer
            live={false}
            cwd="/x"
            onCreateSession={async () => {
              const result = await runtime.createSession({ cwd: "/x", projectRoot: "/x" });
              return { sessionId: result.sessionId, cwd: "/x" };
            }}
            onCreatedSessionDispatched={(created) => setSessionId(created.sessionId)}
          />
        </div>
      );
    }

    mount(<Harness />);
    const ws = await driveReady();
    const textarea = document.querySelector("textarea.chat-input-textarea") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "  first message  " } });
    fireEvent.click(screen.getByLabelText("Send message"));
    await flush();

    const create = lastFrame<{ type: string; id: string; payload: { cwd: string; projectRoot: string; model?: unknown; thinkingLevel?: unknown } }>(ws, "create")!;
    expect(create).toBeTruthy();
    // Phase 3: create allocates identity only. First-turn model/thinking belong
    // to submitTurn.activationOverrides, never the create request.
    expect(create.payload).not.toHaveProperty("model");
    expect(create.payload).not.toHaveProperty("thinkingLevel");
    await serverSend(ws, {
      type: "response",
      id: create.id,
      payload: { ok: true, result: { sessionId: "new-1", epoch: "e1", created: true, cwd: "/x", projectRoot: "/x", snapshot: snapshotPayload({ sessionId: "new-1" }).snapshot } },
    });
    const attach = lastFrame<{ type: string; id: string }>(ws, "attach")!;
    await serverSend(ws, { type: "snapshot", id: attach.id, payload: snapshotPayload({ sessionId: "new-1", capabilities: ["runtime.prompt", "runtime.abort", "runtime.stats", "runtime.tools.read"] }) });
    await flush();

    const commands = ws.sent.filter((frame) => (frame as { type?: string }).type === "command") as Array<{ payload: { command: { type: string; message?: string } } }>;
    expect(commands.map((frame) => frame.payload.command.type)).toEqual(["prompt"]);
    expect(commands[0]!.payload.command.message).toBe("first message");
    expect((document.querySelector("textarea.chat-input-textarea") as HTMLTextAreaElement).value).toBe("");
  });

  it("migrates edits typed during create into the promoted session draft", async () => {
    function Harness() {
      const runtime = useRuntimeConnection();
      const [sessionId, setSessionId] = useState<string | null>(null);
      return sessionId
        ? <Composer sessionId={sessionId} live />
        : <Composer
            live={false}
            cwd="/x"
            onCreateSession={async () => {
              const result = await runtime.createSession({ cwd: "/x", projectRoot: "/x" });
              return { sessionId: result.sessionId, cwd: "/x" };
            }}
            onCreatedSessionDispatched={(created) => setSessionId(created.sessionId)}
          />;
    }
    mount(<Harness />);
    const ws = await driveReady();
    const textarea = document.querySelector("textarea.chat-input-textarea") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "first message" } });
    fireEvent.click(screen.getByLabelText("Send message"));
    await flush();
    // The user starts composing the next turn while create/attach is pending.
    fireEvent.change(textarea, { target: { value: "next draft while creating" } });

    const create = lastFrame<{ type: string; id: string }>(ws, "create")!;
    await serverSend(ws, { type: "response", id: create.id, payload: { ok: true, result: { sessionId: "new-edited", epoch: "e1", created: true, cwd: "/x", projectRoot: "/x", snapshot: snapshotPayload({ sessionId: "new-edited" }).snapshot } } });
    const attach = lastFrame<{ type: string; id: string }>(ws, "attach")!;
    await serverSend(ws, { type: "snapshot", id: attach.id, payload: snapshotPayload({ sessionId: "new-edited", capabilities: ["runtime.prompt", "runtime.abort", "runtime.stats", "runtime.tools.read"] }) });
    await flush();

    const prompt = ws.sent.find((frame) => (frame as { payload?: { command?: { type?: string } } }).payload?.command?.type === "prompt") as { payload: { sessionId: string; command: { message: string } } };
    expect(prompt.payload.sessionId).toBe("new-edited");
    expect(prompt.payload.command.message).toBe("first message");
    expect((document.querySelector("textarea.chat-input-textarea") as HTMLTextAreaElement).value).toBe("next draft while creating");
  });

  it("keeps the transient draft mounted and restores text when create fails", async () => {
    mount(<Composer cwd="/x" onCreateSession={() => Promise.reject({ code: "unavailable", message: "create failed", retryable: false, phase: "activation" })} />);
    await driveReady();
    const textarea = document.querySelector("textarea.chat-input-textarea") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "keep this first message" } });
    fireEvent.click(screen.getByLabelText("Send message"));
    await act(async () => { await flush(4); });
    expect(document.querySelector("textarea.chat-input-textarea")).toBe(textarea);
    expect(textarea.value).toBe("keep this first message");
    expect(screen.getByRole("alert").textContent).toBe("The message was not sent. Your draft has been kept.");
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
    mount(<Composer sessionId="s1" live />);
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

  it("stays editable for a non-selected session: no detached/continue-live copy, no stale stream or Abort", async () => {
    // The runtime (A) is attached to s1, but the SELECTED session is s2 — a
    // history/inactive browsing state. The composer must remain editable and
    // must NOT expose a detached/continue-live state.
    mount(<Composer sessionId="s2" live={false} />);
    const ws = await driveReady();
    await driveAttach(ws);
    // The attached runtime (s1) starts streaming…
    await serverSend(ws, { type: "event", payload: { type: "message_start", sessionId: "s1", streamId: "st", messageId: "m", message: { role: "assistant", model: "m", provider: "p" }, eventId: 1, epoch: "e1" } });
    // …but the selected session (s2) is not live: the composer stays EDITABLE,
    // with no stale streaming state, no Abort for another session, and no
    // detached/continue-live/stopped copy.
    const textarea = document.querySelector("textarea.chat-input-textarea") as HTMLTextAreaElement;
    expect(textarea.disabled).toBe(false);
    expect(screen.queryByLabelText("Stop agent")).toBeNull();
    expect(screen.queryByText(/selected session is not live|detached|continue live|session stopped/i)).toBeNull();
  });
});

describe("TranscriptList — runtime messages", () => {
  beforeEach(() => { vi.useFakeTimers(); SOCKETS.length = 0; capturedStore = null; });
  afterEach(() => { cleanup(); vi.useRealTimers(); });

  it("renders rows from the exact runtime projection", async () => {
    mount(<TranscriptList sessionId="s1" />);
    const ws = await driveReady();
    await driveAttach(ws);
    // full stream lifecycle commits a user message
    await serverSend(ws, { type: "event", payload: { type: "message_start", sessionId: "s1", streamId: "st", messageId: "m", message: { role: "user", content: "hi there" }, eventId: 1, epoch: "e1" } });
    await serverSend(ws, { type: "event", payload: { type: "message_end", sessionId: "s1", streamId: "st", messageId: "m", message: { role: "user", content: "hi there" }, entryId: "en1", eventId: 2, epoch: "e1" } });
    expect(screen.getByText("hi there")).toBeTruthy();
  });

  it("renders the active streaming partial", async () => {
    mount(<TranscriptList sessionId="s1" />);
    const ws = await driveReady();
    await driveAttach(ws);
    await serverSend(ws, { type: "event", payload: { type: "message_start", sessionId: "s1", streamId: "st", messageId: "m", message: { role: "assistant", content: [{ type: "text", text: "part" }], model: "m", provider: "p" }, eventId: 1, epoch: "e1" } });
    // Streaming-partial publish throttle (UI smoothing) — advance past the
    // 90ms interval, then a benign notify (queue_update) recomputes the view so
    // the buffered partial reaches the transcript.
    await act(async () => { vi.advanceTimersByTime(100); });
    await serverSend(ws, { type: "event", payload: { type: "queue_update", sessionId: "s1", steering: [], followUp: [], eventId: 2, epoch: "e1" } });
    expect(document.querySelectorAll(".stream-char")).toHaveLength(4);
    expect(Array.from(document.querySelectorAll(".stream-char")).map((node) => node.textContent).join("")).toBe("part");
  });
});

describe("RuntimeProvider — D2-P5 runBash/abortBash exposure", () => {
  beforeEach(() => { vi.useFakeTimers(); SOCKETS.length = 0; capturedStore = null; });
  afterEach(() => { cleanup(); vi.useRealTimers(); });

  it("exposes runBash and abortBash on the exact runtime", async () => {
    let exposed!: NonNullable<ReturnType<typeof useRuntime>>;
    function Probe(): null {
      exposed = requireExact(useRuntime("s1"));
      return null;
    }
    mount(<Probe />);
    expect(typeof exposed.runBash).toBe("function");
    expect(typeof exposed.abortBash).toBe("function");
  });

  it("runBash sends an exact bash command and abortBash an exact abort_bash interrupt", async () => {
    let exposed!: NonNullable<ReturnType<typeof useRuntime>>;
    function Probe(): null {
      exposed = requireExact(useRuntime("s1"));
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

  it("exposes getTools, setTools and reload on the exact runtime", async () => {
    let exposed!: NonNullable<ReturnType<typeof useRuntime>>;
    function Probe(): null {
      exposed = requireExact(useRuntime("s1"));
      return null;
    }
    mount(<Probe />);
    expect(typeof exposed.getTools).toBe("function");
    expect(typeof exposed.setTools).toBe("function");
    expect(typeof exposed.reload).toBe("function");
  });

  it("getTools sends an exact get_tools query and resolves typed tools", async () => {
    let exposed!: NonNullable<ReturnType<typeof useRuntime>>;
    function Probe(): null {
      exposed = requireExact(useRuntime("s1"));
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
    let exposed!: NonNullable<ReturnType<typeof useRuntime>>;
    function Probe(): null {
      exposed = requireExact(useRuntime("s1"));
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
    let exposed!: NonNullable<ReturnType<typeof useRuntime>>;
    function Probe(): null {
      exposed = requireExact(useRuntime("s1"));
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
    let exposed!: NonNullable<ReturnType<typeof useRuntime>>;
    function Probe(): null {
      exposed = requireExact(useRuntime("s1"));
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
    let exposed!: NonNullable<ReturnType<typeof useRuntime>>;
    function Probe(): null {
      exposed = requireExact(useRuntime("s1"));
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

  it("exposes compact and abortCompaction on the exact runtime", async () => {
    let exposed!: NonNullable<ReturnType<typeof useRuntime>>;
    function Probe(): null {
      exposed = requireExact(useRuntime("s1"));
      return null;
    }
    mount(<Probe />);
    expect(typeof exposed.compact).toBe("function");
    expect(typeof exposed.abortCompaction).toBe("function");
  });

  it("compact sends an exact compact command and abortCompaction an exact abort_compaction interrupt", async () => {
    let exposed!: NonNullable<ReturnType<typeof useRuntime>>;
    function Probe(): null {
      exposed = requireExact(useRuntime("s1"));
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

describe("Composer — selected live Worker stats without attachment", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    SOCKETS.length = 0;
    capturedStore = null;
    window.localStorage.removeItem("pi-drafts");
  });
  afterEach(() => { cleanup(); vi.useRealTimers(); });

  it("a globally-live detached selection stays 0-Worker: no attach, no worker stats read, no worker-derived footer context", async () => {
    mountComposerRerender("live-detached", false);
    const store = capturedStore!;
    let ws!: FakeWebSocket;
    await act(async () => {
      store.connect();
      ws = SOCKETS.at(-1)!;
      ws.serverOpen();
      ws.serverSend(ack(["agent"], ["runtime.running-watch.v1", "runtime.read-rpc.v1"]));
      ws.serverSend({ type: "running_state", payload: { revision: 1, sessionIds: ["live-detached"], busySessionIds: [] } });
      await flush();
    });

    // Context-usage consistency (replaces the old worker-stats read): a
    // detached history footer NEVER reaches for the same-id background
    // Worker — a long-lived worker can hold a different in-memory branch
    // (the exact 80%-vs-26% inconsistency), so its stats must not be the
    // history source. The Composer no longer even resolves the live list for
    // it: zero attach, zero worker reads/commands, zero listRunning.
    expect(ws.sent.filter((frame) => (frame as { type?: string }).type === "attach")).toHaveLength(0);
    expect(ws.sent.filter((frame) => (frame as { type?: string }).type === "read")).toHaveLength(0);
    expect(ws.sent.filter((frame) => (frame as { type?: string }).type === "command")).toHaveLength(0);
    expect(ws.sent.filter((frame) => (frame as { type?: string }).type === "listRunning")).toHaveLength(0);
    // And nothing worker-derived is rendered: no percentage chip appears from
    // the worker's branch (history context comes from the /context numerator +
    // the exact displayed model's catalog window, both absent here → unknown).
    expect(document.querySelector(".session-info-bar-button.is-stats")?.textContent ?? "").not.toContain("%");
  });
});

describe("Composer — F9 stats late-settle generation on session switch", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    SOCKETS.length = 0;
    capturedStore = null;
    clearDraft("s1");
    window.localStorage.removeItem("pi-drafts");
  });
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
      payload: {
        ok: true,
        result: {
          commandId: frame.payload.command.commandId,
          result: {
            ok: true,
            type: "get_session_stats",
            stats: {
              messageCount: 1,
              tokenCount,
              contextUsage: { percent: tokenCount === 222 ? 22 : 99, contextWindow: 1_000, tokens: tokenCount },
            },
          },
        },
      },
    });
  }

  it("a new session never shows the OLD session's stats: a late old ack is dropped and the own fetch wins", async () => {
    const { rerender } = mountComposerRerender("s1", true);
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

    // Switch Composer/selection to s2 when the lease switches, matching production
    // AppShell. Pending s1 get_session_stats is settled on detach and the s2
    // attach fires a FRESH fetch bound to s2. A resent OLD commandId/sessionId
    // frame here would mean the F9 slot leak is back.
    rerender("s2", false);
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
      // Context-usage consistency: the live projection owns context — the
      // worker snapshot carries it exactly where production gets it.
      ws.serverSend({ type: "snapshot", id: attachFrame.id, payload: snapshotPayload({ sessionId: "s2", capabilities: caps, contextUsage: { percent: 22, contextWindow: 1_000, tokens: 222 } }) });
      await flush();
      await p;
    });
    rerender("s2", true);
    const s2Stats = statsFrame(ws);
    // The new fetch is a FRESH command on s2 — never the old s1 sessionId/commandId.
    expect(s2Stats.payload.sessionId).toBe("s2");
    expect(s2Stats.id).not.toBe(s1Stats.id);
    expect(s2Stats.payload.command.commandId).not.toBe(s1Stats.payload.command.commandId);

    // Deliver the OLD s1 stats ack LATE — it must not pollute the new session.
    // Context is projection-owned now (22% from the s2 snapshot): the late
    // stats ack can change NEITHER the context display NOR the totals.
    await statsAck(ws, s1Stats, 99999);
    const btn = screen.getByLabelText("Session info");
    fireEvent.click(btn);
    expect(screen.queryByText("99,999")).toBeNull();

    // Ack s2's OWN fetch → the new session shows ITS tokens (222), never s1's.
    await statsAck(ws, s2Stats, 222);
    expect(screen.getAllByText("222").length).toBeGreaterThan(0);
    expect(screen.queryByText("99,999")).toBeNull();
  });
});

function countCommandType(ws: FakeWebSocket, type: string): number {
  return ws.sent.filter((f) => {
    const frame = f as { payload?: { command?: { type?: string } } };
    return frame.payload?.command?.type === type;
  }).length;
}

/** Attach to a session with explicit runtime capabilities (bypasses driveAttach's default caps). */
async function driveAttachCaps(ws: FakeWebSocket, caps: string[], sessionId = "s1", epoch?: string, lastEventId?: number): Promise<void> {
  const store = capturedStore!;
  await act(async () => {
    void store.openSession(sessionId);
    await flush();
    const attachFrame = lastFrame<{ type: string; id: string }>(ws, "attach")!;
    ws.serverSend({ type: "snapshot", id: attachFrame.id, payload: snapshotPayload({ sessionId, ...(epoch === undefined ? {} : { epoch }), ...(lastEventId === undefined ? {} : { lastEventId }), capabilities: caps }) });
    await flush();
  });
}

describe("Composer — optimistic prompt lifecycle (text + image parity, definite/uncertain)", () => {
  beforeEach(() => { vi.useFakeTimers(); SOCKETS.length = 0; capturedStore = null; });
  afterEach(() => { cleanup(); vi.useRealTimers(); });

  function typeAndSend(text: string): void {
    const textarea = document.querySelector("textarea.chat-input-textarea") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: text } });
    fireEvent.click(screen.getByLabelText("Send message"));
  }

  it("shows the optimistic bubble + Stop instantly, then reconciles once accepted", async () => {
    mount(<><TranscriptList sessionId="s1" /><Composer sessionId="s1" live /></>);
    const ws = await driveReady();
    await driveAttach(ws);
    typeAndSend("hello world");
    await flush();
    // The optimistic user bubble is ALREADY on screen (before any wire ack)…
    expect(screen.getByText("hello world")).toBeTruthy();
    // …and the Stop control appears immediately (speculative running overlay).
    expect(screen.getByLabelText("Stop agent")).toBeTruthy();
    // Transport admission is not completion: Stop remains visible through the
    // ack→agent_start gap and clears only on the authoritative terminal event.
    const cmd = lastFrame<{ type: string; id: string; payload: { command: { commandId: string } } }>(ws, "command")!;
    await serverSend(ws, { type: "response", id: cmd.id, payload: { ok: true, result: { commandId: cmd.payload.command.commandId, result: { ok: true, type: "prompt" } } } });
    expect(screen.getByLabelText("Stop agent")).toBeTruthy();
    await serverSend(ws, { type: "event", payload: { type: "agent_start", sessionId: "s1", eventId: 1, epoch: "e1" } });
    expect(screen.getByLabelText("Stop agent")).toBeTruthy();
    await serverSend(ws, { type: "event", payload: { type: "agent_end", sessionId: "s1", eventId: 2, epoch: "e1" } });
    expect(screen.getByLabelText("Stop agent")).toBeTruthy();
    await serverSend(ws, { type: "event", payload: { type: "agent_settled", sessionId: "s1", eventId: 3, epoch: "e1" } });
    expect(screen.queryByLabelText("Stop agent")).toBeNull();
  });

  it("a DEFINITE rejection drops the optimistic bubble and restores the draft", async () => {
    mount(<><TranscriptList sessionId="s1" /><Composer sessionId="s1" live /></>);
    const ws = await driveReady();
    await driveAttach(ws);
    typeAndSend("will be rejected");
    await flush();
    expect(screen.getByText("will be rejected")).toBeTruthy();
    const cmd = lastFrame<{ type: string; id: string; payload: { command: { commandId: string } } }>(ws, "command")!;
    await serverSend(ws, { type: "response", id: cmd.id, payload: { ok: false, error: { code: "invalid_input", message: "no", retryable: false } } });
    // The turn never started: the optimistic bubble is removed from the store…
    expect(capturedStore!.getSnapshot().liveEntries).toHaveLength(0);
    // …and the text is restored into the composer (textarea + highlight mirror).
    const textarea = document.querySelector("textarea.chat-input-textarea") as HTMLTextAreaElement;
    expect(textarea.value).toBe("will be rejected");
  });

  it("an UNCERTAIN (retryable) rejection keeps the optimistic bubble (delivery ambiguous)", async () => {
    mount(<><TranscriptList sessionId="s1" /><Composer sessionId="s1" live /></>);
    const ws = await driveReady();
    await driveAttach(ws);
    typeAndSend("maybe delivered");
    await flush();
    const cmd = lastFrame<{ type: string; id: string; payload: { command: { commandId: string } } }>(ws, "command")!;
    await serverSend(ws, { type: "response", id: cmd.id, payload: { ok: false, error: { code: "unavailable", message: "busy", retryable: true } } });
    // The bubble stays (the turn may be running server-side); the draft is NOT restored.
    expect(capturedStore!.getSnapshot().liveEntries.some((e) => (e.message as { content: string }).content === "maybe delivered")).toBe(true);
    const textarea = document.querySelector("textarea.chat-input-textarea") as HTMLTextAreaElement;
    expect(textarea.value).toBe("");
  });

  it("image sends are optimistic with parity to text (bubble appears instantly, images on the wire)", async () => {
    // Attach an image via the attach affordance is heavy; instead drive the
    // store path directly through the exact sendPrompt(message, images)
    // and assert the TranscriptList shows the bubble immediately.
    let exposed!: NonNullable<ReturnType<typeof useRuntime>>;
    function Probe(): null {
      exposed = requireExact(useRuntime("s1"));
      return null;
    }
    mount(<><Probe /><TranscriptList sessionId="s1" /></>);
    const ws = await driveReady();
    await driveAttach(ws);
    const p = exposed.sendPrompt("look at this", [{ type: "image", data: "AAAA", mimeType: "image/png" }]);
    await flush();
    expect(screen.getByText("look at this")).toBeTruthy();
    // Speculative running overlay is active (store view), exactly like text sends.
    expect(capturedStore!.getSnapshot().streaming).toBe(true);
    const cmd = lastFrame<{ type: string; id: string; payload: { command: { commandId: string; type: string; images?: unknown[] } } }>(ws, "command")!;
    expect(cmd.payload.command.type).toBe("prompt");
    expect(cmd.payload.command.images).toEqual([{ type: "image", data: "AAAA", mimeType: "image/png" }]);
    await serverSend(ws, { type: "response", id: cmd.id, payload: { ok: true, result: { commandId: cmd.payload.command.commandId, result: { ok: true, type: "prompt" } } } });
    await p;
    expect(capturedStore!.getSnapshot().streaming).toBe(true);
    await serverSend(ws, { type: "event", payload: { type: "agent_start", sessionId: "s1", eventId: 1, epoch: "e1" } });
    await serverSend(ws, { type: "event", payload: { type: "agent_end", sessionId: "s1", eventId: 2, epoch: "e1" } });
    expect(capturedStore!.getSnapshot().streaming).toBe(false);
  });

  it("does NOT refire get_session_stats on every stream event (stable lifecycle refresh)", async () => {
    mount(<Composer sessionId="s1" live />);
    const ws = await driveReady();
    await driveAttachCaps(ws, ["runtime.prompt", "runtime.abort", "runtime.stats"]);
    // Exactly ONE stats fetch on the fresh attach.
    expect(countCommandType(ws, "get_session_stats")).toBe(1);
    // Stream a full turn with several wire events — the fetch must NOT refire.
    await serverSend(ws, { type: "event", payload: { type: "message_start", sessionId: "s1", streamId: "st", messageId: "m", message: { role: "assistant", model: "m", provider: "p" }, eventId: 1, epoch: "e1" } });
    await serverSend(ws, { type: "event", payload: { type: "message_update", sessionId: "s1", streamId: "st", messageId: "m", delta: { role: "assistant", delta: { type: "text", text: "part" } }, eventId: 2, epoch: "e1" } });
    await serverSend(ws, { type: "event", payload: { type: "queue_update", sessionId: "s1", steering: [], followUp: [], eventId: 3, epoch: "e1" } });
    await flush();
    expect(countCommandType(ws, "get_session_stats")).toBe(1);
    // Ack the single in-flight stats read so the store settles cleanly at teardown.
    const statsCmd = lastFrame<{ type: string; id: string; payload: { command: { commandId: string } } }>(ws, "command")!;
    await serverSend(ws, { type: "response", id: statsCmd.id, payload: { ok: true, result: { commandId: statsCmd.payload.command.commandId, result: { ok: true, type: "get_session_stats", stats: { messageCount: 1, tokenCount: 10 } } } } });
  });
});

describe("Composer — slash palette is generated from actually-supported builtins", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    SOCKETS.length = 0;
    capturedStore = null;
    clearDraft("s1");
    window.localStorage.removeItem("pi-drafts");
  });
  afterEach(() => { cleanup(); vi.useRealTimers(); });

  it("offers only the compact builtin; unsupported reload/name/session/copy never appear", async () => {
    mount(<Composer sessionId="s1" live />);
    const ws = await driveReady();
    // `/compact` is only offered while the runtime is live AND advertises the
    // compact capability — exactly the builtins that can actually execute.
    await driveAttachCaps(ws, ["runtime.prompt", "runtime.abort", "runtime.compact"]);
    const textarea = document.querySelector("textarea.chat-input-textarea") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "/" } });
    textarea.setSelectionRange(1, 1);
    fireEvent.select(textarea);
    await flush();
    // Ack the get_commands probe so the runtime palette resolves (empty here).
    const gc = lastFrame<{ type: string; id: string; payload: { command: { commandId: string } } }>(ws, "command");
    if (gc) {
      await serverSend(ws, { type: "response", id: gc.id, payload: { ok: true, result: { commandId: gc.payload.command.commandId, result: { ok: true, type: "get_commands", commands: [] } } } });
    }
    // The compact builtin IS offered…
    expect(screen.getByText("/compact")).toBeTruthy();
    // …and the unsupported builtins (which would fall through as model prompts)
    // are NEVER offered.
    expect(screen.queryByText("/reload")).toBeNull();
    expect(screen.queryByText("/name")).toBeNull();
    expect(screen.queryByText("/session")).toBeNull();
    expect(screen.queryByText("/copy")).toBeNull();
  });
});

describe("TranscriptList — distinguishes loading from real error (i18n, no error-as-spinner)", () => {
  beforeEach(() => { vi.useFakeTimers(); SOCKETS.length = 0; capturedStore = null; });
  afterEach(() => { cleanup(); vi.useRealTimers(); });

  it("shows a loading placeholder while the first history page is in flight", async () => {
    // The context query stays pending (never resolves) → isFetchingInitial.
    const previousFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(() => new Promise<Response>(() => undefined)) as unknown as typeof fetch;
    try {
      mount(<TranscriptList sessionId="s1" live={false} />, { mode: "local", capabilities: ["agent", "sessions"] });
      // Loading state: the i18n loading text with a spinner (aria-busy), never an error.
      expect(screen.getByText("Loading session...")).toBeTruthy();
      expect(screen.getByRole("log").querySelector(".transcript-loading-dot")).toBeTruthy();
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  it("shows a REAL error (not a spinner) when the history load fails", async () => {
    // React Query surfaces query errors on real timers (fake timers hold the
    // observer update); the socket deps use injected timers so real timers here
    // are safe (no socket activity in this history-only test).
    vi.useRealTimers();
    const previousFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockRejectedValue(new TypeError("offline")) as unknown as typeof fetch;
    try {
      mount(<TranscriptList sessionId="s1" live={false} />, { mode: "local", capabilities: ["agent", "sessions"] });
      await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
      expect(screen.getByRole("alert").textContent).toContain("Failed to load conversation history.");
      // No spinner / loading dot and no error-as-spinner text on the error branch.
      expect(screen.getByRole("log").querySelector(".transcript-loading-dot")).toBeNull();
      expect(screen.queryByText("Loading session...")).toBeNull();
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
});

describe("Composer — activation-then-send (send is the activation intent, single state machine)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    SOCKETS.length = 0;
    capturedStore = null;
    clearDraft("s1");
    window.localStorage.removeItem("pi-drafts");
  });
  afterEach(() => { cleanup(); vi.useRealTimers(); });

  function typeAndSend(text: string): void {
    const textarea = document.querySelector("textarea.chat-input-textarea") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: text } });
    fireEvent.click(screen.getByLabelText("Send message"));
  }

  it("inactive selected session: type+send → ONE detach+attach then exactly ONE prompt", async () => {
    // Selected session is s2; the runtime is attached to a DIFFERENT session s1.
    mount(<Composer sessionId="s2" live={false} />);
    const ws = await driveReady();
    await driveAttach(ws);
    const textarea = document.querySelector("textarea.chat-input-textarea") as HTMLTextAreaElement;
    expect(textarea.disabled).toBe(false); // editable while inactive (no detached copy)
    typeAndSend("activate me");
    await flush();
    // Sending is the activation intent: detach stale s1…
    const detachFrame = lastFrame<{ type: string; id: string; payload: { sessionId: string } }>(ws, "detach")!;
    expect(detachFrame.payload.sessionId).toBe("s1");
    await serverSend(ws, { type: "response", id: detachFrame.id, payload: { ok: true, result: { sessionId: "s1", detached: true } } });
    // …attach the exact selected s2…
    const attach = lastFrame<{ type: string; id: string; payload: { sessionId: string } }>(ws, "attach")!;
    expect(attach.payload.sessionId).toBe("s2");
    await serverSend(ws, { type: "snapshot", id: attach.id, payload: snapshotPayload({ sessionId: "s2" }) });
    // …then send the SAME prompt transaction exactly once.
    const cmd = lastFrame<{ type: string; id: string; payload: { sessionId?: string; command: { commandId: string; type: string; message: string } } }>(ws, "command")!;
    expect(cmd.payload.command.type).toBe("prompt");
    expect(cmd.payload.command.message).toBe("activate me");
    expect(cmd.payload.sessionId).toBe("s2");
    await serverSend(ws, { type: "response", id: cmd.id, payload: { ok: true, result: { commandId: cmd.payload.command.commandId, result: { ok: true, type: "prompt" } } } });
    expect(capturedStore!.getSnapshot().sessionId).toBe("s2");
  });

  it("live send preempts an already in-flight attach-time stats read", async () => {
    mount(<Composer sessionId="s1" live />);
    const ws = await driveReady();
    await driveAttachCaps(ws, ["runtime.prompt", "runtime.abort", "runtime.stats", "runtime.tools.read"]);
    const before = ws.sent.filter((frame) => (frame as { type?: string }).type === "command") as Array<{ payload: { command: { type: string } } }>;
    expect(before.map((frame) => frame.payload.command.type)).toEqual(["get_session_stats"]);

    typeAndSend("prompt wins now");
    await flush();
    const commands = ws.sent.filter((frame) => (frame as { type?: string }).type === "command") as Array<{ payload: { sessionId: string; command: { type: string; message?: string } } }>;
    expect(commands.map((frame) => frame.payload.command.type)).toEqual(["get_session_stats", "prompt"]);
    expect(commands[1]!.payload.command.message).toBe("prompt wins now");
    expect(commands[1]!.payload.sessionId).toBe("s1");
  });

  it("first detached send gives prompt priority over attach-time stats/tools reads", async () => {
    function SelectedComposer() {
      return <Composer sessionId="s2" live={false} />;
    }

    mount(<SelectedComposer />);
    const ws = await driveReady();
    typeAndSend("one enter only");
    await flush();
    const attach = lastFrame<{ type: string; id: string; payload: { sessionId: string } }>(ws, "attach")!;
    expect(attach.payload.sessionId).toBe("s2");
    await serverSend(ws, {
      type: "snapshot",
      id: attach.id,
      payload: snapshotPayload({
        sessionId: "s2",
        capabilities: ["runtime.prompt", "runtime.abort", "runtime.stats", "runtime.tools.read"],
      }),
    });

    const commands = ws.sent.filter((frame) => (frame as { type?: string }).type === "command") as Array<{ payload: { command: { type: string; message?: string } } }>;
    expect(commands).toHaveLength(1);
    expect(commands[0]!.payload.command.type).toBe("prompt");
    expect(commands[0]!.payload.command.message).toBe("one enter only");
    const textarea = document.querySelector("textarea.chat-input-textarea") as HTMLTextAreaElement;
    expect(textarea.value).toBe("");
  });

  it("stale/stopped attachment: sending re-attaches the exact session then sends", async () => {
    mount(<Composer sessionId="s1" live={false} />);
    const ws = await driveReady();
    await driveAttach(ws);
    // Stop s1 → stale/stopped attachment.
    const stopP = capturedStore!.stop();
    await flush();
    const stopFrame = lastFrame<{ type: string; id: string }>(ws, "stop")!;
    await serverSend(ws, { type: "response", id: stopFrame.id, payload: { ok: true, result: { sessionId: "s1", stopped: true } } });
    await stopP;
    expect(capturedStore!.getSnapshot().sessionStopped).toBe(true);
    const textarea = document.querySelector("textarea.chat-input-textarea") as HTMLTextAreaElement;
    expect(textarea.disabled).toBe(false); // still editable after a stop
    typeAndSend("wake up");
    await flush();
    // Re-activates the exact s1 (fresh attach), then sends.
    const attach = lastFrame<{ type: string; id: string; payload: { sessionId: string } }>(ws, "attach")!;
    expect(attach.payload.sessionId).toBe("s1");
    await serverSend(ws, { type: "snapshot", id: attach.id, payload: snapshotPayload({ sessionId: "s1", epoch: "e2" }) });
    const cmd = lastFrame<{ type: string; id: string; payload: { sessionId?: string; command: { commandId: string; type: string; message: string } } }>(ws, "command")!;
    expect(cmd.payload.command.type).toBe("prompt");
    expect(cmd.payload.command.message).toBe("wake up");
    expect(cmd.payload.sessionId).toBe("s1");
    await serverSend(ws, { type: "response", id: cmd.id, payload: { ok: true, result: { commandId: cmd.payload.command.commandId, result: { ok: true, type: "prompt" } } } });
    expect(capturedStore!.getSnapshot().sessionStopped).toBe(false);
  });

  it("rapid session switch before send targets the LATEST selection", async () => {
    const { rerender } = mountComposerRerender("s1");
    const ws = await driveReady();
    const textarea = document.querySelector("textarea.chat-input-textarea") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "draft for s1" } });
    // Switch selection to s2 BEFORE sending. Drafts are per-session: switching
    // loads s2's (empty) draft, so the user types the new message here.
    rerender("s2");
    const textarea2 = document.querySelector("textarea.chat-input-textarea") as HTMLTextAreaElement;
    expect(textarea2.value).toBe(""); // s2 has no saved draft
    fireEvent.change(textarea2, { target: { value: "target latest" } });
    fireEvent.click(screen.getByLabelText("Send message"));
    await flush();
    // The send targets the LATEST selection (s2), never the earlier s1.
    const attach = lastFrame<{ type: string; id: string; payload: { sessionId: string } }>(ws, "attach")!;
    expect(attach.payload.sessionId).toBe("s2");
    await serverSend(ws, { type: "snapshot", id: attach.id, payload: snapshotPayload({ sessionId: "s2" }) });
    const cmd = lastFrame<{ type: string; id: string; payload: { sessionId?: string; command: { commandId: string; type: string; message: string } } }>(ws, "command")!;
    expect(cmd.payload.command.type).toBe("prompt");
    expect(cmd.payload.command.message).toBe("target latest");
    expect(cmd.payload.sessionId).toBe("s2");
    await serverSend(ws, { type: "response", id: cmd.id, payload: { ok: true, result: { commandId: cmd.payload.command.commandId, result: { ok: true, type: "prompt" } } } });
  });

  it("activation failure (not_found) preserves the draft and leaves no phantom bubble", async () => {
    mount(<Composer sessionId="ghost" live={false} />);
    const ws = await driveReady();
    await driveAttach(ws); // attached to s1
    const textarea = document.querySelector("textarea.chat-input-textarea") as HTMLTextAreaElement;
    typeAndSend("will fail");
    await flush();
    // The optimistic bubble appears immediately in the selected session layer…
    expect(capturedStore!.getSnapshot().optimisticEntries.some((candidate) => candidate.sessionId === "ghost" && (candidate.entry.message as { content: string }).content === "will fail")).toBe(true);
    // Detach s1 + attach ghost → not_found (never a create).
    const detachFrame = lastFrame<{ type: string; id: string }>(ws, "detach")!;
    await serverSend(ws, { type: "response", id: detachFrame.id, payload: { ok: true, result: { sessionId: "s1", detached: true } } });
    const attach = lastFrame<{ type: string; id: string; payload: { sessionId: string } }>(ws, "attach")!;
    expect(attach.payload.sessionId).toBe("ghost");
    await serverSend(ws, { type: "response", id: attach.id, payload: { ok: false, error: { code: "not_found", message: "no such session", retryable: false } } });
    // No phantom bubble remains…
    expect(capturedStore!.getSnapshot().optimisticEntries.some((candidate) => candidate.sessionId === "ghost" && (candidate.entry.message as { content: string }).content === "will fail")).toBe(false);
    // …and the draft is preserved in the composer.
    expect(textarea.value).toBe("will fail");
  });

  it("RETRYABLE activation failure is proven non-delivery: no phantom bubble, draft retained", async () => {
    mount(<Composer sessionId="ghost" live={false} />);
    const ws = await driveReady();
    await driveAttach(ws); // attached to s1
    const textarea = document.querySelector("textarea.chat-input-textarea") as HTMLTextAreaElement;
    typeAndSend("stuck");
    await flush();
    expect(capturedStore!.getSnapshot().optimisticEntries.some((candidate) => candidate.sessionId === "ghost" && (candidate.entry.message as { content: string }).content === "stuck")).toBe(true);
    const detachFrame = lastFrame<{ type: string; id: string }>(ws, "detach")!;
    await serverSend(ws, { type: "response", id: detachFrame.id, payload: { ok: true, result: { sessionId: "s1", detached: true } } });
    const attach = lastFrame<{ type: string; id: string; payload: { sessionId: string } }>(ws, "attach")!;
    // The attach fails with a RETRYABLE error — still the ACTIVATION phase (no
    // prompt command was dispatched), so it is PROVEN non-delivery.
    await serverSend(ws, { type: "response", id: attach.id, payload: { ok: false, error: { code: "unavailable", message: "busy", retryable: true } } });
    // No phantom bubble, no pending transaction…
    expect(capturedStore!.getSnapshot().optimisticEntries.some((candidate) => candidate.sessionId === "ghost" && (candidate.entry.message as { content: string }).content === "stuck")).toBe(false);
    expect(capturedStore!.getSnapshot().promptPending).toBe(false);
    // …and the draft is RETAINED in the composer.
    expect(textarea.value).toBe("stuck");
  });

  it("two submits during activation: the second is rejected (session_busy), its draft restored, the first untouched", async () => {
    mount(<Composer sessionId="s2" live={false} />);
    const ws = await driveReady();
    await driveAttach(ws); // attached to s1 → activation must detach s1 + attach s2
    const textarea = document.querySelector("textarea.chat-input-textarea") as HTMLTextAreaElement;
    typeAndSend("first message");
    await flush();
    // The first transaction is in flight (activation phase)…
    expect(capturedStore!.getSnapshot().promptPending).toBe(true);
    expect(capturedStore!.getSnapshot().optimisticEntries.some((candidate) => candidate.sessionId === "s2" && (candidate.entry.message as { content: string }).content === "first message")).toBe(true);
    // Second submit (Enter; the Send button is a busy Stop during activation).
    fireEvent.change(textarea, { target: { value: "second message" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    await flush();
    // The second is rejected (session_busy) and its draft restored…
    expect(textarea.value).toBe("second message");
    // …and the first is untouched (no phantom bubble for the second).
    expect(capturedStore!.getSnapshot().optimisticEntries.some((candidate) => candidate.sessionId === "s2" && (candidate.entry.message as { content: string }).content === "second message")).toBe(false);
    expect(capturedStore!.getSnapshot().optimisticEntries.some((candidate) => candidate.sessionId === "s2" && (candidate.entry.message as { content: string }).content === "first message")).toBe(true);
    expect(capturedStore!.getSnapshot().promptPending).toBe(true);
    // The first completes normally.
    const detachFrame = lastFrame<{ type: string; id: string }>(ws, "detach")!;
    await serverSend(ws, { type: "response", id: detachFrame.id, payload: { ok: true, result: { sessionId: "s1", detached: true } } });
    const attach = lastFrame<{ type: string; id: string; payload: { sessionId: string } }>(ws, "attach")!;
    await serverSend(ws, { type: "snapshot", id: attach.id, payload: snapshotPayload({ sessionId: "s2" }) });
    const cmd = lastFrame<{ type: string; id: string; payload: { command: { commandId: string; type: string; message: string } } }>(ws, "command")!;
    expect(cmd.payload.command.message).toBe("first message");
    await serverSend(ws, { type: "response", id: cmd.id, payload: { ok: true, result: { commandId: cmd.payload.command.commandId, result: { ok: true, type: "prompt" } } } });
    expect(capturedStore!.getSnapshot().promptPending).toBe(false);
  });
});

describe("Composer — session title generation (Settings → Chat consumer)", () => {
  /** driveReady with the submit-turn feature accepted ( negotiated turn path). */
  async function driveReadySubmit(): Promise<FakeWebSocket> {
    const store = capturedStore!;
    let ws: FakeWebSocket | undefined;
    await act(async () => {
      store.connect();
      ws = SOCKETS[SOCKETS.length - 1]!;
      ws.serverOpen();
      ws.serverSend(ack(["agent"], ["runtime.running-watch.v1", "runtime.submit-turn.v1", "runtime.read-rpc.v1", "runtime.observe-existing.v1"]));
      await flush();
    });
    return ws!;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    SOCKETS.length = 0;
    capturedStore = null;
    clearDraft("s1");
    window.localStorage.removeItem("pi-drafts");
    window.localStorage.setItem("pi-title-auto", "on");
    window.localStorage.setItem("pi-title-model", "test-provider:test-model");
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    window.localStorage.removeItem("pi-title-auto");
    window.localStorage.removeItem("pi-title-model");
  });

  function typeAndSend(text: string): void {
    const textarea = document.querySelector("textarea.chat-input-textarea") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: text } });
    fireEvent.click(screen.getByLabelText("Send message"));
  }

  /** Drive a full negotiated submit-turn to COMPLETED terminal (probe pattern). */
  async function driveCompletedTurn(ws: FakeWebSocket, prompt: string): Promise<void> {
    typeAndSend(prompt);
    await flush();
    const submit = lastFrame<{ type: "submit_turn"; id: string; payload: { operationId: string } }>(ws, "submit_turn")!;
    const op = submit.payload.operationId;
    await serverSend(ws, {
      type: "submit_turn_result",
      id: submit.id,
      payload: {
        status: "accepted", delivery: "accepted", sessionId: "s1", epoch: "e1", revision: 2, operationId: op, turnId: "turn-1",
        snapshot: snapshotPayload({ sessionId: "s1", epoch: "e1" }).snapshot as never,
        turnStatus: { sessionId: "s1", epoch: "e1", operationId: op, turnId: "turn-1", revision: 0, state: "admitted" },
      },
    });
    // Commit the user entry (real flows deliver message_end before terminal),
    // then drive the turn to its COMPLETED terminal.
    await serverSend(ws, { type: "event", payload: { type: "message_start", sessionId: "s1", streamId: `st-${op}`, messageId: `m-${op}`, message: { role: "user", content: prompt }, eventId: 1, epoch: "e1" } });
    await serverSend(ws, { type: "event", payload: { type: "message_end", sessionId: "s1", streamId: `st-${op}`, messageId: `m-${op}`, message: { role: "user", content: prompt }, entryId: `entry-${op}`, eventId: 2, epoch: "e1" } });
    await serverSend(ws, { type: "turn_status", payload: { sessionId: "s1", epoch: "e1", operationId: op, turnId: "turn-1", revision: 1, state: "completed", userEntryId: `entry-${op}` } });
  }

  let probeExact: { submitTurn: (i: { prompt: string }) => Promise<unknown>; subscribeTurnTerminal: (l: (t: { state: string }) => void) => () => void } | null = null;

  it("auto-generates a title once after the first completed turn of an untitled session, carrying the configured model", async () => {
    function Probe(): null {
      probeExact = useRuntime("s1");
      return null;
    }
    mount(<><Probe /><Composer sessionId="s1" live /></>);
    const ws = await driveReadySubmit();
    await driveAttachCaps(ws, ["runtime.prompt", "runtime.abort", "runtime.auto_name"], "s1", "e1", 2);
    await driveCompletedTurn(ws, "name me");
    // The auto-title command rides the ordinary lane AFTER the turn released it.
    const titleFrame = ws.sent.find((frame) => {
      const command = (frame as { payload?: { command?: { type?: string } } }).payload?.command;
      return command?.type === "generate_session_title";
    }) as { id: string; payload: { sessionId?: string; command: { commandId: string; model?: { provider: string; modelId: string } } } } | undefined;
    expect(titleFrame).toBeDefined();
    expect(titleFrame!.payload.sessionId).toBe("s1");
    expect(titleFrame!.payload.command.model).toEqual({ provider: "test-provider", modelId: "test-model" });
    // Success settles the command and never fabricates a title client-side.
    await serverSend(ws, { type: "response", id: titleFrame!.id, payload: { ok: true, result: { commandId: titleFrame!.payload.command.commandId, result: { ok: true, type: "generate_session_title", title: "Generated" } } } });
    // A second completed turn for the SAME session never re-fires (once per
    // load). Driven through the exact API (the UI's own busy state after the
    // first turn is irrelevant to the once-guard under test).
    const seen: string[] = [];
    await act(async () => {
      probeExact!.subscribeTurnTerminal((terminal) => seen.push(terminal.state));
      const turnP = probeExact!.submitTurn({ prompt: "again" });
      turnP.catch(() => undefined);
      await flush();
      const submits = ws.sent.filter((frame) => (frame as { type?: string }).type === "submit_turn") as { id: string; payload: { operationId: string } }[];
      const submit = submits[submits.length - 1]!;
      const op = submit.payload.operationId;
      ws.serverSend({ type: "submit_turn_result", id: submit.id, payload: { status: "accepted", delivery: "accepted", sessionId: "s1", epoch: "e1", revision: 3, operationId: op, turnId: "turn-2", snapshot: snapshotPayload({ sessionId: "s1", epoch: "e1" }).snapshot as never, turnStatus: { sessionId: "s1", epoch: "e1", operationId: op, turnId: "turn-2", revision: 0, state: "admitted" } } });
      ws.serverSend({ type: "turn_status", payload: { sessionId: "s1", epoch: "e1", operationId: op, turnId: "turn-2", revision: 1, state: "completed" } });
      await flush();
    });
    expect(seen).toContain("completed");
    const titleFrames = ws.sent.filter((frame) => (frame as { payload?: { command?: { type?: string } } }).payload?.command?.type === "generate_session_title");
    expect(titleFrames).toHaveLength(1);
  });

  it("auto-generates without a configured title model by riding the session's current model", async () => {
    window.localStorage.setItem("pi-title-model", "");
    mount(<Composer sessionId="s1" live />);
    const ws = await driveReadySubmit();
    await driveAttachCaps(ws, ["runtime.prompt", "runtime.abort", "runtime.auto_name"], "s1", "e1", 2);
    await driveCompletedTurn(ws, "no model configured");
    const titleFrame = ws.sent.find((frame) => (frame as { payload?: { command?: { type?: string } } }).payload?.command?.type === "generate_session_title") as { id: string; payload: { command: { model?: { provider: string; modelId: string } } } } | undefined;
    expect(titleFrame).toBeDefined();
    // No dedicated title model: the command omits `model` so the Worker uses
    // the session's current model (same policy as the manual smart rename).
    expect(titleFrame!.payload.command.model).toBeUndefined();
    await serverSend(ws, { type: "response", id: titleFrame!.id, payload: { ok: true, result: { commandId: "any", result: { ok: true, type: "generate_session_title", title: "Generated" } } } });
  });

  it("never auto-generates for a session that already has an authoritative title", async () => {
    mount(<Composer sessionId="s1" live selectedSessionHasTitle />);
    const ws = await driveReadySubmit();
    await driveAttachCaps(ws, ["runtime.prompt", "runtime.abort", "runtime.auto_name"], "s1", "e1", 2);
    await driveCompletedTurn(ws, "already titled");
    const titleFrames = ws.sent.filter((frame) => (frame as { payload?: { command?: { type?: string } } }).payload?.command?.type === "generate_session_title");
    expect(titleFrames).toHaveLength(0);
  });
});
