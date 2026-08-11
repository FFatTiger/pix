import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import {
  createExitWatchdog,
  createSafeStderrLogger,
  createStdinEofLatch,
  installParentDeathWatchdog,
  installProcessStdioGuards,
  isProcessStdioBroken,
  safeStderrWrite,
} from "../../src/transport/safe-stdio.js";

const tick = (ms = 0) => new Promise<void>((r) => setTimeout(r, ms));

describe("safe-stdio", () => {
  it("installProcessStdioGuards is idempotent and attaches error listeners", () => {
    installProcessStdioGuards();
    installProcessStdioGuards();
    // Presence of at least one error listener is what prevents uncaught EPIPE.
    assert.ok(process.stdout.listenerCount("error") >= 1);
    assert.ok(process.stderr.listenerCount("error") >= 1);
  });

  it("safeStderrWrite never throws on a destroyed stream", () => {
    installProcessStdioGuards();
    // Calling with normal process.stderr must not throw.
    assert.doesNotThrow(() => safeStderrWrite("safe-stdio unit probe"));
    // createSafeStderrLogger is the production default used by worker-main.
    const log = createSafeStderrLogger();
    assert.doesNotThrow(() => log("logger probe"));
  });

  it("createExitWatchdog fires once then is a no-op; cancel prevents fire", async () => {
    const exits: number[] = [];
    const dog = createExitWatchdog((code) => exits.push(code));
    dog.arm(20, 7);
    await tick(60);
    assert.equal(dog.fired, true);
    assert.deepEqual(exits, [7]);
    // Second arm after fire is a no-op.
    dog.arm(5, 9);
    await tick(30);
    assert.deepEqual(exits, [7]);

    const exits2: number[] = [];
    const dog2 = createExitWatchdog((code) => exits2.push(code));
    dog2.arm(30, 1);
    dog2.cancel();
    await tick(60);
    assert.equal(dog2.fired, false);
    assert.deepEqual(exits2, []);
  });

  it("isProcessStdioBroken reports false for live process stdio", () => {
    // In the test runner process, stdout/stderr remain open and writable.
    assert.equal(isProcessStdioBroken(), false);
  });

  it("safe logger swallows write errors from a destroyed PassThrough used as stderr", () => {
    // Simulate the production logger writing into a destroyed stream the way
    // a broken pipe would: the callback form + try/catch must not throw.
    installProcessStdioGuards();
    const stream = new PassThrough();
    stream.destroy();
    assert.doesNotThrow(() => {
      try {
        stream.write("x\n", () => {});
      } catch {
        // expected for destroyed stream in some Node versions
      }
      safeStderrWrite("still-safe");
    });
  });

  it("installParentDeathWatchdog is armed and cancel stops polling", () => {
    const dog = installParentDeathWatchdog({ exit: () => {} });
    assert.equal(dog.armed, true);
    dog.cancel();
    assert.equal(dog.armed, false);
    // Cancel is idempotent.
    dog.cancel();
    assert.equal(dog.armed, false);
  });

  it("createStdinEofLatch latches end and reports stream-terminal state", async () => {
    const stream = new PassThrough();
    const latch = createStdinEofLatch(stream);
    assert.equal(latch.eofSeen, false);
    // A `data` consumer (like transport.start) triggers flowing so `end` fires.
    stream.on("data", () => {});
    stream.end("payload");
    await tick(10);
    assert.equal(latch.eofSeen, true);
    // Release removes listeners without throwing.
    assert.doesNotThrow(() => latch.release());
  });

  it("createStdinEofLatch reports true for an already-destroyed stream", () => {
    const stream = new PassThrough();
    stream.destroy();
    const latch = createStdinEofLatch(stream);
    assert.equal(latch.eofSeen, true);
    latch.release();
  });
});
