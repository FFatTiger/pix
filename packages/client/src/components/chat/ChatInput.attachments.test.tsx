import { createRef, type ComponentPropsWithRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, createEvent, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { I18nProvider } from "@/hooks/useI18n";
import { ChatInput, type ChatInputHandle } from "./ChatInput";
import { MAX_IMAGE_ATTACHMENTS } from "@fffattiger/pix-protocol";
import { getDraft, setDraft } from "@/lib/draft-store";

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

type InputProps = Partial<ComponentPropsWithRef<typeof ChatInput>>;

const STORED = { path: "/store/notes.txt", name: "notes.txt" };

function uploadOk(result: { path: string; name: string } | { path: string; name: string }[] = STORED) {
  const results = Array.isArray(result) ? result : [result];
  let index = 0;
  return vi.fn(async () => {
    const next = results[index] ?? results[results.length - 1]!;
    index += 1;
    return next;
  });
}

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
    const uploadAttachment = uploadOk();
    const view = renderInput({ uploadAttachment });
    const file = new File(["hello"], "notes.txt", { type: "text/plain" });
    pickFiles(view, [file]);

    expect(await screen.findByText("notes.txt")).toBeTruthy();
    expect(uploadAttachment).not.toHaveBeenCalled();
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("");
  });

  it("removes a pending chip without sending", async () => {
    const uploadAttachment = vi.fn();
    const view = renderInput({ uploadAttachment });
    pickFiles(view, [new File(["hello"], "notes.txt", { type: "text/plain" })]);
    expect(await screen.findByText("notes.txt")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Remove file" }));
    expect(screen.queryByText("notes.txt")).toBeNull();
    expect(uploadAttachment).not.toHaveBeenCalled();
  });

  it("uploads on send and appends the stored-path marker", async () => {
    const nfdName = "\u00b0u\u0301_,.txt";
    expect(nfdName).not.toBe(nfdName.normalize("NFC"));
    const stored = { path: `/store/${nfdName}`, name: nfdName };
    const uploadAttachment = uploadOk(stored);
    const onSend = vi.fn().mockReturnValue(true);
    const view = renderInput({ uploadAttachment, attachmentScopeId: "session-1", onSend });
    const file = new File(["hello"], nfdName, { type: "text/plain" });
    pickFiles(view, [file]);
    expect(await screen.findByText(nfdName)).toBeTruthy();

    fireEvent.change(screen.getByRole("textbox"), { target: { value: "please read" } });
    fireEvent.click(screen.getByLabelText("Send message"));

    await waitFor(() => expect(uploadAttachment).toHaveBeenCalledWith(file, "session-1"));
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    expect(onSend.mock.calls[0]![0]).toBe(`please read\n\n[Attached file saved at: /store/${nfdName}]`);
    expect(onSend.mock.calls[0]![0]).not.toContain(nfdName.normalize("NFC"));
    expect(screen.queryByText(nfdName)).toBeNull();
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("");
  });

  it("writes the marker into the draft when send returns false", async () => {
    const uploadAttachment = uploadOk();
    const onSend = vi.fn().mockReturnValue(false);
    const view = renderInput({ uploadAttachment, onSend });
    pickFiles(view, [new File(["hello"], "notes.txt", { type: "text/plain" })]);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "retry me" } });
    fireEvent.click(screen.getByLabelText("Send message"));

    const marked = "retry me\n\n[Attached file saved at: /store/notes.txt]";
    await waitFor(() => expect(onSend).toHaveBeenCalledWith(marked, undefined, { rawValue: marked }));
    expect(screen.queryByText("notes.txt")).toBeNull();
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(marked);

    onSend.mockReturnValue(true);
    fireEvent.click(screen.getByLabelText("Send message"));
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(2));
    expect(uploadAttachment).toHaveBeenCalledTimes(1);
    expect(onSend.mock.calls[1]![0]).toBe(marked);
  });

  it("keeps the chip and text when upload is rejected", async () => {
    const uploadAttachment = vi.fn().mockRejectedValue(new Error("nope"));
    const onSend = vi.fn();
    const view = renderInput({ uploadAttachment, onSend });
    pickFiles(view, [new File(["hello"], "notes.txt", { type: "text/plain" })]);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "keep me" } });
    fireEvent.click(screen.getByLabelText("Send message"));

    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByText("notes.txt")).toBeTruthy();
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("keep me");
    expect(onSend).not.toHaveBeenCalled();
  });

  it("keeps the chip when the upload result has no path", async () => {
    const uploadAttachment = vi.fn().mockResolvedValue({ path: "", name: "notes.txt" });
    const onSend = vi.fn();
    const view = renderInput({ uploadAttachment, onSend });
    pickFiles(view, [new File(["hello"], "notes.txt", { type: "text/plain" })]);
    fireEvent.click(screen.getByLabelText("Send message"));

    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByText("notes.txt")).toBeTruthy();
    expect(onSend).not.toHaveBeenCalled();
  });

  it.each([
    new Error("send failed"),
    new TypeError("socket closed"),
    { code: "unavailable", message: "socket closed", retryable: false },
  ])("keeps the attachment committed and stays SILENT on an unproven send error: %s", async (cause) => {
    // The outbox retries anything that is not a proven-final rejection, so the
    // composer shows no send copy at all for these shapes.
    const uploadAttachment = uploadOk();
    const onSend = vi.fn(() => { throw cause; });
    const view = renderInput({ uploadAttachment, onSend });
    pickFiles(view, [new File(["hello"], "notes.txt", { type: "text/plain" })]);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "retry" } });
    fireEvent.click(screen.getByLabelText("Send message"));

    await waitFor(() => expect(screen.queryByText("notes.txt")).toBeNull());
    expect(screen.queryByRole("alert")).toBeNull();
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("");
    expect(uploadAttachment).toHaveBeenCalledTimes(1);
  });

  it("restores uploaded markers only when a callback proves pre-dispatch failure", async () => {
    const uploadAttachment = uploadOk();
    const onSend = vi.fn(() => { throw { phase: "activation", code: "invalid_input", retryable: false }; });
    const view = renderInput({ uploadAttachment, onSend });
    pickFiles(view, [new File(["hello"], "notes.txt", { type: "text/plain" })]);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "retry" } });
    fireEvent.click(screen.getByLabelText("Send message"));

    expect((await screen.findByRole("alert")).textContent).toContain("The message was not sent");
    await waitFor(() => expect(screen.queryByText("notes.txt")).toBeNull());
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("retry\n\n[Attached file saved at: /store/notes.txt]");
    expect(uploadAttachment).toHaveBeenCalledTimes(1);
  });

  it("stages a pasted non-image file without uploading", async () => {
    const uploadAttachment = vi.fn();
    renderInput({ uploadAttachment });
    const file = new File(["hello"], "notes.txt", { type: "text/plain" });
    const event = pasteFiles([file]);

    expect(event.defaultPrevented).toBe(true);
    expect(await screen.findByText("notes.txt")).toBeTruthy();
    expect(uploadAttachment).not.toHaveBeenCalled();
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("");
  });

  it("leaves text-only paste native", () => {
    renderInput({ uploadAttachment: vi.fn() });
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
    const uploadAttachment = vi.fn();
    renderInput({ uploadAttachment });
    const file = new File(["fake"], "photo.png", { type: "image/png" });
    const event = pasteFiles([file]);
    expect(event.defaultPrevented).toBe(true);
    await waitFor(() => expect(screen.getByRole("button", { name: "Remove image" })).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Remove file" })).toBeNull();
    expect(uploadAttachment).not.toHaveBeenCalled();
  });

  it("never resurrects text the user deleted, even when a restore wrote it", async () => {
    // A queue restore can write a draft from OUTSIDE the editor. The user's
    // later deletion must still win: the editor must not treat its own clear
    // as an external write and reload the text on the next switch.
    setDraft("restored-draft-a", { value: "recalled text", images: [] });
    const uploadAttachment = vi.fn();
    const view = renderInput({ uploadAttachment, draftKey: "restored-draft-a" });
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    await waitFor(() => expect(textarea.value).toBe("recalled text"));
    fireEvent.change(textarea, { target: { value: "" } });
    await waitFor(() => expect(getDraft("restored-draft-a")).toBeNull());
    view.rerender(inputTree({ uploadAttachment, draftKey: "restored-draft-b" }));
    view.rerender(inputTree({ uploadAttachment, draftKey: "restored-draft-a" }));
    await waitFor(() => expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(""));
    expect(getDraft("restored-draft-a")).toBeNull();
  });

  it("restores pending files when switching away from and back to a draft", async () => {
    const uploadAttachment = vi.fn();
    const view = renderInput({ uploadAttachment, draftKey: "files-draft-a" });
    pickFiles(view, [new File(["a"], "a.txt", { type: "text/plain" })]);
    expect(await screen.findByText("a.txt")).toBeTruthy();

    view.rerender(inputTree({ uploadAttachment, draftKey: "files-draft-b" }));
    await waitFor(() => expect(screen.queryByText("a.txt")).toBeNull());
    view.rerender(inputTree({ uploadAttachment, draftKey: "files-draft-a" }));
    expect(await screen.findByText("a.txt")).toBeTruthy();
    expect(uploadAttachment).not.toHaveBeenCalled();
  });

  it("migrates newer pending files through new-session promotion and remount", async () => {
    const uploadAttachment = vi.fn();
    const inputRef = createRef<ChatInputHandle>();
    const view = renderInput({ uploadAttachment, draftKey: "files-home-draft", ref: inputRef });
    pickFiles(view, [new File(["new"], "newer.txt", { type: "text/plain" })]);
    expect(await screen.findByText("newer.txt")).toBeTruthy();

    act(() => inputRef.current?.promoteDraft("files-real-session", "submitted text", 0));
    expect(screen.queryByText("newer.txt")).toBeNull();
    view.unmount();

    renderInput({ uploadAttachment, draftKey: "files-real-session" });
    expect(await screen.findByText("newer.txt")).toBeTruthy();
    expect(uploadAttachment).not.toHaveBeenCalled();
  });

  it("locks submitted chips while their upload is in flight", async () => {
    const upload = deferred<{ path: string; name: string }>();
    const uploadAttachment = vi.fn(() => upload.promise);
    const onSend = vi.fn().mockReturnValue(true);
    const view = renderInput({ uploadAttachment, onSend, draftKey: "files-locked-draft" });
    pickFiles(view, [new File(["a"], "locked.txt", { type: "text/plain" })]);
    fireEvent.click(screen.getByLabelText("Send message"));
    await waitFor(() => expect(uploadAttachment).toHaveBeenCalledTimes(1));

    const remove = screen.getByRole("button", { name: "Remove file" }) as HTMLButtonElement;
    expect(remove.disabled).toBe(true);
    fireEvent.click(remove);
    expect(screen.getByText("locked.txt")).toBeTruthy();

    await act(async () => { upload.resolve({ path: "/store/locked.txt", name: "locked.txt" }); await upload.promise; });
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
  });

  it("drops a late upload result after switching drafts", async () => {
    const upload = deferred<{ path: string; name: string }>();
    const uploadAttachment = vi.fn(() => upload.promise);
    const onSend = vi.fn().mockReturnValue(true);
    const view = renderInput({ uploadAttachment, onSend, draftKey: "session-a" });
    pickFiles(view, [new File(["a"], "a.txt", { type: "text/plain" })]);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "old draft" } });
    fireEvent.click(screen.getByLabelText("Send message"));
    await waitFor(() => expect(uploadAttachment).toHaveBeenCalledTimes(1));

    view.rerender(
      <I18nProvider>
        <ChatInput
          onSend={onSend}
          onAbort={() => {}}
          isStreaming={false}
          cwd="/project-b"
          draftKey="session-b"
          uploadAttachment={uploadAttachment}
        />
      </I18nProvider>,
    );
    await waitFor(() => expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(""));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "new draft" } });

    await act(async () => { upload.resolve({ path: "/store/a.txt", name: "a.txt" }); await upload.promise; });
    await waitFor(() => expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("new draft"));
    expect(onSend).not.toHaveBeenCalled();
  });

  it("drops a late upload result after the composer unmounts", async () => {
    const upload = deferred<{ path: string; name: string }>();
    const uploadAttachment = vi.fn(() => upload.promise);
    const onSend = vi.fn().mockReturnValue(true);
    const view = renderInput({ uploadAttachment, onSend, draftKey: "files-unmount-draft" });
    pickFiles(view, [new File(["a"], "a.txt", { type: "text/plain" })]);
    fireEvent.click(screen.getByLabelText("Send message"));
    await waitFor(() => expect(uploadAttachment).toHaveBeenCalledTimes(1));
    view.unmount();

    await act(async () => { upload.resolve({ path: "/store/a.txt", name: "a.txt" }); await upload.promise; });
    expect(onSend).not.toHaveBeenCalled();
  });

  it("clears only the submitted files when a newer file is staged during upload", async () => {
    const upload = deferred<{ path: string; name: string }>();
    const uploadAttachment = vi.fn(() => upload.promise);
    const onSend = vi.fn().mockReturnValue(true);
    const view = renderInput({ uploadAttachment, onSend, draftKey: "files-newer-draft" });
    pickFiles(view, [new File(["a"], "first.txt", { type: "text/plain" })]);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "send first" } });
    fireEvent.click(screen.getByLabelText("Send message"));
    await waitFor(() => expect(uploadAttachment).toHaveBeenCalledTimes(1));

    pickFiles(view, [new File(["b"], "second.txt", { type: "text/plain" })]);
    expect(await screen.findByText("second.txt")).toBeTruthy();
    await act(async () => { upload.resolve({ path: "/store/first.txt", name: "first.txt" }); await upload.promise; });

    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByText("first.txt")).toBeNull());
    expect(screen.getByText("second.txt")).toBeTruthy();
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("");
  });

  it("uploads a staged file before sending while the Agent runs (no streaming branch)", async () => {
    const uploadAttachment = uploadOk();
    const onSend = vi.fn().mockReturnValue(true);
    const view = renderInput({ uploadAttachment, isStreaming: true, onSend });
    pickFiles(view, [new File(["hello"], "notes.txt", { type: "text/plain" })]);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "during the run" } });
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });

    await waitFor(() => expect(uploadAttachment).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(onSend).toHaveBeenCalledWith(
      "during the run\n\n[Attached file saved at: /store/notes.txt]",
      undefined,
      expect.anything(),
    ));
    expect(screen.queryByText("notes.txt")).toBeNull();
  });

  it("sends while streaming instead of queueing through a separate channel", () => {
    const onSend = vi.fn().mockReturnValue(true);
    window.localStorage.setItem("pi-streaming-send-mode", "steer");
    renderInput({ isStreaming: true, onSend });
    const textarea = screen.getByRole("textbox");
    fireEvent.change(textarea, { target: { value: "during run" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(onSend).toHaveBeenCalledTimes(1);
  });


  it("references an in-project desktop file and uploads one outside the project", async () => {
    const uploadAttachment = uploadOk({ path: "/store/outside.txt", name: "outside.txt" });
    const onSend = vi.fn().mockReturnValue(true);
    vi.stubGlobal("piDesktop", {
      getPathForFile: (file: File) => file.name === "inside.txt" ? "/project/src/inside.txt" : "/other/outside.txt",
    });
    const view = renderInput({ uploadAttachment, onSend });
    const inside = new File(["in"], "inside.txt", { type: "text/plain" });
    const outside = new File(["out"], "outside.txt", { type: "text/plain" });
    pickFiles(view, [inside, outside]);
    expect(await screen.findByText("inside.txt")).toBeTruthy();
    expect(screen.getByText("outside.txt")).toBeTruthy();

    fireEvent.click(screen.getByLabelText("Send message"));
    await waitFor(() => expect(uploadAttachment).toHaveBeenCalledTimes(1));
    expect(uploadAttachment).toHaveBeenCalledWith(outside, undefined);
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    expect(onSend.mock.calls[0]![0]).toBe("@src/inside.txt \n\n[Attached file saved at: /store/outside.txt]");
  });

  it("uploads a new-session attachment with an undefined scope", async () => {
    const uploadAttachment = uploadOk();
    const onSend = vi.fn().mockReturnValue(true);
    const view = renderInput({ uploadAttachment, onSend });
    const file = new File(["hello"], "notes.txt", { type: "text/plain" });
    pickFiles(view, [file]);
    fireEvent.click(screen.getByLabelText("Send message"));
    await waitFor(() => expect(uploadAttachment).toHaveBeenCalledWith(file, undefined));
    await waitFor(() => expect(onSend.mock.calls[0]![0]).toBe("[Attached file saved at: /store/notes.txt]"));
  });

  it("keeps existing images when overlapping picker batches would exceed the count", async () => {
    const png = (name: string) => new File(["fake"], name, { type: "image/png" });
    const handle = createRef<ChatInputHandle>();
    render(
      <I18nProvider>
        <ChatInput ref={handle} onSend={() => true} onAbort={() => {}} isStreaming={false} />
      </I18nProvider>,
    );
    await act(async () => {
      handle.current?.addImages(Array.from({ length: MAX_IMAGE_ATTACHMENTS }, (_, index) => png(`keep-${index}.png`)));
    });
    await waitFor(() => expect(screen.getAllByRole("button", { name: "Remove image" })).toHaveLength(MAX_IMAGE_ATTACHMENTS));
    await act(async () => {
      handle.current?.addImages([png("ninth.png")]);
    });
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(screen.getAllByRole("button", { name: "Remove image" })).toHaveLength(MAX_IMAGE_ATTACHMENTS);
    expect(screen.getByRole("alert").textContent).toMatch(/at most 8/i);
  });
});
