/**
 * LC-00 layer 2 E2E — REAL Pi SDK runtime over a controllable loopback provider.
 *
 * Chain under test (no fakes on the runtime path):
 *   seeded real SDK JSONL (short / ~1k-message / tool-dense / compacted)
 *     → real sessiond daemon → REAL per-session SDK worker (worker-main default
 *       factory, PIX_AGENT_WORKER_FACTORY cleared)
 *     → real Hono Host runtime WS
 *     → real openai-completions model traffic against 127.0.0.1 (this file's
 *       controlled provider — never remote inference)
 *
 * Proves per history shape (the §5.1 layer-2 contract):
 *   1. worker create/open performs ZERO provider requests before the first
 *      send (no hidden model calls during init/history load);
 *   2. the EXACT supplied prompt reaches the provider exactly once per turn;
 *   3. first streaming events arrive (agent_start / message deltas);
 *   4. the turn completes with commit identity (operationId/turnId/leafId) and
 *      the persisted context contains the exact user + stub assistant text;
 *   5. the post-terminal snapshot is IDLE (isPromptRunning/isStreaming false)
 *      — the previously observed busy-terminal regression is asserted here;
 *   6. a second send on the same session succeeds;
 *   7. provider failures (fixed HTTP 500, context-length 400, broken SSE
 *      stream) settle as bounded, structured terminal failures — never hangs.
 *
 * Privacy: only prompt-match booleans/hashes, counts, bytes, timestamps and
// ids are recorded or reported (see helpers/controlled-provider.mjs).
 *
 * Run: node tests/e2e/lifecycle-real-sdk.mjs
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { RUNTIME_OBSERVE_EXISTING_FEATURE, RUNTIME_SUBMIT_TURN_FEATURE } from "@fffattiger/pix-protocol";
import { seedSessionHistoryForTests, listSeededSessionIdsForTests } from "@fffattiger/pix-pi-sdk-adapter/testing";
import { startControlledProvider, markExactPrompt, hashPrompt, requestHasUserHash } from "./helpers/controlled-provider.mjs";
import {
  RuntimeWsClient,
  bootLifecycleStack,
  COMMAND_TIMEOUT_MS,
  LIFECYCLE_FEATURES,
  SUITE_DEADLINE_MS,
  delay,
  submitFenced,
  submitUnfenced,
  log,
  makeIsolatedDirs,
  teardownLifecycleStack,
  writeStubProviderConfig,
} from "./helpers/lifecycle-stack.mjs";

const ROOT = join(import.meta.dirname, "..", "..");
const CLIENT_DIST = join(ROOT, "packages", "client", "dist");
const STUB_REPLY = ["Hello ", "from ", "the ", "stub ", "provider."].join("");

/** Each size gets one seeded session; the scenario label reaches the provider. */
const HISTORY_SHAPES = [
  { label: "short", turns: 2 },
  { label: "long-1k", turns: 500 },
  { label: "tool-dense", turns: 50, toolDense: true },
  { label: "compacted", turns: 300, compact: { summary: "e2e compaction summary", keptTurns: 3 } },
  { label: "large-jsonl", turns: 8, padBytes: 2_200_000 },
];

function expectedActiveContext(shape, history) {
  const systemAllowance = 2;
  if (shape.label === "compacted") {
    const kept = history.compactKeptTurns;
    return {
      kind: "compacted",
      minMessages: 1 + kept * 2 + 1,
      maxMessages: 1 + kept * 2 + 1 + systemAllowance + 8,
      requireCompaction: true,
      requireOldest: false,
      requireKept: true,
      requireTools: false,
    };
  }
  if (shape.toolDense) {
    const turns = shape.turns;
    return {
      kind: "tool-dense",
      minMessages: turns * 3 + 1,
      maxMessages: turns * 4 + 1 + systemAllowance + 8,
      requireCompaction: false,
      requireOldest: true,
      requireKept: false,
      requireTools: true,
    };
  }
  const turns = shape.turns;
  return {
    kind: shape.label,
    minMessages: turns * 2 + 1,
    maxMessages: turns * 2 + 1 + systemAllowance + 8,
    requireCompaction: false,
    requireOldest: true,
    requireKept: false,
    requireTools: false,
  };
}

function messageText(entry) {
  const content = entry?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((block) => (typeof block?.text === "string" ? block.text : "")).join("");
  return "";
}

function terminalSnapshotDiag(label, snapshot) {
  const state = snapshot?.state ?? {};
  return JSON.stringify({
    label,
    isPromptRunning: state.isPromptRunning,
    isStreaming: state.isStreaming,
    streamingActive: snapshot?.streaming?.active,
    streamingPhase: snapshot?.streaming?.phase,
    leafId: typeof state.leafId === "string" ? `${state.leafId.slice(0, 8)}…` : state.leafId,
    messageCount: state.messageCount,
  });
}

function textDeltaCount(client, sessionId) {
  let count = 0;
  for (const event of client.eventsFor(sessionId)) {
    if (event.type !== "message_update") continue;
    const delta = event.delta?.delta;
    if (delta?.type === "text" && typeof delta.text === "string" && delta.text.length > 0) count += 1;
  }
  return count;
}

function entryIdOf(entry) {
  return typeof entry?.entryId === "string" ? entry.entryId : typeof entry?.id === "string" ? entry.id : undefined;
}

async function readContext(origin, sessionId) {
  const response = await fetch(`${origin}/v1/sessions/${sessionId}/context`);
  const text = await response.text();
  assert.equal(response.status, 200, `context read must stay 200 (got ${response.status}: ${text.slice(0, 300)})`);
  return JSON.parse(text);
}

function assertPersistedTurn(label, context, prompt, assistant, expectedIds) {
  const entries = context.context.entries;
  const lastUser = [...entries].reverse().find((e) => e.message?.role === "user");
  const lastAssistant = [...entries].reverse().find((e) => e.message?.role === "assistant");
  assert.ok(lastUser, `${label}: persisted user entry missing`);
  assert.ok(lastAssistant, `${label}: persisted assistant entry missing`);
  assert.equal(messageText(lastUser), prompt, `${label}: persisted user entry must be the exact prompt`);
  assert.equal(messageText(lastAssistant), assistant, `${label}: persisted assistant entry must be the stub reply`);
  const userId = entryIdOf(lastUser);
  const assistantId = entryIdOf(lastAssistant);
  assert.ok(typeof userId === "string" && userId.length > 0, `${label}: persisted user entryId missing`);
  assert.ok(typeof assistantId === "string" && assistantId.length > 0, `${label}: persisted assistant entryId missing`);
  if (expectedIds?.userEntryId) {
    assert.equal(userId, expectedIds.userEntryId, `${label}: persisted user entryId must match terminal userEntryId`);
  }
  if (expectedIds?.finalLeafId) {
    assert.equal(assistantId, expectedIds.finalLeafId, `${label}: persisted assistant entryId must match terminal finalLeafId`);
  }
  if (context.context.leafId) {
    assert.equal(context.context.leafId, assistantId, `${label}: context.leafId must equal persisted assistant entryId`);
  }
  return { userId, assistantId };
}

function assertProviderContext(label, shape, history, record, prompt) {
  const expect = expectedActiveContext(shape, history);
  const report = JSON.stringify({
    messages: record.messageCount,
    userCount: record.userCount,
    assistantCount: record.assistantCount,
    toolCount: record.toolCount,
    systemCount: record.systemCount,
    bytes: record.requestBytes,
    hasCompactionSummary: record.hasCompactionSummary,
  });
  assert.ok(
    record.messageCount >= expect.minMessages && record.messageCount <= expect.maxMessages,
    `${label}: provider messageCount ${record.messageCount} outside [${expect.minMessages},${expect.maxMessages}]: ${report}`,
  );
  assert.equal(record.exactPrompt, true, `${label}: the exact supplied prompt must reach the provider`);
  assert.equal(record.promptHash, hashPrompt(prompt), `${label}: last user hash must be the exact prompt`);
  if (expect.requireOldest) {
    assert.equal(requestHasUserHash(record, history.firstUserText), true, `${label}: oldest user marker must reach the provider: ${report}`);
  } else {
    assert.equal(requestHasUserHash(record, history.firstUserText), false, `${label}: compacted context must omit the oldest user marker: ${report}`);
  }
  if (expect.requireKept) {
    assert.equal(requestHasUserHash(record, history.lastUserText), true, `${label}: retained tail user marker must reach the provider: ${report}`);
  }
  if (expect.requireCompaction) {
    assert.equal(record.hasCompactionSummary, true, `${label}: compacted context must include the SDK compaction summary: ${report}`);
    assert.ok(record.messageCount < history.messageCount, `${label}: compacted active context (${record.messageCount}) must be smaller than JSONL messages (${history.messageCount})`);
  } else {
    assert.equal(record.hasCompactionSummary, false, `${label}: non-compacted context must not carry a compaction summary: ${report}`);
  }
  if (expect.requireTools) {
    assert.ok(record.toolCount >= shape.turns, `${label}: tool-dense context must include tool results: ${report}`);
  }
}

async function probeProvider500Retry() {
  const provider = await startControlledProvider();
  let exitCode = 0;
  try {
    const prompt = "failure probe http-500 retry";
    const body = JSON.stringify({
      model: "stub-model",
      messages: [{ role: "user", content: prompt }],
    });
    provider.plan({
      httpError: { status: 500, body: JSON.stringify({ error: { message: "stub upstream exploded", type: "server_error" } }) },
    });
    const first = await fetch(`http://127.0.0.1:${provider.port}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body, signal: AbortSignal.timeout(5_000) });
    const second = await fetch(`http://127.0.0.1:${provider.port}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body, signal: AbortSignal.timeout(5_000) });
    assert.equal(first.status, 500, `first retry must stay HTTP 500, got ${first.status}`);
    assert.equal(second.status, 500, `second retry must stay HTTP 500, not success: ${second.status}`);
    assert.equal(provider.requests.length, 2, `two-request 500 probe must record 2 attempts: ${JSON.stringify(provider.report())}`);
    log("PASS provider 500 retry probe", JSON.stringify({ attempts: provider.requests.length, statuses: [first.status, second.status] }));
  } catch (error) {
    exitCode = 1;
    log("FAIL", error?.stack ?? error);
    log("provider-report", JSON.stringify(provider.report(), null, 2));
  } finally {
    const closed = await Promise.race([provider.close().then(() => true), delay(3_000).then(() => false)]).catch(() => false);
    if (!closed) {
      log("CLEANUP-FAIL", JSON.stringify(["provider.close timed out"]));
      exitCode = 1;
    }
  }
  return exitCode;
}

async function main() {
  if (process.argv.includes("--probe-provider-500")) return probeProvider500Retry();
  const suiteDeadline = Date.now() + SUITE_DEADLINE_MS;
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousFactory = process.env.PIX_AGENT_WORKER_FACTORY;
  delete process.env.PIX_AGENT_WORKER_FACTORY;
  const dirs = await makeIsolatedDirs("px-sdk");
  const provider = await startControlledProvider();
  const stub = await writeStubProviderConfig(dirs.agentDir, provider.port);
  process.env.PI_CODING_AGENT_DIR = dirs.agentDir;

  const clientDist = existsSync(CLIENT_DIST)
    ? CLIENT_DIST
    : await (async () => {
        // This node-level suite never loads the client; serve the same minimal
        // placeholder sessions-history uses so createNodeServer accepts boot.
        const dist = join(dirs.sessiondDir, "client-dist");
        mkdirSync(join(dist, "assets"), { recursive: true });
        await (await import("node:fs/promises")).writeFile(
          join(dist, "index.html"),
          '<!doctype html><html><body><div id="root"></div></body></html>',
        );
        return dist;
      })();

  let stack;
  const seeded = [];
  const results = [];
  let exitCode = 0;
  let cleanupFailures = [];
  try {
    assert.ok(Date.now() < suiteDeadline, "suite deadline exceeded before boot");
    // ---- Seed real JSONL (adapter testing export keeps the SDK import
    // confined to packages/pi-sdk-adapter). -------------------------------
    for (const shape of HISTORY_SHAPES) {
      const history = seedSessionHistoryForTests({
        cwd: dirs.projectCwd,
        turns: shape.turns,
        ...(shape.toolDense ? { toolDense: true } : {}),
        ...(shape.compact ? { compact: shape.compact } : {}),
        ...(shape.padBytes ? { padBytes: shape.padBytes } : {}),
        model: { provider: stub.providerId, modelId: stub.modelId },
        label: `lifecycle-${shape.label}`,
      });
      seeded.push({
        shape,
        history: {
          ...history,
          label: `lifecycle-${shape.label}`,
          compactKeptTurns: shape.compact?.keptTurns ?? 0,
        },
      });
      log(
        `seeded ${shape.label}: session=${history.sessionId.slice(0, 8)}… entries=${history.entryCount} messages=${history.messageCount} jsonlBytes=${history.jsonlBytes} continuation=${history.hasContinuation} compactKept=${shape.compact?.keptTurns ?? 0}`,
      );
    }
    const catalogIds = await listSeededSessionIdsForTests();
    for (const { history } of seeded) {
      assert.ok(catalogIds.includes(history.sessionId), `seeded session must be catalog-visible: ${history.sessionId}`);
    }

    stack = await bootLifecycleStack({ sessiondDir: dirs.sessiondDir, projectCwd: dirs.projectCwd, hostDir: dirs.hostDir, clientDist });

    // Zero workers before any send (read-only phase of this suite).
    const runningAtBoot = await stack.rpc.call("runtime.listRunning", {});
    assert.deepEqual(runningAtBoot.sessions, [], "no worker before cold submit");

    // ---- Happy path per history shape: COLD submit, then observe --------
    for (const { shape, history } of seeded) {
      const sessionId = history.sessionId;
      provider.reset();
      const client = new RuntimeWsClient(stack.wsUrl);
      await client.connect();
      await client.handshake(LIFECYCLE_FEATURES);
      client.requireAcceptedFeatures([RUNTIME_SUBMIT_TURN_FEATURE, RUNTIME_OBSERVE_EXISTING_FEATURE]);
      try {
        assert.equal(provider.requests.length, 0, `${shape.label}: no provider traffic before send`);
        const runningBefore = await stack.rpc.call("runtime.listRunning", {});
        assert.deepEqual(runningBefore.sessions, [], `${shape.label}: no workers before cold submit`);
        assert.ok(Date.now() < suiteDeadline, `${shape.label}: suite deadline exceeded before cold submit`);

        const prompt1 = `lifecycle-real-sdk ${shape.label} send-1 ${sessionId.slice(0, 8)} ${Date.now()}`;
        const operation1 = `op-${shape.label}-1`;
        provider.plan({ gateAfterChunks: 0 });
        const afterSubmit1 = client.messages.length;
        const tSubmit = Date.now();
        const submit1 = await submitUnfenced(client, sessionId, {
          prompt: prompt1,
          operationId: operation1,
          activationOverrides: { model: { provider: stub.providerId, modelId: stub.modelId }, thinkingLevel: "off" },
        });
        const admitMs = Date.now() - tSubmit;
        log(`${shape.label}: cold-submit admission ${submit1.payload.status} in ${admitMs}ms`);
        assert.equal(submit1.payload.status, "accepted", `${shape.label}: cold submit must be accepted: ${JSON.stringify(submit1.payload)}`);
        assert.ok(submit1.payload.turnId, `${shape.label}: admission must carry a turnId`);
        const workerUp = await stack.rpc.call("runtime.listRunning", {});
        assert.equal(workerUp.sessions.length, 1, `${shape.label}: accepted cold submit must activate exactly one worker: ${JSON.stringify(workerUp.sessions.map((s) => s.sessionId?.slice?.(0, 8)))}`);
        assert.equal(workerUp.sessions[0]?.sessionId, sessionId, `${shape.label}: the single running worker must be the submitted session`);
        const observeDeadline = Date.now() + COMMAND_TIMEOUT_MS;
        while (provider.requests.length === 0 && Date.now() < observeDeadline) await delay(50);
        const providerMs = provider.requests[0] ? provider.requests[0].receivedAt - tSubmit : null;
        log(`${shape.label}: first provider request at +${providerMs}ms messages=${provider.requests[0]?.messageCount} bytes=${provider.requests[0]?.requestBytes}`);
        assert.equal(provider.requests.length, 1, `${shape.label}: cold submit must hit the provider once before observe: ${JSON.stringify(provider.report())}`);
        while (!provider.gated && Date.now() < observeDeadline) await delay(50);
        assert.equal(provider.gated, true, `${shape.label}: provider must hold the stream until observe attaches`);

        // Subscribe AFTER admission so observation is not an implicit attach/activate.
        const attached = await client.attach(sessionId, undefined, { existingOnly: true });
        assert.equal(attached.type, "snapshot", `${shape.label}: post-admission attach must deliver a snapshot`);
        assert.equal(attached.payload.sessionId, sessionId);
        provider.release();

        const terminal1 = await client.waitForTurnTerminal(sessionId, operation1, { afterIndex: afterSubmit1 });
        assert.equal(terminal1.payload.state, "completed", `${shape.label}: turn must complete: ${JSON.stringify(terminal1.payload)}`);
        assert.equal(terminal1.payload.turnId, submit1.payload.turnId, `${shape.label}: terminal turnId must match admission turnId`);
        assert.ok(typeof terminal1.payload.userEntryId === "string" && terminal1.payload.userEntryId.length > 0, `${shape.label}: terminal must carry userEntryId: ${JSON.stringify(terminal1.payload)}`);
        assert.ok(typeof terminal1.payload.finalLeafId === "string" && terminal1.payload.finalLeafId.length > 0, `${shape.label}: terminal must carry finalLeafId: ${JSON.stringify(terminal1.payload)}`);

        markExactPrompt(provider, prompt1);
        assert.equal(provider.requests.length, 1, `${shape.label}: exactly one provider request per turn: ${JSON.stringify(provider.report())}`);
        assert.equal(provider.requests[0].model, stub.modelId, `${shape.label}: provider request must use the stub model`);
        assertProviderContext(shape.label, shape, history, provider.requests[0], prompt1);

        const allTypes = client.eventTypes(sessionId);
        const attachSnapshot = attached.payload?.snapshot ?? attached.payload;
        const liveAtAttach = attachSnapshot?.state?.isPromptRunning === true || attachSnapshot?.streaming?.active === true;
        assert.ok(
          allTypes.includes("agent_start") || liveAtAttach,
          `${shape.label}: observe must see agent_start or an already-running snapshot: types=${allTypes.join(",")} liveAtAttach=${liveAtAttach}`,
        );
        assert.ok(textDeltaCount(client, sessionId) >= 1, `${shape.label}: at least one text-delta message_update required: ${allTypes.join(",")}`);
        assert.ok(allTypes.includes("prompt_done"), `${shape.label}: prompt_done missing: ${allTypes.join(",")}`);

        const snap1 = await client.getSnapshot(sessionId);
        assert.ok(snap1?.state, `${shape.label}: getSnapshot must return a snapshot`);
        assert.equal(snap1.streaming?.active ?? false, false, `${shape.label}: post-terminal streaming must be idle: ${terminalSnapshotDiag(shape.label, snap1)}`);
        assert.equal(snap1.state?.isPromptRunning ?? false, false, `${shape.label}: post-terminal isPromptRunning must be false: ${terminalSnapshotDiag(shape.label, snap1)}`);
        assert.equal(snap1.state?.isStreaming ?? false, false, `${shape.label}: post-terminal isStreaming must be false`);
        assert.equal(snap1.state?.leafId, terminal1.payload.finalLeafId, `${shape.label}: snapshot leafId must equal terminal finalLeafId`);

        const context1 = await readContext(stack.origin, sessionId);
        assert.equal(context1.context.sessionId, sessionId);
        const persisted1 = assertPersistedTurn(shape.label, context1, prompt1, STUB_REPLY, {
          userEntryId: terminal1.payload.userEntryId,
          finalLeafId: terminal1.payload.finalLeafId,
        });
        assert.equal(context1.context.leafId, snap1.state.leafId, `${shape.label}: context.leafId must equal post-terminal snapshot.state.leafId`);

        const prompt2 = `lifecycle-real-sdk ${shape.label} send-2 ${sessionId.slice(0, 8)} ${Date.now()}`;
        provider.plan({});
        const afterSubmit2 = client.messages.length;
        const submit2 = await submitFenced(client, sessionId, {
          prompt: prompt2,
          operationId: `op-${shape.label}-2`,
        });
        assert.equal(submit2.payload.status, "accepted");
        const terminal2 = await client.waitForTurnTerminal(sessionId, `op-${shape.label}-2`, { afterIndex: afterSubmit2 });
        assert.equal(terminal2.payload.state, "completed", `${shape.label}: second turn must complete: ${JSON.stringify(terminal2.payload)}`);
        assert.equal(terminal2.payload.turnId, submit2.payload.turnId, `${shape.label}: second terminal turnId must match admission`);
        assert.ok(typeof terminal2.payload.userEntryId === "string" && terminal2.payload.userEntryId.length > 0, `${shape.label}: second terminal must carry userEntryId: ${JSON.stringify(terminal2.payload)}`);
        assert.ok(typeof terminal2.payload.finalLeafId === "string" && terminal2.payload.finalLeafId.length > 0, `${shape.label}: second terminal must carry finalLeafId: ${JSON.stringify(terminal2.payload)}`);
        markExactPrompt(provider, prompt2);
        assert.equal(provider.requests.length, 2, `${shape.label}: second turn adds exactly one request: ${JSON.stringify(provider.report())}`);
        assert.equal(provider.requests[1].exactPrompt, true, `${shape.label}: second exact prompt must reach the provider`);
        const snap2 = await client.getSnapshot(sessionId);
        assert.equal(snap2.streaming?.active ?? false, false, `${shape.label}: post-second-terminal streaming must be idle: ${terminalSnapshotDiag(shape.label, snap2)}`);
        assert.equal(snap2.state?.isPromptRunning ?? false, false, `${shape.label}: post-second-terminal isPromptRunning must be false: ${terminalSnapshotDiag(shape.label, snap2)}`);
        assert.equal(snap2.state?.isStreaming ?? false, false, `${shape.label}: post-second-terminal isStreaming must be false`);
        assert.equal(snap2.state?.leafId, terminal2.payload.finalLeafId, `${shape.label}: second snapshot leafId must equal terminal finalLeafId`);
        const context2 = await readContext(stack.origin, sessionId);
        assert.equal(context2.context.sessionId, sessionId);
        assertPersistedTurn(`${shape.label}-send-2`, context2, prompt2, STUB_REPLY, {
          userEntryId: terminal2.payload.userEntryId,
          finalLeafId: terminal2.payload.finalLeafId,
        });
        assert.equal(context2.context.leafId, snap2.state.leafId, `${shape.label}: second context.leafId must equal post-terminal snapshot.state.leafId`);

        results.push({
          shape: shape.label,
          turnIds: [submit1.payload.turnId, submit2.payload.turnId],
          providerRequests: 2,
          jsonlBytes: history.jsonlBytes,
          providerBytes: provider.requests.map((r) => r.requestBytes),
          providerMessages: provider.requests.map((r) => r.messageCount),
          persisted: persisted1,
          ok: true,
        });
        log(`PASS ${shape.label} (entries=${history.entryCount}, messages=${history.messageCount}, jsonl=${history.jsonlBytes}B, provider0=${provider.requests[0].messageCount}msg/${provider.requests[0].requestBytes}B)`);
      } finally {
        client.close();
        await stack.rpc.call("runtime.stop", { sessionId, reason: "user" }).catch(() => {});
        for (let i = 0; i < 100; i++) {
          const running = await stack.rpc.call("runtime.listRunning", {});
          if (!running.sessions.some((s) => s.sessionId === sessionId)) break;
          await delay(50);
        }
      }
    }

    // ---- Failure scenarios (bounded, structured; fresh short session) ---
    {
      const failHistory = seedSessionHistoryForTests({
        cwd: dirs.projectCwd,
        turns: 2,
        model: { provider: stub.providerId, modelId: stub.modelId },
        label: "lifecycle-failure",
      });
      const sessionId = failHistory.sessionId;
      const scenarios = [
        {
          name: "http-500",
          script: { httpError: { status: 500, body: JSON.stringify({ error: { message: "stub upstream exploded", type: "server_error" } }) } },
        },
        {
          name: "context-length",
          script: { contextError: { message: "This model supports at most 1 tokens, however you sent 42", code: "context_length_exceeded" } },
        },
        { name: "broken-stream", script: { breakAfterChunks: 2 } },
      ];
      // Observed SDK behavior: 5xx / broken-stream are retried by the agent
      // core (bounded backoff) before the turn fails; context-length is fatal
      // immediately. Bounds are recorded, not assumed tighter than reality.
      const expectedAttempts = { "http-500": [1, 4], "context-length": [1, 1], "broken-stream": [1, 4] };
      const client = new RuntimeWsClient(stack.wsUrl);
      await client.connect();
      await client.handshake(LIFECYCLE_FEATURES);
      client.requireAcceptedFeatures([RUNTIME_SUBMIT_TURN_FEATURE, RUNTIME_OBSERVE_EXISTING_FEATURE]);
      try {
        await client.attach(sessionId);
        for (const scenario of scenarios) {
          provider.reset();
          provider.plan(scenario.script);
          const operationId = `op-fail-${scenario.name}`;
          const prompt = `failure probe ${scenario.name} ${Date.now()}`;
          const afterSubmit = client.messages.length;
          const submit = await submitFenced(client, sessionId, { prompt, operationId });
          assert.equal(submit.payload.status, "accepted", `${scenario.name}: failure probes must still be admitted`);
          const terminal = await client.waitForTurnTerminal(sessionId, operationId, { afterIndex: afterSubmit });
          assert.equal(terminal.payload.state, "failed", `${scenario.name}: provider failure must surface as a failed turn: ${JSON.stringify(terminal.payload)}`);
          assert.ok(terminal.payload.error?.code, `${scenario.name}: failed terminal must carry a structured error code`);
          const [minAttempts, maxAttempts] = expectedAttempts[scenario.name];
          assert.ok(
            provider.requests.length >= minAttempts && provider.requests.length <= maxAttempts,
            `${scenario.name}: provider attempts ${provider.requests.length} outside bounded [${minAttempts},${maxAttempts}]: ${JSON.stringify(provider.report())}`,
          );
          const snap = await client.getSnapshot(sessionId);
          log(
            `scenario ${scenario.name}: settled state=${terminal.payload.state} code=${terminal.payload.error?.code} retryable=${terminal.payload.error?.retryable} providerAttempts=${provider.requests.length} streamingActive=${snap.streaming?.active} isPromptRunning=${snap.state?.isPromptRunning}`,
          );
          results.push({ scenario: scenario.name, code: terminal.payload.error?.code, retryable: terminal.payload.error?.retryable, providerAttempts: provider.requests.length, ok: true });

          if (scenario.name === "http-500") {
            const requestsBeforeDedupe = provider.requests.length;
            const duplicate = await submitFenced(client, sessionId, { prompt, operationId });
            assert.equal(duplicate.payload.status, "duplicate", `http-500 same operationId must be duplicate admission: ${JSON.stringify(duplicate.payload)}`);
            assert.equal(provider.requests.length, requestsBeforeDedupe, `http-500 duplicate must not add provider requests: ${JSON.stringify(provider.report())}`);
            results.push({ scenario: "http-500-dedupe", status: duplicate.payload.status, providerAttempts: provider.requests.length, ok: true });
          }
        }
        provider.reset();
        const operationId = `op-fail-recover`;
        const afterRecover = client.messages.length;
        await submitFenced(client, sessionId, { prompt: `failure recovery probe ${Date.now()}`, operationId });
        const terminal = await client.waitForTurnTerminal(sessionId, operationId, { afterIndex: afterRecover });
        assert.equal(terminal.payload.state, "completed", "session must remain usable after provider failures");
        assert.equal(provider.requests.length, 1, `recovery turn must be a single clean request: ${JSON.stringify(provider.report())}`);
      } finally {
        client.close();
        await stack.rpc.call("runtime.stop", { sessionId, reason: "user" }).catch(() => {});
      }
    }

    log(`PASS — ${seeded.length} history shapes × 2 cold/hot sends + 3 bounded failure scenarios + same-operationId dedupe against the real SDK worker`);
    log("summary", JSON.stringify(results));
  } catch (error) {
    exitCode = 1;
    log("FAIL", error?.stack ?? error);
    log("provider-report", JSON.stringify(provider.report(), null, 2));
  } finally {
    process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    if (previousFactory === undefined) delete process.env.PIX_AGENT_WORKER_FACTORY;
    else process.env.PIX_AGENT_WORKER_FACTORY = previousFactory;
    provider.release();
    const torn = await teardownLifecycleStack(stack, dirs);
    cleanupFailures = torn.failures;
    const providerClosed = await Promise.race([
      provider.close().then(() => true),
      delay(3_000).then(() => false),
    ]);
    if (!providerClosed) cleanupFailures.push("provider.close timed out");
    if (cleanupFailures.length > 0) {
      log("CLEANUP-FAIL", JSON.stringify(cleanupFailures));
      exitCode = 1;
    }
  }
  return exitCode;
}

main().then((code) => {
  process.exit(code);
});
