import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { mkdtempSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileWatchManager } from "../dist/resources/file-watch.js";

const temporary = [];
const CANON_TMP = realpathSync(tmpdir());
function temp(prefix) {
  const value = mkdtempSync(join(CANON_TMP, prefix));
  temporary.push(value);
  return value;
}
afterEach(() => {
  while (temporary.length) rmSync(temporary.pop(), { recursive: true, force: true });
});

test("file watch overflow is an invalidation hint and triggers an authoritative rescan", async () => {
  const root = temp("pi-watch-overflow-");
  const file = join(root, "target.txt");
  writeFileSync(file, "one");
  let notify;
  let onError;
  const manager = createFileWatchManager(1, {
    watch(_path, listener) {
      notify = listener;
      return {
        close() {},
        on(event, listener) {
          if (event === "error") onError = listener;
        },
      };
    },
  });
  const response = manager.open(file);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const first = await reader.read();
  assert.match(decoder.decode(first.value), /event: connected/);

  writeFileSync(file, "two-two");
  notify("overflow", "unrelated.txt");
  const overflow = await reader.read();
  const overflowText = decoder.decode(overflow.value);
  assert.match(overflowText, /event: change/);
  assert.match(overflowText, /size/);
  assert.ok(!overflowText.includes("unrelated.txt"), "raw overflow filename is not authority");

  const err = new Error("inotify queue overflow");
  err.code = "ENOSPC";
  writeFileSync(file, "three-three");
  onError(err);
  const rescanned = await reader.read();
  assert.match(decoder.decode(rescanned.value), /event: change/);
  assert.equal(manager.activeCount(), 1, "overflow must not close the watch");
  await reader.cancel();
});
