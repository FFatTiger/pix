import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, cleanup, act, fireEvent, waitFor } from "@testing-library/react";
import { useRef, useEffect, type ReactNode } from "react";
import { RuntimeProvider, useRuntimeStore } from "@/runtime/runtime-provider";
import { CapabilityProvider } from "@/features/capability/CapabilityProvider";
import { HttpClientProvider } from "@/app/http-context";
import { ErrorBoundary } from "@/app/ErrorBoundary";
import { ExtensionRequests } from "./ExtensionRequests";
import { Composer } from "@/components/shell/Composer";
import { FakeWebSocket, flush, lastFrame, snapshotPayload } from "@/runtime/testing/harness";
import type { RuntimeSocketDeps } from "@/runtime/socket";
import type { HostInfo } from "@fffattiger/pix-protocol";
import type { SessionStore } from "@/runtime/session-store";

const EXT_CAPS = ["runtime.prompt", "runtime.abort", "runtime.extension_ui"];

const SOCKETS: FakeWebSocket[] = [];
function fakeDeps(): RuntimeSocketDeps {
  return {
    createWebSocket: (url) => { const ws = new FakeWebSocket(url); SOCKETS.push(ws); return ws; },
    now: () => Date.now(),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    random: () => 0.5,
    location: { href: "https://pix.local/app/" },
    identity: { shell: "web", platform: "mac" },
    onOnline: () => () => undefined,
    onVisible: () => () => undefined,
  };
}

let capturedStore: SessionStore | null = null;
function Capture(): null {
  const store = useRuntimeStore();
  useEffect(() => { capturedStore = store; }, [store]);
  return null;
}

function mount(children: ReactNode, host: Partial<HostInfo> | null | undefined = { mode: "local", capabilities: ["agent"] }): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <ErrorBoundary>
      <QueryClientProvider client={qc}>
        <HttpClientProvider>
          <CapabilityProvider {...(host === undefined ? {} : { host })}>
            <RuntimeProvider deps={fakeDeps()}>
              <Capture />
              {children}
            </RuntimeProvider>
          </CapabilityProvider>
        </HttpClientProvider>
      </QueryClientProvider>
    </ErrorBoundary>,
  );
}

function ack(caps: string[] = ["agent"]) {
  return { type: "handshake_ack", payload: { protocolVersion: 1, host: { mode: "local", capabilities: caps }, limits: { maxUpload: 0, maxOpenSessions: 4 }, sessionSnapshotSupport: true } };
}

async function driveAttach(sessionId = "s1", runtimeCaps = EXT_CAPS): Promise<FakeWebSocket> {
  const store = capturedStore!;
  await act(async () => {
    store.connect();
    const ws = SOCKETS[SOCKETS.length - 1]!;
    ws.serverOpen();
    ws.serverSend(ack());
    await flush();
    void store.openSession(sessionId);
    await flush();
    const attachFrame = lastFrame<{ type: string; id: string }>(ws, "attach")!;
    ws.serverSend({ type: "snapshot", id: attachFrame.id, payload: snapshotPayload({ sessionId, capabilities: runtimeCaps }) });
    await flush();
  });
  return SOCKETS[SOCKETS.length - 1]!;
}

async function pushRequest(ws: FakeWebSocket, request: unknown, eventId = 1, sessionId = "s1"): Promise<void> {
  await act(async () => {
    ws.serverSend({ type: "event", payload: { type: "extension_ui_request", sessionId, request, eventId, epoch: "e1" } });
    await flush();
  });
}

async function closeRequest(ws: FakeWebSocket, request: { id: string }, eventId = 2, sessionId = "s1"): Promise<void> {
  await act(async () => {
    ws.serverSend({ type: "event", payload: { type: "extension_ui_request", sessionId, request: { ...request, closed: true }, eventId, epoch: "e1" } });
    await flush();
  });
}

interface ExtReplyFrame {
  type: string;
  id: string;
  payload: { sessionId: string; command: { commandId: string; type: string; id: string; method: string; responseKind: string; selected?: string; confirmed?: boolean; value?: string; cancelled?: boolean } };
}

function extReplies(ws: FakeWebSocket): ExtReplyFrame[] {
  return (ws.sent as ExtReplyFrame[]).filter((f) => f.type === "command" && f.payload.command.type === "extension_ui_response");
}

function extInputs(ws: FakeWebSocket): unknown[] {
  return (ws.sent as { payload?: { command?: { type?: string } } }[]).filter((f) => f.payload?.command?.type === "extension_ui_input");
}

async function ackExtReply(ws: FakeWebSocket, frame: ExtReplyFrame): Promise<void> {
  await act(async () => {
    ws.serverSend({ type: "response", id: frame.id, payload: { ok: true, result: { commandId: frame.payload.command.commandId, result: { ok: true, type: "extension_ui_response" } } } });
    await flush();
  });
}

const CONFIRM = { id: "c1", method: "confirm", title: "Proceed?", message: "Continue the operation?" };
const SELECT = { id: "s1", method: "select", title: "Pick one", options: ["Alpha", "Beta"] };
const INPUT = { id: "i1", method: "input", title: "Name", placeholder: "Enter name" };
const EDITOR = { id: "e1", method: "editor", title: "Edit", prefill: "seed text" };
const CUSTOM = { id: "u1", method: "custom", lines: ["<b>bold</b>", "second & line"] };
const NOTIFY = { id: "n1", method: "notify", message: "note", notifyType: "info" };

describe("ExtensionRequests — all five interactive forms", () => {
  beforeEach(() => { SOCKETS.length = 0; capturedStore = null; });
  afterEach(() => { cleanup(); });

  it("renders confirm title+message with Confirm/Cancel and Cancel focused by default", async () => {
    mount(<ExtensionRequests live />);
    const ws = await driveAttach();
    await pushRequest(ws, CONFIRM);
    expect(screen.getByRole("region", { name: "Extension request" })).toBeTruthy();
    expect(screen.getByText("Proceed?")).toBeTruthy();
    expect(screen.getByText("Continue the operation?")).toBeTruthy();
    const confirm = screen.getByRole("button", { name: "Confirm" });
    const cancel = screen.getByRole("button", { name: "Cancel" });
    expect(confirm).toBeTruthy();
    expect(cancel).toBeTruthy();
    expect(document.activeElement).toBe(cancel);
  });

  it("renders select options as list buttons with no preselected auto-submit; explicit option click sends selected", async () => {
    mount(<ExtensionRequests live />);
    const ws = await driveAttach();
    await pushRequest(ws, SELECT);
    expect(screen.getByRole("button", { name: "Alpha" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Beta" })).toBeTruthy();
    expect(extReplies(ws)).toHaveLength(0); // no auto-submit on arrival
    fireEvent.click(screen.getByRole("button", { name: "Beta" }));
    await flush();
    const replies = extReplies(ws);
    expect(replies).toHaveLength(1);
    expect(replies[0]!.payload.command).toMatchObject({ id: "s1", method: "select", responseKind: "selected", selected: "Beta" });
  });

  it("renders input with placeholder; Enter submits non-empty; empty only by explicit Submit", async () => {
    mount(<ExtensionRequests live />);
    const ws = await driveAttach();
    await pushRequest(ws, INPUT);
    const input = screen.getByRole("textbox", { name: "Name" }) as HTMLInputElement;
    expect(input.placeholder).toBe("Enter name");

    // Enter with an empty draft must NOT submit.
    fireEvent.keyDown(input, { key: "Enter" });
    await flush();
    expect(extReplies(ws)).toHaveLength(0);

    // Explicit Submit with empty value IS allowed (empty string only by explicit submit).
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    await flush();
    let replies = extReplies(ws);
    expect(replies).toHaveLength(1);
    expect(replies[0]!.payload.command).toMatchObject({ id: "i1", method: "input", responseKind: "value", value: "" });
    await ackExtReply(ws, replies[0]!);
    await closeRequest(ws, INPUT);

    // A fresh request: Enter with text submits.
    await pushRequest(ws, INPUT, 3);
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "typed value" } });
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Name" }), { key: "Enter" });
    await flush();
    replies = extReplies(ws);
    expect(replies[replies.length - 1]!.payload.command).toMatchObject({ id: "i1", method: "input", responseKind: "value", value: "typed value" });
  });

  it("renders editor with prefill seeded once; plain Enter is a newline, Cmd+Enter submits", async () => {
    mount(<ExtensionRequests live />);
    const ws = await driveAttach();
    await pushRequest(ws, EDITOR);
    const editor = screen.getByRole("textbox", { name: "Edit" }) as HTMLTextAreaElement;
    expect(editor.value).toBe("seed text"); // prefill seeded once

    // Plain Enter inserts a newline (no submit) and keeps the draft.
    fireEvent.keyDown(editor, { key: "Enter" });
    await flush();
    expect(extReplies(ws)).toHaveLength(0);

    // Cmd+Enter submits the current draft.
    fireEvent.keyDown(editor, { key: "Enter", metaKey: true });
    await flush();
    const replies = extReplies(ws);
    expect(replies).toHaveLength(1);
    expect(replies[0]!.payload.command).toMatchObject({ id: "e1", method: "editor", responseKind: "value", value: "seed text" });

    // Re-emit the SAME request (replay) must NOT reset the draft to the prefill.
    await ackExtReply(ws, replies[0]!);
    await closeRequest(ws, EDITOR);
    await pushRequest(ws, EDITOR, 3);
    const editor2 = screen.getByRole("textbox", { name: "Edit" }) as HTMLTextAreaElement;
    fireEvent.change(editor2, { target: { value: "user draft" } });
    fireEvent.change(editor2, { target: { value: "user draft" } });
    expect(editor2.value).toBe("user draft");
  });

  it("renders custom lines strictly as text nodes (no HTML) with a neutral blank fallback", async () => {
    mount(<ExtensionRequests live />);
    const ws = await driveAttach();
    await pushRequest(ws, CUSTOM);
    const line1 = screen.getByText("<b>bold</b>");
    expect(line1.tagName).toBe("P");
    expect(line1.querySelector("b")).toBeNull(); // never rendered as HTML
    expect(screen.getByText("second & line")).toBeTruthy();

    // Blank custom lines fall back to a neutral fixed placeholder.
    await closeRequest(ws, CUSTOM);
    await pushRequest(ws, { id: "u2", method: "custom", lines: [] }, 3);
    expect(screen.getByText("(no content)")).toBeTruthy();
  });
});

describe("ExtensionRequests — capability/live gates + deterministic multi-request", () => {
  beforeEach(() => { SOCKETS.length = 0; capturedStore = null; });
  afterEach(() => { cleanup(); });

  it("renders nothing without the runtime.extension_ui capability", async () => {
    mount(<ExtensionRequests live />);
    const ws = await driveAttach("s1", ["runtime.prompt", "runtime.abort"]);
    await pushRequest(ws, CONFIRM);
    expect(screen.queryByRole("region", { name: "Extension request" })).toBeNull();
    expect(extReplies(ws)).toHaveLength(0);
  });

  it("renders nothing when not live", async () => {
    mount(<ExtensionRequests live={false} />);
    const ws = await driveAttach();
    await pushRequest(ws, CONFIRM);
    expect(screen.queryByRole("region", { name: "Extension request" })).toBeNull();
  });

  it("stacks multiple requests deterministically; only the first is operable, later disabled with a waiting note", async () => {
    mount(<ExtensionRequests live />);
    const ws = await driveAttach();
    await pushRequest(ws, CONFIRM, 1);
    await pushRequest(ws, INPUT, 2);
    const cards = screen.getAllByRole("article");
    expect(cards).toHaveLength(2);

    // First card operable: its Cancel is enabled and the active card is present.
    expect((screen.getAllByRole("button", { name: "Cancel" })[0] as HTMLButtonElement).disabled).toBe(false);
    // Second card controls disabled with a waiting note.
    expect((screen.getAllByRole("button", { name: "Cancel" })[1] as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Submit" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Waiting for the previous extension request to finish.")).toBeTruthy();

    // Deterministic order preserved in the DOM (first = confirm, then input).
    const titles = cards.map((card) => card.textContent ?? "");
    expect(titles[0]).toContain("Proceed?");
    expect(titles[1]).toContain("Name");

    // Responding to the first frees the second to become operable after it closes.
    fireEvent.click(screen.getAllByRole("button", { name: "Cancel" })[0]!);
    await flush();
    const replies = extReplies(ws);
    expect(replies).toHaveLength(1);
    expect(replies[0]!.payload.command).toMatchObject({ id: "c1", method: "confirm", responseKind: "cancelled", cancelled: true });
    await ackExtReply(ws, replies[0]!);
    await closeRequest(ws, CONFIRM, 3);
    // Now the input request is the only/first operable one.
    expect((screen.getAllByRole("button", { name: "Cancel" })[0] as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole("textbox", { name: "Name" }) as HTMLInputElement).disabled).toBe(false);
  });

  it("does not steal focus when a second request arrives behind the first", async () => {
    mount(<ExtensionRequests live />);
    const ws = await driveAttach();
    await pushRequest(ws, CONFIRM, 1);
    const firstCancel = screen.getByRole("button", { name: "Cancel" });
    expect(document.activeElement).toBe(firstCancel);
    await pushRequest(ws, INPUT, 2);
    // Focus stays on the first request's Cancel; the second is disabled.
    expect(document.activeElement).toBe(firstCancel);
  });

  it("defensive non-interactive request renders a passive fixed notice and NEVER a response command", async () => {
    mount(<ExtensionRequests live />);
    const ws = await driveAttach();
    await pushRequest(ws, NOTIFY);
    expect(screen.queryByRole("article")).toBeNull();
    expect(screen.getByText(/updated its status/i)).toBeTruthy();
    expect(extReplies(ws)).toHaveLength(0);
    expect(extInputs(ws)).toHaveLength(0);
  });
});

describe("ExtensionRequests — keyboard, IME and explicit submit", () => {
  beforeEach(() => { SOCKETS.length = 0; capturedStore = null; });
  afterEach(() => { cleanup(); });

  it("Escape cancels the first operable request (confirm)", async () => {
    mount(<ExtensionRequests live />);
    const ws = await driveAttach();
    await pushRequest(ws, CONFIRM);
    fireEvent.keyDown(screen.getByRole("region", { name: "Extension request" }), { key: "Escape" });
    await flush();
    const replies = extReplies(ws);
    expect(replies).toHaveLength(1);
    expect(replies[0]!.payload.command).toMatchObject({ id: "c1", method: "confirm", responseKind: "cancelled", cancelled: true });
  });

  it("input Enter during IME composition must not submit", async () => {
    mount(<ExtensionRequests live />);
    const ws = await driveAttach();
    await pushRequest(ws, INPUT);
    const input = screen.getByRole("textbox", { name: "Name" });
    fireEvent.change(input, { target: { value: "composition text" } });
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    await flush();
    expect(extReplies(ws)).toHaveLength(0);
  });

  it("editor Cmd+Enter during IME composition must not submit", async () => {
    mount(<ExtensionRequests live />);
    const ws = await driveAttach();
    await pushRequest(ws, EDITOR);
    const editor = screen.getByRole("textbox", { name: "Edit" });
    fireEvent.keyDown(editor, { key: "Enter", metaKey: true, isComposing: true });
    await flush();
    expect(extReplies(ws)).toHaveLength(0);
  });
});

describe("ExtensionRequests — race/security/lifecycle", () => {
  beforeEach(() => { SOCKETS.length = 0; capturedStore = null; });
  afterEach(() => { cleanup(); });

  it("synchronous double-click sends exactly one reply", async () => {
    mount(<ExtensionRequests live />);
    const ws = await driveAttach();
    await pushRequest(ws, CONFIRM);
    const confirm = screen.getByRole("button", { name: "Confirm" });
    fireEvent.click(confirm);
    fireEvent.click(confirm); // same tick
    await flush();
    expect(extReplies(ws)).toHaveLength(1);
  });

  it("a new request behind the first does NOT invalidate the first's in-flight reply", async () => {
    mount(<ExtensionRequests live />);
    const ws = await driveAttach();
    await pushRequest(ws, CONFIRM, 1);
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await flush();
    const replies = extReplies(ws);
    expect(replies).toHaveLength(1);
    // A second request arrives BEHIND the first (first stays operable/first).
    await pushRequest(ws, INPUT, 2);
    expect(screen.getAllByRole("article")).toHaveLength(2);
    // The first's in-flight reply is still current: a server error surfaces on it.
    await act(async () => {
      ws.serverSend({ type: "response", id: replies[0]!.id, payload: { ok: false, error: { code: "invalid_input", message: "raw", retryable: false } } });
      await flush();
    });
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("This extension request cannot be answered this way.");
  });

  it("request close while reply in-flight: card unmounts, focus returns, late error is inert", async () => {
    mount(<ExtensionRequests live />);
    const ws = await driveAttach();
    await pushRequest(ws, CONFIRM);
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await flush();
    const replies = extReplies(ws);
    expect(replies).toHaveLength(1);
    // Runtime closes the request independently (e.g. SDK timeout) while the reply is in flight.
    await closeRequest(ws, CONFIRM, 2);
    expect(screen.queryByRole("region", { name: "Extension request" })).toBeNull();
    // A late not_found response arrives: the UI must not surface an error.
    await act(async () => {
      ws.serverSend({ type: "response", id: replies[0]!.id, payload: { ok: false, error: { code: "not_found", message: "no pending request", retryable: false } } });
      await flush();
    });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("capability revoke unmounts the panel and in-flight settle stays inert", async () => {
    mount(<ExtensionRequests live />);
    const ws = await driveAttach();
    await pushRequest(ws, CONFIRM);
    expect(screen.getByRole("region", { name: "Extension request" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await flush();
    expect(extReplies(ws)).toHaveLength(1);
    // Capability revoked via a runtime event: the store settles the reply and the panel unmounts.
    await act(async () => {
      ws.serverSend({ type: "event", payload: { type: "runtime_capabilities_changed", sessionId: "s1", eventId: 2, epoch: "e1", capabilities: { capabilities: ["runtime.prompt", "runtime.abort"], version: 2 } } });
      await flush();
    });
    await waitFor(() => expect(screen.queryByRole("region", { name: "Extension request" })).toBeNull());
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("server rejection surfaces fixed error copy, never the raw message", async () => {
    mount(<ExtensionRequests live />);
    const ws = await driveAttach();
    await pushRequest(ws, CONFIRM);
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await flush();
    const replies = extReplies(ws);
    await act(async () => {
      ws.serverSend({ type: "response", id: replies[0]!.id, payload: { ok: false, error: { code: "invalid_input", message: "raw secret method mismatch for /secret/path", retryable: false } } });
      await flush();
    });
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("This extension request cannot be answered this way.");
    expect(alert.textContent).not.toContain("raw");
    expect(alert.textContent).not.toContain("secret");
  });

  it("never emits incremental extension_ui_input across all interactions", async () => {
    mount(<ExtensionRequests live />);
    const ws = await driveAttach();
    // input: type + Enter submit, then close.
    await pushRequest(ws, INPUT, 1);
    const input = screen.getByRole("textbox", { name: "Name" });
    fireEvent.change(input, { target: { value: "abc" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await flush();
    const inputReply = extReplies(ws)[0]!;
    expect(inputReply.payload.command).toMatchObject({ id: "i1", method: "input", responseKind: "value", value: "abc" });
    await ackExtReply(ws, inputReply);
    await closeRequest(ws, INPUT, 2);
    // editor: type + Cmd+Enter submit.
    await pushRequest(ws, EDITOR, 3);
    const editor = screen.getByRole("textbox", { name: "Edit" });
    fireEvent.change(editor, { target: { value: "xyz" } });
    fireEvent.keyDown(editor, { key: "Enter", metaKey: true });
    await flush();
    const editorReply = extReplies(ws)[1]!;
    expect(editorReply.payload.command).toMatchObject({ id: "e1", method: "editor", responseKind: "value", value: "xyz" });
    expect(extInputs(ws)).toHaveLength(0);
    expect(extReplies(ws).length).toBe(2);
  });
});

describe("ExtensionRequests + Composer — disable and focus restore", () => {
  beforeEach(() => { SOCKETS.length = 0; capturedStore = null; });
  afterEach(() => { cleanup(); });

  function DualMount() {
    const textareaRef = useRef<HTMLTextAreaElement | null>(null);
    return (
      <>
        <ExtensionRequests live composerTextareaRef={textareaRef} />
        <Composer live textareaRef={textareaRef} />
      </>
    );
  }

  it("Composer is disabled with the fixed reason while a request is pending; final close re-enables and restores focus", async () => {
    mount(<DualMount />);
    const ws = await driveAttach();

    // Composer starts enabled.
    const textarea = screen.getByLabelText("Message the agent") as HTMLTextAreaElement;
    expect(textarea.disabled).toBe(false);

    await pushRequest(ws, CONFIRM, 1);
    // Composer disabled with the fixed reason; the request's Cancel is focused.
    expect(textarea.disabled).toBe(true);
    expect(screen.getByText("Extension is waiting for input.")).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cancel" }));

    // Respond (Confirm), ack, then the runtime closes the request → panel unmounts.
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await flush();
    const replies = extReplies(ws);
    await ackExtReply(ws, replies[0]!);
    await closeRequest(ws, CONFIRM, 2);

    // Composer re-enabled and focus restored to the textarea (same session/live/cap).
    await waitFor(() => expect(textarea.disabled).toBe(false));
    expect(document.activeElement).toBe(textarea);
  });

  it("does not restore focus when no composer ref is provided (standalone panel)", async () => {
    mount(<ExtensionRequests live />);
    const ws = await driveAttach();
    await pushRequest(ws, CONFIRM, 1);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await flush();
    const replies = extReplies(ws);
    await ackExtReply(ws, replies[0]!);
    await closeRequest(ws, CONFIRM, 2);
    await waitFor(() => expect(screen.queryByRole("region", { name: "Extension request" })).toBeNull());
    // No composer ref → focus simply stays where it is (no crash).
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
