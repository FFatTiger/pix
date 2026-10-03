import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { SideChatState } from "@fffattiger/pix-protocol";
import { I18nProvider } from "@/hooks/useI18n";
import type { ExactRuntimeApi } from "@/runtime";
import { SideChatPanel } from "./SideChatPanel";

function sideState(patch: Partial<SideChatState> = {}): SideChatState {
  return {
    conversationId: "conversation-1",
    revision: 1,
    capturedModel: { provider: "anthropic", id: "claude-sonnet" },
    capturedThinkingLevel: "medium",
    mode: "read_only",
    status: "idle",
    messages: [],
    messagesTruncated: false,
    totalCharsTruncated: false,
    stream: { text: "", thinking: "", textTruncated: false, thinkingTruncated: false },
    tools: [],
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
    sideChatSetMode: vi.fn(async () => undefined),
    sideChatRespondOverlap: vi.fn(async () => undefined),
    abortSideChat: vi.fn(async () => ({ ok: true })),
    ...methods,
  } as unknown as ExactRuntimeApi;
}

function mount(value: ExactRuntimeApi) {
  return render(<I18nProvider><SideChatPanel runtime={value} cwd="/work" /></I18nProvider>);
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
  it("renders canonical messages, stream, tools, errors, and truncation without owning global chat", () => {
    const value = runtime(sideState({
      revision: 4,
      status: "running",
      runId: "run-1",
      messages: [
        { id: "u1", role: "user", text: "Question", textTruncated: false, thinkingTruncated: false },
        { id: "a1", role: "assistant", text: "**Answer**", thinking: "Reasoning", textTruncated: true, thinkingTruncated: false },
        { id: "t1", role: "toolResult", text: "tool output", toolName: "read", textTruncated: false, thinkingTruncated: false },
      ],
      messagesTruncated: true,
      stream: { text: "Streaming reply", thinking: "Working", textTruncated: false, thinkingTruncated: true },
      tools: [{ toolCallId: "tool-1", name: "search", status: "running", nameTruncated: false }],
      error: { code: "run_failed", message: "Side chat request failed" },
    }));
    mount(value);

    expect(screen.getByText("Question")).toBeTruthy();
    expect(screen.getByText("Answer")).toBeTruthy();
    expect(screen.getByTestId("side-chat-scroll").textContent).toContain("Streaming reply");
    expect(screen.getByText("search")).toBeTruthy();
    expect(screen.getByText("The side chat request failed.")).toBeTruthy();
    expect(screen.getAllByText("Some side chat content was truncated.").length).toBeGreaterThan(1);
    expect(document.querySelector(".chat-input-textarea")).toBeNull();
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
    fireEvent.keyDown(input, { key: "Enter", code: "Enter" });
    fireEvent.submit(input.closest("form")!);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith("conversation-1", "keep this");

    await act(async () => { rejectSend({ code: "timeout", message: "raw provider text", retryable: true }); });
    expect((input as HTMLTextAreaElement).value).toBe("keep this");
    expect(screen.getByRole("alert").textContent).toContain("timed out");
    expect(screen.getByRole("alert").textContent).not.toContain("raw provider text");
  });

  it("uses exact conversation and overlap identities for mode, reset, overlap, and stop", async () => {
    const setMode = vi.fn(async () => undefined);
    const reset = vi.fn(async () => "conversation-2");
    const overlap = vi.fn(async () => undefined);
    const abort = vi.fn(async () => ({ ok: true }));
    const value = runtime(sideState({
      status: "awaiting_overlap",
      runId: "run-7",
      pendingOverlap: { id: "overlap-3", runId: "run-7", path: "src/file.ts", pathTruncated: false },
    }), {
      sideChatSetMode: setMode,
      sideChatReset: reset,
      sideChatRespondOverlap: overlap,
      abortSideChat: abort,
    });
    mount(value);

    const editButton = screen.getByRole("button", { name: "Edit" });
    fireEvent.click(editButton);
    await waitFor(() => expect(setMode).toHaveBeenCalledWith("conversation-1", "edit"));
    const reforkButton = screen.getByRole("button", { name: "Refork from current conversation" }) as HTMLButtonElement;
    await waitFor(() => expect(reforkButton.disabled).toBe(false));
    fireEvent.click(reforkButton);
    await waitFor(() => expect(reset).toHaveBeenCalledWith("conversation-1", "refork"));
    const proceedButton = screen.getByRole("button", { name: "Proceed" }) as HTMLButtonElement;
    await waitFor(() => expect(proceedButton.disabled).toBe(false));
    fireEvent.click(proceedButton);
    await waitFor(() => expect(overlap).toHaveBeenCalledWith("conversation-1", "overlap-3", true));
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
    expect(input.disabled).toBe(true);

    const replacement = runtime(sideState(), { epoch: "epoch-2", attachGeneration: 2 });
    view.rerender(<I18nProvider><SideChatPanel runtime={replacement} cwd="/work" /></I18nProvider>);
    input = screen.getByRole("textbox", { name: "Side chat message" }) as HTMLTextAreaElement;
    expect(input.value).toBe("draft-before-reattach");
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
    view.rerender(<I18nProvider><SideChatPanel runtime={replacement} cwd="/work" /></I18nProvider>);
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
    view.rerender(<I18nProvider><SideChatPanel runtime={replacement} cwd="/work" /></I18nProvider>);
    const input = screen.getByRole("textbox", { name: "Side chat message" }) as HTMLTextAreaElement;
    expect(input.disabled).toBe(false);
    fireEvent.change(input, { target: { value: "new conversation draft" } });
    await act(async () => { reset.resolve("conversation-B"); });
    expect(input.value).toBe("new conversation draft");
    expect(input.disabled).toBe(false);
  });

  it("starts once for an uninitialized exact parent", async () => {
    const start = vi.fn(async () => "conversation-1");
    mount(runtime(null, { sideChatStart: start }));
    await waitFor(() => expect(start).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId("side-chat-panel")).toBeTruthy();
  });
});
