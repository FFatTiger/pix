import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useUiScale } from "./useUiScale";

/**
 * Focused useUiScale tests: prove the dedicated Text Size preference owner
 * initializes from the persisted `pi-font-scale`, clamps/validates with the
 * lib/ui-scale helpers, persists on change, and keeps the CSS `--app-ui-scale`
 * zoom in sync. This replaces the former font-scale coverage that lived inside
 * the removed theme controller.
 */

function UiScaleProbe() {
  const { fontScale, setFontScale } = useUiScale();
  return (
    <div>
      <span data-testid="scale">{fontScale}</span>
      <button onClick={() => setFontScale(1.2)}>set-120</button>
      <button onClick={() => setFontScale(3)}>set-clamped</button>
    </div>
  );
}

const appliedScale = () => document.documentElement.style.getPropertyValue("--app-ui-scale");

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute("style");
});

afterEach(() => {
  cleanup();
});

describe("useUiScale — Text Size preference owner", () => {
  it("initializes from pi-font-scale and applies --app-ui-scale on mount", () => {
    localStorage.setItem("pi-font-scale", "1.2");
    render(<UiScaleProbe />);
    expect(screen.getByTestId("scale").textContent).toBe("1.2");
    expect(appliedScale()).toBe("1.2");
  });

  it("defaults to 1 when no valid stored scale is present", () => {
    render(<UiScaleProbe />);
    expect(screen.getByTestId("scale").textContent).toBe("1");
    expect(appliedScale()).toBe("1");
  });

  it("rejects out-of-range stored values (falls back to 1) instead of applying them", () => {
    localStorage.setItem("pi-font-scale", "9");
    render(<UiScaleProbe />);
    expect(screen.getByTestId("scale").textContent).toBe("1");

    cleanup();
    localStorage.setItem("pi-font-scale", "0.5");
    render(<UiScaleProbe />);
    expect(screen.getByTestId("scale").textContent).toBe("1");
  });

  it("setFontScale updates state, persists pi-font-scale, and re-applies the CSS var", () => {
    render(<UiScaleProbe />);
    fireEvent.click(screen.getByText("set-120"));
    expect(screen.getByTestId("scale").textContent).toBe("1.2");
    expect(localStorage.getItem("pi-font-scale")).toBe("1.2");
    expect(appliedScale()).toBe("1.2");
  });

  it("clamps out-of-range set values to the valid range", () => {
    render(<UiScaleProbe />);
    fireEvent.click(screen.getByText("set-clamped"));
    expect(screen.getByTestId("scale").textContent).toBe("1.5");
    expect(localStorage.getItem("pi-font-scale")).toBe("1.5");
    expect(appliedScale()).toBe("1.5");
  });
});
