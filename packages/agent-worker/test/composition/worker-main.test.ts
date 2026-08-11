import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runWorkerMain } from "../../src/composition/worker-main.js";
import { FakeAgentRuntimeFactory } from "../helpers/fake-runtime.js";
import type { RuntimeCommandResult as CoreRuntimeCommandResult } from "@fffattiger/pix-runtime-core";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, "..", "..");
const workspaceRoot = resolve(packageRoot, "..", "..");

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

  constructor(child: ReturnType<typeof spawn>) {
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
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
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => this.stderr.push(chunk));
  }

  waitFor(predicate: (frame: Record<string, any>) => boolean, timeoutMs = 8_000): Promise<Record<string, any>> {
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for frame; stderr: ${this.stderr.join("")}`)), timeoutMs);
      const check = () => {
        const frame = this.frames.find((f) => !this.consumed.has(f) && predicate(f));
        if (frame) {
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

function waitForExit(child: ReturnType<typeof spawn>, timeoutMs = 8_000): Promise<number | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(child.exitCode), timeoutMs);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
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
  let entryPath = "";
  before(() => {
    entryPath = resolveWorkerMainEntry();
    if (!existsSync(entryPath)) {
      throw new Error(`worker-main dist entry missing (run npm run build first): ${entryPath}`);
    }
  });

  it("spawns the executable, completes create/rekey/prompt/shutdown, and exits cleanly on EOF", async () => {
    const fixturePath = resolve(here, "..", "fixtures", "child-worker-factory.mjs");
    const child = spawn(process.execPath, [entryPath], {
      cwd: workspaceRoot,
      env: { ...process.env, PIX_AGENT_WORKER_FACTORY: fixturePath },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const ndjson = new ChildNdjson(child);

    writeFrame(child.stdin!, { type: "worker.init", id: "init-1", protocolVersion: 1, payload: { mode: "create", sessionId: "provisional", cwd: "/workspace", projectRoot: "/workspace" } });

    const discovered = await ndjson.waitFor((f) => f.type === "worker.sessionDiscovered");
    assert.equal(discovered.payload.sessionId, "sess-created-real");
    const ready = await ndjson.waitFor((f) => f.type === "worker.ready");
    assert.equal(ready.payload.sessionId, "sess-created-real");
    assert.equal(ready.payload.workerStatus, "ready");

    writeFrame(child.stdin!, { type: "worker.command", id: "wire-1", protocolVersion: 1, payload: { sessionId: "sess-created-real", command: { commandId: "cmd-1", type: "prompt", message: "hi" } } });
    const eventFrames = await Promise.all([
      ndjson.waitFor((f) => f.type === "worker.event" && f.payload.event.type === "message_start"),
      ndjson.waitFor((f) => f.type === "worker.event" && f.payload.event.type === "message_update"),
      ndjson.waitFor((f) => f.type === "worker.event" && f.payload.event.type === "message_end"),
    ]);
    assert.equal(eventFrames.length, 3);
    assert.deepEqual(eventFrames[1]!.payload.event.delta, { role: "assistant", delta: { type: "text", text: " world" } });
    const result = await ndjson.waitFor((f) => f.type === "worker.commandResult");
    assert.equal(result.payload.result.commandId, "cmd-1");

    // Snapshot round trip.
    writeFrame(child.stdin!, { type: "worker.getSnapshot", id: "snap-1", protocolVersion: 1, payload: { sessionId: "sess-created-real" } });
    const snapshot = await ndjson.waitFor((f) => f.type === "worker.snapshot");
    assert.equal(snapshot.id, "snap-1");
    assert.equal(snapshot.payload.snapshot.sessionId, "sess-created-real");

    // Ordered shutdown via stdin EOF must terminate the process.
    child.stdin!.end();
    const exitCode = await waitForExit(child);
    assert.equal(exitCode, 0);
  });

  it("spawns the executable and fails closed on an unsupported backend", async () => {
    const child = spawn(process.execPath, [entryPath], {
      cwd: workspaceRoot,
      env: { ...process.env, PIX_AGENT_BACKEND: "rpc" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const ndjson = new ChildNdjson(child);
    const fatal = await ndjson.waitFor((f) => f.type === "worker.fatal");
    assert.equal(fatal.payload.error.code, "unsupported_capability");
    child.stdin!.end();
    const exitCode = await waitForExit(child);
    assert.equal(exitCode, 1);
  });
});
