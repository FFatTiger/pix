import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MessageView } from "./MessageView";
import { I18nProvider } from "@/hooks/useI18n";

const writeText = vi.fn(async () => undefined);

function mount(node: React.ReactElement) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <I18nProvider>{node}</I18nProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  window.localStorage.setItem("pi-locale", "en");
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
});

afterEach(() => {
  writeText.mockClear();
  window.localStorage.removeItem("pi-locale");
});

describe("UserMessageView attachment markers", () => {
  it("shows clean text plus a file chip and copies the stripped text", async () => {
    const text = [
      "please read",
      "",
      "[Attached file saved at: /store/dir/notes.txt]",
      "[Attached file saved at: C:\\docs\\report.pdf]",
    ].join("\n");
    mount(<MessageView message={{ role: "user", content: text, timestamp: 0 } as never} />);

    expect(screen.getByText("please read")).toBeTruthy();
    expect(screen.getByText("notes.txt")).toBeTruthy();
    expect(screen.getByText("report.pdf")).toBeTruthy();
    expect(screen.queryByText(/Attached file saved/)).toBeNull();
    expect(document.body.textContent).not.toContain("/store/dir");
    expect(document.body.textContent).not.toContain("C:\\docs");

    fireEvent.click(screen.getByTitle("Copy message"));
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith("please read"));
  });

  it("hides image marker lines while inline image thumbnails still render", () => {
    mount(
      <MessageView
        message={{
          role: "user",
          content: [
            { type: "text", text: "look\n\n[Attached image saved at: /store/pic.png]" },
            { type: "image", source: { type: "base64", media_type: "image/png", data: "abc" } },
          ],
          timestamp: 0,
        } as never}
      />,
    );
    expect(screen.getByText("look")).toBeTruthy();
    expect(screen.queryByText(/Attached image saved/)).toBeNull();
    expect(document.body.textContent).not.toContain("/store/pic.png");
    expect(document.querySelector("img")?.getAttribute("src")).toBe("data:image/png;base64,abc");
  });

  it("restores an edit with the marker lines removed", () => {
    const onEditContent = vi.fn();
    const onNavigate = vi.fn();
    mount(
      <MessageView
        message={{ role: "user", content: "edit me\n\n[Attached file saved at: /store/notes.txt]", timestamp: 0 } as never}
        entryId="e1"
        prevAssistantEntryId="a1"
        onNavigate={onNavigate}
        onEditContent={onEditContent}
      />,
    );
    fireEvent.click(screen.getByTitle("Edit from here — branches within this session"));
    expect(onNavigate).toHaveBeenCalledWith("a1");
    expect(onEditContent).toHaveBeenCalledWith(expect.objectContaining({
      content: "edit me",
    }));
  });
});
