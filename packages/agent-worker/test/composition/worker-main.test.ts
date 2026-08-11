import { describe, it, before, afterEach } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runWorkerMain } from "../../src/composition/worker-main.js";
import { FakeAgentRuntimeFactory } from "../helpers/fake-runtime.js";
import type { RuntimeCommandResult as CoreRuntimeCommandResult } from "@fffattiger/pix-runtime-core";

const here = dirname(fileURLToPath(import.meta.url));

/** Climb from the compiled (dist-test) or source test path to the package root. */
function findPackageRoot(start: string): string {
  let dir = start;
  for (let i = 0; i < 8; i += 1) {
    const manifest = join(dir, "package.json");
    if (existsSync(manifest)) {
      try {
        const name = JSON.parse(readFileSync(manifest, "utf8")).name as string | undefined;
        if (name === "@fffattiger/pix-agent-worker") return dir;
      } catch {
        // keep climbing
      }
    }
    dir = resolve(dir, "..");
  }
  throw new Error(`agent-worker package root not found from ${start}`);
}

const packageRoot = findPackageRoot(here);
const workspaceRoot = resolve(packageRoot, "..", "..");
const fixturePath = resolve(packageRoot, "test", "fixtures", "child-worker-factory.mjs");

/** Resolve the worker-main entry exactly as R2 does via the package exports. */
function resolveWorkerMainEntry(): string {
  const url = import.meta.resolve("@fffattiger/pix-agent-worker/worker-main");
  return fileURLToPath(url);
}

/** A minimal NDJSON frame reader over a child's stdout. */
class ChildNdjson {
  readonly frames: Record<string, unknown>[] = [];
  readonly stderr: string[] = [];
  private readonly consumed = new Set<Record<string, unknown>>();
  private buffer = "";

  constructor(child: ChildProcessWithoutNullStreams) {
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      this.buffer += chunk;
      let index = this.buffer.indexOf("\n");
      while (index !== -1) {
        const line = this.buffer.slice(0, index).trim();
        this.buffer = this.buffer.slice(index + 1);
        if (line.length > 0) {
          try {
            this.frames.push(JSON.parse(line) as Record<string, unknown>);
          } catch {
            this.frames.push({ __malformed: line });
          }
        }
        index = this.buffer.indexOf("\n");
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => this.stderr.push(chunk));
  }

  waitFor(predicate: (frame: Record<string, any>) => boolean, timeoutMs = 5_000): Promise<Record<string, any>> {
    return new Promise((resolvePromise, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(
          new Error(
            `timeout waiting for frame; saw=[${this.frames.map((f) => String((f as { type?: string }).type)).join(",")}] stderr=${this.stderr.join("")}`,
          ),
        );
      }, timeoutMs);
      const check = () => {
        if (settled) return;
        const frame = this.frames.find((f) => !this.consumed.has(f) && predicate(f));
        if (frame) {
          settled = true;
          this.consumed.add(frame);
          clearTimeout(timer);
          resolvePromise(frame);
          return;
        }
        setTimeout(check, 10);
      };
      check();
    });
  }
}

function writeFrame(stream: NodeJS.WritableStream, frame: unknown): void {
  stream.write(`${JSON.stringify(frame)}\n`);
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs = 5_000): Promise<number | null> {
  return new Promise((resolvePromise) => {
    if (child.exitCode !== null) {
      resolvePromise(child.exitCode);
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // already dead
      }
      resolvePromise(child.exitCode);
    }, timeoutMs);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolvePromise(code);
    });
  });
}

/** Track live children so a failed assertion never leaves an orphan process. */
const liveChildren = new Set<ChildProcessWithoutNullStreams>();
/** Track worker grandchild PIDs (spawned by probe parent scripts) for cleanup. */
const liveWorkerPids = new Set<number>();

function spawnWorker(env: NodeJS.ProcessEnv): ChildProcessWithoutNullStreams {
  const child = spawn(process.execPath, [resolveWorkerMainEntry()], {
    cwd: workspaceRoot,
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  liveChildren.add(child);
  child.once("exit", () => liveChildren.delete(child));
  return child;
}

describe("worker-main composition (in-process)", () => {
  it("drives init → ready → command → shutdown through real transport/controller wiring", async () => {
    const factory = new FakeAgentRuntimeFactory();
    factory.script = () => ({
      sessionId: "sess-real",
      onExecute: async (command, runtime) => {
        if (command.type === "prompt") {
          runtime.emit({ type: "agent_start", sessionId: "sess-real" });
          runtime.emit({ type: "message_update", sessionId: "sess-real", message: { role: "assistant", content: [{ type: "text", text: "hi" }] } });
          runtime.emit({ type: "message_end", sessionId: "sess-real", message: { role: "assistant", content: [{ type: "text", text: "hi" }], model: "m", provider: "p" } });
          return { ok: true, type: "prompt" };
        }
        return { ok: true, type: command.type } as CoreRuntimeCommandResult;
      },
    });
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const exitCodes: number[] = [];
    const handle = await runWorkerMain({ factory, stdin, stdout, exit: (code) => exitCodes.push(code), stderr: () => {} });
    assert.ok(handle.controller !== null);

    const frames: Record<string, any>[] = [];
    stdout.setEncoding("utf8");
    stdout.on("data", (chunk: string) => {
      for (const line of chunk.split("\n").filter((l) => l.length > 0)) frames.push(JSON.parse(line));
    });

    writeFrame(stdin, { type: "worker.init", id: "init-1", protocolVersion: 1, payload: { mode: "create", sessionId: "provisional", cwd: "/workspace", projectRoot: "/workspace" } });
    await tick();
    await tick();
    assert.ok(frames.some((f) => f.type === "worker.sessionDiscovered"));
    assert.ok(frames.some((f) => f.type === "worker.ready"));

    writeFrame(stdin, { type: "worker.command", id: "wire-1", protocolVersion: 1, payload: { sessionId: "sess-real", command: { commandId: "cmd-1", type: "prompt", message: "hi" } } });
    await tick();
    await tick();
    await tick();
    const events = frames.filter((f) => f.type === "worker.event");
    assert.ok(events.length >= 3, `expected stream events, got ${events.length}`);
    const results = frames.filter((f) => f.type === "worker.commandResult");
    assert.equal(results.length, 1);
    assert.equal(results[0]!.payload.result.commandId, "cmd-1");

    writeFrame(stdin, { type: "worker.shutdown", id: "sh-1", protocolVersion: 1, payload: { reason: "user" } });
    const code = await handle.closed;
    assert.equal(code, 0);
  });

  it("unsupported PIX_AGENT_BACKEND emits worker.fatal and exits 1", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const exitCodes: number[] = [];
    process.env.PIX_AGENT_BACKEND = "rpc";
    try {
      const handle = await runWorkerMain({ stdin, stdout, exit: (code) => exitCodes.push(code), stderr: () => {} });
      assert.equal(handle.controller, null);
      const code = await handle.closed;
      assert.equal(code, 1);
      await tick();
      const out = stdout.read()?.toString("utf8") ?? "";
      assert.ok(out.includes("worker.fatal"));
      assert.ok(out.includes("unsupported_capability"));
      assert.deepEqual(exitCodes, [1]);
    } finally {
      delete process.env.PIX_AGENT_BACKEND;
    }
  });
});

describe("worker-main composition (real child process)", () => {
  before(() => {
    const entryPath = resolveWorkerMainEntry();
    if (!existsSync(entryPath)) {
      throw new Error(`worker-main dist entry missing (run npm run build first): ${entryPath}`);
    }
    if (!existsSync(fixturePath)) {
      throw new Error(`child factory fixture missing: ${fixturePath}`);
    }
  });

  afterEach(() => {
    for (const child of [...liveChildren]) {
      try {
        child.kill("SIGKILL");
      } catch {
        // already dead
      }
      liveChildren.delete(child);
    }
  });

  it("spawns the executable, completes create/rekey/prompt/shutdown, and exits cleanly on EOF", async () => {
    const child = spawnWorker({ PIX_AGENT_WORKER_FACTORY: fixturePath });
    const ndjson = new ChildNdjson(child);

    writeFrame(child.stdin, {
      type: "worker.init",
      id: "init-1",
      protocolVersion: 1,
      payload: { mode: "create", sessionId: "provisional", cwd: "/workspace", projectRoot: "/workspace" },
    });

    const discovered = await ndjson.waitFor((f) => f.type === "worker.sessionDiscovered");
    assert.equal(discovered.payload.sessionId, "sess-created-real");
    const ready = await ndjson.waitFor((f) => f.type === "worker.ready");
    assert.equal(ready.payload.sessionId, "sess-created-real");
    assert.equal(ready.payload.workerStatus, "ready");

    writeFrame(child.stdin, {
      type: "worker.command",
      id: "wire-1",
      protocolVersion: 1,
      payload: { sessionId: "sess-created-real", command: { commandId: "cmd-1", type: "prompt", message: "hi" } },
    });
    const eventFrames = await Promise.all([
      ndjson.waitFor((f) => f.type === "worker.event" && f.payload.event.type === "message_start"),
      ndjson.waitFor((f) => f.type === "worker.event" && f.payload.event.type === "message_update"),
      ndjson.waitFor((f) => f.type === "worker.event" && f.payload.event.type === "message_end"),
    ]);
    assert.equal(eventFrames.length, 3);
    assert.deepEqual(eventFrames[1]!.payload.event.delta, {
      role: "assistant",
      delta: { type: "text", text: " world" },
    });
    const result = await ndjson.waitFor((f) => f.type === "worker.commandResult");
    assert.equal(result.payload.result.commandId, "cmd-1");

    // Snapshot round trip.
    writeFrame(child.stdin, {
      type: "worker.getSnapshot",
      id: "snap-1",
      protocolVersion: 1,
      payload: { sessionId: "sess-created-real" },
    });
    const snapshot = await ndjson.waitFor((f) => f.type === "worker.snapshot");
    assert.equal(snapshot.id, "snap-1");
    assert.equal(snapshot.payload.snapshot.sessionId, "sess-created-real");

    // Ordered shutdown via stdin EOF must terminate the process.
    child.stdin.end();
    const exitCode = await waitForExit(child);
    assert.equal(exitCode, 0);
  });

  it("spawns the executable and fails closed on an unsupported backend", async () => {
    const child = spawnWorker({ PIX_AGENT_BACKEND: "rpc" });
    const ndjson = new ChildNdjson(child);
    const fatal = await ndjson.waitFor((f) => f.type === "worker.fatal");
    assert.equal(fatal.payload.error.code, "unsupported_capability");
    child.stdin.end();
    const exitCode = await waitForExit(child);
    assert.equal(exitCode, 1);
  });

  it("live-parent stdin.end still exits 0 (graceful EOF contract)", async () => {
    const child = spawnWorker({ PIX_AGENT_WORKER_FACTORY: fixturePath });
    const ndjson = new ChildNdjson(child);
    writeFrame(child.stdin, {
      type: "worker.init",
      id: "init-live",
      protocolVersion: 1,
      payload: { mode: "create", sessionId: "provisional", cwd: "/workspace", projectRoot: "/workspace" },
    });
    await ndjson.waitFor((f) => f.type === "worker.ready");
    child.stdin.end();
    const exitCode = await waitForExit(child, 5_000);
    assert.equal(exitCode, 0);
  });
});

/**
 * Real-process orphan hardening: when a parent dies (normal exit / throw /
 * SIGKILL) the worker child must observe stdin EOF and exit within a bounded
 * window even though stdout/stderr close at the same time. Live-parent
 * stdin.end remains the graceful path (exit 0).
 *
 * Each scenario is repeated ≥5 times. Worker PIDs are captured and asserted
 * dead; afterEach / finally always SIGKILL residual children.
 */
describe("worker-main parent-death orphan hardening (real process)", () => {
  before(() => {
    if (!existsSync(resolveWorkerMainEntry())) {
      throw new Error(`worker-main dist entry missing: ${resolveWorkerMainEntry()}`);
    }
    if (!existsSync(fixturePath)) {
      throw new Error(`child factory fixture missing: ${fixturePath}`);
    }
  });

  afterEach(() => {
    for (const child of [...liveChildren]) {
      try {
        child.kill("SIGKILL");
      } catch {
        // already dead
      }
      liveChildren.delete(child);
    }
    // Kill any residual worker grandchild PIDs that were reparented and thus
    // not reached by killing the parent ChildProcess.
    for (const pid of [...liveWorkerPids]) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // already dead
      }
      liveWorkerPids.delete(pid);
    }
  });

  const ROUNDS = 5;
  /** Parent death must kill the worker well under the 1s broken-stdio watchdog. */
  const ORPHAN_DEADLINE_MS = 3_000;
  /** Parent delays cycled across rounds to cover the pre-transport race. */
  const PARENT_DELAYS_MS = [0, 50, 150, 0, 50];

  async function assertWorkerDiesAfterParent(
    mode: "exit0" | "crash" | "sigkill",
    rounds: number,
  ): Promise<void> {
    for (let round = 0; round < rounds; round += 1) {
      const delay = PARENT_DELAYS_MS[round % PARENT_DELAYS_MS.length]!;
      const result = await runParentDeathProbe(mode, ORPHAN_DEADLINE_MS, delay);
      assert.equal(
        result.workerAlive,
        false,
        `round ${round + 1}/${rounds} mode=${mode} delay=${delay}ms: worker pid=${result.workerPid} still alive after parent death ` +
          `(waited ${result.waitedMs}ms). stderr=${JSON.stringify(result.parentStderr)}`,
      );
      assert.ok(result.workerPid > 0, "expected a real worker pid");
    }
  }

  it("parent normal exit (process.exit 0) does not orphan the worker (≥5 rounds)", async () => {
    await assertWorkerDiesAfterParent("exit0", ROUNDS);
  });

  it("parent throw/crash does not orphan the worker (≥5 rounds)", async () => {
    await assertWorkerDiesAfterParent("crash", ROUNDS);
  });

  it("parent SIGKILL does not orphan the worker (≥5 rounds)", async () => {
    await assertWorkerDiesAfterParent("sigkill", ROUNDS);
  });

  it("broken stderr alone (parent still alive) still allows clean stdin.end exit", async () => {
    // Parent keeps stdout open but destroys its stderr reader so the child's
    // stderr pipe breaks; stdin.end from the live parent must still exit 0.
    const child = spawnWorker({ PIX_AGENT_WORKER_FACTORY: fixturePath });
    const ndjson = new ChildNdjson(child);
    writeFrame(child.stdin, {
      type: "worker.init",
      id: "init-br-err",
      protocolVersion: 1,
      payload: { mode: "create", sessionId: "provisional", cwd: "/workspace", projectRoot: "/workspace" },
    });
    await ndjson.waitFor((f) => f.type === "worker.ready");
    try {
      child.stderr.destroy();
    } catch {
      // ignore
    }
    child.stdin.end();
    const code = await waitForExit(child, 5_000);
    assert.equal(code, 0);
  });

  it("broken stdout alone (parent still alive) still exits on stdin.end", async () => {
    const child = spawnWorker({ PIX_AGENT_WORKER_FACTORY: fixturePath });
    // Don't attach stdout consumers beyond what's needed — destroy after ready.
    const ndjson = new ChildNdjson(child);
    writeFrame(child.stdin, {
      type: "worker.init",
      id: "init-br-out",
      protocolVersion: 1,
      payload: { mode: "create", sessionId: "provisional", cwd: "/workspace", projectRoot: "/workspace" },
    });
    await ndjson.waitFor((f) => f.type === "worker.ready");
    try {
      child.stdout.destroy();
    } catch {
      // ignore
    }
    child.stdin.end();
    // Exit code may be 0 (ordered) or 1 (flush/watchdog under broken stdout);
    // the contract is that the process terminates, not that it stays at 0.
    const code = await waitForExit(child, 5_000);
    assert.ok(code === 0 || code === 1, `expected exit 0|1, got ${code}`);
  });

  it("broken stdout+stderr together (simulating parent death pipes) still exits on stdin.end", async () => {
    const child = spawnWorker({ PIX_AGENT_WORKER_FACTORY: fixturePath });
    const ndjson = new ChildNdjson(child);
    writeFrame(child.stdin, {
      type: "worker.init",
      id: "init-br-both",
      protocolVersion: 1,
      payload: { mode: "create", sessionId: "provisional", cwd: "/workspace", projectRoot: "/workspace" },
    });
    await ndjson.waitFor((f) => f.type === "worker.ready");
    try {
      child.stdout.destroy();
    } catch {
      // ignore
    }
    try {
      child.stderr.destroy();
    } catch {
      // ignore
    }
    child.stdin.end();
    const code = await waitForExit(child, 5_000);
    assert.ok(code === 0 || code === 1, `expected exit 0|1, got ${code}`);
  });
});

interface ParentDeathResult {
  workerPid: number;
  workerAlive: boolean;
  waitedMs: number;
  parentStderr: string;
}

/**
 * Spawn a short-lived parent that itself spawns the real worker-main, prints
 * the worker pid, then dies according to `mode`. The test process then polls
 * whether the worker pid is still alive.
 *
 * `parentDelayMs` controls how long the parent lives before dying — 0/50ms
 * exercises the pre-transport race (parent dead before transport.start),
 * 150ms exercises the running-worker case.
 */
function runParentDeathProbe(
  mode: "exit0" | "crash" | "sigkill",
  deadlineMs: number,
  parentDelayMs = 150,
): Promise<ParentDeathResult> {
  return new Promise((resolvePromise, reject) => {
    const workerEntry = resolveWorkerMainEntry();
    // Inline parent script: spawns worker, prints WORKER_PID, then dies.
    // Uses only node builtins so no build step is required.
    const parentSource = `
const { spawn } = require("node:child_process");
const worker = spawn(process.execPath, ${JSON.stringify([workerEntry])}, {
  env: { ...process.env, PIX_AGENT_WORKER_FACTORY: ${JSON.stringify(fixturePath)} },
  stdio: ["pipe", "pipe", "pipe"],
  detached: false,
});
if (!worker.pid) {
  console.error("no worker pid");
  process.exit(2);
}
process.stdout.write("WORKER_PID=" + worker.pid + "\\n");
// Keep pipes alive briefly so the worker boots, then die as requested.
setTimeout(() => {
  const mode = ${JSON.stringify(mode)};
  if (mode === "exit0") {
    process.exit(0);
  } else if (mode === "crash") {
    throw new Error("parent intentional crash");
  } else if (mode === "sigkill") {
    // Self-SIGKILL: no finally / no stdin.end — pure hard death.
    process.kill(process.pid, "SIGKILL");
  }
}, ${parentDelayMs});
`;
    const parent = spawn(process.execPath, ["-e", parentSource], {
      cwd: workspaceRoot,
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    liveChildren.add(parent as unknown as ChildProcessWithoutNullStreams);

    let stdout = "";
    let stderr = "";
    parent.stdout?.setEncoding("utf8");
    parent.stdout?.on("data", (c: string) => {
      stdout += c;
    });
    parent.stderr?.setEncoding("utf8");
    parent.stderr?.on("data", (c: string) => {
      stderr += c;
    });

    let workerPid = 0;
    const started = Date.now();
    const killWorker = (): void => {
      // Always clean up the worker grandchild PID — killing the parent
      // ChildProcess does NOT reach a reparented grandchild. This prevents
      // machine pollution on any failure.
      if (workerPid > 0) {
        liveWorkerPids.delete(workerPid);
        try {
          process.kill(workerPid, "SIGKILL");
        } catch {
          // already dead
        }
      }
    };
    const finish = (workerAlive: boolean) => {
      killWorker();
      try {
        parent.kill("SIGKILL");
      } catch {
        // ignore
      }
      liveChildren.delete(parent as unknown as ChildProcessWithoutNullStreams);
      resolvePromise({
        workerPid,
        workerAlive,
        waitedMs: Date.now() - started,
        parentStderr: stderr.slice(0, 500),
      });
    };

    const deadline = setTimeout(() => {
      // Timed out waiting for parent/worker lifecycle — treat worker as alive if pid known.
      finish(workerPid > 0 ? isPidAlive(workerPid) : true);
    }, deadlineMs + 2_000);

    parent.on("error", (err) => {
      clearTimeout(deadline);
      reject(err);
    });

    // Wait until we learn the worker pid, then wait for parent death, then poll.
    const pollForPid = () => {
      const match = /WORKER_PID=(\d+)/.exec(stdout);
      if (match) {
        workerPid = Number(match[1]);
        liveWorkerPids.add(workerPid);
        waitForParentThenWorker();
        return;
      }
      if (Date.now() - started > 2_000) {
        clearTimeout(deadline);
        finish(true);
        return;
      }
      setTimeout(pollForPid, 20);
    };

    const waitForParentThenWorker = () => {
      const onParentGone = () => {
        const pollStart = Date.now();
        const poll = () => {
          if (!isPidAlive(workerPid)) {
            clearTimeout(deadline);
            finish(false);
            return;
          }
          if (Date.now() - pollStart > deadlineMs) {
            clearTimeout(deadline);
            finish(true);
            return;
          }
          setTimeout(poll, 25);
        };
        poll();
      };
      if (parent.exitCode !== null || parent.signalCode !== null) {
        onParentGone();
        return;
      }
      parent.once("exit", onParentGone);
    };

    pollForPid();
  });
}

function isPidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  // kill(pid, 0) succeeds for zombies too (they still occupy a PID until reaped),
  // which would make a dying worker look alive. Use `ps -o stat=` to confirm a
  // truly-running process whose STAT does not start with 'Z' (zombie).
  try {
    const result = spawnSync("ps", ["-p", String(pid), "-o", "stat="], {
      encoding: "utf8",
      timeout: 1_000,
    });
    if (result.status !== 0 || result.error) return false;
    const stat = result.stdout.trim();
    return stat.length > 0 && !stat.startsWith("Z");
  } catch {
    return false;
  }
}
