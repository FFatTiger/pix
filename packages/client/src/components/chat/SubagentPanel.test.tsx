import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState, type ReactNode } from "react";
import { I18nProvider } from "@/hooks/useI18n";
import { HttpClientProvider } from "@/app/http-context";
import { CapabilityProvider } from "@/features/capability/CapabilityProvider";
import { RuntimeProvider } from "@/runtime/runtime-provider";
import { flush } from "@/runtime/testing/harness";
import { transcriptScrollRef } from "@/components/chat/chat-experience-bridge";
import { refreshReadonlySessionHistory } from "@/api/session-history";
import type { SubagentActivity } from "@/lib/subagent-activity";
import { SubagentPanel } from "./SubagentPanel";
import type { RuntimeSocketDeps } from "@/runtime";
import type { StreamingAgentMessage } from "@fffattiger/pix-protocol";

vi.mock("@/api/session-history", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/session-history")>();
  return {
    ...actual,
    refreshReadonlySessionHistory: vi.fn(actual.refreshReadonlySessionHistory),
  };
});

const ACTIVITIES: SubagentActivity[] = [
  {
    key: "task:running",
    taskId: "running",
    title: "Inspect runtime",
    agentType: "Explore",
    status: "running",
  },
  {
    key: "task:completed",
    taskId: "completed",
    title: "Check tests",
    agentType: "verification",
    status: "completed",
    childSessionId: "child-completed",
  },
];

const RUNNING_CHILD: SubagentActivity = {
  key: "task:child-running",
  taskId: "child-running",
  title: "Explore files",
  agentType: "Explore",
  status: "running",
  childSessionId: "child-running",
};

const COMPLETED_CHILD: SubagentActivity = {
  ...RUNNING_CHILD,
  key: "task:child-done",
  taskId: "child-done",
  status: "completed",
};

const CHILD_PARTIAL: StreamingAgentMessage = {
  role: "assistant",
  content: [{ type: "text", text: "child token stream" }],
};

class ResizeObserverStub {
  observe(): void { /* jsdom no-op */ }
  unobserve(): void { /* jsdom no-op */ }
  disconnect(): void { /* jsdom no-op */ }
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

function contextResponse(sessionId: string, entries: unknown[]): Response {
  return json({
    context: {
      sessionId,
      entries,
      settings: { model: null, thinkingLevel: "off" },
      pageInfo: { hasMore: false },
    },
  });
}

function childHistoryEntries(options?: { answer?: boolean }): unknown[] {
  const content = options?.answer === false
    ? [{ type: "thinking", thinking: "plan" }]
    : [{ type: "thinking", thinking: "plan" }, { type: "text", text: "committed answer" }];
  return [
    { entryId: "child-u1", message: { role: "user", content: "inspect" } },
    {
      entryId: "child-a1",
      parentEntryId: "child-u1",
      message: {
        role: "assistant",
        model: "m",
        provider: "p",
        content,
      },
    },
  ];
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
    onVisible: () => () => undefined,
  };
}

function renderPanel(props: React.ComponentProps<typeof SubagentPanel>) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <I18nProvider>
        <SubagentPanel {...props} />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

function ChildTree(props: React.ComponentProps<typeof SubagentPanel> & { children?: ReactNode }): ReactNode {
  const [queryClient] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false } } }));
  const { children: _ignored, ...panelProps } = props;
  return (
    <QueryClientProvider client={queryClient}>
      <HttpClientProvider>
        <CapabilityProvider host={{ mode: "local", capabilities: ["agent", "sessions"] }}>
          <RuntimeProvider deps={fakeDeps()}>
            <I18nProvider>
              <SubagentPanel {...panelProps} />
            </I18nProvider>
          </RuntimeProvider>
        </CapabilityProvider>
      </HttpClientProvider>
    </QueryClientProvider>
  );
}

const idleHandlers = {
  onSelectActivity: () => undefined,
  onBack: () => undefined,
  onClose: () => undefined,
  onRefresh: () => undefined,
};

async function settle(): Promise<void> {
  for (let round = 0; round < 4; round += 1) {
    await act(async () => {
      await flush(20);
      vi.advanceTimersByTime(0);
      await flush(20);
    });
  }
}

let previousFetch: typeof fetch;
let previousIntersectionObserver: (typeof globalThis)["IntersectionObserver"];

describe("SubagentPanel", () => {
  it("keeps an unpersisted running task visible and opens a persisted child", () => {
    const onSelectActivity = vi.fn();
    const onRefresh = vi.fn();
    const onClose = vi.fn();
    renderPanel({
      activities: ACTIVITIES,
      error: false,
      loading: false,
      refreshing: false,
      parentSessionId: "parent",
      parentEpoch: "epoch-1",
      subagentsRevision: 1,
      selectedChildSessionId: null,
      onSelectActivity,
      onBack: () => undefined,
      onClose,
      onRefresh,
    });

    expect(screen.getByText("Inspect runtime").closest("[aria-disabled='true']")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open agent Check tests" }));
    expect(onSelectActivity).toHaveBeenCalledWith(ACTIVITIES[1]);
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(onRefresh).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("reports child-catalog failures honestly", () => {
    renderPanel({
      activities: [],
      error: true,
      loading: false,
      refreshing: false,
      parentSessionId: "parent",
      parentEpoch: "epoch-1",
      subagentsRevision: 1,
      selectedChildSessionId: null,
      ...idleHandlers,
    });
    expect(screen.getByRole("alert").textContent).toBe("Agent sessions are temporarily unavailable.");
  });
});

describe("SubagentPanel — child transcript streaming", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    previousFetch = globalThis.fetch;
    previousIntersectionObserver = globalThis.IntersectionObserver;
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= ResizeObserverStub;
    (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver ??= class {
      observe(): void { /* jsdom no-op */ }
      unobserve(): void { /* jsdom no-op */ }
      disconnect(): void { /* jsdom no-op */ }
    } as unknown as (typeof globalThis)["IntersectionObserver"];
    (globalThis as { matchMedia?: unknown }).matchMedia ??= (query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    });
    transcriptScrollRef.current = document.createElement("div");
    vi.mocked(refreshReadonlySessionHistory).mockClear();
    window.localStorage.setItem("pi-process-display-mode", "timeline");
  });
  afterEach(() => {
    cleanup();
    globalThis.fetch = previousFetch;
    (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = previousIntersectionObserver;
    transcriptScrollRef.current = null;
    window.localStorage.removeItem("pi-process-display-mode");
    vi.useRealTimers();
  });

  it("renders the live child partial in the read-only list and clears it on done", async () => {
    const contextCalls: string[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      if (path.includes("/v1/sessions/child-running/context")) {
        contextCalls.push(path);
        return contextResponse("child-running", childHistoryEntries());
      }
      return json({});
    }) as unknown as typeof fetch;

    const view = render(
      <ChildTree
        activities={[RUNNING_CHILD]}
        error={false}
        loading={false}
        refreshing={false}
        parentSessionId="parent"
        parentEpoch="epoch-1"
        subagentsRevision={1}
        selectedChildSessionId="child-running"
        childStream={CHILD_PARTIAL}
        {...idleHandlers}
      />,
    );
    await settle();
    expect(Array.from(document.querySelectorAll(".stream-char")).map((node) => node.textContent).join("")).toContain("child token stream");
    expect(document.querySelector(".chat-assistant-message.is-streaming")).toBeTruthy();
    expect(document.querySelector(".process-streaming-dot")).toBeTruthy();
    expect(transcriptScrollRef.current).not.toBe(document.querySelector(".transcript-scroll"));

    view.rerender(
      <ChildTree
        activities={[COMPLETED_CHILD]}
        error={false}
        loading={false}
        refreshing={false}
        parentSessionId="parent"
        parentEpoch="epoch-1"
        subagentsRevision={2}
        selectedChildSessionId="child-running"
        childStream={null}
        {...idleHandlers}
      />,
    );
    await settle();
    expect(document.querySelector(".chat-assistant-message.is-streaming")).toBeNull();
    expect(document.querySelector(".process-streaming-dot")).toBeNull();
    expect(contextCalls.length).toBeGreaterThan(0);
  });

  it("does not render a stale partial once the child leaves running", async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      if (path.includes("/v1/sessions/child-running/context")) {
        return contextResponse("child-running", childHistoryEntries());
      }
      return json({});
    }) as unknown as typeof fetch;

    render(
      <ChildTree
        activities={[COMPLETED_CHILD]}
        error={false}
        loading={false}
        refreshing={false}
        parentSessionId="parent"
        parentEpoch="epoch-1"
        subagentsRevision={4}
        selectedChildSessionId="child-running"
        childStream={CHILD_PARTIAL}
        {...idleHandlers}
      />,
    );
    await settle();
    expect(document.querySelector(".chat-assistant-message.is-streaming")).toBeNull();
    expect(document.querySelector(".process-streaming-dot")).toBeNull();
    expect(screen.getByText("committed answer")).toBeTruthy();
  });

  it("keeps tailActive expanding the last group until the first child token arrives", async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      if (path.includes("/v1/sessions/child-running/context")) {
        return contextResponse("child-running", childHistoryEntries({ answer: false }));
      }
      return json({});
    }) as unknown as typeof fetch;

    const view = render(
      <ChildTree
        activities={[RUNNING_CHILD]}
        error={false}
        loading={false}
        refreshing={false}
        parentSessionId="parent"
        parentEpoch="epoch-1"
        subagentsRevision={1}
        selectedChildSessionId="child-running"
        {...idleHandlers}
      />,
    );
    await settle();
    expect(document.querySelector(".process-streaming-dot")).toBeTruthy();
    expect(document.querySelector('button[aria-expanded="true"]')).toBeTruthy();
    expect(document.querySelector(".chat-assistant-message.is-streaming")).toBeNull();

    view.rerender(
      <ChildTree
        activities={[RUNNING_CHILD]}
        error={false}
        loading={false}
        refreshing={false}
        parentSessionId="parent"
        parentEpoch="epoch-1"
        subagentsRevision={1}
        selectedChildSessionId="child-running"
        childStream={CHILD_PARTIAL}
        {...idleHandlers}
      />,
    );
    await settle();
    expect(Array.from(document.querySelectorAll(".stream-char")).map((node) => node.textContent).join("")).toContain("child token stream");
    expect(document.querySelector(".process-streaming-dot")).toBeTruthy();
  });

  it("does not publish the nested scroll owner and still refreshes on parent/epoch/child fences", async () => {
    const parentScroll = document.createElement("div");
    transcriptScrollRef.current = parentScroll;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      if (path.includes("/v1/sessions/child-running/context")) {
        return contextResponse("child-running", childHistoryEntries());
      }
      return json({});
    }) as unknown as typeof fetch;

    const view = render(
      <ChildTree
        activities={[RUNNING_CHILD]}
        error={false}
        loading={false}
        refreshing={false}
        parentSessionId="parent"
        parentEpoch="epoch-1"
        subagentsRevision={1}
        selectedChildSessionId="child-running"
        childStream={CHILD_PARTIAL}
        {...idleHandlers}
      />,
    );
    await settle();
    expect(transcriptScrollRef.current).toBe(parentScroll);
    expect(vi.mocked(refreshReadonlySessionHistory)).not.toHaveBeenCalled();

    view.rerender(
      <ChildTree
        activities={[RUNNING_CHILD]}
        error={false}
        loading={false}
        refreshing={false}
        parentSessionId="parent"
        parentEpoch="epoch-1"
        subagentsRevision={2}
        selectedChildSessionId="child-running"
        childStream={CHILD_PARTIAL}
        {...idleHandlers}
      />,
    );
    await settle();
    expect(vi.mocked(refreshReadonlySessionHistory)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(refreshReadonlySessionHistory).mock.calls[0]![1]).toBe("child-running");
    expect(transcriptScrollRef.current).toBe(parentScroll);

    view.rerender(
      <ChildTree
        activities={[{ ...RUNNING_CHILD, childSessionId: "child-other", key: "task:other" }]}
        error={false}
        loading={false}
        refreshing={false}
        parentSessionId="parent"
        parentEpoch="epoch-1"
        subagentsRevision={2}
        selectedChildSessionId="child-other"
        {...idleHandlers}
      />,
    );
    await settle();
    expect(vi.mocked(refreshReadonlySessionHistory)).toHaveBeenCalledTimes(1);
  });
});
