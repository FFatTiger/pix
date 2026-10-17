import { describe, expect, it } from "vitest";
import { formatCompactActivity } from "@/lib/i18n/format";

describe("formatCompactActivity", () => {
  const now = Date.parse("2026-08-18T12:00:00.000Z");

  it("renders compact idle chips in the active locale", () => {
    expect(formatCompactActivity(now - 10_000, "zh-CN", now)).toBe("刚刚");
    expect(formatCompactActivity(now - 12 * 60_000, "zh-CN", now)).toBe("12分钟");
    expect(formatCompactActivity(now - 5 * 60 * 60_000, "zh-CN", now)).toBe("5小时");
    expect(formatCompactActivity(now - 24 * 60 * 60_000, "zh-CN", now)).toBe("昨天");
    expect(formatCompactActivity(now - 3 * 24 * 60 * 60_000, "zh-CN", now)).toBe("3天");
    expect(formatCompactActivity(Date.parse("2026-07-12T00:00:00.000Z"), "zh-CN", now)).toBe("7月12日");

    expect(formatCompactActivity(now - 10_000, "en", now)).toBe("now");
    expect(formatCompactActivity(now - 12 * 60_000, "en", now)).toBe("12m");
    expect(formatCompactActivity(now - 5 * 60 * 60_000, "en", now)).toBe("5h");
    expect(formatCompactActivity(now - 24 * 60 * 60_000, "en", now)).toBe("yesterday");
    expect(formatCompactActivity(now - 3 * 24 * 60 * 60_000, "en", now)).toBe("3d");
    expect(formatCompactActivity(Date.parse("2026-07-12T00:00:00.000Z"), "en", now)).toBe("Jul 12");
  });
});
