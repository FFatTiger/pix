import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyLockProcess,
  currentProcessStartIdentity,
  inspectProcessLiveness,
} from "../dist/process/index.js";

const isWindows = process.platform === "win32";
const isLinux = process.platform === "linux";

test("dead pids are stale regardless of recorded start identity", () => {
  assert.equal(classifyLockProcess({ pid: 999_999_999 }), "stale");
  assert.equal(classifyLockProcess({
    pid: 999_999_999,
    start: { kind: "windows-creation-time", value: "1" },
  }), "stale");
});

test("current process is live when start identity matches or is not required", () => {
  const start = currentProcessStartIdentity();
  if (isWindows || isLinux) {
    assert.ok(start);
    assert.equal(classifyLockProcess({ pid: process.pid, start }), "live");
    assert.equal(classifyLockProcess({ pid: process.pid }), "obstructed");
    assert.equal(classifyLockProcess({
      pid: process.pid,
      start: { kind: start.kind, value: `${start.value}0` },
    }), "stale");
  } else {
    assert.equal(start, undefined);
    assert.equal(classifyLockProcess({ pid: process.pid }), "live");
  }
});

test("inspectProcessLiveness reports the current process as live", () => {
  const liveness = inspectProcessLiveness(process.pid);
  assert.equal(liveness.kind, "live");
  if (isWindows) {
    assert.ok(liveness.start);
    assert.equal(liveness.start.kind, "windows-creation-time");
    assert.match(liveness.start.value, /^[0-9]+$/u);
  }
  if (isLinux) {
    assert.ok(liveness.start);
    assert.equal(liveness.start.kind, "linux-startticks");
    assert.match(liveness.start.value, /^[0-9]+$/u);
  }
});
