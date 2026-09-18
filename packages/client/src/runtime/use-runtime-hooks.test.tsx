/**
 * Phase 4A.3.2a exact React hooks tests.
 *
 * Covers `useRuntimeConnection` (stable global surface), the exact
 * `useRuntime(sessionId)` hook (available/eviction/admission/stable refs/A-B
 * isolation/committed-vs-optimism/exact-vs-global separation/terminal
 * listener/StrictMode) and `SelectedSessionProvider`/`useSelectedRuntime`
 * (route-agnostic selection with NO fallback to holder/foreground).
 *
 * Driven through the deterministic FakeWebSocket provider mount (same pattern
 * as runtime-provider.test.tsx).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { StrictMode, useState, type ReactNode } from "react";
import {
  RuntimeProvider,
  useRuntime,
  useRuntimeConnection,
  useRuntimeForegroundActivity,
  useRuntimeOwners,
  useSelectedRuntime,
  SelectedSessionProvider,
} from "./runtime-provider";
import type { ExactRuntimeApi, RuntimeConnectionApi } from "./exact-runtime";
import { parseWorkspaceSearch } from "@/lib/search-params";
import { createHarness, FakeWebSocket, flush, lastFrame, snapshotPayload } from "./testing/harness";
import { CaptureTestRuntime } from "./testing/capture-test-runtime";
import type { TestRuntimeStore } from "./testing/test-runtime-store";
import type { RuntimeSocketDeps } from "./socket";

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

function mount(children: ReactNode, options?: { maxControllers?: number }): void {
  render(
    <RuntimeProvider deps={fakeDeps()} {...(options === undefined ? {} : { options })}>
      <CaptureTestRuntime onStore={(store) => { capturedStore = store; }} />
      {children}
    </RuntimeProvider>,
  );
}

function ack(caps: string[] = ["agent"]) {
  return {
    type: "handshake_ack",
    payload: {
      protocolVersion: 2,
      host: { mode: "local", capabilities: caps },
      limits: { maxUpload: 0, maxOpenSessions: 4 },
      sessionSnapshotSupport: true,
      acceptedFeatures: ["runtime.running-watch.v1", "runtime.submit-turn.v1", "runtime.read-rpc.v1", "runtime.observe-existing.v1"],
    },
  };
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

/** Drive an exact acquire on the given hook sample and settle its attach snapshot. */
async function acquireExact(ws: FakeWebSocket, sample: ExactRuntimeApi, sessionId: string, epoch = `e-${sessionId}`): Promise<void> {
  await act(async () => {
    const p = sample.acquire();
    await flush();
    // A transfer first releases the held source session (observation detach).
    if (capturedStore!.registry.leaseSnapshot.phase === "releasing") {
      const detach = lastFrame<{ type: "detach"; id: string; payload: { sessionId: string } }>(ws, "detach")!;
      ws.serverSend({ type: "response", id: detach.id, payload: { ok: true, result: { sessionId: detach.payload.sessionId, detached: true } } });
      await flush();
    }
    const attach = lastFrame<{ type: "attach"; id: string; payload: { sessionId: string } }>(ws, "attach")!;
    expect(attach.payload.sessionId).toBe(sessionId);
    ws.serverSend({ type: "snapshot", id: attach.id, payload: snapshotPayload({ sessionId, epoch }) });
    await p;
  });
}

describe("exact React hooks (4A.3.2a)", () => {
  beforeEach(() => { vi.useFakeTimers(); SOCKETS.length = 0; capturedStore = null; });
  afterEach(() => { cleanup(); vi.useRealTimers(); });

  it("useRuntimeConnection: stable connect/createSession + global fields only", async () => {
    const samples: RuntimeConnectionApi[] = [];
    function Probe(): null {
      samples.push(useRuntimeConnection());
      return null;
    }
    mount(<Probe />);
    expect(samples.at(-1)!.state).toBe("idle");
    const initial = samples.at(-1)!;
    await driveReady();
    const updated = samples.at(-1)!;
    expect(updated.state).toBe("ready");
    expect(updated.connect).toBe(initial.connect);
    expect(updated.getLiveSessionStats).toBe(initial.getLiveSessionStats);
    expect(updated.createSession).toBe(initial.createSession);
    expect(updated.host).not.toBeNull();
    expect(updated.acceptedFeatures).toContain("runtime.submit-turn.v1");
    expect(updated.runningSessionIds).toEqual([]);
    expect(updated.liveSessionIds).toEqual([]);
    expect(updated.liveSessionStateKnown).toBe(false);
    expect(typeof updated.generation).toBe("number");
    expect(updated.fatal).toBe(false);
    // No exact/lease actions on the connection surface.
    expect("openSession" in updated).toBe(false);
    expect("acquire" in updated).toBe(false);
    expect("stop" in updated).toBe(false);
    expect("detach" in updated).toBe(false);
    expect(SOCKETS).toHaveLength(1);
  });

  it("useRuntimeForegroundActivity: stable snapshot between changes; no selected/current fallback", async () => {
    const samples: ReturnType<typeof useRuntimeForegroundActivity>[] = [];
    let exact: ExactRuntimeApi | null = null;
    function Probe(): null {
      samples.push(useRuntimeForegroundActivity());
      exact = useRuntime("s1");
      return null;
    }
    mount(<Probe />);
    const initial = samples.at(-1)!;
    expect(initial).toEqual({ optimisticRunningSessionId: null });
    const ws = await driveReady();
    expect(samples.at(-1)).toBe(initial);
    expect("acquire" in initial).toBe(false);
    expect("openSession" in initial).toBe(false);
    await acquireExact(ws, exact!, "s1");
    await act(async () => {
      void exact!.sendPrompt("hi").catch(() => undefined);
      await flush();
    });
    const running = samples.at(-1)!;
    expect(running.optimisticRunningSessionId).toBe("s1");
    expect(running).not.toBe(initial);
    const again = samples.at(-1)!;
    expect(again).toBe(running);
  });

  it("useRuntime(null) returns null; zero-arg useRuntime is gone", () => {
    let exact: unknown = "unset";
    function Probe(): null {
      exact = useRuntime(null);
      return null;
    }
    mount(<Probe />);
    expect(exact).toBeNull();
    expect(useRuntime.length).toBe(1);
  });

  it("absent session: stable available:false wrapper with exact id + null authority, zero frames/LRU", async () => {
    const samples: ExactRuntimeApi[] = [];
    function Probe(): null {
      const rt = useRuntime("ghost");
      if (rt !== null) samples.push(rt);
      return null;
    }
    mount(<Probe />);
    const view = samples.at(-1)!;
    expect(view.available).toBe(false);
    expect(view.sessionId).toBe("ghost");
    expect(view.attached).toBe(false);
    expect(view.stopped).toBe(false);
    expect(view.epoch).toBeNull();
    expect(view.snapshot).toBeNull();
    expect(view.streaming).toBe(false);
    expect(view.partial).toBeNull();
    expect(view.promptPending).toBe(false);
    expect(view.attachGeneration).toBe(0);
    expect(view.liveEntries).toEqual([]);
    expect(view.optimisticEntries).toEqual([]);
    expect(view.error).toBeNull();
    expect(view.turnActive).toBe(false);
    expect(view.turnDelivery).toBeNull();
    expect(view.capabilities).toBeNull();
    expect(SOCKETS).toHaveLength(0); // mounting never connects (no socket created at all)
    expect(capturedStore!.registry.controllerCount).toBe(0);
    expect(capturedStore!.registry.getSnapshot().accessOrdinal).toBe(0);
    // Stable action refs across no-op re-renders.
    const acquireRef = view.acquire;
    const submitRef = view.submitTurn;
    await act(async () => { await flush(); });
    expect(samples.at(-1)!.acquire).toBe(acquireRef);
    expect(samples.at(-1)!.submitTurn).toBe(submitRef);
  });

  it("actions admit only on invocation: absent acquire admits + attaches and flips available:true", async () => {
    const samples: ExactRuntimeApi[] = [];
    function Probe(): null {
      const rt = useRuntime("s1");
      if (rt !== null) samples.push(rt);
      return null;
    }
    mount(<Probe />);
    const ws = await driveReady();
    expect(samples.at(-1)!.available).toBe(false);
    expect(capturedStore!.registry.controllerCount).toBe(0);
    await acquireExact(ws, samples.at(-1)!, "s1");
    expect(samples.at(-1)!.available).toBe(true);
    expect(samples.at(-1)!.attached).toBe(true);
    expect(samples.at(-1)!.epoch).toBe("e-s1");
    expect(capturedStore!.registry.controllerCount).toBe(1);
  });

  it("eviction falls back to available:false; re-admission rebinds with stable action refs", async () => {
    const samples: ExactRuntimeApi[] = [];
    function Probe(): null {
      const rt = useRuntime("A");
      if (rt !== null) samples.push(rt);
      return null;
    }
    mount(<Probe />, { maxControllers: 2 });
    const ws = await driveReady();
    await acquireExact(ws, samples.at(-1)!, "A", "eA");
    expect(samples.at(-1)!.available).toBe(true);
    const acquireRef = samples.at(-1)!.acquire;
    const submitRef = samples.at(-1)!.submitTurn;
    // Observation-only release so A becomes evictable.
    await act(async () => {
      const detachP = capturedStore!.detach();
      await flush();
      const detach = lastFrame<{ type: "detach"; id: string }>(ws, "detach")!;
      ws.serverSend({ type: "response", id: detach.id, payload: { ok: true, result: { sessionId: "A", detached: true } } });
      await detachP;
    });
    // Fill B + C to evict A (detached + quiescent + not lease-protected).
    await act(async () => {
      capturedStore!.registry.getOrCreate("B");
      capturedStore!.registry.getOrCreate("C");
      await flush();
    });
    expect(capturedStore!.registry.peek("A")).toBeNull();
    expect(samples.at(-1)!.available).toBe(false);
    expect(samples.at(-1)!.acquire).toBe(acquireRef);
    expect(samples.at(-1)!.submitTurn).toBe(submitRef);
    // Re-admission rebinds the exact controller and flips available:true.
    await acquireExact(ws, samples.at(-1)!, "A", "eA");
    expect(samples.at(-1)!.available).toBe(true);
    expect(samples.at(-1)!.attached).toBe(true);
    expect(samples.at(-1)!.acquire).toBe(acquireRef);
    expect(samples.at(-1)!.submitTurn).toBe(submitRef);
  });

  it("simultaneous exact A/B hooks stay isolated", async () => {
    const aSamples: ExactRuntimeApi[] = [];
    const bSamples: ExactRuntimeApi[] = [];
    function Probe(): null {
      const a = useRuntime("A");
      const b = useRuntime("B");
      if (a !== null) aSamples.push(a);
      if (b !== null) bSamples.push(b);
      return null;
    }
    mount(<Probe />);
    const ws = await driveReady();
    await acquireExact(ws, aSamples.at(-1)!, "A", "eA");
    expect(bSamples.at(-1)!.available).toBe(false);
    await acquireExact(ws, bSamples.at(-1)!, "B", "eB");
    expect(aSamples.at(-1)!.attached).toBe(false);
    expect(aSamples.at(-1)!.epoch).toBe("eA");
    expect(bSamples.at(-1)!.attached).toBe(true);
    expect(bSamples.at(-1)!.epoch).toBe("eB");
    // Drive a live entry on B only → B updates, A (detached) stays untouched.
    await act(async () => {
      ws.serverSend({ type: "event", payload: { type: "message_start", sessionId: "B", epoch: "eB", eventId: 1, streamId: "s", messageId: "m", message: { role: "user", content: "B only" } } });
      ws.serverSend({ type: "event", payload: { type: "message_end", sessionId: "B", epoch: "eB", eventId: 2, streamId: "s", messageId: "m", entryId: "entry-B", message: { role: "user", content: "B only" } } });
      await flush();
    });
    expect(bSamples.at(-1)!.liveEntries.some((e) => (e.message as { content?: string }).content === "B only")).toBe(true);
    expect(aSamples.at(-1)!.liveEntries.some((e) => (e.message as { content?: string }).content === "B only")).toBe(false);
  });

  it("exact view separates committed liveEntries from optimisticEntries; the facade keeps the merged tail", async () => {
    const samples: ExactRuntimeApi[] = [];
    function Probe(): null {
      const rt = useRuntime("s1");
      if (rt !== null) samples.push(rt);
      return null;
    }
    mount(<Probe />);
    const ws = await driveReady();
    await acquireExact(ws, samples.at(-1)!, "s1", "e1");
    let pending: Promise<unknown> | null = null;
    await act(async () => {
      pending = samples.at(-1)!.sendPrompt("hi");
      pending.catch((e: unknown) => { void e; });
      await flush();
    });
    const exact = samples.at(-1)!;
    expect(exact.liveEntries.some((e) => (e.message as { content?: string }).content === "hi")).toBe(false);
    expect(exact.optimisticEntries.some((c) => (c.entry.message as { content?: string }).content === "hi")).toBe(true);
    expect(capturedStore!.getSnapshot().liveEntries.some((e) => (e.message as { content?: string }).content === "hi")).toBe(true);
    // Settle the pending turn so teardown leaves no unhandled rejection.
    await act(async () => {
      const submit = lastFrame<{ type: "submit_turn"; id: string; payload: { operationId: string } }>(ws, "submit_turn")!;
      const op = submit.payload.operationId;
      ws.serverSend({
        type: "submit_turn_result",
        id: submit.id,
        payload: {
          status: "accepted", delivery: "accepted", sessionId: "s1", epoch: "e1", revision: 1, operationId: op, turnId: "turn-1",
          snapshot: snapshotPayload({ sessionId: "s1", epoch: "e1", lastEventId: 1 }).snapshot as never,
          turnStatus: { sessionId: "s1", epoch: "e1", operationId: op, turnId: "turn-1", revision: 0, state: "admitted" },
        },
      });
      await pending;
    });
  });

  it("exact view has no global host/running/fatal/optimisticRunningSessionId; connection hook has them", async () => {
    let exact: ExactRuntimeApi | null = null;
    let conn: RuntimeConnectionApi | null = null;
    function Probe(): null {
      exact = useRuntime("s1");
      conn = useRuntimeConnection();
      return null;
    }
    mount(<Probe />);
    const ws = await driveReady();
    await acquireExact(ws, exact!, "s1");
    const e = exact!;
    expect("host" in e).toBe(false);
    expect("runningSessionIds" in e).toBe(false);
    expect("liveSessionIds" in e).toBe(false);
    expect("liveSessionStateKnown" in e).toBe(false);
    expect("fatal" in e).toBe(false);
    expect("optimisticRunningSessionId" in e).toBe(false);
    expect("connection" in e).toBe(false);
    const c = conn!;
    expect("host" in c).toBe(true);
    expect("runningSessionIds" in c).toBe(true);
    expect("liveSessionIds" in c).toBe(true);
    expect("fatal" in c).toBe(true);
    expect("attached" in c).toBe(false);
  });

  it("all-protected exact admission fails session_busy retryable BEFORE any wire side effect", async () => {
    let aExact: ExactRuntimeApi | null = null;
    let bExact: ExactRuntimeApi | null = null;
    function Probe(): null {
      aExact = useRuntime("A");
      bExact = useRuntime("B");
      return null;
    }
    mount(<Probe />, { maxControllers: 1 });
    const ws = await driveReady();
    await acquireExact(ws, aExact!, "A", "eA");
    const before = ws.sent.length;
    let err: unknown = null;
    await act(async () => {
      bExact!.acquire().catch((e: unknown) => { err = e; });
      await flush();
    });
    expect(err).toMatchObject({ code: "session_busy", retryable: true });
    expect(ws.sent).toHaveLength(before);
    expect(bExact!.available).toBe(false);
  });

  it("subscribeTurnTerminal works before and after admission and is exact-session filtered", async () => {
    let exact: ExactRuntimeApi | null = null;
    function Probe(): null {
      exact = useRuntime("s1");
      return null;
    }
    mount(<Probe />);
    const ws = await driveReady();
    let terminals: string[] = [];
    let unsub: (() => void) | null = null;
    await act(async () => {
      // Before admission: registry-level subscription, no admission.
      unsub = exact!.subscribeTurnTerminal((info: { sessionId: string }) => terminals.push(info.sessionId));
    });
    expect(capturedStore!.registry.controllerCount).toBe(0);
    await acquireExact(ws, exact!, "s1", "e1");
    // Full accepted turn + terminal completion.
    await act(async () => {
      const turnP = exact!.submitTurn({ prompt: "hello" });
      turnP.catch(() => undefined);
      await flush();
      const submit = lastFrame<{ type: "submit_turn"; id: string; payload: { operationId: string } }>(ws, "submit_turn")!;
      const op = submit.payload.operationId;
      ws.serverSend({
        type: "submit_turn_result",
        id: submit.id,
        payload: {
          status: "accepted", delivery: "accepted", sessionId: "s1", epoch: "e1", revision: 1, operationId: op, turnId: "turn-1",
          snapshot: snapshotPayload({ sessionId: "s1", epoch: "e1", lastEventId: 1 }).snapshot as never,
          turnStatus: { sessionId: "s1", epoch: "e1", operationId: op, turnId: "turn-1", revision: 0, state: "admitted" },
        },
      });
      ws.serverSend({ type: "turn_status", payload: { sessionId: "s1", epoch: "e1", operationId: op, turnId: "turn-1", revision: 1, state: "completed" } });
      await flush();
    });
    expect(terminals).toEqual(["s1"]);
    unsub!();
  });

  it("StrictMode remount keeps the sole owner usable (F1): registry NOT disposed, connect + exact actions work, exactly one socket", async () => {
    const samples: ExactRuntimeApi[] = [];
    function Probe(): null {
      const rt = useRuntime("s1");
      if (rt !== null) samples.push(rt);
      return null;
    }
    render(
      <StrictMode>
        <RuntimeProvider deps={fakeDeps()}>
          <CaptureTestRuntime onStore={(store) => { capturedStore = store; }} />
          <Probe />
        </RuntimeProvider>
      </StrictMode>,
    );
    // StrictMode simulated cleanup+setup must NOT dispose the sole owner.
    const store = capturedStore!;
    await act(async () => {
      store.registry.getOrCreate("s1");
      await flush();
    });
    expect(store.registry.controllerCount).toBe(1);
    expect(samples.at(-1)!.available).toBe(true);
    // Connect: exactly ONE socket after the effect replay.
    let ws: FakeWebSocket | undefined;
    await act(async () => {
      store.connect();
      ws = SOCKETS[SOCKETS.length - 1]!;
      ws.serverOpen();
      ws.serverSend(ack());
      await flush();
    });
    expect(SOCKETS).toHaveLength(1);
    // Registry-backed exact action still works after StrictMode replay.
    await acquireExact(ws!, samples.at(-1)!, "s1", "e1");
    expect(samples.at(-1)!.attached).toBe(true);
    expect(samples.at(-1)!.epoch).toBe("e1");
    expect(store.registry.controllerCount).toBe(1);
  });

  it("real unmount + microtask flush disposes registry/connection exactly once with no stop frame/orphan (F1)", async () => {
    let owners: { connection: import("./runtime-connection").RuntimeConnection; registry: import("./session-controller-registry").SessionControllerRegistry } | null = null;
    function Probe(): null {
      owners = useRuntimeOwners();
      return null;
    }
    const utils = render(
      <RuntimeProvider deps={fakeDeps()}>
        <Probe />
      </RuntimeProvider>,
    );
    await act(async () => {
      owners!.connection.connect();
      SOCKETS[SOCKETS.length - 1]!.serverOpen();
      await flush();
    });
    const ws = SOCKETS[SOCKETS.length - 1]!;
    expect(ws.readyState).toBe(1); // OPEN
    // Real unmount defers disposal to a microtask (StrictMode-safe).
    utils.unmount();
    await flush();
    expect(ws.wasClosedByClient).toBe(true); // the one socket closed
    expect(owners!.registry.controllerCount).toBe(0); // controllers evicted once
    expect(owners!.registry.getSnapshot().createReserved).toBe(false);
    expect(owners!.connection.connectionState).toBe("stopped");
    expect(ws.sent.filter((frame) => (frame as { type?: string }).type === "stop")).toHaveLength(0);
    expect(ws.sent.filter((frame) => (frame as { type?: string }).type === "detach")).toHaveLength(0);
    // Adapter cleanup already ran once; a second explicit dispose is a no-op.
    expect(owners!.registry.controllerCount).toBe(0);
  });

  it("provider owner is intentionally immutable across prop changes: no rebuild, no double-dispose, still usable (F1)", async () => {
    const owners: ReturnType<typeof useRuntimeOwners>[] = [];
    function Probe(): null {
      owners.push(useRuntimeOwners());
      return null;
    }
    const utils = render(
      <RuntimeProvider deps={fakeDeps()}>
        <Probe />
      </RuntimeProvider>,
    );
    const first = owners.at(-1)!;
    const connRef = first.connection;
    const regRef = first.registry;
    // Rerender with different deps/options: the owner is INTENTIONALLY
    // immutable (useState initializer) — identity must NOT change.
    utils.rerender(
      <RuntimeProvider deps={fakeDeps()} options={{ maxControllers: 5 }}>
        <Probe />
      </RuntimeProvider>,
    );
    expect(owners.at(-1)!.connection).toBe(connRef);
    expect(owners.at(-1)!.registry).toBe(regRef);
    // Still usable after the rerender.
    expect(() => owners.at(-1)!.registry.getOrCreate("s1")).not.toThrow();
    // Real unmount disposes the old owner exactly once.
    utils.unmount();
    await flush();
    expect(regRef.controllerCount).toBe(0);
    expect(connRef.connectionState).toBe("stopped");
  });
});

describe("SelectedSessionProvider / useSelectedRuntime (4A.3.2a)", () => {
  beforeEach(() => { vi.useFakeTimers(); SOCKETS.length = 0; capturedStore = null; });
  afterEach(() => { cleanup(); vi.useRealTimers(); });

  it("returns the exact runtime for the provided selection and null for null (never holder/foreground fallback)", async () => {
    const samples: (ExactRuntimeApi | null)[] = [];
    function SelectedProbe(): null {
      samples.push(useSelectedRuntime());
      return null;
    }
    function SelectedHarness(): ReactNode {
      const [selected, setSelected] = useState<string | null>(null);
      return (
        <SelectedSessionProvider sessionId={selected}>
          <SelectedProbe />
          <button type="button" onClick={() => setSelected("A")}>selectA</button>
          <button type="button" onClick={() => setSelected("B")}>selectB</button>
          <button type="button" onClick={() => setSelected(null)}>clear</button>
        </SelectedSessionProvider>
      );
    }
    mount(<SelectedHarness />);
    // null selection → null exact runtime (no fallback to attached/foreground).
    expect(samples.at(-1)).toBeNull();
    const ws = await driveReady();
    // Attach a foreground session via the store; selection is still null.
    await act(async () => {
      const p = capturedStore!.openSession("holder");
      await flush();
      const attach = lastFrame<{ type: "attach"; id: string }>(ws, "attach")!;
      ws.serverSend({ type: "snapshot", id: attach.id, payload: snapshotPayload({ sessionId: "holder" }) });
      await p;
    });
    expect(samples.at(-1)).toBeNull();
    // Select "A" → exact runtime for A (available:false until admitted).
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "selectA" })); await flush(); });
    expect(samples.at(-1)!.sessionId).toBe("A");
    expect(samples.at(-1)!.available).toBe(false);
    // A/B switching.
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "selectB" })); await flush(); });
    expect(samples.at(-1)!.sessionId).toBe("B");
    expect(samples.at(-1)!.available).toBe(false);
    // Clear → null again.
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "clear" })); await flush(); });
    expect(samples.at(-1)).toBeNull();
  });

  it("maps the validated router search to selection (session → id; home/file → null) with ZERO frames/admission/lease", async () => {
    // Mirrors the 4A.3.2b1a router boundary exactly: the search is validated
    // (parseWorkspaceSearch — a file selector drops a present session) and then
    // `validated.session ?? null` selects the sessionId; home/file/new (no
    // session selector) select null. Selecting must never attach/admit/lease.
    const samples: (ExactRuntimeApi | null)[] = [];
    function MapHarness(): ReactNode {
      const [search, setSearch] = useState<Record<string, unknown>>({});
      const validated = parseWorkspaceSearch(search);
      return (
        <SelectedSessionProvider sessionId={validated.session ?? null}>
          <Probe push={(v) => samples.push(v)} />
          <button type="button" onClick={() => setSearch({ session: "A" })}>selectA</button>
          <button type="button" onClick={() => setSearch({ session: "B" })}>selectB</button>
          <button type="button" onClick={() => setSearch({ cwd: "/x" })}>home</button>
          <button type="button" onClick={() => setSearch({ cwd: "/x", file: "/x/f.ts", session: "A" })}>file</button>
        </SelectedSessionProvider>
      );
    }
    function Probe({ push }: { push: (v: ExactRuntimeApi | null) => void }): null {
      push(useSelectedRuntime());
      return null;
    }
    mount(<MapHarness />);
    const ws = await driveReady();
    const framesOf = (type: string): number => (ws.sent as Array<{ type: string }>).filter((f) => f.type === type).length;
    const baselineAttach = framesOf("attach");
    // home → null selection.
    expect(samples.at(-1)).toBeNull();
    // session A → selects A.
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "selectA" })); await flush(); });
    expect(samples.at(-1)!.sessionId).toBe("A");
    // session B → selects B.
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "selectB" })); await flush(); });
    expect(samples.at(-1)!.sessionId).toBe("B");
    // file wins over session (validated search drops session) → null.
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "file" })); await flush(); });
    expect(samples.at(-1)).toBeNull();
    // home again → null.
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "home" })); await flush(); });
    expect(samples.at(-1)).toBeNull();
    // Selection wiring produces NO frames (no attach beyond the ready baseline,
    // no command, no create, no detach, no stop) and NO admission/lease.
    expect(framesOf("attach")).toBe(baselineAttach);
    expect(framesOf("command")).toBe(0);
    expect(framesOf("create")).toBe(0);
    expect(framesOf("detach")).toBe(0);
    expect(framesOf("stop")).toBe(0);
    expect(capturedStore!.registry.peek("A")).toBeNull();
    expect(capturedStore!.registry.peek("B")).toBeNull();
    expect(capturedStore!.registry.leaseSnapshot).toMatchObject({ phase: "vacant" });
  });
});

describe("ownership invariant (4A.3.2a)", () => {
  beforeEach(() => { vi.useFakeTimers(); SOCKETS.length = 0; capturedStore = null; });
  afterEach(() => { cleanup(); vi.useRealTimers(); });

  it("provider owns exactly ONE connection + registry; hooks share those SAME owners", async () => {
    const owners: ReturnType<typeof useRuntimeOwners>[] = [];
    function Probe(): null {
      owners.push(useRuntimeOwners());
      return null;
    }
    mount(<Probe />);
    const first = owners.at(-1)!;
    expect(capturedStore!.registry).toBe(first.registry);
    const connRef = first.connection;
    const regRef = first.registry;
    await driveReady();
    expect(owners.at(-1)!.connection).toBe(connRef);
    expect(owners.at(-1)!.registry).toBe(regRef);
    expect(SOCKETS).toHaveLength(1);
  });

  it("adapter cleanup only unsubscribes (no close/stop); registry.dispose closes the one socket exactly once, never stop", async () => {
    const h = createHarness();
    h.store.connect();
    const ws = h.lastSocket();
    ws.serverOpen();
    ws.serverSend({
      type: "handshake_ack",
      payload: { protocolVersion: 2, host: { mode: "local", capabilities: ["agent"] }, limits: { maxUpload: 0, maxOpenSessions: 4 }, sessionSnapshotSupport: true },
    });
    const p = h.store.openSession("s1");
    await flush();
    const attach = lastFrame<{ type: "attach"; id: string }>(ws, "attach")!;
    ws.serverSend({ type: "snapshot", id: attach.id, payload: snapshotPayload({ sessionId: "s1" }) });
    await p;
    expect(h.registry.controllerCount).toBe(1);
    // Adapter cleanup: unsubscribes only — the socket stays OPEN, controllers
    // are NOT disposed, no stop frame.
    h.store.dispose();
    expect(ws.readyState).toBe(1); // still OPEN (wasClosedByClient false)
    expect(ws.wasClosedByClient).toBe(false);
    expect(h.registry.controllerCount).toBe(1);
    expect(lastFrame(ws, "stop")).toBeUndefined();
    // The owner disposes the registry EXACTLY once: controllers evicted + the
    // one socket closed, never a runtime.stop frame.
    h.registry.dispose();
    expect(h.registry.controllerCount).toBe(0);
    expect(ws.wasClosedByClient).toBe(true);
    expect(lastFrame(ws, "stop")).toBeUndefined();
    // Double dispose is a no-op (exactly once).
    h.registry.dispose();
    expect(ws.wasClosedByClient).toBe(true);
  });
});

describe("exact stop via the hook routes through the registry lease (F2)", () => {
  beforeEach(() => { vi.useFakeTimers(); SOCKETS.length = 0; capturedStore = null; });
  afterEach(() => { cleanup(); vi.useRealTimers(); });

  it("confirmed stop (stopped:true) clears the exact attachment lease and marks stopped", async () => {
    const samples: ExactRuntimeApi[] = [];
    function Probe(): null {
      const rt = useRuntime("A");
      if (rt !== null) samples.push(rt);
      return null;
    }
    mount(<Probe />);
    const ws = await driveReady();
    await acquireExact(ws, samples.at(-1)!, "A", "eA");
    expect(capturedStore!.registry.leaseSnapshot.holderSessionId).toBe("A");
    await act(async () => {
      const p = samples.at(-1)!.stop();
      await flush();
      const stopFrame = lastFrame<{ type: "stop"; id: string }>(ws, "stop")!;
      ws.serverSend({ type: "response", id: stopFrame.id, payload: { ok: true, result: { sessionId: "A", stopped: true } } });
      await p;
    });
    expect(samples.at(-1)!.stopped).toBe(true);
    // The exact lease was cleared by registry.stop (same strict semantics as the facade).
    expect(capturedStore!.registry.leaseSnapshot.phase).toBe("vacant");
    expect(capturedStore!.registry.leaseSnapshot.holderSessionId).toBeNull();
    expect(ws.sent.filter((frame) => (frame as { type?: string }).type === "stop")).toHaveLength(1);
  });

  it("unconfirmed stop (stopped:false) leaves the lease held and the stop pending (never clears)", async () => {
    const samples: ExactRuntimeApi[] = [];
    function Probe(): null {
      const rt = useRuntime("A");
      if (rt !== null) samples.push(rt);
      return null;
    }
    mount(<Probe />);
    const ws = await driveReady();
    await acquireExact(ws, samples.at(-1)!, "A", "eA");
    let settled = false;
    let stopP: Promise<void> | null = null;
    await act(async () => {
      stopP = samples.at(-1)!.stop();
      stopP.then(() => { settled = true; }, () => { settled = true; });
      await flush();
      const stopFrame = lastFrame<{ type: "stop"; id: string }>(ws, "stop")!;
      // A `stopped:false` result does NOT match the stop attempt (strict matcher),
      // so the stop stays pending and the lease is retained.
      ws.serverSend({ type: "response", id: stopFrame.id, payload: { ok: true, result: { sessionId: "A", stopped: false } } });
      await flush();
    });
    expect(settled).toBe(false);
    expect(capturedStore!.registry.leaseSnapshot.holderSessionId).toBe("A");
    expect(samples.at(-1)!.stopped).toBe(false);
    // Confirm the stop to settle cleanly (no unhandled rejection on teardown).
    await act(async () => {
      const stopFrame = lastFrame<{ type: "stop"; id: string }>(ws, "stop")!;
      ws.serverSend({ type: "response", id: stopFrame.id, payload: { ok: true, result: { sessionId: "A", stopped: true } } });
      await stopP;
    });
    expect(settled).toBe(true);
    expect(samples.at(-1)!.stopped).toBe(true);
  });

  it("absent exact stop is a no-op (never admits a controller) and never touches another holder", async () => {
    const samples: ExactRuntimeApi[] = [];
    function Probe(): null {
      const rt = useRuntime("ghost");
      if (rt !== null) samples.push(rt);
      return null;
    }
    mount(<Probe />);
    const ws = await driveReady();
    expect(samples.at(-1)!.available).toBe(false);
    expect(capturedStore!.registry.controllerCount).toBe(0);
    await act(async () => {
      await samples.at(-1)!.stop();
      await flush();
    });
    // No admission, no stop frame, no holder disturbed (the handshake frame is
    // expected — the socket was opened by driveReady).
    expect(capturedStore!.registry.controllerCount).toBe(0);
    expect(ws.sent.filter((frame) => (frame as { type?: string }).type === "stop")).toHaveLength(0);
    expect(ws.sent.filter((frame) => (frame as { type?: string }).type === "attach")).toHaveLength(0);
    expect(capturedStore!.registry.leaseSnapshot.phase).toBe("vacant");
  });
});
