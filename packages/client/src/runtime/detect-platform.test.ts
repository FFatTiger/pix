import { describe, expect, it } from "vitest";
import { detectClientIdentity, detectPlatform } from "./runtime-provider";

describe("detectPlatform", () => {
  it("classifies iPadOS 13+ Macintosh+touch as ios before mac", () => {
    expect(detectPlatform({
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)",
      maxTouchPoints: 5,
    })).toBe("ios");
  });

  it("keeps a real Mac as mac", () => {
    expect(detectPlatform({
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko)",
      maxTouchPoints: 0,
    })).toBe("mac");
  });

  it("still recognizes explicit iPhone tokens", () => {
    expect(detectPlatform({
      userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)",
      maxTouchPoints: 5,
    })).toBe("ios");
  });

  it("keeps Windows and Android independent of Mac tokens", () => {
    expect(detectPlatform({ userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" })).toBe("win");
    expect(detectPlatform({ userAgent: "Mozilla/5.0 (Linux; Android 14)" })).toBe("android");
  });
});

describe("detectClientIdentity", () => {
  it("uses standalone display-mode for the PWA shell", () => {
    const identity = detectClientIdentity(
      { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", maxTouchPoints: 0 } as Navigator,
      (query) => ({ matches: query.includes("standalone") }),
    );
    expect(identity).toEqual({ shell: "pwa", platform: "mac" });
  });
});
