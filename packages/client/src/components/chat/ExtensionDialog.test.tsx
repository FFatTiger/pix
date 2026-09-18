import { describe, expect, it, vi } from "vitest";
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
