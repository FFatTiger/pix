#!/usr/bin/env node
/**
 * Trampoline that re-spawns fixture-worker.mjs with FIXTURE_MODE as argv[2].
 * ProductionWorkerProcessFactory always launches `execPath workerMain` with no
 * extra argv, so tests that need a mode flag go through this entry.
 *
 * FIXTURE_MODE is read from env (not a PIX_* key) so buildWorkerEnv forwards
 * nothing special — the trampoline is itself the workerMainPath and inherits
 * the filtered env, but we re-read from the original process env is wrong.
 * Instead: the factory's buildWorkerEnv does not forward FIXTURE_MODE.
 *
 * So we encode the mode in the trampoline filename? No — pass via a sibling
 * convention: read mode from the last path segment query... simplest fix:
 * write per-mode trampolines is heavy. Better: the parent factory test sets
 * workerMainPath to this file AND we stash mode in an env key that IS
 * forwarded. Use PI_CODING_AGENT_DIR? Too invasive.
 *
 * Practical approach: this trampoline parses its own source path's directory
 * and reads `./.fixture-mode` — still racey.
 *
 * Best approach for tests: argv is only [trampoline]. Embed mode by using
 * distinct trampoline files generated at test time. For static fixtures,
 * accept mode via the non-filtered approach of spawning with a custom
 * execPath script:
 *
 *   execPath = node, workerMainPath = trampoline which reads process.argv
 *
 * Actually ProductionWorkerProcessFactory spawns:
 *   spawn(execPath, [workerMainPath], { env: buildWorkerEnv(sourceEnv) })
 *
 * buildWorkerEnv drops unknown keys. We'll extend the test factory helper to
 * pass `env` that includes a custom key and patch buildWorkerEnv in tests?
 * Cleaner: allow optional `extraEnv` only through ProductionWorkerProcessOptions
 * for test injection of non-secret keys.
 */
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, "fixture-worker.mjs");

// Mode resolution order:
// 1. PIX_FIXTURE_MODE if factory test options added it via extraEnv (see worker-process)
// 2. FIXTURE_MODE (forwarded only when using raw env override path)
// 3. default echo
const mode = process.env.PIX_FIXTURE_MODE || process.env.FIXTURE_MODE || "echo";

const child = spawn(process.execPath, [fixture, mode], {
  stdio: ["pipe", "pipe", "pipe"],
  env: process.env,
  windowsHide: true,
});

// Do not use pipe() for stdin: on Darwin, pipe() auto-ends the grandchild
// stdin and can tear down this trampoline before SIGKILL escalation.
// VS Code keeps stdio lifetime explicit on child wrappers.
process.stdin.on("data", (chunk) => {
  if (!child.stdin.destroyed) child.stdin.write(chunk);
});
process.stdin.on("end", () => {
  if (!child.stdin.destroyed) child.stdin.end();
});
process.stdin.resume();
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);

child.on("error", (error) => {
  process.stderr.write(`trampoline spawn error: ${error.message}\n`);
  process.exit(1);
});
child.on("exit", (code, signal) => {
  if (signal) {
    // Re-raise so parent sees the same signal disposition when possible.
    try {
      process.kill(process.pid, signal);
    } catch {
      process.exit(code ?? 1);
    }
    return;
  }
  process.exit(code ?? 0);
});

for (const signal of ["SIGTERM", "SIGINT"]) {
  try {
    process.on(signal, () => {
      try {
        child.kill(signal);
      } catch {
        // ignore
      }
    });
  } catch {
    // ignore
  }
}
