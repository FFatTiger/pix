/**
 * File watch transport for the existing GET /v1/files/watch?path= SSE route.
 *
 * Client boundaries intentionally forbid direct browser SSE constructors, so
 * this API-layer adapter consumes the same-origin event stream with fetch and
 * models it as a **WatchSession**: explicit connection state, bounded
 * reconnect/backoff, and an authoritative `resync` signal after every
 * (re)connect. Consumers listen to `change` for incremental events and to
 * `resync` to refetch content/diff — closing the gap left by events that
 * dropped while the stream was down. Failures surface as typed states on the
 * session (`state` + `lastError`), never as scattered toasts.
 */

/** Explicit connection lifecycle surfaced to consumers. */
export type WatchConnectionState =
  | "idle"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "closed";

/** Minimal MessageEvent-like shape consumed by file viewers. */
export interface WatchChangeEvent {
  readonly data?: string;
}

/**
 * Bounded reconnect schedule (ms). The budget persists across connect/drop
 * flaps and advances through this list; once the final delay has been used
 * and the stream drops again, the session closes with its last error surfaced.
 * The budget only resets on objective stability — a received change event or
 * the stable-duration window elapsing — so a server that repeatedly connects
 * then immediately ends cannot reconnect forever at delay[0].
 */
export const WATCH_RECONNECT_DELAYS_MS: readonly number[] = [500, 1000, 2000, 4000, 8000];

/**
 * Stable-duration window. A connection that stays up for this long without
 * dropping is considered healthy and its reconnect budget resets, so a
 * genuinely stable connection that drops later starts a fresh outage instead
 * of carrying old flap debt.
 */
export const WATCH_STABLE_MS = 30_000;

/** Watch source surface consumed by file viewers. */
export interface WatchSession {
  /** Current explicit connection state. */
  readonly state: WatchConnectionState;
  /** Last stream/connect failure; undefined while healthy. */
  readonly lastError: string | undefined;
  /** Register a listener. Returns an unsubscribe function. */
  addEventListener(type: "change", listener: (event: WatchChangeEvent) => void): () => void;
  addEventListener(type: "resync", listener: () => void): () => void;
  addEventListener(type: "state", listener: (state: WatchConnectionState) => void): () => void;
  /** Tear down the stream, pending reconnect, and all listeners. */
  close(): void;
}

/** URL → watch session factory, injectable for deterministic tests. */
export type WatchSessionFactory = (url: string) => WatchSession;

function parseEventBlock(block: string): { event: string; data: string } | null {
  let event = "message";
  const data: string[] = [];
  for (const line of block.split("\n")) {
    if (line.startsWith(":")) continue;
    const separator = line.indexOf(":");
    const field = separator < 0 ? line : line.slice(0, separator);
    const value = separator < 0 ? "" : line.slice(separator + 1).replace(/^ /, "");
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
  }
  return data.length > 0 ? { event, data: data.join("\n") } : null;
}

type ListenerMap = {
  change: Set<(event: WatchChangeEvent) => void>;
  resync: Set<() => void>;
  state: Set<(state: WatchConnectionState) => void>;
};

function createFetchWatchSession(url: string): WatchSession {
  const listeners: ListenerMap = { change: new Set(), resync: new Set(), state: new Set() };
  let state: WatchConnectionState = "idle";
  let lastError: string | undefined;
  // Persisted across connect/drop flaps. NOT reset on a successful connect:
  // that would let a server that connects then immediately ends reconnect
  // forever at delay[0]. Reset only on objective stability (a received change
  // event or the stable-duration window elapsing).
  let reconnectBudget = 0;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let stabilityTimer: ReturnType<typeof setTimeout> | null = null;
  let controller: AbortController | null = null;
  let closed = false;

  const setState = (next: WatchConnectionState, error?: string) => {
    state = next;
    if (error !== undefined) lastError = error;
    for (const listener of listeners.state) listener(next);
  };

  const clearRetry = () => {
    if (retryTimer !== null) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
  };

  const clearStabilityTimer = () => {
    if (stabilityTimer !== null) {
      clearTimeout(stabilityTimer);
      stabilityTimer = null;
    }
  };

  // Once the stream has stayed up for the stable window without dropping, the
  // connection is objectively healthy and the reconnect budget resets.
  const armStabilityTimer = () => {
    clearStabilityTimer();
    stabilityTimer = setTimeout(() => {
      stabilityTimer = null;
      reconnectBudget = 0;
    }, WATCH_STABLE_MS);
  };

  const scheduleReconnect = (error: string) => {
    if (closed) return;
    // Bounded: once every delay has been spent across flaps and the stream
    // drops again, the session gives up and closes with the error surfaced.
    if (reconnectBudget >= WATCH_RECONNECT_DELAYS_MS.length) {
      setState("closed", error);
      return;
    }
    const delay = WATCH_RECONNECT_DELAYS_MS[reconnectBudget]!;
    reconnectBudget += 1;
    setState("reconnecting", error);
    clearRetry();
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void runStream();
    }, delay);
  };

  async function runStream(): Promise<void> {
    if (closed) return;
    controller = new AbortController();
    setState("connecting");
    try {
      const response = await fetch(url, {
        headers: { Accept: "text/event-stream" },
        signal: controller.signal,
      });
      if (!response.ok || !response.body) {
        throw new Error(`Watch stream failed (HTTP ${response.status})`);
      }
      if (closed) return;

      // (Re)connected: emit an authoritative resync so the consumer refetches
      // content/diff — events that fired while the stream was down cannot be
      // replayed, only re-read. The reconnect budget is intentionally NOT
      // reset here (see reconnectBudget); stability resets it.
      lastError = undefined;
      armStabilityTimer();
      setState("connected");
      for (const listener of listeners.resync) listener();

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (!controller.signal.aborted) {
        const { value, done } = await reader.read();
        buffer += decoder.decode(value, { stream: !done }).replace(/\r\n?/g, "\n");

        let boundary = buffer.indexOf("\n\n");
        while (boundary >= 0) {
          const parsed = parseEventBlock(buffer.slice(0, boundary));
          buffer = buffer.slice(boundary + 2);
          if (parsed?.event === "change") {
            // Functional proof: the stream is delivering real changes, so the
            // connection is stable — reset the flap budget.
            reconnectBudget = 0;
            for (const listener of listeners.change) listener({ data: parsed.data });
          }
          boundary = buffer.indexOf("\n\n");
        }

        if (done) break;
      }

      // Clean stream end (Host closed it) → reconnect unless we were closed.
      if (!closed && !controller.signal.aborted) {
        clearStabilityTimer();
        scheduleReconnect("Watch stream ended");
      }
    } catch (error) {
      if (closed) return;
      if (controller.signal.aborted) return; // explicit close()
      clearStabilityTimer();
      scheduleReconnect(error instanceof Error ? error.message : String(error));
    }
  }

  const session: WatchSession = {
    get state() {
      return state;
    },
    get lastError() {
      return lastError;
    },
    addEventListener(type, listener) {
      if (type === "change") {
        const changeListener = listener as (event: WatchChangeEvent) => void;
        listeners.change.add(changeListener);
        return () => { listeners.change.delete(changeListener); };
      }
      if (type === "resync") {
        const resyncListener = listener as () => void;
        listeners.resync.add(resyncListener);
        return () => { listeners.resync.delete(resyncListener); };
      }
      const stateListener = listener as (state: WatchConnectionState) => void;
      listeners.state.add(stateListener);
      return () => { listeners.state.delete(stateListener); };
    },
    close() {
      if (closed) return;
      closed = true;
      clearRetry();
      clearStabilityTimer();
      controller?.abort();
      controller = null;
      listeners.change.clear();
      listeners.resync.clear();
      listeners.state.clear();
      setState("closed");
    },
  };

  // Kick off the first connection on the next tick so callers can register
  // listeners before the stream resolves.
  void runStream();
  return session;
}

let watchSessionFactory: WatchSessionFactory = createFetchWatchSession;

/** Open a same-origin watch session for one authorized file. */
export function openWatchSession(url: string): WatchSession {
  return watchSessionFactory(url);
}

/** Replace the transport for deterministic tests or an alternate host bridge. */
export function setWatchSessionFactory(factory: WatchSessionFactory): void {
  watchSessionFactory = factory;
}
