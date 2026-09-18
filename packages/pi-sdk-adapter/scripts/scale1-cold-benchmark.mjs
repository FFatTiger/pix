// SCALE1 — cold-start session-list benchmark (synthetic corpus, scripted store).
//
// Usage: node packages/pi-sdk-adapter/scripts/scale1-cold-benchmark.mjs [sessionCount]
//
// Generates a synthetic corpus of N real JSONL session files in a temp dir,
// then measures the COLD list path over the SAME corpus:
//   1. baseline      — fresh store WITHOUT the projection (authoritative
//                      `SessionManager.listAll` re-parses every file);
//   2. projection build — fresh store WITH the projection, index dir deleted
//                      first → unusable index → full rebuild (listAll + persist);
//   3. projection serve — ANOTHER fresh store WITH the projection over the
//                      built index → served from the index (lstat validation +
//                      reconcile, no per-file JSONL parse);
//   4. warm          — the SAME store's second list within the 30s TTL cache.
//
// Each cold measurement runs in a fresh child process so the OS page cache is
// not pre-warmed by an earlier parse of the same corpus. This benchmark is NOT
// part of `npm test` (timing tests are flaky); it is a repeatable evidence
// artifact for the SCALE1 cold-start deliverable.
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const sessionCount = Number(process.argv[2] ?? 1000);
const ROUNDS = 3;

function uuid() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/** A realistic-ish session: header + 60 user/assistant turns with substantive text. */
function sessionJsonl(cwd, sessionId) {
  const header = JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: new Date(1_700_000_000_000).toISOString(), cwd });
  const lines = [header];
  const text = (n) => `Turn ${n} of this conversation contains a realistic amount of prose for a coding-assistant session, discussing implementation details, tradeoffs, and next steps across several paragraphs of analysis. `.repeat(3);
  for (let t = 0; t < 60; t += 1) {
    const base = 1_700_000_000_000 + t * 1000;
    lines.push(JSON.stringify({ type: "message", id: uuid(), parentId: null, timestamp: new Date(base).toISOString(), message: { role: "user", content: text(t), timestamp: base } }));
    lines.push(JSON.stringify({
      type: "message", id: uuid(), parentId: null, timestamp: new Date(base + 1).toISOString(),
      message: {
        role: "assistant",
        content: [{ type: "thinking", thinking: text(t) }, { type: "text", text: text(t) }],
        api: "anthropic", provider: "anthropic", model: "claude-test",
        usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 150, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "end_turn", timestamp: base + 1,
      },
    }));
  }
  return `${lines.join("\n")}\n`;
}

/** Generate the synthetic corpus and return { root, sessionDir, cwd }. */
async function generateCorpus(count) {
  const root = await mkdtemp(join(tmpdir(), "pix-scale1-bench-"));
  const sessionDir = join(root, "sessions");
  const cwd = join(root, "project");
  await mkdir(sessionDir, { recursive: true });
  await mkdir(cwd, { recursive: true });
  const ts = Date.now();
  for (let i = 0; i < count; i += 1) {
    await writeFile(
      join(sessionDir, `${new Date(ts + i).toISOString().replace(/[:.]/g, "-")}_${uuid()}.jsonl`),
      sessionJsonl(cwd, uuid()),
    );
  }
  return { root, sessionDir, cwd };
}

const storePath = join(here, "../dist/internal/session-store.js");

/** Run one cold-list measurement in a FRESH child process (no fs-cache pre-warm). */
function coldMeasure(kind, sessionDir, indexDir) {
  const projection = kind !== "baseline";
  const script = `
    import { createPiSdkSessionStore } from ${JSON.stringify(storePath)};
    import { performance } from "node:perf_hooks";
    const sessionDir = ${JSON.stringify(sessionDir)};
    const indexDir = ${JSON.stringify(indexDir)};
    const store = createPiSdkSessionStore(${projection
      ? `{ sessionDir, projection: { enabled: true, dir: indexDir } }`
      : `{ sessionDir }`});
    const t0 = performance.now();
    const headers = await store.listSessions();
    const t1 = performance.now();
    console.log(JSON.stringify({ ms: t1 - t0, count: headers.length }));
  `;
  const res = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" });
  if (res.status !== 0) throw new Error(`measure ${kind} failed:\n${res.stderr}`);
  return JSON.parse(res.stdout.trim().split("\n").pop());
}

/** One in-process warm measurement: second list within the 30s TTL cache. */
function warmMeasure(sessionDir, indexDir) {
  const script = `
    import { createPiSdkSessionStore } from ${JSON.stringify(storePath)};
    import { performance } from "node:perf_hooks";
    const sessionDir = ${JSON.stringify(sessionDir)};
    const indexDir = ${JSON.stringify(indexDir)};
    const store = createPiSdkSessionStore({ sessionDir, projection: { enabled: true, dir: indexDir } });
    await store.listSessions(); // cold (served from the built index)
    const t0 = performance.now();
    const headers = await store.listSessions(); // warm TTL cache hit
    const t1 = performance.now();
    console.log(JSON.stringify({ ms: t1 - t0, count: headers.length }));
  `;
  const res = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" });
  if (res.status !== 0) throw new Error(`measure warm failed:\n${res.stderr}`);
  return JSON.parse(res.stdout.trim().split("\n").pop());
}

function median(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

async function main() {
  console.log(`SCALE1 cold-start benchmark — synthetic ${sessionCount}-session corpus`);
  const { root, sessionDir } = await generateCorpus(sessionCount);
  const indexDir = join(root, ".pix");
  try {
    // Build the projection once (serves both projection measurements below).
    coldMeasure("projection", sessionDir, indexDir);

    const baselineSamples = [];
    const serveSamples = [];
    for (let i = 0; i < ROUNDS; i += 1) {
      baselineSamples.push(coldMeasure("baseline", sessionDir, indexDir).ms);
      serveSamples.push(coldMeasure("projection", sessionDir, indexDir).ms);
    }
    const baseline = median(baselineSamples);
    const serve = median(serveSamples);

    // Fresh build measurement: delete the index, then a fresh cold list rebuilds it.
    const buildSamples = [];
    for (let i = 0; i < ROUNDS; i += 1) {
      await rm(indexDir, { recursive: true, force: true });
      buildSamples.push(coldMeasure("projection", sessionDir, indexDir).ms);
    }
    const build = median(buildSamples);

    const warm = warmMeasure(sessionDir, indexDir).ms;
    const count = coldMeasure("baseline", sessionDir, indexDir).count;

    const fmt = (ms) => `${ms.toFixed(0).padStart(6)} ms`;
    console.log("-------------------------------------------------------------");
    console.log("  path                    median cold list    vs baseline");
    console.log("  ------------------------------------------------------------");
    console.log(`  baseline (SDK listAll)    ${fmt(baseline)}    1.00x`);
    console.log(`  projection build          ${fmt(build)}    ${(build / baseline).toFixed(2)}x`);
    console.log(`  projection serve          ${fmt(serve)}    ${(serve / baseline).toFixed(2)}x`);
    console.log(`  warm (30s TTL cache)      ${fmt(warm)}        ${(warm / baseline).toFixed(2)}x`);
    console.log("-------------------------------------------------------------");
    console.log(`sessions listed: ${count}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

await main();
