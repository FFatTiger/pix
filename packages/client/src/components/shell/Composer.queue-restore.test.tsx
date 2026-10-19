/** @vitest-environment jsdom */
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRef } from "react";
import { restoreQueueText } from "./Composer";
import { ChatInput, type ChatInputHandle } from "@/components/chat/ChatInput";
import { I18nProvider } from "@/hooks/useI18n";
import { clearDraft, getDraft, setDraft } from "@/lib/draft-store";
/**
 * `restoreQueueText` is the "clear_queue already emptied the runtime queue"
 * seam: whatever it does not hand back is lost for good. The editor instance
 * can be unmounted when an async restore resumes, so it must fall back to the
 * persisted draft instead of dropping the text.
 */
function handle(prepend = vi.fn()): ChatInputHandle {
  return {
    insertText: vi.fn(),
    insertIfEmpty: vi.fn(),
    promoteDraft: vi.fn(),
    replaceMessage: vi.fn(),
    prependText: prepend,
    addImages: vi.fn(),
    addFileMentions: vi.fn(),
  } as ChatInputHandle;
}

// jsdom has no ResizeObserver; the input's scroll-sync observer needs one.
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
  observe(): void { /* no-op */ }
  unobserve(): void { /* no-op */ }
  disconnect(): void { /* no-op */ }
};

afterEach(() => {
  clearDraft("s1");
});

describe("restoreQueueText", () => {
  it("prepends into the live editor and never touches the stored draft", () => {
    const prepend = vi.fn();
    expect(restoreQueueText(handle(prepend), "s1", "recalled text")).toBe(true);
    expect(prepend).toHaveBeenCalledWith("recalled text");
    // The editor owns its own draft-store write; a second write here would
    // let a concurrent editor save overwrite the recovered text.
    expect(getDraft("s1")).toBeNull();
  });

  it("falls back to the persisted draft when no editor is mounted", () => {
    expect(restoreQueueText(null, "s1", "recalled text")).toBe(true);
    expect(getDraft("s1")?.value).toBe("recalled text");
  });

  it("merges ahead of text the user already typed, keeping both", () => {
    setDraft("s1", { value: "typed before recall", images: [] });
    expect(restoreQueueText(null, "s1", "recalled text")).toBe(true);
    expect(getDraft("s1")?.value).toBe("recalled text\n\ntyped before recall");
  });

  it("preserves images the draft already staged", () => {
    setDraft("s1", { value: "", images: [{ data: "aGk=", mimeType: "image/png" }] });
    restoreQueueText(null, "s1", "recalled text");
    expect(getDraft("s1")?.images).toHaveLength(1);
  });

  it("reports the one case it truly cannot restore", () => {
    // No editor and no session key (a not-yet-created draft): the caller must
    // surface the failure instead of claiming the queue came back.
    expect(restoreQueueText(null, undefined, "recalled text")).toBe(false);
  });

  it("ignores blank text", () => {
    expect(restoreQueueText(null, "s1", "   ")).toBe(false);
    expect(getDraft("s1")).toBeNull();
  });

  it("a draft-only restore survives the remount that follows it", async () => {
    // The unmounted-composer case: the store is the only seam, so the next
    // mount must hydrate it into the editor instead of starting empty.
    expect(restoreQueueText(null, "s1", "recalled text")).toBe(true);
    const ref = createRef<ChatInputHandle>();
    render(
      <I18nProvider>
        <ChatInput ref={ref} draftKey="s1" isStreaming={false} onSend={() => true} onAbort={() => undefined} />
      </I18nProvider>,
    );
    await waitFor(() => {
      expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("recalled text");
    });
  });

  it("keeps items apart with a blank line, never gluing a body to the next message", () => {
    // A Pixie notice body is already multi-line; a single newline would merge
    // it into the user's own message as one draft.
    setDraft("s1", { value: "", images: [] });
    restoreQueueText(null, "s1", "会话: X\n结果: 完成\n\n我自己的消息");
    expect(getDraft("s1")?.value).toBe("会话: X\n结果: 完成\n\n我自己的消息");
  });
});
