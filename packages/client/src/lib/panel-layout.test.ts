import { describe, expect, it } from "vitest";
import {
  RIGHT_PANEL_DEFAULT_WIDTH,
  RIGHT_PANEL_MAX_WIDTH,
  RIGHT_PANEL_MIN_WIDTH,
  clampPanelWidth,
  getDefaultRightPanelWidth,
} from "./panel-layout";

describe("panel layout defaults", () => {
  it("uses a 312px fresh right-pane default while honoring min/max clamp", () => {
    expect(RIGHT_PANEL_DEFAULT_WIDTH).toBe(312);
    expect(RIGHT_PANEL_MIN_WIDTH).toBe(300);
    expect(getDefaultRightPanelWidth(1366)).toBe(312);
    expect(getDefaultRightPanelWidth(320)).toBe(312);
    expect(clampPanelWidth(280, RIGHT_PANEL_MIN_WIDTH, RIGHT_PANEL_MAX_WIDTH)).toBe(300);
    expect(clampPanelWidth(1600, RIGHT_PANEL_MIN_WIDTH, RIGHT_PANEL_MAX_WIDTH)).toBe(1200);
  });
});
