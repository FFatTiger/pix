import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import test from "node:test";
import { createProcessTreeController, windowsTaskkillPath } from "../dist/process/index.js";

test("createProcessTreeController selects POSIX vs Windows by platform", () => {
  const posix = createProcessTreeController({ platform: "linux" });
  assert.equal(posix.kind, "posix");
  assert.equal(posix.supportsDescendants, true);
  const windows = createProcessTreeController({ platform: "win32" });
  assert.equal(windows.kind, "windows");
  assert.equal(windows.supportsDescendants, true);
});

test("windowsTaskkillPath uses WINDIR System32 and never PATH", () => {
  assert.equal(windowsTaskkillPath({ WINDIR: "D:\\Windows" }), join("D:\\Windows", "System32", "taskkill.exe"));
  assert.equal(windowsTaskkillPath({}), join("C:\\Windows", "System32", "taskkill.exe"));
  assert.equal(windowsTaskkillPath({ WINDIR: "C:\\Windows\0evil" }), join("C:\\Windows", "System32", "taskkill.exe"));
});

test("Windows controller keeps spawn and terminate semantics", async () => {
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

test("Windows SIGKILL taskkill also stops a grandchild", { skip: process.platform !== "win32" }, async () => {
  const tree = createProcessTreeController({ platform: "win32" });
  const child = tree.spawn({
    argv: [
      process.execPath,
      "-e",
      "const {spawn}=require('child_process'); const g=spawn(process.execPath,['-e','setTimeout(()=>{},30000)'],{stdio:'ignore',windowsHide:true}); process.stdout.write(String(g.pid)); setTimeout(()=>{},30000);",
    ],
    stdio: ["ignore", "pipe", "ignore"],
    windowsHide: true,
  });
  const grandchildPid = await new Promise((resolve, reject) => {
    let text = "";
    const timer = setTimeout(() => reject(new Error("grandchild pid was not printed")), 5_000);
    child.stdout.on("data", (chunk) => {
      text += String(chunk);
      const match = text.match(/[0-9]+/);
      if (match) {
        clearTimeout(timer);
        resolve(Number(match[0]));
      }
    });
    child.once("error", reject);
  });
  assert.equal(tree.terminate(child.pid, "SIGKILL"), true);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("parent did not exit")), 5_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
  const stillListed = spawnSync(windowsTaskkillPath(), ["/T", "/F", "/PID", String(grandchildPid)], {
    stdio: "ignore",
    windowsHide: true,
    shell: false,
  });
  assert.notEqual(stillListed.status, 0);
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
