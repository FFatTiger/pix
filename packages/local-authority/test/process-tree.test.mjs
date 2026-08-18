import assert from "node:assert/strict";
import test from "node:test";
import { createProcessTreeController } from "../dist/process/index.js";

test("createProcessTreeController selects POSIX vs Windows by platform", () => {
  const posix = createProcessTreeController({ platform: "linux" });
  assert.equal(posix.kind, "posix");
  assert.equal(posix.supportsDescendants, true);
  const windows = createProcessTreeController({ platform: "win32" });
  assert.equal(windows.kind, "windows");
  assert.equal(windows.supportsDescendants, false);
});

test("Windows controller keeps direct-child spawn and terminate semantics", async () => {
  const tree = createProcessTreeController({ platform: "win32" });
  const child = tree.spawn({
    argv: [process.execPath, "-e", "setTimeout(() => {}, 30_000)"],
    stdio: ["ignore", "ignore", "ignore"],
    windowsHide: true,
  });
  assert.ok(typeof child.pid === "number");
  assert.equal(tree.terminate(child.pid, "SIGKILL"), true);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("child did not exit")), 5_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
  assert.equal(tree.terminate(child.pid ?? 0, "SIGKILL"), false);
});

test("POSIX controller isolates a process group when not on Windows", { skip: process.platform === "win32" }, async () => {
  const tree = createProcessTreeController({ platform: "linux" });
  const child = tree.spawn({
    argv: [process.execPath, "-e", "setTimeout(() => {}, 30_000)"],
    stdio: ["ignore", "ignore", "ignore"],
  });
  assert.ok(typeof child.pid === "number");
  assert.equal(tree.terminate(child.pid, "SIGKILL"), true);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("child did not exit")), 5_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
});
