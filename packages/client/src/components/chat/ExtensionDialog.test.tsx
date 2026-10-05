import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { I18nProvider } from "@/hooks/useI18n";
import { ExtensionDialog, type ExtensionDialogRequest, type ExtensionDialogResponse } from "./ExtensionDialog";

function wrap(node: React.ReactNode) {
  return render(<I18nProvider>{node}</I18nProvider>);
}

function inputRequest(): ExtensionDialogRequest {
  return { id: "r1", method: "input", title: "Name", placeholder: "type" };
}

function editorRequest(): ExtensionDialogRequest {
  return { id: "r2", method: "editor", title: "Edit", prefill: "seed" };
}

function makeRespond() {
  const onRespond = vi.fn((_request: ExtensionDialogRequest, _response: ExtensionDialogResponse) => undefined);
  return onRespond;
}

describe("ExtensionDialog — compact heading and complete prompt", () => {
  afterEach(cleanup);
  const title = `[Ask test] ${"A long question that must remain readable in full. ".repeat(10)}\nPreview details`;
  it.each<ExtensionDialogRequest>([
    { id: "select", method: "select", title, options: ["Coffee — freshly brewed", "Tea"] },
    { id: "confirm", method: "confirm", title, message: "Confirmation details" },
    { id: "input", method: "input", title, placeholder: "Your answer" },
    { id: "editor", method: "editor", title, prefill: "Draft answer" },
  ])("separates the $method prompt from its short accessible title", (request) => {
    const onRespond = makeRespond();
    wrap(<ExtensionDialog request={request} onRespond={onRespond} />);
    const dialog = screen.getByRole("dialog", { name: "Your response" });
    const heading = screen.getByRole("heading", { name: "Your response" });
    const prompt = document.getElementById(dialog.getAttribute("aria-describedby")!);
    expect(prompt?.textContent).toBe(title);
    expect(heading.parentElement?.contains(prompt)).toBe(false);
    if (request.method === "select") {
      fireEvent.click(screen.getByRole("button", { name: request.options[0]! }));
      expect(onRespond).toHaveBeenCalledWith(request, { value: request.options[0] });
    }
    if (request.method === "confirm") expect(screen.getByText(request.message)).toBeTruthy();
    if (request.method === "editor") expect(screen.getByDisplayValue("Draft answer")).toBeTruthy();
  });
});

describe("ExtensionDialog — IME-composition submit guard (F1)", () => {
  it("input Enter submits when not composing, with preventDefault", () => {
    const onRespond = makeRespond();
    wrap(<ExtensionDialog request={inputRequest()} onRespond={onRespond} />);
    const input = screen.getByPlaceholderText("type");
    const keyDown = fireEvent.keyDown(input, { key: "Enter", keyCode: 13 });
    expect(keyDown).toBe(false); // preventDefault was called
    expect(onRespond).toHaveBeenCalledTimes(1);
    expect(onRespond.mock.calls[0]![1]).toEqual({ value: "" });
    cleanup();
  });

  it("input Enter NEVER submits while IME is composing (nativeEvent.isComposing)", () => {
    const onRespond = makeRespond();
    wrap(<ExtensionDialog request={inputRequest()} onRespond={onRespond} />);
    const input = screen.getByPlaceholderText("type");
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    expect(onRespond).not.toHaveBeenCalled();
    cleanup();
  });

  it("input Enter NEVER submits during legacy IME composition (keyCode 229)", () => {
    const onRespond = makeRespond();
    wrap(<ExtensionDialog request={inputRequest()} onRespond={onRespond} />);
    const input = screen.getByPlaceholderText("type");
    fireEvent.keyDown(input, { key: "Enter", keyCode: 229 });
    expect(onRespond).not.toHaveBeenCalled();
    cleanup();
  });

  it("input Escape cancels with preventDefault", () => {
    const onRespond = makeRespond();
    wrap(<ExtensionDialog request={inputRequest()} onRespond={onRespond} />);
    const input = screen.getByPlaceholderText("type");
    const keyDown = fireEvent.keyDown(input, { key: "Escape", keyCode: 27 });
    expect(keyDown).toBe(false);
    expect(onRespond).toHaveBeenCalledWith(inputRequest(), { cancelled: true });
    cleanup();
  });

  it("editor Ctrl+Enter submits when not composing", () => {
    const onRespond = makeRespond();
    wrap(<ExtensionDialog request={editorRequest()} onRespond={onRespond} />);
    const textarea = screen.getByDisplayValue("seed");
    fireEvent.change(textarea, { target: { value: "edited text" } });
    const keyDown = fireEvent.keyDown(textarea, { key: "Enter", ctrlKey: true, keyCode: 13 });
    expect(keyDown).toBe(false); // preventDefault on the real submit
    expect(onRespond).toHaveBeenCalledTimes(1);
    expect(onRespond.mock.calls[0]![1]).toEqual({ value: "edited text" });
    cleanup();
  });

  it("editor Cmd+Enter submits when not composing", () => {
    const onRespond = makeRespond();
    wrap(<ExtensionDialog request={editorRequest()} onRespond={onRespond} />);
    const textarea = screen.getByDisplayValue("seed");
    fireEvent.keyDown(textarea, { key: "Enter", metaKey: true, keyCode: 13 });
    expect(onRespond).toHaveBeenCalledTimes(1);
    cleanup();
  });

  it("editor Ctrl+Enter NEVER submits while IME is composing", () => {
    const onRespond = makeRespond();
    wrap(<ExtensionDialog request={editorRequest()} onRespond={onRespond} />);
    const textarea = screen.getByDisplayValue("seed");
    fireEvent.keyDown(textarea, { key: "Enter", ctrlKey: true, isComposing: true });
    expect(onRespond).not.toHaveBeenCalled();
    cleanup();
  });

  it("editor Cmd+Enter NEVER submits during legacy IME composition (keyCode 229)", () => {
    const onRespond = makeRespond();
    wrap(<ExtensionDialog request={editorRequest()} onRespond={onRespond} />);
    const textarea = screen.getByDisplayValue("seed");
    fireEvent.keyDown(textarea, { key: "Enter", metaKey: true, keyCode: 229 });
    expect(onRespond).not.toHaveBeenCalled();
    cleanup();
  });

  it("editor Escape cancels with preventDefault", () => {
    const onRespond = makeRespond();
    wrap(<ExtensionDialog request={editorRequest()} onRespond={onRespond} />);
    const textarea = screen.getByDisplayValue("seed");
    const keyDown = fireEvent.keyDown(textarea, { key: "Escape", keyCode: 27 });
    expect(keyDown).toBe(false);
    expect(onRespond).toHaveBeenCalledWith(editorRequest(), { cancelled: true });
    cleanup();
  });
});

describe("ExtensionDialog — draft retention across cloned request snapshots", () => {
  afterEach(cleanup);

  it("keeps a typed input draft when the same request is structuredClone-refreshed and submits that draft", () => {
    const onRespond = makeRespond();
    const request = inputRequest();
    const { rerender } = wrap(<ExtensionDialog request={request} onRespond={onRespond} />);
    const input = screen.getByPlaceholderText("type");
    fireEvent.change(input, { target: { value: "custom answer" } });
    expect((input as HTMLInputElement).value).toBe("custom answer");

    rerender(
      <I18nProvider>
        <ExtensionDialog request={structuredClone(request)} onRespond={onRespond} />
      </I18nProvider>,
    );
    const refreshed = screen.getByPlaceholderText("type") as HTMLInputElement;
    expect(refreshed.value).toBe("custom answer");
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    expect(onRespond).toHaveBeenCalledTimes(1);
    expect(onRespond.mock.calls[0]![1]).toEqual({ value: "custom answer" });
  });

  it("keeps editor edits when the same prefill request is structuredClone-refreshed", () => {
    const onRespond = makeRespond();
    const request = editorRequest();
    const { rerender } = wrap(<ExtensionDialog request={request} onRespond={onRespond} />);
    const textarea = screen.getByDisplayValue("seed");
    fireEvent.change(textarea, { target: { value: "edited seed" } });

    rerender(
      <I18nProvider>
        <ExtensionDialog request={structuredClone(request)} onRespond={onRespond} />
      </I18nProvider>,
    );
    const refreshed = screen.getByDisplayValue("edited seed") as HTMLTextAreaElement;
    expect(refreshed.value).toBe("edited seed");
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    expect(onRespond.mock.calls[0]![1]).toEqual({ value: "edited seed" });
  });

  it("initializes a new request id without leaking the previous draft", () => {
    const onRespond = makeRespond();
    const { rerender } = wrap(<ExtensionDialog request={inputRequest()} onRespond={onRespond} />);
    fireEvent.change(screen.getByPlaceholderText("type"), { target: { value: "old draft" } });

    rerender(
      <I18nProvider>
        <ExtensionDialog request={{ id: "r-new", method: "input", title: "Next", placeholder: "type" }} onRespond={onRespond} />
      </I18nProvider>,
    );
    const next = screen.getByPlaceholderText("type") as HTMLInputElement;
    expect(next.value).toBe("");
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    expect(onRespond.mock.calls[0]![1]).toEqual({ value: "" });
  });

  it("resets immediately when the method changes on the same request id", () => {
    const onRespond = makeRespond();
    const { rerender } = wrap(<ExtensionDialog request={inputRequest()} onRespond={onRespond} />);
    fireEvent.change(screen.getByPlaceholderText("type"), { target: { value: "typed" } });

    rerender(
      <I18nProvider>
        <ExtensionDialog request={{ id: "r1", method: "editor", title: "Edit", prefill: "fresh prefill" }} onRespond={onRespond} />
      </I18nProvider>,
    );
    expect((screen.getByDisplayValue("fresh prefill") as HTMLTextAreaElement).value).toBe("fresh prefill");
  });
});
