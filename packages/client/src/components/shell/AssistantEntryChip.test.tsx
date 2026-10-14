import { describe, expect, it, vi, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AssistantEntryChip } from "./AssistantEntryChip";
import { I18nProvider } from "@/hooks/useI18n";

function mountChip(props: { state: "idle" | "selected" | "hidden"; onActivate?: () => void; onDismiss?: () => void }) {
  return render(
    <I18nProvider>
      <AssistantEntryChip
        state={props.state}
        onActivate={props.onActivate ?? (() => undefined)}
        onDismiss={props.onDismiss ?? (() => undefined)}
      />
    </I18nProvider>,
  );
}

afterEach(cleanup);

describe("AssistantEntryChip", () => {
  it("idle: renders the invitation copy with the assistant icon and activates on click", () => {
    const onActivate = vi.fn();
    mountChip({ state: "idle", onActivate });
    expect(screen.getByTestId("assistant-entry-tab").getAttribute("data-state")).toBe("idle");
    expect(screen.getByTestId("assistant-entry-chip-activate").textContent).toContain("Ask the assistant");
    fireEvent.click(screen.getByTestId("assistant-entry-chip-activate"));
    expect(onActivate).toHaveBeenCalledTimes(1);
  });

  it("selected: shows the assistant label with a dismiss control; dismiss does not activate", () => {
    const onActivate = vi.fn();
    const onDismiss = vi.fn();
    mountChip({ state: "selected", onActivate, onDismiss });
    expect(screen.getByTestId("assistant-entry-chip-selected").textContent).toContain("Assistant");
    fireEvent.click(screen.getByTestId("assistant-entry-chip-dismiss"));
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onActivate).not.toHaveBeenCalled();
  });

  it("hidden: collapses without any interactive surface", () => {
    mountChip({ state: "hidden" });
    expect(screen.getByTestId("assistant-entry-tab").getAttribute("data-state")).toBe("hidden");
    expect(screen.queryByTestId("assistant-entry-chip-activate")).toBeNull();
    expect(screen.queryByTestId("assistant-entry-chip-selected")).toBeNull();
  });
});
