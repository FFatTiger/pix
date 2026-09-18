/**
 * Deterministic test harness for the client runtime.
 *
 * Provides a FakeWebSocket (server-controllable), injected clock/timers/random
 * and online/visibility hooks so the RuntimeConnection + registry can be driven
 * without real IO. Tests use vitest fake timers (`vi.useFakeTimers`) so the
 * injected `setTimeout`/`Date.now` are the faked globals; `random` is a plain
 * function for deterministic jitter.
 */
import { TestRuntimeStore, buildRegistryOptions, type TestStoreOptions } from "./test-runtime-store.js";
import { RuntimeConnection, type RuntimeConnectionOptions } from "../runtime-connection.js";
import { SessionControllerRegistry } from "../session-controller-registry.js";
import type { SessionController } from "../session-controller.js";
import type { RuntimeSocketDeps } from "../socket.js";
import type { ClientIdentity } from "@fffattiger/pix-protocol";

const CONNECTING = 0;
const OPEN = 1;
const CLOSED = 3;

/** Minimal ManagedWebSocket that the test drives from the "server" side. */
export class FakeWebSocket {
  readonly url: string;
  readyState: number = CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((data: string) => void) | null = null;
  onclose: ((info: { code: number; reason: string; wasClean: boolean }) => void) | null = null;
  onerror: (() => void) | null = null;
  /** Frames sent by the client (parsed). */
  readonly sent: unknown[] = [];
  private closedByClient = false;

  constructor(url: string) {
    this.url = url;
  }

  send(data: string): void {
    if (this.readyState !== OPEN) throw new Error("FakeWebSocket send while not open");
    this.sent.push(JSON.parse(data));
  }

  close(code?: number, reason?: string): void {
    if (this.readyState === CLOSED) return;
    this.closedByClient = true;
    this.readyState = CLOSED;
    this.onclose?.({ code: code ?? 1000, reason: reason ?? "", wasClean: true });
  }

  // --- server-side test API ---
  serverOpen(): void {
    this.readyState = OPEN;
    this.onopen?.();
  }

  serverSend(message: unknown): void {
    this.onmessage?.(JSON.stringify(message));
  }

  serverClose(code = 1006, reason = ""): void {
    if (this.readyState === CLOSED) return;
    this.readyState = CLOSED;
    this.onclose?.({ code, reason, wasClean: false });
  }

  get wasClosedByClient(): boolean { return this.closedByClient; }
}

export interface HarnessOptions {
  readonly href?: string;
  readonly identity?: ClientIdentity;
  readonly random?: () => number;
  readonly features?: readonly string[];
  readonly id?: () => string;
  readonly storeOptions?: TestStoreOptions;
  readonly connectionOptions?: RuntimeConnectionOptions;
  /** If true, createWebSocket throws once before succeeding (transient). */
  readonly failFirstConnect?: boolean;
}

export interface RuntimeHarness {
  readonly connection: RuntimeConnection;
  readonly registry: SessionControllerRegistry;
  /** TEST-ONLY relocated compatibility driver (see test-runtime-store.ts). */
  readonly store: TestRuntimeStore;
  readonly sockets: FakeWebSocket[];
  readonly onlineListeners: Set<() => void>;
  readonly visibleListeners: Set<() => void>;
  /** Explicit owner cleanup: disposes the registry exactly once (closes the one socket). */
  dispose(): void;
  goOnline(): void;
  goVisible(): void;
  lastSocket(): FakeWebSocket;
  controller(sessionId: string): SessionController | null;
}

export function createHarness(options: HarnessOptions = {}): RuntimeHarness {
  const sockets: FakeWebSocket[] = [];
  const onlineListeners = new Set<() => void>();
  const visibleListeners = new Set<() => void>();
  let firstAttempt = true;
  const deps: RuntimeSocketDeps = {
    createWebSocket: (url) => {
      if (options.failFirstConnect && firstAttempt) {
        firstAttempt = false;
        throw new Error("transient connect failure");
      }
      const ws = new FakeWebSocket(url);
      sockets.push(ws);
      return ws;
    },
    now: () => Date.now(),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    random: options.random ?? (() => 0.5),
    location: { href: options.href ?? "https://pix.local/app/" },
    identity: options.identity ?? { shell: "web", platform: "mac" },
    onOnline: (cb) => {
      onlineListeners.add(cb);
      return () => { onlineListeners.delete(cb); };
    },
    onVisible: (cb) => {
      visibleListeners.add(cb);
      return () => { visibleListeners.delete(cb); };
    },
    ...(options.features === undefined ? {} : { features: options.features }),
  };
  const connection = new RuntimeConnection(deps, {
    ...(options.id === undefined ? {} : { id: options.id }),
    ...(options.storeOptions?.setTimeout === undefined ? {} : { setTimeout: options.storeOptions.setTimeout }),
    ...(options.storeOptions?.clearTimeout === undefined ? {} : { clearTimeout: options.storeOptions.clearTimeout }),
    ...(options.connectionOptions ?? {}),
  });
  // The harness explicitly owns the registry: it constructs it once with the
  // same options the facade previously derived and disposes it exactly once
  // via harness.dispose(). The TestRuntimeStore is a NON-OWNING test driver
  // and never disposes the registry/socket/controllers.
  const mergedStoreOptions: TestStoreOptions = { ...(options.id === undefined ? {} : { id: options.id }), ...(options.storeOptions ?? {}) };
  const registry = new SessionControllerRegistry(connection, buildRegistryOptions(mergedStoreOptions));
  const store = new TestRuntimeStore(connection, registry, mergedStoreOptions);
  return {
    connection,
    registry,
    store,
    sockets,
    onlineListeners,
    visibleListeners,
    dispose: () => registry.dispose(),
    goOnline: () => { for (const cb of onlineListeners) cb(); },
    goVisible: () => { for (const cb of visibleListeners) cb(); },
    lastSocket: () => sockets[sockets.length - 1]!,
    controller: (sessionId) => registry.lookup(sessionId),
  };
}

/** Find the most recent client-sent frame of a given WS message type. */
export function lastFrame<T extends { type: string }>(ws: FakeWebSocket, type: T["type"]): T | undefined {
  for (let i = ws.sent.length - 1; i >= 0; i -= 1) {
    const frame = ws.sent[i] as T;
    if (frame.type === type) return frame;
  }
  return undefined;
}

/** Flush a few rounds of promise microtasks (store promise chains). */
export async function flush(rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i += 1) await Promise.resolve();
}

/** A valid initial attach snapshot payload builder. */
export function snapshotPayload(overrides: Partial<{
  sessionId: string;
  epoch: string;
  lastEventId: number;
  cwd: string;
  projectRoot: string;
  workerStatus: string;
  resumeStatus: string;
  capabilities: string[];
  thinkingLevel?: string;
  thinkingLevelPinned?: boolean;
  model?: { provider: string; id: string } | null;
  autoRetryEnabled?: boolean;
  queuedMessages?: { steering: { message: string; images?: { type: "image"; data: string; mimeType: "image/png" }[] }[]; followUp: { message: string; images?: { type: "image"; data: string; mimeType: "image/png" }[] }[] };
  tools?: { name: string; description?: string; active: boolean }[];
  /**
   * Context-usage consistency: the live projection owns context usage — tests
   * seed it exactly where production gets it (worker snapshot state / the
   * atomic runtime_state_changed payload), never via a stats read.
   */
  contextUsage?: { percent: number; contextWindow?: number; tokens?: number } | null;
}> = {}): {
  sessionId: string; cwd: string; projectRoot: string; epoch: string; lastEventId: number; workerStatus: string; snapshot: unknown; resumeStatus: string;
} {
  const sessionId = overrides.sessionId ?? "s1";
  return {
    sessionId,
    cwd: overrides.cwd ?? "/x",
    projectRoot: overrides.projectRoot ?? "/x",
    epoch: overrides.epoch ?? "e1",
    lastEventId: overrides.lastEventId ?? 0,
    workerStatus: overrides.workerStatus ?? "ready",
    resumeStatus: overrides.resumeStatus ?? "snapshot",
    snapshot: {
      sessionId,
      cwd: overrides.cwd ?? "/x",
      projectRoot: overrides.projectRoot ?? "/x",
      state: {
        sessionId,
        isStreaming: false,
        isPromptRunning: false,
        isBashRunning: false,
        isCompacting: false,
        model: overrides.model === undefined ? null : overrides.model,
        messageCount: overrides.lastEventId ?? 0,
        ...(overrides.thinkingLevel === undefined ? {} : { thinkingLevel: overrides.thinkingLevel }),
        ...(overrides.thinkingLevelPinned === undefined ? {} : { thinkingLevelPinned: overrides.thinkingLevelPinned }),
        ...(overrides.autoRetryEnabled === undefined ? {} : { autoRetryEnabled: overrides.autoRetryEnabled }),
        ...(overrides.queuedMessages === undefined ? {} : { queuedMessages: overrides.queuedMessages }),
        ...(overrides.tools === undefined ? {} : { tools: overrides.tools }),
        ...(overrides.contextUsage === undefined ? {} : { contextUsage: overrides.contextUsage }),
      },
      capabilities: { capabilities: overrides.capabilities ?? ["runtime.prompt", "runtime.abort"], version: 1 },
      streaming: { active: false, phase: "idle" },
    },
  };
}
