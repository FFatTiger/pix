#!/usr/bin/env node
/**
 * Controllable fixture child for R2 factory tests.
 *
 * Modes via argv[2] or PIX_FIXTURE_MODE:
 *   echo            — parse stdin NDJSON, echo worker.ready on init, exit on stdin EOF
 *   early-message   — print a valid worker.ready immediately, then wait for EOF
 *   early-exit      — print worker.ready and exit 0 immediately
 *   early-exit-1    — exit 1 immediately (no message)
 *   hang            — ignore stdin EOF; only die on SIGTERM/SIGKILL (for close escalation)
 *   hang-term       — ignore SIGTERM; only die on SIGKILL
 *   stderr-flood    — flood stderr with secrets/paths then wait for EOF
 *   split-frames    — write a ready frame in small chunks with delay
 *   oversize        — write an oversize line then exit
 *   malformed       — write invalid JSON then exit
 *   coalesced       — write two frames in one write()
 *   slow-stdin      — pause reading stdin (backpressure)
 *   exit-signal     — wait for signal only
 *   print-env       — dump selected env keys as a worker.event-like diagnostic line then exit
 *
 * Protocol: worker → sessiond frames use existing WorkerToSessiond schema.
 */
import { createInterface } from "node:readline";

const mode = process.argv[2] || process.env.PIX_FIXTURE_MODE || "echo";

function writeFrame(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function ready(id = "init:fixture", sessionId = "sess-fixture") {
  writeFrame({
    type: "worker.ready",
    id,
    payload: { sessionId, workerStatus: "ready" },
  });
}

function onSignal(handler) {
  for (const signal of ["SIGTERM", "SIGINT"]) {
    try {
      process.on(signal, () => handler(signal));
    } catch {
      // Windows may not support all signals
    }
  }
}

function drainStdin(onLine, onEnd) {
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on("line", (line) => {
    if (!line) return;
    try {
      onLine(JSON.parse(line));
    } catch {
      // ignore malformed inbound for fixture simplicity
    }
  });
  rl.on("close", () => onEnd?.());
}

switch (mode) {
  case "early-message": {
    ready("early", "sess-early");
    drainStdin(() => {}, () => process.exit(0));
    break;
  }
  case "early-exit": {
    ready("early-exit", "sess-early-exit");
    process.exit(0);
    break;
  }
  case "early-exit-1": {
    process.stderr.write("fixture intentional failure\n");
    process.exit(1);
    break;
  }
  case "hang": {
    // Ignore stdin EOF; keep the event loop alive and exit only on
    // SIGTERM/SIGKILL. Signal listeners alone do not keep Node alive on Unix.
    process.stdin.resume();
    setInterval(() => {}, 1_000);
    onSignal((signal) => {
      process.stderr.write(`fixture got ${signal}\n`);
      process.exit(0);
    });
    ready("hang-ready", "sess-hang");
    break;
  }
  case "hang-term": {
    process.stdin.resume();
    setInterval(() => {}, 1_000);
    // Swallow SIGTERM; only SIGKILL works.
    try {
      process.on("SIGTERM", () => {
        process.stderr.write("fixture ignoring SIGTERM\n");
      });
    } catch {
      // ignore
    }
    ready("hang-term-ready", "sess-hang-term");
    break;
  }
  case "stderr-flood": {
    const secret =
      "OPENAI_API_KEY=sk-secretvalueABCDEFGHIJKLMNOPQRSTUVWX " +
      "Authorization: Bearer supersecrettokenvalue " +
      "path=/Users/proxy/.pi/secrets/key.json " +
      "token=abcd1234efgh5678ijkl9012mnop3456qrstuvwx\n";
    for (let i = 0; i < 2000; i += 1) process.stderr.write(secret);
    drainStdin(() => {}, () => process.exit(0));
    break;
  }
  case "stderr-split-secret": {
    // Emit a long secret across many tiny writes (no coalescing) then exit 1
    // so the parent's exit.error surfaces stderr.snapshot().slice(0,400).
    const secret =
      "OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz0123456789ABCDEF\n";
    // Write 1–3 bytes at a time to force many pipe-level chunk boundaries.
    for (let i = 0; i < secret.length; ) {
      const n = 1 + (i % 3);
      process.stderr.write(secret.slice(i, i + n));
      i += n;
    }
    // Also a Bearer split similarly.
    const bearer = "Authorization: Bearer supersecrettokenvalueXYZ1234567890\n";
    for (let i = 0; i < bearer.length; ) {
      const n = 1 + (i % 2);
      process.stderr.write(bearer.slice(i, i + n));
      i += n;
    }
    process.exit(1);
    break;
  }
  case "split-frames": {
    const frame = JSON.stringify({
      type: "worker.ready",
      id: "split",
      payload: { sessionId: "sess-split", workerStatus: "ready" },
    }) + "\n";
    let offset = 0;
    const step = () => {
      if (offset >= frame.length) {
        drainStdin(() => {}, () => process.exit(0));
        return;
      }
      const end = Math.min(offset + 7, frame.length);
      process.stdout.write(frame.slice(offset, end));
      offset = end;
      setTimeout(step, 5);
    };
    step();
    break;
  }
  case "oversize": {
    const huge = "x".repeat(2 * 1024 * 1024 + 64);
    process.stdout.write(`{"type":"worker.ready","id":"x","payload":{"sessionId":"${huge}","workerStatus":"ready"}}\n`);
    process.exit(0);
    break;
  }
  case "malformed": {
    process.stdout.write("{not-json\n");
    process.exit(0);
    break;
  }
  case "coalesced": {
    const a = JSON.stringify({
      type: "worker.ready",
      id: "c1",
      payload: { sessionId: "sess-c1", workerStatus: "ready" },
    });
    const b = JSON.stringify({
      type: "worker.status",
      payload: { sessionId: "sess-c1", status: "ready" },
    });
    process.stdout.write(`${a}\n${b}\n`);
    drainStdin(() => {}, () => process.exit(0));
    break;
  }
  case "slow-stdin": {
    // Don't read stdin promptly so the parent writer hits backpressure when
    // the OS pipe buffer fills. Still exit on EOF eventually.
    process.stdin.on("data", () => {
      // drop
    });
    process.stdin.on("end", () => process.exit(0));
    // Periodic tiny reads off to keep event loop alive without draining fast.
    break;
  }
  case "exit-signal": {
    process.stdin.resume();
    onSignal(() => process.exit(0));
    break;
  }
  case "print-env": {
    const keys = [
      "PIX_AGENT_BACKEND",
      "PIX_SESSIOND_DIR",
      "PIX_AGENT_WORKER_FACTORY",
      "PATH",
      "HOME",
      "PI_CODING_AGENT_DIR",
      "OPENAI_API_KEY",
      "ANTHROPIC_API_KEY",
      "SESSIOND_SECRET",
      "PIX_PASSWORD",
    ];
    const dump = {};
    for (const key of keys) dump[key] = process.env[key] ?? null;
    // Not a protocol frame — parent tests may read raw or we wrap as fatal-safe.
    // Emit as worker.ready with sessionId carrying a marker; env goes to stderr JSON.
    process.stderr.write(`ENV_DUMP ${JSON.stringify(dump)}\n`);
    ready("env", "sess-env");
    process.exit(0);
    break;
  }
  case "crlf": {
    const frame = JSON.stringify({
      type: "worker.ready",
      id: "crlf",
      payload: { sessionId: "sess-crlf", workerStatus: "ready" },
    });
    process.stdout.write(`${frame}\r\n`);
    drainStdin(() => {}, () => process.exit(0));
    break;
  }
  case "echo":
  default: {
    drainStdin(
      (msg) => {
        if (msg && msg.type === "worker.init") {
          ready(msg.id, msg.payload?.sessionId ?? "sess-fixture");
        } else if (msg && msg.type === "worker.getSnapshot") {
          writeFrame({
            type: "worker.snapshot",
            id: msg.id,
            payload: {
              sessionId: msg.payload?.sessionId ?? "sess-fixture",
              snapshot: {
                sessionId: msg.payload?.sessionId ?? "sess-fixture",
                cwd: "/tmp",
                projectRoot: "/tmp",
                state: {
                  sessionId: msg.payload?.sessionId ?? "sess-fixture",
                  isStreaming: false,
                  isPromptRunning: false,
                  isBashRunning: false,
                  isCompacting: false,
                  model: null,
                  messageCount: 0,
                },
                capabilities: { capabilities: [], version: 1 },
              },
            },
          });
        } else if (msg && msg.type === "worker.ping") {
          writeFrame({ type: "worker.pong", id: msg.id, payload: {} });
        }
      },
      () => process.exit(0),
    );
    break;
  }
}
