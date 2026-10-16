import { describe, expect, it } from "vitest";
import { formatToolDurationMs } from "./message-display";

const t = (key: string, params?: Record<string, string | number>): string => {
  const en: Record<string, string> = {
    "desktop.toolDurationSeconds": "{count}s",
    "desktop.toolDurationMinutes": "{minutes}m {seconds}s",
  };
  let text = en[key] ?? key;
  for (const [name, value] of Object.entries(params ?? {})) {
    text = text.replaceAll(`{${name}}`, String(value));
  }
  return text;
};

describe("formatToolDurationMs", () => {
  it("keeps one decimal under a second", () => {
    expect(formatToolDurationMs(t, 0)).toBe("0.0s");
    expect(formatToolDurationMs(t, 430)).toBe("0.4s");
    expect(formatToolDurationMs(t, 999)).toBe("1.0s");
  });

  it("shows whole seconds under a minute", () => {
    expect(formatToolDurationMs(t, 1000)).toBe("1s");
    expect(formatToolDurationMs(t, 12_400)).toBe("12s");
    expect(formatToolDurationMs(t, 59_400)).toBe("59s");
    // Rounding can carry a sub-minute value into the minute shape.
    expect(formatToolDurationMs(t, 59_900)).toBe("1m 0s");
  });

  it("splits minutes and seconds from a minute up", () => {
    expect(formatToolDurationMs(t, 60_000)).toBe("1m 0s");
    expect(formatToolDurationMs(t, 65_000)).toBe("1m 5s");
    expect(formatToolDurationMs(t, 3_661_000)).toBe("61m 1s");
  });
});
