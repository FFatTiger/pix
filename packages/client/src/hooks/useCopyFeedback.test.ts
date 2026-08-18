import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useCopyFeedback } from "./useCopyFeedback";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("useCopyFeedback", () => {
  it("records a visible failure instead of staying idle", async () => {
    vi.stubGlobal("navigator", {
      clipboard: {
        writeText: vi.fn(async () => {
          throw new Error("denied");
        }),
      },
    });
    const { result } = renderHook(() => useCopyFeedback(1_500));
    await act(async () => {
      await result.current.copy("secret");
    });
    expect(result.current.status).toBe("failed");
  });

  it("records success when copyText resolves", async () => {
    vi.stubGlobal("navigator", {
      clipboard: {
        writeText: vi.fn(async () => undefined),
      },
    });
    const { result } = renderHook(() => useCopyFeedback(1_500));
    await act(async () => {
      await result.current.copy("secret");
    });
    expect(result.current.status).toBe("copied");
  });
});
