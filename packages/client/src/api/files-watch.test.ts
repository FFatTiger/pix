import { afterEach, describe, expect, it, vi } from "vitest";
import { openFileWatch } from "./files-watch";

function streamResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
    { status: 200, headers: { "Content-Type": "text/event-stream" } },
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("file watch transport", () => {
  it("parses chunked SSE and forwards only change events", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      streamResponse([
        "event: connected\r\ndata: {\"size\":1}\r\n\r\nevent: cha",
        "nge\ndata: {\"modified\":2,\"size\":3}\n\n",
      ]),
    );
    vi.stubGlobal("fetch", fetchMock);

    const source = openFileWatch("/v1/files/watch?path=%2Ftmp%2Fa");
    const events: string[] = [];
    source.addEventListener("change", (event) => events.push(event.data ?? ""));

    await vi.waitFor(() => expect(events).toEqual(['{"modified":2,"size":3}']));
    expect(fetchMock).toHaveBeenCalledWith(
      "/v1/files/watch?path=%2Ftmp%2Fa",
      expect.objectContaining({ headers: { Accept: "text/event-stream" } }),
    );
    source.close();
  });

  it("degrades silently when the stream request fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("secret host failure")));
    const source = openFileWatch("/v1/files/watch?path=x");
    const listener = vi.fn();
    source.addEventListener("change", listener);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(listener).not.toHaveBeenCalled();
    source.close();
  });
});
