import { afterEach, describe, expect, it, vi } from "vitest";
import { copyText } from "./clipboard";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("copyText", () => {
  it("rejects when the modern clipboard API fails", async () => {
    vi.stubGlobal("navigator", {
      clipboard: {
        writeText: vi.fn(async () => {
          throw new Error("denied");
        }),
      },
    });
    await expect(copyText("secret")).rejects.toThrow("denied");
  });

  it("rejects when execCommand is missing or reports failure", async () => {
    vi.stubGlobal("navigator", {});
    const exec = typeof document.execCommand === "function"
      ? vi.spyOn(document, "execCommand").mockReturnValue(false)
      : vi.fn().mockReturnValue(false);
    if (typeof document.execCommand !== "function") {
      Object.defineProperty(document, "execCommand", { configurable: true, value: exec });
    }
    await expect(copyText("secret")).rejects.toThrow("Clipboard copy failed");
    expect(exec).toHaveBeenCalledWith("copy");
  });
});
