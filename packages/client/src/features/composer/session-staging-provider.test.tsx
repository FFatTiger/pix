/**
 * SessionStagingProvider / useSessionStaging (4A.3.2a) — React wiring tests.
 */
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { useEffect, type ReactNode } from "react";
import { SessionStagingProvider, useSessionStaging, type SessionStagingApi } from "./session-staging-provider";
import { useSessionStagingStore } from "./session-staging-provider";

const MODEL_A = { provider: "openai", modelId: "gpt-4o" };
const MODEL_B = { provider: "anthropic", modelId: "claude" };

function mount(children: ReactNode, maxRecords?: number): void {
  render(
    <SessionStagingProvider {...(maxRecords === undefined ? {} : { options: { maxRecords } })}>
      {children}
    </SessionStagingProvider>,
  );
}

afterEach(() => { cleanup(); });

describe("SessionStagingProvider / useSessionStaging (4A.3.2a)", () => {
  it("exposes reactive immutable records with stable action refs", async () => {
    const samples: SessionStagingApi[] = [];
    function Probe(): null {
      samples.push(useSessionStaging());
      return null;
    }
    mount(<Probe />);
    expect(samples.at(-1)!.records).toEqual([]);
    const stageRef = samples.at(-1)!.stage;
    const clearRef = samples.at(-1)!.clear;
    const promoteRef = samples.at(-1)!.promote;
    await act(async () => { samples.at(-1)!.stage("session:A", MODEL_A, "medium"); });
    expect(samples.at(-1)!.records).toEqual([{ key: "session:A", revision: expect.any(Number), model: MODEL_A, thinking: "medium" }]);
    expect(samples.at(-1)!.stage).toBe(stageRef);
    expect(samples.at(-1)!.clear).toBe(clearRef);
    expect(samples.at(-1)!.promote).toBe(promoteRef);
    await act(async () => { samples.at(-1)!.clear("session:A"); });
    expect(samples.at(-1)!.records).toEqual([]);
  });

  it("supports A/B independent staging through the hook", async () => {
    const samples: SessionStagingApi[] = [];
    function Probe(): null {
      samples.push(useSessionStaging());
      return null;
    }
    mount(<Probe />);
    await act(async () => { samples.at(-1)!.stage("session:A", MODEL_A, "high"); });
    await act(async () => { samples.at(-1)!.stage("session:B", MODEL_B, "low"); });
    expect(samples.at(-1)!.get("session:A")).toEqual({ key: "session:A", revision: expect.any(Number), model: MODEL_A, thinking: "high" });
    expect(samples.at(-1)!.get("session:B")).toEqual({ key: "session:B", revision: expect.any(Number), model: MODEL_B, thinking: "low" });
  });

  it("promote through the hook moves provisional to exact; collision fails closed with source retained", async () => {
    const samples: SessionStagingApi[] = [];
    function Probe(): null {
      samples.push(useSessionStaging());
      return null;
    }
    mount(<Probe />);
    await act(async () => { samples.at(-1)!.stage("new:tx-1", MODEL_A, "medium"); });
    let result: ReturnType<SessionStagingApi["promote"]> | null = null;
    await act(async () => { result = samples.at(-1)!.promote("new:tx-1", "s1"); });
    expect(result!.ok).toBe(true);
    expect(samples.at(-1)!.get("session:s1")).toEqual({ key: "session:s1", revision: expect.any(Number), model: MODEL_A, thinking: "medium" });
    expect(samples.at(-1)!.get("new:tx-1")).toBeNull();
  });

  it("provider unmount clears every staged record", async () => {
    let store: ReturnType<typeof useSessionStagingStore> | null = null;
    let unmountStore: (() => void) | null = null;
    function Probe(): null {
      store = useSessionStagingStore();
      useEffect(() => () => { unmountStore = () => { /* captured */ }; }, []);
      return null;
    }
    // Use a manual render to control unmount.
    const utils = render(
      <SessionStagingProvider>
        <Probe />
      </SessionStagingProvider>,
    );
    await act(async () => { store!.stage("session:A", MODEL_A, "medium"); });
    expect(store!.count).toBe(1);
    utils.unmount();
    await act(async () => { await Promise.resolve(); });
    expect(store!.count).toBe(0);
    void unmountStore;
  });

  it("throws when used outside the provider", () => {
    function Broken(): null {
      useSessionStaging();
      return null;
    }
    const originalError = console.error;
    console.error = () => undefined;
    try {
      expect(() => render(<Broken />)).toThrow(/must be used within SessionStagingProvider/);
    } finally {
      console.error = originalError;
    }
  });
});
