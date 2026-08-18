import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { MessageView } from "./MessageView";
import { I18nProvider } from "@/hooks/useI18n";

describe("MessageView streaming fade (UI-first)", () => {
  it("wraps newly streamed characters for fade-in", () => {
    render(
      <I18nProvider>
        <MessageView
          message={{ role: "assistant", content: [{ type: "text", text: "hello streaming" }], model: "m", provider: "p" } as never}
          isStreaming
          toolResults={new Map()}
          cwd="/x"
          onOpenFile={undefined}
        />
      </I18nProvider>,
    );
    expect(document.querySelectorAll(".stream-char").length).toBeGreaterThan(0);
    expect(document.querySelector(".markdown-body.is-streaming")).toBeTruthy();
  });

  it("does NOT fade non-streaming text blocks", () => {
    render(
      <I18nProvider>
        <MessageView
          message={{ role: "assistant", content: [{ type: "text", text: "settled answer" }], model: "m", provider: "p" } as never}
          toolResults={new Map()}
          cwd="/x"
          onOpenFile={undefined}
        />
      </I18nProvider>,
    );
    expect(screen.getByText("settled answer")).toBeTruthy();
    expect(document.querySelector(".stream-char")).toBeNull();
    expect(document.querySelector(".markdown-body.is-streaming")).toBeNull();
  });
});
