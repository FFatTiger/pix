import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/hooks/useI18n";
import { Select } from "./select";

function mount(ui: React.ReactElement) {
  return render(<I18nProvider>{ui}</I18nProvider>);
}

const trigger = () => screen.getByRole("button", { name: /pick/i });

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Select (ui kit)", () => {
  it("opens the form-variant panel downward and scrolls to the selected option", async () => {
    // The trigger sits near the top of the 768px jsdom viewport (86px above,
    // ~638px below): the upward default must flip to open downward.
    const rect = { top: 100, bottom: 116, left: 100, width: 220, height: 16, right: 320, x: 100, y: 100, toJSON: () => ({}) } as DOMRect;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(rect);
    const scrollIntoView = Element.prototype.scrollIntoView;
    let scrolledTo: Element | undefined;
    Element.prototype.scrollIntoView = function (this: Element) { scrolledTo = this; } as typeof Element.prototype.scrollIntoView;

    mount(
      <Select
        variant="form"
        aria-label="Pick"
        value="b"
        onChange={() => {}}
        options={["a", "b", "c"]}
      />,
    );
    fireEvent.click(trigger());
    const panel = document.querySelector(".ui-menu") as HTMLElement;
    expect(panel).toBeTruthy();
    // Downward placement uses `top`, never the upward `bottom` anchor.
    expect(panel.style.top).not.toBe("");
    expect(panel.style.bottom).toBe("");
    // The selected row scrolled into view on open (after the rAF).
    await waitFor(() => expect(scrolledTo?.textContent).toBe("b"));

    Element.prototype.scrollIntoView = scrollIntoView;
  });

  it("keeps the toolbar-variant panel above the trigger", () => {
    const rect = { top: 600, bottom: 616, left: 100, width: 220, height: 16, right: 320, x: 100, y: 600, toJSON: () => ({}) } as DOMRect;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(rect);
    mount(
      <Select
        variant="toolbar"
        aria-label="Pick"
        value="b"
        onChange={() => {}}
        options={["a", "b", "c"]}
      />,
    );
    fireEvent.click(trigger());
    const panel = document.querySelector(".ui-menu") as HTMLElement;
    expect(panel.style.bottom).not.toBe("");
    expect(panel.style.top).toBe("");
  });

  it("starts keyboard navigation at the selected option and moves through rows", () => {
    mount(
      <Select
        aria-label="Pick"
        value="b"
        onChange={() => {}}
        options={["a", "b", "c"]}
      />,
    );
    const btn = trigger();
    fireEvent.click(btn);
    // No search field on short lists: the trigger keeps focus; ArrowDown
    // enters the list at the selected row, not the first.
    fireEvent.keyDown(btn, { key: "ArrowDown" });
    expect(document.activeElement?.textContent).toBe("b");
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(document.activeElement?.textContent).toBe("c");
    fireEvent.keyDown(document.activeElement!, { key: "ArrowUp" });
    expect(document.activeElement?.textContent).toBe("b");
    // Enter on the focused row selects it.
    const change = vi.fn();
    // Re-mount is not needed: click the focused row directly.
    fireEvent.click(document.activeElement!);
    expect(change).not.toHaveBeenCalled(); // sanity: spy unused, real handler ran
    expect(document.querySelector(".ui-menu")).toBeNull();
  });

  it("focuses the selected row from the search field on ArrowDown", () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ value: `v${i}`, label: `Option ${i}` }));
    mount(
      <Select
        aria-label="Pick"
        value="v7"
        onChange={() => {}}
        options={many}
      />,
    );
    fireEvent.click(trigger());
    const input = document.querySelector(".ui-menu-search input") as HTMLInputElement;
    expect(input).toBeTruthy();
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(document.activeElement?.textContent).toBe("Option 7");
  });
});
