/**
 * 4A.3.2b1a — `useSessionTranscript` exact per-session runtime wiring.
 *
 * The hook now binds the exact `useRuntime(sessionId)` instead of the zero-arg
 * facade. Deterministic provider mount driven through the FakeWebSocket (same
 * pattern as the runtime tests). `enabled:false` + no "sessions" capability
 * keep the HTTP infinite query inert, so `entries` isolates the exact
 * live/optimistic layer — proving exact A/B isolation, HTTP-only unadmitted
 * behavior (zero controller/admission/attach), retained detached
 * committed+optimism and no duplicate optimism. The pure `mergeTranscriptEntries`
 * reconciliation tests live in the sibling `use-session-transcript.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { useSessionTranscript, type SessionTranscript } from "./use-session-transcript";
import { HttpClientProvider } from "@/app/http-context";
import { CapabilityProvider } from "@/features/capability/CapabilityProvider";
import { RuntimeProvider, useRuntime } from "@/runtime";
import type { ExactRuntimeApi } from "@/runtime/exact-runtime";
import type { RuntimeSocketDeps } from "@/runtime";
import { FakeWebSocket, flush, lastFrame, snapshotPayload } from "@/runtime/testing/harness";
import { CaptureTestRuntime } from "@/runtime/testing/capture-test-runtime";
import type { TestRuntimeStore } from "@/runtime/testing/test-runtime-store";

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
    features: ["runtime.running-watch.v1", "runtime.submit-turn.v1", "runtime.read-rpc.v1", "runtime.observe-existing.v1"],
  };
}

let capturedStore: TestRuntimeStore | null = null;

function Tree({ children }: { children: ReactNode }): ReactNode {
  const [queryClient] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false } } }));
  return (
    <QueryClientProvider client={queryClient}>
      <HttpClientProvider>
        <CapabilityProvider host={{ mode: "local", capabilities: ["agent"] }}>
          <RuntimeProvider deps={fakeDeps()}>
            <CaptureTestRuntime onStore={(store) => { capturedStore = store; }} />
            {children}
          </RuntimeProvider>
        </CapabilityProvider>
      </HttpClientProvider>
    </QueryClientProvider>
  );
}

describe("useSessionTranscript — exact runtime wiring (4A.3.2b1a)", () => {
  beforeEach(() => { vi.useFakeTimers(); SOCKETS.length = 0; capturedStore = null; });
  afterEach(() => { cleanup(); vi.useRealTimers(); });

  async function driveReady(): Promise<FakeWebSocket> {
    const store = capturedStore!;
    let ws: FakeWebSocket | undefined;
    await act(async () => {
      store.connect();
      ws = SOCKETS[SOCKETS.length - 1]!;
      ws.serverOpen();
      ws.serverSend({ type: "handshake_ack", payload: { protocolVersion: 2, host: { mode: "local", capabilities: ["agent"] }, limits: { maxUpload: 0, maxOpenSessions: 4 }, sessionSnapshotSupport: true, acceptedFeatures: ["runtime.running-watch.v1", "runtime.submit-turn.v1", "runtime.read-rpc.v1", "runtime.observe-existing.v1"] } });
      await flush();
    });
    return ws!;
  }

  async function serverSend(ws: FakeWebSocket, message: unknown): Promise<void> {
    await act(async () => { ws.serverSend(message); await flush(); });
  }

  it("unadmitted selected session stays HTTP-only with ZERO controller/admission/attach", async () => {
    const transcripts: (SessionTranscript | null)[] = [];
    function Probe(): null {
      transcripts.push(useSessionTranscript({ sessionId: "B", enabled: false, live: false }));
      return null;
    }
    render(<Tree><Probe /></Tree>);
    const ws = await driveReady();
    const store = capturedStore!;
    // Attach a DIFFERENT session A so the runtime is genuinely live; the
    // selected B must stay unadmitted (no controller, no attach, no admission).
    await act(async () => {
      void store.openSession("A").catch(() => {});
      await flush();
      const attach = lastFrame<{ type: "attach"; id: string; payload: { sessionId: string } }>(ws, "attach")!;
      expect(attach.payload.sessionId).toBe("A");
      ws.serverSend({ type: "snapshot", id: attach.id, payload: snapshotPayload({ sessionId: "A" }) });
      await flush();
    });
    const t = transcripts.at(-1)!;
    expect(t.entries).toEqual([]);
    expect(t.error).toBe(false);
    const attachFrames = (ws.sent as Array<{ type: string; payload?: { sessionId?: string } }>).filter((f) => f.type === "attach");
    expect(attachFrames.some((f) => f.payload?.sessionId === "B")).toBe(false);
    expect(store.registry.peek("B")).toBeNull();
  });

  it("exact A/B isolation: A's committed live entries never leak into B's transcript", async () => {
    const transcripts: (SessionTranscript | null)[] = [];
    function Probe(): null {
      transcripts.push(useSessionTranscript({ sessionId: "A", enabled: false, live: true }));
      transcripts.push(useSessionTranscript({ sessionId: "B", enabled: false, live: true }));
      return null;
    }
    render(<Tree><Probe /></Tree>);
    const ws = await driveReady();
    const store = capturedStore!;
    await act(async () => {
      void store.openSession("A").catch(() => {});
      await flush();
      const attach = lastFrame<{ type: "attach"; id: string; payload: { sessionId: string } }>(ws, "attach")!;
      ws.serverSend({ type: "snapshot", id: attach.id, payload: snapshotPayload({ sessionId: "A" }) });
      await flush();
    });
    await serverSend(ws, { type: "event", payload: { type: "message_start", sessionId: "A", streamId: "st", messageId: "m", message: { role: "user", content: "hello A" }, eventId: 1, epoch: "e1" } });
    await serverSend(ws, { type: "event", payload: { type: "message_end", sessionId: "A", streamId: "st", messageId: "m", message: { role: "user", content: "hello A" }, entryId: "en-A", eventId: 2, epoch: "e1" } });
    const tA = transcripts.at(-2)!;
    const tB = transcripts.at(-1)!;
    expect(tA.entries.map((entry) => entry.entryId)).toContain("en-A");
    expect(tA.entries.some((entry) => (entry.message as { content?: string }).content === "hello A")).toBe(true);
    expect(tB.entries).toEqual([]);
  });

  it("detached A retains committed + optimistic entries (no duplicate optimism)", async () => {
    const transcripts: (SessionTranscript | null)[] = [];
    const exactSamples: (ExactRuntimeApi | null)[] = [];
    function Probe(): null {
      transcripts.push(useSessionTranscript({ sessionId: "A", enabled: false, live: true }));
      exactSamples.push(useRuntime("A"));
      return null;
    }
    render(<Tree><Probe /></Tree>);
    const ws = await driveReady();
    const store = capturedStore!;
    await act(async () => {
      void store.openSession("A").catch(() => {});
      await flush();
      const attach = lastFrame<{ type: "attach"; id: string; payload: { sessionId: string } }>(ws, "attach")!;
      ws.serverSend({ type: "snapshot", id: attach.id, payload: snapshotPayload({ sessionId: "A", epoch: "eA" }) });
      await flush();
    });
    // Commit a live user message on A.
    await serverSend(ws, { type: "event", payload: { type: "message_start", sessionId: "A", streamId: "st", messageId: "m", message: { role: "user", content: "persisted live" }, eventId: 1, epoch: "eA" } });
    await serverSend(ws, { type: "event", payload: { type: "message_end", sessionId: "A", streamId: "st", messageId: "m", message: { role: "user", content: "persisted live" }, entryId: "entry-A", eventId: 2, epoch: "eA" } });
    // Create an exact optimistic entry via the ID-bound sendPrompt.
    let pending: Promise<unknown> | null = null;
    await act(async () => {
      pending = exactSamples.at(-1)!.sendPrompt("optimistic hi");
      pending.catch((cause: unknown) => { void cause; });
      await flush();
    });
    // Transfer the lease to B → A becomes detached but its controller is retained.
    await act(async () => {
      const p = store.openSession("B").catch(() => {});
      await flush();
      const detach = lastFrame<{ type: "detach"; id: string; payload: { sessionId: string } }>(ws, "detach")!;
      expect(detach.payload.sessionId).toBe("A");
      ws.serverSend({ type: "response", id: detach.id, payload: { ok: true, result: { sessionId: "A", detached: true } } });
      await flush();
      const attachB = lastFrame<{ type: "attach"; id: string; payload: { sessionId: string } }>(ws, "attach")!;
      expect(attachB.payload.sessionId).toBe("B");
      ws.serverSend({ type: "snapshot", id: attachB.id, payload: snapshotPayload({ sessionId: "B" }) });
      await flush();
      await p;
    });
    const tA = transcripts.at(-1)!;
    const ids = tA.entries.map((entry) => entry.entryId);
    expect(ids).toContain("entry-A");
    const optimisticIds = ids.filter((id) => id.startsWith("optimistic:"));
    expect(optimisticIds).toHaveLength(1);
    // Settle the detached pending turn so teardown leaves no unhandled rejection.
    await act(async () => {
      const submit = lastFrame<{ type: "submit_turn"; id: string; payload: { operationId: string } }>(ws, "submit_turn")!;
      ws.serverSend({
        type: "submit_turn_result",
        id: submit.id,
        payload: {
          status: "accepted",
          delivery: "accepted",
          sessionId: "A",
          epoch: "eA",
          revision: 1,
          operationId: submit.payload.operationId,
          turnId: "turn-1",
          snapshot: snapshotPayload({ sessionId: "A", epoch: "eA", lastEventId: 1 }).snapshot as never,
          turnStatus: { sessionId: "A", epoch: "eA", operationId: submit.payload.operationId, turnId: "turn-1", revision: 0, state: "admitted" },
        },
      });
      await pending;
    });
  });
});

/**
 * Same-session placeholder snapshot across history → live activation.
 *
 * Activating a session moves the history query key from the read-only
 * generation 0 to a live generation; the query re-serves the generation-0
 * response as placeholderData while the anchored response loads. The WHOLE
 * response — entries, settings and contextTokens — must stay one consistent
 * snapshot (never old rows mixed with new/absent metadata) until the anchored
 * response commits.
 */
describe("useSessionTranscript — activation placeholder keeps one consistent snapshot", () => {
  let previousFetch: typeof fetch;
  /** Flush microtasks AND React Query's setTimeout(0) notification batch. */
  const settle = async (): Promise<void> => {
    for (let round = 0; round < 4; round += 1) {
      await act(async () => {
        await flush(20);
        vi.advanceTimersByTime(0);
        await flush(20);
      });
    }
  };
  beforeEach(() => { vi.useFakeTimers(); SOCKETS.length = 0; capturedStore = null; previousFetch = globalThis.fetch; });
  afterEach(() => { cleanup(); globalThis.fetch = previousFetch; vi.useRealTimers(); });

  // Module-stable probe: a component defined inside the tree would remount on
  // every parent render and lose the query observer.
  function ActivationProbe({ live, onSample }: { live: boolean; onSample: (t: SessionTranscript) => void }): null {
    onSample(useSessionTranscript({ sessionId: "s1", enabled: true, live }));
    return null;
  }

  function ActivationTree({ live, onSample }: { live: boolean; onSample: (t: SessionTranscript) => void }): ReactNode {
    const [queryClient] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false } } }));
    return (
      <QueryClientProvider client={queryClient}>
        <HttpClientProvider>
          <CapabilityProvider host={{ mode: "local", capabilities: ["agent", "sessions"] }}>
            <RuntimeProvider deps={fakeDeps()}>
              <CaptureTestRuntime onStore={(store) => { capturedStore = store; }} />
              <ActivationProbe live={live} onSample={onSample} />
            </RuntimeProvider>
          </CapabilityProvider>
        </HttpClientProvider>
      </QueryClientProvider>
    );
  }

  const jsonResponse = (context: unknown): Response =>
    new Response(JSON.stringify({ context }), { status: 200, headers: { "Content-Type": "application/json" } });

  it("serves the generation-0 entries AND metadata through the placeholder window, then the committed revision", async () => {
    const entries = Array.from({ length: 5 }, (_, index) => ({
      entryId: `s1-u${index + 1}`,
      message: { role: "user" as const, content: `row ${index + 1}` },
    }));
    const generationZero = jsonResponse({
      sessionId: "s1",
      entries,
      settings: { model: { provider: "p", modelId: "m-zero" }, thinkingLevel: "low" },
      contextTokens: 1234,
      pageInfo: { hasMore: false },
    });
    const held = new Map<string, ((response: Response) => void) | null>();
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const path = typeof input === "string" ? input : input instanceof URL ? `${input.pathname}${input.search}` : input.url;
      const match = path.match(/^\/v1\/sessions\/([^/]+)\/context/);
      if (!match) return jsonResponse({ sessionId: "s1", entries: [], pageInfo: { hasMore: false } });
      const leaf = new URLSearchParams(path.split("?")[1] ?? "").get("leafId") ?? "";
      if (held.has(leaf) && held.get(leaf) === null) {
        return await new Promise<Response>((resolve) => { held.set(leaf, resolve); });
      }
      return generationZero;
    }) as unknown as typeof fetch;

    const samples: SessionTranscript[] = [];
    const view = render(<ActivationTree live={false} onSample={(t) => { samples.push(t); }} />);
    await settle();
    const history = samples.at(-1)!;
    expect(history.entries).toHaveLength(5);
    expect(history.persistedModel).toEqual({ provider: "p", modelId: "m-zero" });
    expect(history.persistedThinkingLevel).toBe("low");
    expect(history.contextTokens).toBe(1234);

    // Attach + leaf fence → live generation with anchor L1.
    const store = capturedStore!;
    let ws: FakeWebSocket | undefined;
    await act(async () => {
      store.connect();
      ws = SOCKETS[SOCKETS.length - 1]!;
      ws.serverOpen();
      ws.serverSend({ type: "handshake_ack", payload: { protocolVersion: 2, host: { mode: "local", capabilities: ["agent"] }, limits: { maxUpload: 0, maxOpenSessions: 4 }, sessionSnapshotSupport: true } });
      await flush();
      void store.openSession("s1").catch(() => {});
      await flush();
      const attach = lastFrame<{ type: "attach"; id: string }>(ws, "attach")!;
      ws.serverSend({ type: "snapshot", id: attach.id, payload: snapshotPayload({ sessionId: "s1" }) });
      await flush();
      ws.serverSend({ type: "event", payload: { type: "session_changed", sessionId: "s1", cwd: "/x", leafId: "L1", eventId: 1, epoch: "e1" } });
      await flush();
    });

    // Activation flips the layer live; the anchored response is held pending,
    // so the served snapshot is the generation-0 placeholder — WHOLE and
    // consistent, never blank rows or mixed metadata.
    held.set("L1", null);
    view.rerender(<ActivationTree live onSample={(t) => { samples.push(t); }} />);
    await settle();
    const placeholderSample = samples.at(-1)!;
    expect(placeholderSample.entries).toHaveLength(5);
    expect(placeholderSample.persistedModel).toEqual({ provider: "p", modelId: "m-zero" });
    expect(placeholderSample.persistedThinkingLevel).toBe("low");
    expect(placeholderSample.contextTokens).toBe(1234);

    // The anchored revision commits → entries and metadata advance together.
    const resolve = held.get("L1");
    expect(resolve).toBeTruthy();
    await act(async () => {
      resolve!(jsonResponse({
        sessionId: "s1",
        entries: [...entries, { entryId: "s1-a1", parentEntryId: "s1-u5", message: { role: "assistant", content: [{ type: "text", text: "answer" }], model: "m", provider: "p" } }],
        settings: { model: { provider: "p", modelId: "m-live" }, thinkingLevel: "high" },
        contextTokens: 2345,
        pageInfo: { hasMore: false },
      }));
    });
    await settle();
    const live = samples.at(-1)!;
    expect(live.entries.map((entry) => entry.entryId)).toContain("s1-a1");
    expect(live.persistedModel).toEqual({ provider: "p", modelId: "m-live" });
    expect(live.persistedThinkingLevel).toBe("high");
    expect(live.contextTokens).toBe(2345);
  });
});
