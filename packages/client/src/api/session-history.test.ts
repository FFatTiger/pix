import { describe, expect, it, vi } from "vitest";
import { createHttpClient, type HttpClient } from "./http-client";
import { createDeferredThinkingLoader, createSessionHistoryQueryOptions } from "./session-history";

const previousData = { context: { sessionId: "s1", entries: [], pageInfo: { hasMore: false } } };

function placeholderFor(sessionId: string, generation: number) {
  const options = createSessionHistoryQueryOptions({
    http: {} as HttpClient,
    sessionId,
    generation,
    anchor: generation === 0 ? null : "leaf-1",
    enabled: true,
  });
  return options.placeholderData as (
    data: typeof previousData | undefined,
    query: { queryKey: readonly unknown[] } | undefined,
  ) => typeof previousData | undefined;
}

describe("session history complete-branch query", () => {
  it("fetches ONE complete deferred response — no limit, deferThinking=1&deferMedia=1", async () => {
    const fetchImpl = vi.fn().mockImplementation(async () => new Response(JSON.stringify({
      context: { sessionId: "s1", entries: [], pageInfo: { hasMore: false } },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const http = createHttpClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const options = createSessionHistoryQueryOptions({
      http,
      sessionId: "s1",
      generation: 0,
      anchor: null,
      enabled: true,
    });
    const queryFn = options.queryFn as unknown as (input: {
      signal: AbortSignal;
    }) => Promise<unknown>;

    await queryFn({ signal: new AbortController().signal });

    // Exactly one request; NO limit (complete branch contract) and both defer
    // flags so thinking/media never ride the initial response.
    expect(fetchImpl.mock.calls).toHaveLength(1);
    expect(fetchImpl.mock.calls[0]![0]).toBe(
      "/v1/sessions/s1/context?deferThinking=1&deferMedia=1",
    );
  });

  it("pins the live anchor leaf on the complete request", async () => {
    const fetchImpl = vi.fn().mockImplementation(async () => new Response(JSON.stringify({
      context: { sessionId: "s1", entries: [], pageInfo: { hasMore: false } },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const http = createHttpClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const options = createSessionHistoryQueryOptions({
      http,
      sessionId: "s1",
      generation: 3,
      anchor: "leaf-9",
      enabled: true,
    });
    await (options.queryFn as unknown as (input: { signal: AbortSignal }) => Promise<unknown>)({
      signal: new AbortController().signal,
    });
    expect(fetchImpl.mock.calls[0]![0]).toBe(
      "/v1/sessions/s1/context?leafId=leaf-9&deferThinking=1&deferMedia=1",
    );
  });

  it("is disabled (inert) when the enabled gate is false", () => {
    const options = createSessionHistoryQueryOptions({
      http: {} as HttpClient,
      sessionId: "s1",
      generation: 0,
      anchor: null,
      enabled: false,
    });
    expect(options.enabled).toBe(false);
    expect(options.retry).toBe(false);
    expect(options.retryOnMount).toBe(false);
  });
});

describe("session history same-session placeholder", () => {
  it("keeps the same session's previous response through ANY revision bump (activation, rebase)", () => {
    const placeholder = placeholderFor("s1", 1);
    // read-only generation 0 → live activation
    expect(placeholder(previousData, {
      queryKey: ["pix", "sessions", "session", "s1", "history", 0, null],
    })).toBe(previousData);
    // turn-end leaf fence / gap / epoch rebase: live generation → live generation
    expect(placeholder(previousData, {
      queryKey: ["pix", "sessions", "session", "s1", "history", 3, "leaf-old"],
    })).toBe(previousData);
  });

  it("never carries history across sessions", () => {
    const placeholder = placeholderFor("s2", 2);
    expect(placeholder(previousData, {
      queryKey: ["pix", "sessions", "session", "s1", "history", 0, null],
    })).toBeUndefined();
  });
});

describe("deferred thinking loader", () => {
  it("requests the exact block index and unwraps {thinking}", async () => {
    const fetchImpl = vi.fn().mockImplementation(async () => new Response(JSON.stringify({
      thinking: "because reasons",
      entryId: "e1",
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const http = createHttpClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const loader = createDeferredThinkingLoader(http);
    await expect(loader("s1", "e1", 2)).resolves.toBe("because reasons");
    expect(fetchImpl.mock.calls[0]![0]).toBe(
      "/v1/sessions/s1/entries/e1/thinking?blockIndex=2",
    );
  });

  it("fails closed on a malformed response (required entryId missing)", async () => {
    const fetchImpl = vi.fn().mockImplementation(async () => new Response(JSON.stringify({
      thinking: "partial",
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const http = createHttpClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const loader = createDeferredThinkingLoader(http);
    await expect(loader("s1", "e1", 0)).rejects.toBeTruthy();
  });
});
