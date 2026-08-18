import { describe, expect, it } from "vitest";
import { formatCompactActivity } from "@/components/shell/Sidebar";

describe("formatCompactActivity", () => {
  const now = Date.parse("2026-08-18T12:00:00.000Z");

  it("renders compact idle chips", () => {
    expect(formatCompactActivity(now - 10_000, now)).toBe("NOW");
    expect(formatCompactActivity(now - 3 * 60_000, now)).toBe("3M");
    expect(formatCompactActivity(now - 60 * 60_000, now)).toBe("1H");
    expect(formatCompactActivity(now - 2 * 24 * 60 * 60_000, now)).toBe("2D");
  });
});
