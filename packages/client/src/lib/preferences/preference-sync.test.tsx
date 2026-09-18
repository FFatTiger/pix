import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  PREFERENCE_KEYS,
  flushNow,
  hydratePreferencesFromServer,
  pendingPatchSnapshot,
  registerPreferenceHttpClient,
  reportPreferenceWrite,
  resetPendingWritesForTest,
} from "./preference-sync";
import { useProcessDisplayMode } from "@/components/chat/useProcessDisplayMode";
import { act, render } from "@testing-library/react";

function stubPreferencesHttp(responses: Array<Error>): { calls: Array<Record<string, string | null>> } {
  const calls: Array<Record<string, string | null>> = [];
  registerPreferenceHttpClient((() => ({
    put: async (_path: string, body: { patch: Record<string, string | null> }) => {
      calls.push(body.patch);
      const failure = responses.shift();
      if (failure !== undefined) throw failure;
      return { ok: true as const, preferences: {} };
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  })) as any);
  return { calls };
}

function ModeProbe({ onChange }: { onChange: (mode: string) => void }) {
  const { displayMode } = useProcessDisplayMode();
  onChange(displayMode);
  return null;
}

beforeEach(() => {
  window.localStorage.clear();
  resetPendingWritesForTest();
});

afterEach(() => {
  resetPendingWritesForTest();
});

describe("server preference sync core", () => {
  it("registry covers the user-level preference keys and rejects unknown writes", () => {
    expect(PREFERENCE_KEYS).toContain("pi-process-display-mode");
    expect(PREFERENCE_KEYS).toContain("pi-sidebar-item-state");
    reportPreferenceWrite("some-random-key", "x");
    expect(pendingPatchSnapshot()).toEqual({});
  });

  it("hydration applies server values into the local mirrors and notifies owners", async () => {
    window.localStorage.setItem("pi-process-display-mode", "tabs");
    const seen: string[] = [];
    render(<ModeProbe onChange={(mode) => { seen[seen.length] = mode; }} />);
    expect(seen[seen.length - 1]).toBe("tabs");

    await act(async () => {
      await hydratePreferencesFromServer({ "pi-process-display-mode": "timeline" });
    });
    // The hook followed the synthetic storage event without a reload.
    expect(seen[seen.length - 1]).toBe("timeline");
    expect(window.localStorage.getItem("pi-process-display-mode")).toBe("timeline");
  });

  it("accepts the collapse-only Codex process display preference", () => {
    window.localStorage.setItem("pi-process-display-mode", "codex");
    const seen: string[] = [];
    render(<ModeProbe onChange={(mode) => { seen[seen.length] = mode; }} />);
    expect(seen[seen.length - 1]).toBe("codex");
  });

  it("hydration uploads local-only values once (migration) and later writes batch into one patch", async () => {
    window.localStorage.setItem("pi-sound-enabled", "false");
    const { calls } = stubPreferencesHttp([]);
    await act(async () => {
      await hydratePreferencesFromServer({});
    });
    expect(calls[0]).toEqual({ "pi-sound-enabled": "false" });

    reportPreferenceWrite("pi-title-auto", "off");
    reportPreferenceWrite("pi-title-model", "");
    reportPreferenceWrite("pi-title-model", "p:m"); // dedupe: last wins
    // flushNow cancels the debounce and sends ONE batched patch.
    await act(async () => { await flushNow(); });
    expect(calls[1]).toEqual({ "pi-title-auto": "off", "pi-title-model": "p:m" });
  });

  it("a dirty local write beats the server value during hydration", async () => {
    window.localStorage.setItem("pi-process-display-mode", "tabs");
    reportPreferenceWrite("pi-process-display-mode", "tabs");
    await act(async () => {
      await hydratePreferencesFromServer({ "pi-process-display-mode": "timeline" });
    });
    expect(window.localStorage.getItem("pi-process-display-mode")).toBe("tabs");
  });

  it("a failed flush re-queues the patch (no data loss, no fake success)", async () => {
    const { calls } = stubPreferencesHttp([new Error("network down")]);
    reportPreferenceWrite("pi-locale", "zh-CN");
    await act(async () => { await flushNow(); });
    expect(calls).toHaveLength(1);
    expect(pendingPatchSnapshot()).toEqual({ "pi-locale": "zh-CN" });
  });
});
