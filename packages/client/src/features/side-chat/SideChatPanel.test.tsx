import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SideChatState } from "@fffattiger/pix-protocol";
import { HttpClientProvider } from "@/app/http-context";
import { I18nProvider } from "@/hooks/useI18n";
import type { ExactRuntimeApi } from "@/runtime";
import { clearDraft } from "@/lib/draft-store";
import { SideChatPanel } from "./SideChatPanel";

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  // Side chat drafts persist per conversation in the shared draft store.
  for (const id of ["conversation-1", "conversation-A", "conversation-B"]) clearDraft(`side-chat:parent:${id}`);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function sideState(patch: Partial<SideChatState> = {}): SideChatState {
  return {
    conversationId: "conversation-1",
    revision: 1,
    model: { provider: "anthropic", id: "claude-sonnet" },
    thinkingLevel: "medium",
    status: "idle",
    messages: [],
    messagesTruncated: false,
    totalCharsTruncated: false,
    partialMessage: null,
    ...patch,
  };
}

function runtime(state: SideChatState | null, methods: Partial<ExactRuntimeApi> = {}): ExactRuntimeApi {
  return {
    sessionId: "parent",
    epoch: "epoch-1",
    attachGeneration: 1,
    snapshot: { state: { sideChat: state } },
    sideChatStart: vi.fn(async () => "conversation-1"),
    sideChatSend: vi.fn(async () => "run-1"),
    sideChatReset: vi.fn(async () => "conversation-2"),
    abortSideChat: vi.fn(async () => undefined),
    sideChatSetModel: vi.fn(async () => undefined),
    ...methods,
  } as unknown as ExactRuntimeApi;
}

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

function providers(node: React.ReactNode) {
  return (
    <QueryClientProvider client={queryClient}>
      <HttpClientProvider>
        <I18nProvider>{node}</I18nProvider>
      </HttpClientProvider>
    </QueryClientProvider>
  );
}

const MODELS_CATALOG = {
  models: [
    { id: "claude-sonnet", provider: "anthropic", displayName: "Claude Sonnet" },
    { id: "gpt-5", provider: "openai", displayName: "GPT-5" },
  ],
  defaultModel: null,
};

function mount(value: ExactRuntimeApi) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(MODELS_CATALOG), { status: 200, headers: { "Content-Type": "application/json" } })));
  return render(providers(<SideChatPanel runtime={value} cwd="/work" />));
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function settleDeferred<T>(pending: ReturnType<typeof deferred<T>>, outcome: "resolve" | "reject", value: T): Promise<void> {
  await act(async () => {
    if (outcome === "resolve") pending.resolve(value);
    else pending.reject({ code: "timeout", message: "stale failure", retryable: true });
  });
}

describe("SideChatPanel", () => {
  it("renders through the main transcript components: user bubble, process tools, model label", async () => {
    const value = runtime(sideState({
      revision: 4,
      messages: [
        { role: "user", content: "Question" },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "Reasoning" },
            { type: "toolCall", toolCallId: "tc1", toolName: "read", input: { path: "a.ts" } },
            { type: "text", text: "Committed answer" },
          ],
          model: "claude-sonnet",
          provider: "anthropic",
        },
        { role: "toolResult", toolCallId: "tc1", toolName: "read", content: [{ type: "text", text: "tool output" }] },
      ],
      messagesTruncated: true,
      error: { code: "run_failed", message: "Side chat request failed" },
    }));
    mount(value);

    // User message renders as the main transcript's user bubble.
    expect(document.querySelector(".chat-user-message")?.textContent).toContain("Question");
    // The assistant turn renders through the shared process-group pipeline
    // (collapsed summary exactly like a settled main-session turn), not the
    // removed side-only markup.
    const scroll = screen.getByTestId("side-chat-scroll");
    expect(scroll.querySelector(".side-chat-message")).toBeNull();
    expect(scroll.querySelector(".side-chat-tool")).toBeNull();
    expect(scroll.querySelector(".process-group-shell")).toBeTruthy();
    // The committed answer renders with the model label resolved from the
    // shared models catalog query.
    expect(scroll.textContent).toContain("Committed answer");
    await waitFor(() => expect(scroll.textContent).toContain("Claude Sonnet"));
    expect(screen.getByText("The side chat request failed.")).toBeTruthy();
    expect(screen.getAllByText("Some side chat content was truncated.").length).toBeGreaterThan(0);
    // The side chat IS the main ChatInput (variant="side"): one shell, one
    // textarea, no attachment button.
    expect(document.querySelectorAll(".chat-input-shell")).toHaveLength(1);
    expect(document.querySelectorAll(".chat-input-textarea")).toHaveLength(1);
    expect(document.querySelector(".chat-input-toolbar-attach")).toBeNull();
    expect(document.querySelector(".chat-input-textarea")?.getAttribute("aria-label")).toBe("Side chat message");
  });

  it("renders the live turn through the shared streaming tail", async () => {
    const value = runtime(sideState({
      status: "running",
      runId: "run-1",
      messages: [{ role: "user", content: "Question" }],
      partialMessage: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Working" },
          { type: "toolCall", toolCallId: "tc-live", toolName: "read", input: { path: "live.ts" } },
          { type: "text", text: "Streaming reply" },
        ],
        model: "claude-sonnet",
        provider: "anthropic",
      },
    }));
    mount(value);

    const scroll = screen.getByTestId("side-chat-scroll");
    expect(scroll.textContent).toContain("Streaming reply");
    // The streaming partial feeds the SAME process-group/message pipeline the
    // main transcript uses for its live tail — tool rows render with their
    // arguments while the group auto-follows the stream.
    expect(scroll.querySelector(".process-group-shell")).toBeTruthy();
    expect(scroll.textContent).toContain("Read");
    expect(scroll.textContent).toContain("live.ts");
    await waitFor(() => {
      const streaming = scroll.querySelector(".chat-assistant-message.is-streaming");
      expect(streaming?.textContent).toContain("Streaming reply");
    });
    expect(screen.getByRole("button", { name: "Stop side chat" })).toBeTruthy();
  });

  it("sends on IME-safe Enter, suppresses duplicate admission, and keeps a failed draft", async () => {
    let rejectSend!: (error: unknown) => void;
    const pending = new Promise<string>((_resolve, reject) => { rejectSend = reject; });
    const send = vi.fn(() => pending);
    const value = runtime(sideState(), { sideChatSend: send });
    mount(value);
    const input = screen.getByRole("textbox", { name: "Side chat message" });

    fireEvent.change(input, { target: { value: "keep this" } });
    fireEvent.compositionStart(input);
    fireEvent.keyDown(input, { key: "Enter", code: "Enter", isComposing: true });
    expect(send).not.toHaveBeenCalled();
    fireEvent.compositionEnd(input);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 200)); });
    fireEvent.keyDown(input, { key: "Enter", code: "Enter" });
    fireEvent.keyDown(input, { key: "Enter", code: "Enter" });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith("conversation-1", "keep this");

    await act(async () => { rejectSend({ code: "timeout", message: "raw provider text", retryable: true }); });
    expect((input as HTMLTextAreaElement).value).toBe("keep this");
    expect(screen.getByRole("alert").textContent).toContain("timed out");
    expect(screen.getByRole("alert").textContent).not.toContain("raw provider text");
  });

  it("uses exact conversation identity for reset and stop, with no mode or overlap controls", async () => {
    const reset = vi.fn(async () => "conversation-2");
    const abort = vi.fn(async () => ({ ok: true }));
    const value = runtime(sideState({
      status: "running",
      runId: "run-7",
    }), {
      sideChatReset: reset,
      abortSideChat: abort,
    });
    mount(value);

    // The discussion/edit toggle and overlap approval were removed with the
    // read-only-only side chat; only refork/clear remain in the toolbar.
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Discussion" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Proceed" })).toBeNull();
    const reforkButton = screen.getByRole("button", { name: "Refork from current conversation" }) as HTMLButtonElement;
    await waitFor(() => expect(reforkButton.disabled).toBe(false));
    fireEvent.click(reforkButton);
    await waitFor(() => expect(reset).toHaveBeenCalledWith("conversation-1", "refork"));
    const stopButton = screen.getByRole("button", { name: "Stop side chat" }) as HTMLButtonElement;
    await waitFor(() => expect(stopButton.disabled).toBe(false));
    fireEvent.click(stopButton);
    await waitFor(() => expect(abort).toHaveBeenCalledWith("conversation-1"));
  });

  it.each(["resolve", "reject"] as const)("makes a replacement epoch usable when the old action later settles by %s", async (outcome) => {
    const oldSend = deferred<string>();
    const first = runtime(sideState(), { sideChatSend: vi.fn(() => oldSend.promise) });
    const view = mount(first);
    let input = screen.getByRole("textbox", { name: "Side chat message" }) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "draft-before-reattach" } });
    fireEvent.keyDown(input, { key: "Enter", code: "Enter" });
    // Accepted sends clear the composer like the main session does.
    expect(input.value).toBe("");

    const replacement = runtime(sideState(), { epoch: "epoch-2", attachGeneration: 2 });
    view.rerender(providers(<SideChatPanel runtime={replacement} cwd="/work" />));
    input = screen.getByRole("textbox", { name: "Side chat message" }) as HTMLTextAreaElement;
    expect(input.disabled).toBe(false);
    fireEvent.change(input, { target: { value: "new epoch draft" } });

    await settleDeferred(oldSend, outcome, "run-old");
    expect(input.value).toBe("new epoch draft");
    expect(input.disabled).toBe(false);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it.each(["resolve", "reject"] as const)("fences a replacement conversation when the old send later settles by %s", async (outcome) => {
    const oldSend = deferred<string>();
    const first = runtime(sideState({ conversationId: "conversation-A" }), { sideChatSend: vi.fn(() => oldSend.promise) });
    const view = mount(first);
    let input = screen.getByRole("textbox", { name: "Side chat message" }) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "draft-A" } });
    fireEvent.keyDown(input, { key: "Enter", code: "Enter" });

    const replacement = runtime(sideState({ conversationId: "conversation-B" }));
    view.rerender(providers(<SideChatPanel runtime={replacement} cwd="/work" />));
    input = screen.getByRole("textbox", { name: "Side chat message" }) as HTMLTextAreaElement;
    expect(input.value).toBe("");
    expect(input.disabled).toBe(false);
    fireEvent.change(input, { target: { value: "draft-B" } });

    await settleDeferred(oldSend, outcome, "run-old");
    expect(input.value).toBe("draft-B");
    expect(input.disabled).toBe(false);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("does not leave a locally requested reset pending after authority installs its new conversation", async () => {
    const reset = deferred<string>();
    const first = runtime(sideState({ conversationId: "conversation-A" }), { sideChatReset: vi.fn(() => reset.promise) });
    const view = mount(first);
    fireEvent.click(screen.getByRole("button", { name: "Clear side chat" }));

    const replacement = runtime(sideState({ conversationId: "conversation-B" }));
    view.rerender(providers(<SideChatPanel runtime={replacement} cwd="/work" />));
    const input = screen.getByRole("textbox", { name: "Side chat message" }) as HTMLTextAreaElement;
    expect(input.disabled).toBe(false);
    fireEvent.change(input, { target: { value: "new conversation draft" } });
    await act(async () => { reset.resolve("conversation-B"); });
    expect(input.value).toBe("new conversation draft");
    expect(input.disabled).toBe(false);
  });

  it("selects the side-chat model and thinking level from the composer toolbar", async () => {
    const setModel = vi.fn(async () => undefined);
    const value = runtime(sideState({ thinkingLevel: "medium" }), { sideChatSetModel: setModel });
    mount(value);

    // Both selectors render beside the send button with the effective values.
    const modelButton = await screen.findByRole("button", { name: "Change model" });
    expect(modelButton.textContent).toContain("Claude Sonnet");
    const thinkingButton = screen.getByRole("button", { name: "Thinking effort" });
    expect(thinkingButton.textContent).toContain("medium");

    // Model change carries the CURRENT thinking level; no "auto" level exists.
    fireEvent.click(modelButton);
    fireEvent.click(screen.getByRole("button", { name: "openai" }));
    fireEvent.click(screen.getByRole("button", { name: /GPT-5/ }));
    await waitFor(() => expect(setModel).toHaveBeenCalledWith("conversation-1", "openai", "gpt-5", "medium"));

    // Thinking change carries the CURRENT model.
    fireEvent.click(thinkingButton);
    fireEvent.click(screen.getByRole("button", { name: "high" }));
    await waitFor(() => expect(setModel).toHaveBeenCalledWith("conversation-1", "anthropic", "claude-sonnet", "high"));
    expect(screen.queryByRole("button", { name: "auto" })).toBeNull();
  });

  it("locks the selectors while the side chat is running", async () => {
    const setModel = vi.fn(async () => undefined);
    mount(runtime(sideState({ status: "running", runId: "run-1" }), { sideChatSetModel: setModel }));

    const modelButton = await screen.findByRole("button", { name: "Change model" });
    expect((modelButton as HTMLButtonElement).disabled).toBe(true);
    expect(modelButton.getAttribute("title")).toBe("The model is locked while the side chat is running.");
    const thinkingButton = screen.getByRole("button", { name: "Thinking effort" });
    expect((thinkingButton as HTMLButtonElement).disabled).toBe(true);
    expect(setModel).not.toHaveBeenCalled();
  });

  it("starts once for an uninitialized exact parent", async () => {
    const start = vi.fn(async () => "conversation-1");
    mount(runtime(null, { sideChatStart: start }));
    await waitFor(() => expect(start).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId("side-chat-panel")).toBeTruthy();
  });
});
