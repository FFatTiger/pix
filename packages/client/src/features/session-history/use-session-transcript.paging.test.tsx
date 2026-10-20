/**
 * `useSessionTranscript` — budgeted history paging.
 *
 * A session whose active branch exceeds the lightweight history budget comes
 * back as the NEWEST page with `pageInfo.hasMore` + `nextCursor`. The hook must
 * keep that newest page alone until the caller asks (`hasOlder: true`, no
 * request), then prepend older pages chronologically so the merged entry list
 * stays a single continuous conversation and stops requesting once the branch
 * is complete (`hasMore:false`).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { useSessionTranscript, type SessionTranscript } from "./use-session-transcript";
import { HttpClientProvider } from "@/app/http-context";
import { CapabilityProvider } from "@/features/capability/CapabilityProvider";
import { RuntimeProvider } from "@/runtime";
import type { RuntimeSocketDeps } from "@/runtime";
import { flush } from "@/runtime/testing/harness";

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

function fakeDeps(): RuntimeSocketDeps {
  return {
    createWebSocket: () => { throw new Error("no socket expected in this suite"); },
    now: () => Date.now(),
    setTimeout: (fn) => setTimeout(fn),
    clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    random: () => 0.5,
    location: { href: "https://pix.local/app/" },
    identity: { shell: "web", platform: "mac" },
    onOnline: () => () => undefined,
  };
}

interface ProbeProps {
  readonly onValue: (value: SessionTranscript) => void;
}

function Probe({ onValue }: ProbeProps): ReactNode {
  const transcript = useSessionTranscript({ sessionId: "s1", enabled: true, live: false });
  onValue(transcript);
  return null;
}

function page(from: number, to: number, hasMore: boolean): Response {
  return json({
    context: {
      sessionId: "s1",
      entries: Array.from({ length: to - from }, (_, index) => ({
        entryId: `e${from + index + 1}`,
        message: { role: "user", content: `row ${from + index + 1}` },
      })),
      settings: { model: null, thinkingLevel: "off" },
      pageInfo: hasMore ? { hasMore: true, nextCursor: `e${from + 1}` } : { hasMore: false },
    },
  });
}

let previousFetch: typeof fetch;

async function settle(): Promise<void> {
  for (let round = 0; round < 4; round += 1) {
    await act(async () => {
      await flush(20);
      vi.advanceTimersByTime(0);
      await flush(20);
    });
  }
}

describe("useSessionTranscript — budgeted history paging", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    previousFetch = globalThis.fetch;
  });
  afterEach(() => {
    cleanup();
    globalThis.fetch = previousFetch;
    vi.useRealTimers();
  });

  function mount(): { current(): SessionTranscript } {
    let latest: SessionTranscript | null = null;
    const Tree = (): ReactNode => {
      const [queryClient] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false } } }));
      return (
        <QueryClientProvider client={queryClient}>
          <HttpClientProvider>
            <CapabilityProvider host={{ mode: "local", capabilities: ["agent", "sessions"] }}>
              <RuntimeProvider deps={fakeDeps()}>
                <Probe onValue={(value) => { latest = value; }} />
              </RuntimeProvider>
            </CapabilityProvider>
          </HttpClientProvider>
        </QueryClientProvider>
      );
    };
    render(<Tree />);
    return { current: () => latest! };
  }

  it("keeps the newest page only until asked, then prepends older pages oldest-first", async () => {
    const calls: string[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const path = typeof input === "string" ? input : input instanceof URL ? `${input.pathname}${input.search}` : input.url;
      if (!path.includes("/v1/sessions/s1/context")) return json({});
      calls.push(path);
      const before = new URL(`https://pix.local${path}`).searchParams.get("before");
      if (before === null) return page(20, 30, true);      // newest: e21..e30
      if (before === "e21") return page(10, 20, true);      // next older: e11..e20
      return page(0, 10, false);                            // oldest: e1..e10
    }) as unknown as typeof fetch;

    const probe = mount();
    await settle();
    expect(calls).toHaveLength(1);
    expect(probe.current().entryIds).toEqual(Array.from({ length: 10 }, (_, index) => `e${index + 21}`));
    expect(probe.current().hasOlder).toBe(true);
    // Nothing to load yet: `loadOlder` is the only trigger.
    await settle();
    expect(calls).toHaveLength(1);

    await act(async () => { probe.current().loadOlder(); await flush(20); });
    await settle();
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain("before=e21");
    // Older page is prepended (oldest page first) — chronological, no duplicates.
    expect(probe.current().entryIds).toEqual(Array.from({ length: 20 }, (_, index) => `e${index + 11}`));
    expect(probe.current().hasOlder).toBe(true);

    await act(async () => { probe.current().loadOlder(); await flush(20); });
    await settle();
    expect(calls).toHaveLength(3);
    expect(probe.current().entryIds).toEqual(Array.from({ length: 30 }, (_, index) => `e${index + 1}`));
    expect(probe.current().hasOlder).toBe(false);

    // Complete branch: no further request, even if the caller keeps asking.
    await act(async () => { probe.current().loadOlder(); await flush(20); });
    await settle();
    expect(calls).toHaveLength(3);
  });

  it("a session that fits the budget is one complete request and never asks for more", async () => {
    const calls: string[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const path = typeof input === "string" ? input : input instanceof URL ? `${input.pathname}${input.search}` : input.url;
      if (!path.includes("/v1/sessions/s1/context")) return json({});
      calls.push(path);
      return page(0, 40, false);
    }) as unknown as typeof fetch;

    const probe = mount();
    await settle();
    expect(calls).toEqual(["/v1/sessions/s1/context?deferThinking=1&deferMedia=1"]);
    expect(probe.current().entries).toHaveLength(40);
    expect(probe.current().hasOlder).toBe(false);
    await act(async () => { probe.current().loadOlder(); await flush(20); });
    await settle();
    expect(calls).toHaveLength(1);
  });
});
