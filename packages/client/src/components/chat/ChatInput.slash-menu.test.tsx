import { type ComponentPropsWithRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { I18nProvider } from "@/hooks/useI18n";
import { ChatInput } from "./ChatInput";
import type { SlashCommandInfo } from "@/lib/chat-view-model";

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

function textarea(): HTMLTextAreaElement {
  return screen.getByRole("textbox") as HTMLTextAreaElement;
}

/** Open the slash palette by typing `/` and typing the filter query. */
function openSlashMenu(query = ""): void {
  const input = textarea();
  fireEvent.change(input, { target: { value: `/${query}`, selectionStart: query.length + 1 } });
  fireEvent.keyUp(input, { key: query === "" ? "/" : query.slice(-1) });
}

const extensionCommands: SlashCommandInfo[] = [
  {
    name: "smart-compact",
    description: "EESV smart compaction. Usage: /smart-compact [model|settings|handoff]",
    source: "extension",
  },
  { name: "todo", description: "Manage the todo list", source: "extension" },
];

describe("ChatInput slash palette — bundled smart-compact command hiding", () => {
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
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("never offers /smart-compact while the other extension commands stay listed", async () => {
    render(inputTree({ slashCommands: extensionCommands, onLoadSlashCommands: () => extensionCommands }));
    openSlashMenu("");

    // The unrelated plugin command is offered…
    await waitFor(() => expect(document.body.textContent).toContain("/todo"));
    // …and the smart-compact panel opener is not, in any form.
    expect(document.body.textContent).not.toContain("smart-compact");
  });

  it("stays hidden even when the typed filter matches its name exactly", async () => {
    render(inputTree({ slashCommands: extensionCommands }));
    openSlashMenu("smart");

    // Filtering by the hidden command's own name must not surface it; the menu
    // honestly reports that nothing matches instead.
    await waitFor(() => expect(screen.getByText("No extension, prompt, or skill commands found")).toBeTruthy());
    expect(document.body.textContent).not.toContain("smart-compact");
  });
});
