import { describe, expect, it } from "vitest";
import { coalesceBursts } from "./burst-coalescer";

function frames() {
  const queued: Array<() => void> = [];
  return {
    deps: { schedule: (onFrame: () => void) => { queued.push(onFrame); } },
    next() { for (const onFrame of queued.splice(0)) onFrame(); },
  };
}

describe("coalesceBursts", () => {
  it("renders sparse updates immediately, one per frame", () => {
    const f = frames();
    let calls = 0;
    const { notify } = coalesceBursts(() => { calls += 1; }, f.deps);
    for (let i = 0; i < 10; i++) { notify(); f.next(); }
    expect(calls).toBe(10);
  });

  it("delivers the rest of a burst once on the next frame", () => {
    const f = frames();
    let calls = 0;
    const { notify } = coalesceBursts(() => { calls += 1; }, f.deps);
    for (let i = 0; i < 1000; i++) notify();
    expect(calls).toBe(2);
    f.next();
    expect(calls).toBe(3);
    f.next();
    expect(calls).toBe(3);
    notify();
    expect(calls).toBe(4);
  });

  it("drops a pending delivery after cancel", () => {
    const f = frames();
    let calls = 0;
    const coalesced = coalesceBursts(() => { calls += 1; }, f.deps);
    for (let i = 0; i < 6; i++) coalesced.notify();
    coalesced.cancel();
    f.next();
    coalesced.notify();
    expect(calls).toBe(2);
  });
});
