import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readInstanceLock, sessiondPaths } from "@fffattiger/pix-sessiond/control";

const tempDir = (): Promise<string> => mkdtemp(join(tmpdir(), "pix-control-export-"));

test("control compatibility export exposes readInstanceLock", async () => {
  const dir = await tempDir();
  const paths = sessiondPaths(dir);
  try {
    await writeFile(paths.lockFile, JSON.stringify({ pid: 123, instanceId: "compat", createdAt: 456 }));
    assert.deepEqual(await readInstanceLock(paths), { pid: 123, instanceId: "compat", createdAt: 456 });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
