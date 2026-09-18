/**
 * Unit tests for the session-title command module: the correlated-result
 * unwrap contract (the ordinary command lane resolves
 * `{ commandId, result: RuntimeCommandOutcome }`), the model field presence,
 * and the armed/config helpers against the localStorage settings.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { ExactRuntimeApi } from "@/runtime/exact-runtime";
import { configuredTitleModel, isAutoTitleArmed, requestSessionTitle } from "./session-title";

function fakeExact(resolveWith: unknown): { exact: ExactRuntimeApi; sent: unknown[] } {
  const sent: unknown[] = [];
  const exact = {
    sendCommand: (command: unknown) => {
      sent.push(command);
      if (resolveWith instanceof Error) return Promise.reject(resolveWith);
      return Promise.resolve(resolveWith);
    },
  } as unknown as ExactRuntimeApi;
  return { exact, sent };
}

describe("requestSessionTitle", () => {
  afterEach(() => {
    window.localStorage.removeItem("pi-title-auto");
    window.localStorage.removeItem("pi-title-model");
  });

  it("unwraps the correlated result envelope and returns the title", async () => {
    const { exact, sent } = fakeExact({
      commandId: "c1",
      result: { ok: true, type: "generate_session_title", title: "修复登录闪退" },
    });
    await expect(requestSessionTitle(exact, { provider: "p", modelId: "m" })).resolves.toBe("修复登录闪退");
    expect(sent).toHaveLength(1);
    const command = sent[0] as { commandId: string; type: string; model?: { provider: string; modelId: string } };
    expect(command.type).toBe("generate_session_title");
    expect(command.commandId).toMatch(/^session-title:/);
    expect(command.model).toEqual({ provider: "p", modelId: "m" });
  });

  it("omits the model field when no override is configured", async () => {
    const { exact, sent } = fakeExact({
      commandId: "c1",
      result: { ok: true, type: "generate_session_title", title: "Session title" },
    });
    await expect(requestSessionTitle(exact, null)).resolves.toBe("Session title");
    expect((sent[0] as { model?: unknown }).model).toBeUndefined();
  });

  it("rejects a correlated error outcome (never a fallback title)", async () => {
    const { exact } = fakeExact({
      commandId: "c1",
      result: { ok: false, type: "generate_session_title", error: { code: "unavailable", message: "runtime is not active" } },
    });
    await expect(requestSessionTitle(exact, null)).rejects.toThrow("unexpected result");
  });

  it("rejects a wrong-shape success (another command's outcome)", async () => {
    const { exact } = fakeExact({ commandId: "c1", result: { ok: true, type: "get_state", state: {} } });
    await expect(requestSessionTitle(exact, null)).rejects.toThrow("unexpected result");
  });

  it("propagates transport failures untouched", async () => {
    const { exact } = fakeExact(new Error("boom"));
    await expect(requestSessionTitle(exact, null)).rejects.toThrow("boom");
  });
});

describe("title settings arming", () => {
  afterEach(() => {
    window.localStorage.removeItem("pi-title-auto");
    window.localStorage.removeItem("pi-title-model");
  });

  it("armed by the toggle alone; a missing model rides the session's current model", () => {
    window.localStorage.setItem("pi-title-auto", "on");
    window.localStorage.setItem("pi-title-model", "p:m");
    expect(isAutoTitleArmed()).toBe(true);
    expect(configuredTitleModel()).toEqual({ provider: "p", modelId: "m" });

    // No dedicated title model: still armed (generation omits `model`).
    window.localStorage.removeItem("pi-title-model");
    expect(isAutoTitleArmed()).toBe(true);
    expect(configuredTitleModel()).toBeNull();

    window.localStorage.setItem("pi-title-model", "p:m");
    window.localStorage.setItem("pi-title-auto", "off");
    expect(isAutoTitleArmed()).toBe(false);

    window.localStorage.removeItem("pi-title-model");
    window.localStorage.setItem("pi-title-auto", "off");
    expect(isAutoTitleArmed()).toBe(false);
  });
});
