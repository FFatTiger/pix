/**
 * `endpointCleared` platform semantics: POSIX checks the socket file's absence;
 * win32 (named pipe endpoints leave no files) proves liveness with the
 * active-connect probe instead. Unit-tested on macOS by injecting the platform
 * and using a real local listener path.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { endpointCleared } from "../src/supervise.js";
import { sessiondPaths } from "@fffattiger/pix-sessiond/control";
import { fixtureEndpoint } from "./test-endpoint.js";

const dirs: string[] = [];
function freshDir(): string {
  // Short prefix: the probe listener binds a real Unix socket (macOS sun_path
  // budget ~104 bytes with the /private realpath expansion).
  const dir = mkdtempSync(join(tmpdir(), "ec-"));
  dirs.push(dir);
  return dir;
}
test.afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

function pathsWith(endpoint: string) {
  return { ...sessiondPaths(join(freshDir(), "d")), endpoint };
}

test("endpointCleared posix: absent file ⇒ cleared; present file ⇒ not cleared", async () => {
  const absent = pathsWith(join(freshDir(), "gone.sock"));
  assert.equal(await endpointCleared(absent, "darwin"), true);
  const present = join(freshDir(), "present.sock");
  writeFileSync(present, "x");
  assert.equal(await endpointCleared(pathsWith(present), "linux"), false);
});

test("endpointCleared win32: a live listener keeps it uncleared; nothing listening ⇒ cleared", async () => {
  // A real listening socket stands in for the named-pipe listener (the probe
  // is endpoint-path agnostic: it just connects).
  const dir = freshDir();
  const server = createServer();
  const endpoint = fixtureEndpoint(dir);
  await new Promise<void>((resolve) => server.listen(endpoint, resolve));
  try {
    assert.equal(await endpointCleared(pathsWith(endpoint), "win32"), false);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  assert.equal(await endpointCleared(pathsWith(endpoint), "win32"), true);
});
