import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/hooks/useI18n";
import { SidebarFooter } from "./Sidebar";

describe("SidebarFooter", () => {
  it("shows the settings entry with the faint version chip; the chip opens the About page", () => {
    const onOpenSettings = vi.fn();
    render(<I18nProvider><SidebarFooter version="0.3.1" onOpenSettings={onOpenSettings} /></I18nProvider>);
    const chip = screen.getByTestId("sidebar-version");
    expect(chip.textContent).toBe("v0.3.1");
    fireEvent.click(chip);
    expect(onOpenSettings).toHaveBeenCalledWith("about", true);
    // The settings row itself keeps opening the default settings page.
    fireEvent.click(screen.getByTestId("sidebar-nav-settings"));
    expect(onOpenSettings).toHaveBeenCalledWith("appearance");
  });

  it("renders no chip while the about seam is unwired (no guessed version)", () => {
    render(<I18nProvider><SidebarFooter version={undefined} onOpenSettings={() => {}} /></I18nProvider>);
    expect(screen.queryByTestId("sidebar-version")).toBeNull();
  });
});
