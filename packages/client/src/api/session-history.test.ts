import { describe, expect, it } from "vitest";
import type { HttpClient } from "./http-client";
import { createSessionHistoryQueryOptions } from "./session-history";

const previousData = { pages: [], pageParams: [] };

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

describe("session history activation placeholder", () => {
  it("keeps the same session's prepared history through read-only → live activation", () => {
    const placeholder = placeholderFor("s1", 1);
    expect(placeholder(previousData, {
      queryKey: ["pix", "sessions", "session", "s1", "history", 0, null],
    })).toBe(previousData);
  });

  it("never carries history across sessions or between live generations", () => {
    const placeholder = placeholderFor("s2", 2);
    expect(placeholder(previousData, {
      queryKey: ["pix", "sessions", "session", "s1", "history", 0, null],
    })).toBeUndefined();
    expect(placeholder(previousData, {
      queryKey: ["pix", "sessions", "session", "s2", "history", 1, "leaf-old"],
    })).toBeUndefined();
  });
});
