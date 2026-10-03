import { createRef, type ComponentPropsWithRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, createEvent, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { I18nProvider } from "@/hooks/useI18n";
import { ChatInput, type ChatInputHandle } from "./ChatInput";

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

type InputProps = Partial<ComponentPropsWithRef<typeof ChatInput>>;

function inputTree(props: InputProps = {}) {
  return (
    <I18nProvider>
      <ChatInput
        onSend={() => true}
        onAbort={() => {}}
        isStreaming={false}
        cwd="/project"
        {...props}
      />
    </I18nProvider>
  );
}

function renderInput(props: InputProps = {}) {
  return render(inputTree(props));
}

function pickFiles(view: ReturnType<typeof render>, files: File[]) {
  fireEvent.click(screen.getByLabelText("Add context"));
  fireEvent.click(screen.getByRole("button", { name: "Upload files" }));
  const uploadInput = view.container.querySelector<HTMLInputElement>('input[type="file"]:not([accept])');
  expect(uploadInput).toBeTruthy();
  fireEvent.change(uploadInput!, { target: { files } });
}

function pasteFiles(files: File[], extras?: { items?: Array<{ kind: string; type: string; getAsFile: () => File | null }> }) {
  const textarea = screen.getByRole("textbox");
  const items = extras?.items ?? files.map((file) => ({
    kind: "file",
    type: file.type,
    getAsFile: () => file,
  }));
  const fileList = Object.assign(files.slice(), {
    item: (index: number) => files[index] ?? null,
  });
  const event = createEvent.paste(textarea);
  Object.defineProperty(event, "clipboardData", {
    value: { files: fileList, items },
  });
  fireEvent(textarea, event);
  return event;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("ChatInput pending file attachments", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.localStorage.setItem("pi-locale", "en");
    vi.stubGlobal("ResizeObserver", ResizeObserverStub);
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({
      matches: false,
      media: "",
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: vi.fn(() => "blob:pending-file"),
      revokeObjectURL: vi.fn(),
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("shows a chip from the picker and does not upload until send", async () => {
    const uploadFiles = vi.fn().mockResolvedValue(["notes.txt"]);
    const view = renderInput({ uploadFiles });
    const file = new File(["hello"], "notes.txt", { type: "text/plain" });
    pickFiles(view, [file]);

    expect(await screen.findByText("notes.txt")).toBeTruthy();
    expect(uploadFiles).not.toHaveBeenCalled();
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("");
  });

  it("removes a pending chip without sending", async () => {
    const uploadFiles = vi.fn();
    const view = renderInput({ uploadFiles });
    pickFiles(view, [new File(["hello"], "notes.txt", { type: "text/plain" })]);
    expect(await screen.findByText("notes.txt")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Remove file" }));
    expect(screen.queryByText("notes.txt")).toBeNull();
    expect(uploadFiles).not.toHaveBeenCalled();
  });

  it("uploads on send and appends the exact Unicode mention", async () => {
    const nfdName = "\u00b0u\u0301_,.txt";
    expect(nfdName).not.toBe(nfdName.normalize("NFC"));
    const uploadFiles = vi.fn().mockImplementation(async (files: File[]) => files.map((file) => file.name));
    const onSend = vi.fn().mockReturnValue(true);
    const view = renderInput({ uploadFiles, onSend });
    const file = new File(["hello"], nfdName, { type: "text/plain" });
    pickFiles(view, [file]);
    expect(await screen.findByText(nfdName)).toBeTruthy();

    fireEvent.change(screen.getByRole("textbox"), { target: { value: "please read" } });
    fireEvent.click(screen.getByLabelText("Send message"));

    await waitFor(() => expect(uploadFiles).toHaveBeenCalledWith([file], "/project"));
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    expect(onSend.mock.calls[0]![0]).toBe(`please read @${nfdName} `);
    expect(onSend.mock.calls[0]![0]).not.toContain(nfdName.normalize("NFC"));
    expect(screen.queryByText(nfdName)).toBeNull();
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("");
  });

  it("converts uploaded files into mention text when send returns false", async () => {
    const uploadFiles = vi.fn().mockResolvedValue(["notes.txt"]);
    const onSend = vi.fn().mockReturnValue(false);
    const view = renderInput({ uploadFiles, onSend });
    pickFiles(view, [new File(["hello"], "notes.txt", { type: "text/plain" })]);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "retry me" } });
    fireEvent.click(screen.getByLabelText("Send message"));

    await waitFor(() => expect(onSend).toHaveBeenCalledWith("retry me @notes.txt ", undefined, { rawValue: "retry me @notes.txt " }));
    expect(screen.queryByText("notes.txt")).toBeNull();
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("retry me @notes.txt ");

    onSend.mockReturnValue(true);
    fireEvent.click(screen.getByLabelText("Send message"));
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(2));
    expect(uploadFiles).toHaveBeenCalledTimes(1);
    expect(onSend.mock.calls[1]![0]).toBe("retry me @notes.txt");
  });

  it("keeps the chip and text when upload is rejected", async () => {
    const uploadFiles = vi.fn().mockRejectedValue(new Error("nope"));
    const onSend = vi.fn();
    const view = renderInput({ uploadFiles, onSend });
    pickFiles(view, [new File(["hello"], "notes.txt", { type: "text/plain" })]);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "keep me" } });
    fireEvent.click(screen.getByLabelText("Send message"));

    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByText("notes.txt")).toBeTruthy();
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("keep me");
    expect(onSend).not.toHaveBeenCalled();
  });

  it("keeps the chip when the upload result is incomplete", async () => {
    const uploadFiles = vi.fn().mockResolvedValue([]);
    const onSend = vi.fn();
    const view = renderInput({ uploadFiles, onSend });
    pickFiles(view, [new File(["hello"], "notes.txt", { type: "text/plain" })]);
    fireEvent.click(screen.getByLabelText("Send message"));

    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByText("notes.txt")).toBeTruthy();
    expect(onSend).not.toHaveBeenCalled();
  });

  it("converts uploaded files to mention text when the send callback throws", async () => {
    const uploadFiles = vi.fn().mockResolvedValue(["notes.txt"]);
    const onSend = vi.fn(() => { throw new Error("send failed"); });
    const view = renderInput({ uploadFiles, onSend });
    pickFiles(view, [new File(["hello"], "notes.txt", { type: "text/plain" })]);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "retry" } });
    fireEvent.click(screen.getByLabelText("Send message"));

    expect(await screen.findByRole("alert")).toBeTruthy();
    await waitFor(() => expect(screen.queryByText("notes.txt")).toBeNull());
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("retry @notes.txt ");
    expect(uploadFiles).toHaveBeenCalledTimes(1);
  });

  it("stages a pasted non-image file without uploading", async () => {
    const uploadFiles = vi.fn();
    renderInput({ uploadFiles });
    const file = new File(["hello"], "notes.txt", { type: "text/plain" });
    const event = pasteFiles([file]);

    expect(event.defaultPrevented).toBe(true);
    expect(await screen.findByText("notes.txt")).toBeTruthy();
    expect(uploadFiles).not.toHaveBeenCalled();
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("");
  });

  it("leaves text-only paste native", () => {
    renderInput({ uploadFiles: vi.fn() });
    const event = pasteFiles([], { items: [{ kind: "string", type: "text/plain", getAsFile: () => null }] });
    expect(event.defaultPrevented).toBe(false);
    expect(screen.queryByRole("button", { name: "Remove file" })).toBeNull();
  });

  it("leaves file paste native when the composer has no upload seam", () => {
    renderInput();
    const event = pasteFiles([new File(["hello"], "notes.txt", { type: "text/plain" })]);
    expect(event.defaultPrevented).toBe(false);
    expect(screen.queryByRole("button", { name: "Remove file" })).toBeNull();
  });

  it("leaves a mixed image/file paste native when ordinary files cannot be staged", () => {
    renderInput();
    const event = pasteFiles([
      new File(["image"], "photo.png", { type: "image/png" }),
      new File(["text"], "notes.txt", { type: "text/plain" }),
    ]);
    expect(event.defaultPrevented).toBe(false);
    expect(screen.queryByRole("button", { name: "Remove image" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Remove file" })).toBeNull();
  });

  it("keeps image paste on the image path", async () => {
    const uploadFiles = vi.fn();
    renderInput({ uploadFiles });
    const file = new File(["fake"], "photo.png", { type: "image/png" });
    const event = pasteFiles([file]);
    expect(event.defaultPrevented).toBe(true);
    await waitFor(() => expect(screen.getByRole("button", { name: "Remove image" })).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Remove file" })).toBeNull();
    expect(uploadFiles).not.toHaveBeenCalled();
  });

  it("restores pending files when switching away from and back to a draft", async () => {
    const uploadFiles = vi.fn();
    const view = renderInput({ uploadFiles, draftKey: "files-draft-a" });
    pickFiles(view, [new File(["a"], "a.txt", { type: "text/plain" })]);
    expect(await screen.findByText("a.txt")).toBeTruthy();

    view.rerender(inputTree({ uploadFiles, draftKey: "files-draft-b" }));
    await waitFor(() => expect(screen.queryByText("a.txt")).toBeNull());
    view.rerender(inputTree({ uploadFiles, draftKey: "files-draft-a" }));
    expect(await screen.findByText("a.txt")).toBeTruthy();
    expect(uploadFiles).not.toHaveBeenCalled();
  });

  it("migrates newer pending files through new-session promotion and remount", async () => {
    const uploadFiles = vi.fn();
    const inputRef = createRef<ChatInputHandle>();
    const view = renderInput({ uploadFiles, draftKey: "files-home-draft", ref: inputRef });
    pickFiles(view, [new File(["new"], "newer.txt", { type: "text/plain" })]);
    expect(await screen.findByText("newer.txt")).toBeTruthy();

    act(() => inputRef.current?.promoteDraft("files-real-session", "submitted text", 0));
    expect(screen.queryByText("newer.txt")).toBeNull();
    view.unmount();

    renderInput({ uploadFiles, draftKey: "files-real-session" });
    expect(await screen.findByText("newer.txt")).toBeTruthy();
    expect(uploadFiles).not.toHaveBeenCalled();
  });

  it("locks submitted chips while their upload is in flight", async () => {
    const upload = deferred<string[]>();
    const uploadFiles = vi.fn(() => upload.promise);
    const onSend = vi.fn().mockReturnValue(true);
    const view = renderInput({ uploadFiles, onSend, draftKey: "files-locked-draft" });
    pickFiles(view, [new File(["a"], "locked.txt", { type: "text/plain" })]);
    fireEvent.click(screen.getByLabelText("Send message"));
    await waitFor(() => expect(uploadFiles).toHaveBeenCalledTimes(1));

    const remove = screen.getByRole("button", { name: "Remove file" }) as HTMLButtonElement;
    expect(remove.disabled).toBe(true);
    fireEvent.click(remove);
    expect(screen.getByText("locked.txt")).toBeTruthy();

    await act(async () => { upload.resolve(["locked.txt"]); await upload.promise; });
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
  });

  it("drops a late upload result after switching drafts", async () => {
    const upload = deferred<string[]>();
    const uploadFiles = vi.fn(() => upload.promise);
    const onSend = vi.fn().mockReturnValue(true);
    const view = renderInput({ uploadFiles, onSend, draftKey: "session-a" });
    pickFiles(view, [new File(["a"], "a.txt", { type: "text/plain" })]);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "old draft" } });
    fireEvent.click(screen.getByLabelText("Send message"));
    await waitFor(() => expect(uploadFiles).toHaveBeenCalledTimes(1));

    view.rerender(
      <I18nProvider>
        <ChatInput
          onSend={onSend}
          onAbort={() => {}}
          isStreaming={false}
          cwd="/project-b"
          draftKey="session-b"
          uploadFiles={uploadFiles}
        />
      </I18nProvider>,
    );
    await waitFor(() => expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(""));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "new draft" } });

    await act(async () => { upload.resolve(["a.txt"]); await upload.promise; });
    await waitFor(() => expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("new draft"));
    expect(onSend).not.toHaveBeenCalled();
  });

  it("drops a late upload result after the composer unmounts", async () => {
    const upload = deferred<string[]>();
    const uploadFiles = vi.fn(() => upload.promise);
    const onSend = vi.fn().mockReturnValue(true);
    const view = renderInput({ uploadFiles, onSend, draftKey: "files-unmount-draft" });
    pickFiles(view, [new File(["a"], "a.txt", { type: "text/plain" })]);
    fireEvent.click(screen.getByLabelText("Send message"));
    await waitFor(() => expect(uploadFiles).toHaveBeenCalledTimes(1));
    view.unmount();

    await act(async () => { upload.resolve(["a.txt"]); await upload.promise; });
    expect(onSend).not.toHaveBeenCalled();
  });

  it("clears only the submitted files when a newer file is staged during upload", async () => {
    const upload = deferred<string[]>();
    const uploadFiles = vi.fn(() => upload.promise);
    const onSend = vi.fn().mockReturnValue(true);
    const view = renderInput({ uploadFiles, onSend, draftKey: "files-newer-draft" });
    pickFiles(view, [new File(["a"], "first.txt", { type: "text/plain" })]);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "send first" } });
    fireEvent.click(screen.getByLabelText("Send message"));
    await waitFor(() => expect(uploadFiles).toHaveBeenCalledTimes(1));

    pickFiles(view, [new File(["b"], "second.txt", { type: "text/plain" })]);
    expect(await screen.findByText("second.txt")).toBeTruthy();
    await act(async () => { upload.resolve(["first.txt"]); await upload.promise; });

    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByText("first.txt")).toBeNull());
    expect(screen.getByText("second.txt")).toBeTruthy();
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("");
  });

  it("uploads a staged file before a streaming slash follow-up", async () => {
    const uploadFiles = vi.fn().mockResolvedValue(["notes.txt"]);
    const onPromptWithStreamingBehavior = vi.fn();
    const view = renderInput({
      uploadFiles,
      isStreaming: true,
      onFollowUp: vi.fn(),
      onPromptWithStreamingBehavior,
    });
    pickFiles(view, [new File(["hello"], "notes.txt", { type: "text/plain" })]);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "/skill:test" } });
    fireEvent.click(screen.getByLabelText("Follow-up"));

    await waitFor(() => expect(uploadFiles).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(onPromptWithStreamingBehavior).toHaveBeenCalledWith(
      "/skill:test @notes.txt ",
      "followUp",
      undefined,
    ));
  });

  it("uploads a staged file before a streaming follow-up", async () => {
    const uploadFiles = vi.fn().mockResolvedValue(["notes.txt"]);
    const onFollowUp = vi.fn();
    const view = renderInput({
      uploadFiles,
      isStreaming: true,
      onFollowUp,
      onSteer: vi.fn(),
    });
    pickFiles(view, [new File(["hello"], "notes.txt", { type: "text/plain" })]);
    expect(await screen.findByText("notes.txt")).toBeTruthy();
    expect(uploadFiles).not.toHaveBeenCalled();

    fireEvent.click(screen.getByLabelText("Follow-up"));
    await waitFor(() => expect(uploadFiles).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(onFollowUp).toHaveBeenCalledWith("@notes.txt ", undefined));
    expect(screen.queryByText("notes.txt")).toBeNull();
  });
});
