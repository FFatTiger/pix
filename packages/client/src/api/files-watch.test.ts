import { afterEach, describe, expect, it, vi } from "vitest";
import {
  openWatchSession,
  WATCH_RECONNECT_DELAYS_MS,
  WATCH_STABLE_MS,
  type WatchConnectionState,
} from "./files-watch";

function openStream(): { response: Response; enqueue: (chunk: string) => void; close: () => void } {
  const encoder = new TextEncoder();
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(c) { controller = c; },
  });
  return {
    response: new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } }),
    enqueue(chunk: string) { controller?.enqueue(encoder.encode(chunk)); },
    close() { controller?.close(); },
  };
}

/** A stream that connects (HTTP 200 + body) but immediately ends. */
function endedStream(): Response {
  return new Response(
    new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } }),
    { status: 200, headers: { "Content-Type": "text/event-stream" } },
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("file watch session", () => {
  it("parses chunked SSE, forwards only change events and resyncs on connect", async () => {
    const { response, enqueue } = openStream();
    const fetchMock = vi.fn().mockResolvedValue(response);
    vi.stubGlobal("fetch", fetchMock);

    const session = openWatchSession("/v1/files/watch?path=%2Ftmp%2Fa");
    const changes: string[] = [];
    const resyncs: number[] = [];
    session.addEventListener("change", (event) => changes.push(event.data ?? ""));
    session.addEventListener("resync", () => resyncs.push(1));

    await vi.waitFor(() => expect(session.state).toBe("connected"));
    // The initial connect is authoritative: consumers must refetch once.
    expect(resyncs).toEqual([1]);
    expect(fetchMock).toHaveBeenCalledWith(
      "/v1/files/watch?path=%2Ftmp%2Fa",
      expect.objectContaining({ headers: { Accept: "text/event-stream" } }),
    );

    enqueue("event: connected\r\ndata: {\"size\":1}\r\n\r\nevent: cha");
    enqueue("nge\ndata: {\"modified\":2,\"size\":3}\n\n");
    await vi.waitFor(() => expect(changes).toEqual(['{"modified":2,"size":3}']));

    // A "connected" event is never forwarded as a change; the stream stays up.
    expect(session.state).toBe("connected");
    session.close();
    expect(session.state).toBe("closed");
  });

  it("reconnects with backoff after a drop and emits an authoritative resync", async () => {
    vi.useFakeTimers();
    const first = openStream();
    const second = openStream();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(first.response)
      .mockResolvedValueOnce(second.response);
    vi.stubGlobal("fetch", fetchMock);

    const session = openWatchSession("/v1/files/watch?path=x");
    const resyncs: number[] = [];
    const states: WatchConnectionState[] = [];
    session.addEventListener("resync", () => resyncs.push(1));
    session.addEventListener("state", (state) => states.push(state));

    await vi.advanceTimersByTimeAsync(0);
    expect(session.state).toBe("connected");
    expect(resyncs).toEqual([1]);

    // Drop the first stream (clean end) → reconnect scheduled with backoff.
    first.close();
    await vi.advanceTimersByTimeAsync(0);
    expect(session.state).toBe("reconnecting");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // After the first backoff delay a fresh stream connects; consumers get an
    // authoritative resync so the events dropped during the outage are re-read.
    await vi.advanceTimersByTimeAsync(WATCH_RECONNECT_DELAYS_MS[0]!);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(session.state).toBe("connected");
    expect(resyncs).toEqual([1, 1]);
    expect(states).toContain("reconnecting");

    session.close();
    expect(session.state).toBe("closed");
  });

  it("gives up after the bounded backoff schedule and surfaces the error", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));

    const session = openWatchSession("/v1/files/watch?path=x");
    const states: WatchConnectionState[] = [];
    session.addEventListener("state", (state) => states.push(state));

    await vi.advanceTimersByTimeAsync(0);
    expect(session.state).toBe("reconnecting");

    // Step through the full bounded schedule; after the final delay a failure
    // closes the session instead of reconnecting forever.
    for (const delay of WATCH_RECONNECT_DELAYS_MS) {
      await vi.advanceTimersByTimeAsync(delay);
    }
    expect(session.state).toBe("closed");
    expect(session.lastError).toBe("network down");
    expect(states).toContain("reconnecting");
    expect(states).toContain("closed");
  });

  it("delivers change events in order and stops after close", async () => {
    const { response, enqueue } = openStream();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));

    const session = openWatchSession("/v1/files/watch?path=x");
    const changes: string[] = [];
    session.addEventListener("change", (event) => changes.push(event.data ?? ""));

    await vi.waitFor(() => expect(session.state).toBe("connected"));
    // Two rapid changes: the transport must deliver them in arrival order.
    enqueue("event: change\ndata: {\"modified\":1}\n\nevent: change\ndata: {\"modified\":2}\n\n");
    await vi.waitFor(() => expect(changes).toEqual(['{"modified":1}', '{"modified":2}']));

    session.close();
    enqueue("event: change\ndata: {\"modified\":3}\n\n");
    // No events after close; the listener set is cleared.
    expect(changes).toEqual(['{"modified":1}', '{"modified":2}']);
  });

  it("bounded budget: repeated successful-connect/immediate-end flaps reach closed", async () => {
    vi.useFakeTimers();
    // Each connect succeeds (HTTP 200 + body) but the stream ends immediately:
    // the server is alive but never delivers a change, so nothing resets the
    // budget and the session must exhaust the schedule and CLOSE instead of
    // reconnecting at delay[0] forever.
    const connectThenEnd = vi.fn(() => Promise.resolve(endedStream()));
    vi.stubGlobal("fetch", connectThenEnd);

    const session = openWatchSession("/v1/files/watch?path=x");
    const states: WatchConnectionState[] = [];
    session.addEventListener("state", (state) => states.push(state));

    await vi.advanceTimersByTimeAsync(0);
    expect(session.state).toBe("reconnecting");
    expect(connectThenEnd).toHaveBeenCalledTimes(1);

    // One delay per flap; the budget never resets (no change, no stable
    // duration), so after the whole schedule the session closes.
    for (const delay of WATCH_RECONNECT_DELAYS_MS) {
      await vi.advanceTimersByTimeAsync(delay);
    }
    expect(session.state).toBe("closed");
    expect(session.lastError).toBe("Watch stream ended");
    expect(connectThenEnd).toHaveBeenCalledTimes(WATCH_RECONNECT_DELAYS_MS.length + 1);
    expect(states).toContain("closed");
  });

  it("a received change event resets the budget across a flap", async () => {
    vi.useFakeTimers();
    // First connect drops with no change (budget 1, delay 500). The reconnect
    // delivers a change event — objective stability — so a later drop must
    // restart the budget at delay[0] instead of continuing the flap count.
    const first = openStream();
    const second = openStream();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(first.response)
      .mockResolvedValueOnce(second.response);
    vi.stubGlobal("fetch", fetchMock);

    const session = openWatchSession("/v1/files/watch?path=x");
    const changes: string[] = [];
    session.addEventListener("change", (event) => changes.push(event.data ?? ""));

    await vi.advanceTimersByTimeAsync(0);
    expect(session.state).toBe("connected");
    first.close();
    await vi.advanceTimersByTimeAsync(0);
    expect(session.state).toBe("reconnecting");

    // Reconnect at delay[0]; deliver a change (stability) then end.
    await vi.advanceTimersByTimeAsync(WATCH_RECONNECT_DELAYS_MS[0]!);
    expect(session.state).toBe("connected");
    second.enqueue("event: change\ndata: {\"modified\":1}\n\n");
    await vi.advanceTimersByTimeAsync(0);
    expect(changes).toEqual(['{"modified":1}']);
    second.close();
    await vi.advanceTimersByTimeAsync(0);
    expect(session.state).toBe("reconnecting");
    // Budget was reset by the change event → next delay is delay[0] again.
    await vi.advanceTimersByTimeAsync(WATCH_RECONNECT_DELAYS_MS[0]!);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    session.close();
  });

  it("the stable-duration window resets the budget after an idle stable connection", async () => {
    vi.useFakeTimers();
    const first = openStream();
    const second = openStream();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(first.response)
      .mockResolvedValueOnce(second.response);
    vi.stubGlobal("fetch", fetchMock);

    const session = openWatchSession("/v1/files/watch?path=x");
    await vi.advanceTimersByTimeAsync(0);
    expect(session.state).toBe("connected");

    // First flap → budget 1 (delay 500).
    first.close();
    await vi.advanceTimersByTimeAsync(0);
    expect(session.state).toBe("reconnecting");
    await vi.advanceTimersByTimeAsync(WATCH_RECONNECT_DELAYS_MS[0]!);
    expect(session.state).toBe("connected");

    // The reconnect stays up (idle, no changes) past the stable window: the
    // budget resets. A drop now is a fresh outage → delay[0] again.
    await vi.advanceTimersByTimeAsync(WATCH_STABLE_MS);
    second.close();
    await vi.advanceTimersByTimeAsync(0);
    expect(session.state).toBe("reconnecting");
    await vi.advanceTimersByTimeAsync(WATCH_RECONNECT_DELAYS_MS[0]!);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    session.close();
  });
});
