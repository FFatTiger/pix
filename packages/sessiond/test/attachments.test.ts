/**
 * Inline-image persistence: sessiond writes content-addressed files into the
 * shared attachments store and appends protocol marker lines before dispatch.
 * Deterministic — no timers, no wall-clock waits.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  appendAttachedMarkerLines,
  formatAttachedImageMarkerLine,
  type ImageAttachment,
  type RuntimeSnapshot,
  type SessiondToWorkerMessage,
} from "@fffattiger/pix-protocol";
import type { SessionCatalogPort, SessionLocatorPort } from "@fffattiger/pix-runtime-core";
import {
  UNFILED_ATTACHMENTS_SCOPE,
  attachmentScopeExists,
  writeAttachmentFile,
} from "@fffattiger/pix-local-authority/state";
import { startDaemon } from "../src/composition/index.js";
import { SessiondService } from "../src/service.js";
import { FakeWorkerFactory } from "../src/testing/fake-worker.js";
import { attachmentImageFileName, createSessiondAttachmentStore, type InlineImageInput } from "../src/attachments.js";

const PNG = Buffer.from("png-bytes").toString("base64");
const JPEG = Buffer.from("jpeg-bytes").toString("base64");

const image = (data: string, mimeType: ImageAttachment["mimeType"]): ImageAttachment => ({
  type: "image",
  data,
  mimeType,
});

const sha16 = (data: string): string => createHash("sha256").update(Buffer.from(data, "base64")).digest("hex").slice(0, 16);

function promptSnapshot(sessionId: string): RuntimeSnapshot {
  return {
    sessionId,
    cwd: "/workspace",
    projectRoot: "/workspace",
    state: {
      sessionId,
      isStreaming: false,
      isPromptRunning: false,
      isBashRunning: false,
      isCompacting: false,
      model: null,
      messageCount: 0,
      queuedMessages: { steering: [], followUp: [] },
      pendingMessageCount: 0,
      writtenFiles: [],
    },
    capabilities: { capabilities: ["runtime.prompt", "runtime.steer", "runtime.follow_up"], version: 1 },
    streaming: { active: false, phase: "idle" },
  };
}

async function harness(root: string) {
  const locator: SessionLocatorPort = {
    async locate(sessionId) { return { sessionId, sessionFile: `/sessions/${sessionId}.jsonl`, exists: true }; },
    async resolveLeafId() { return "leaf"; },
  };
  const catalog: SessionCatalogPort = {
    async listSessions() { return []; },
    async readSession(sessionId) { return { sessionId, cwd: "/workspace", projectRoot: "/workspace", entries: [] }; },
    async readSessionContext(sessionId) { return { sessionId, entries: [], pageInfo: { hasMore: false } }; },
    async readSessionThinking() { throw new Error("not used"); },
    async readSessionTree(sessionId) { return { sessionId, roots: [], entryCount: 0 }; },
    async deleteSession() {},
  };
  const workers = new FakeWorkerFactory({ readyDelayMs: 0, snapshot: promptSnapshot("s"), turnCompletion: "handled" });
  const attachments = createSessiondAttachmentStore({ root, now: () => 0 });
  const service = new SessiondService({
    sessionLocator: locator,
    activationContext: { async resolve(_sessionId, _location, requestedCwd) { return { cwd: requestedCwd ?? "/workspace", projectRoot: requestedCwd ?? "/workspace" }; } },
    workerFactory: workers,
    sessionCatalog: catalog,
    attachments,
  }, { workerStartTimeoutMs: 500, commandTimeoutMs: 500, idleTimeoutMs: 0 });
  return { service, workers, attachments };
}

function liveRevision(service: SessiondService, sessionId: string, epoch: string): number {
  const prepared = service.prepareAttach({ sessionId, epoch });
  const revision = prepared.result.lastEventId;
  prepared.close();
  return revision;
}

function submitRequests(messages: readonly SessiondToWorkerMessage[]) {
  return messages.filter((message) => message.type === "worker.submitTurn");
}

function commandMessages(messages: readonly SessiondToWorkerMessage[]) {
  return messages.filter((message) => message.type === "worker.command");
}

test("attachment store names files by sha16 and mime type, and appends protocol marker lines", async () => {
  const root = await mkdtemp(join(tmpdir(), "pix-attach-store-"));
  try {
    const store = createSessiondAttachmentStore({ root });
    const cases: ReadonlyArray<readonly [ImageAttachment["mimeType"] | "image/bmp", string]> = [
      ["image/png", "png"],
      ["image/jpeg", "jpg"],
      ["image/gif", "gif"],
      ["image/webp", "webp"],
      ["image/bmp", "bin"],
    ];
    const images = cases.map(([mimeType], index) => ({ data: Buffer.from(`bytes-${index}`).toString("base64"), mimeType }));
    const annotated = await store.annotateMessageWithImages("session-1", "look", images);
    const lines = cases.map(([mimeType], index) => formatAttachedImageMarkerLine(join(root, "session-1", attachmentImageFileName(images[index]!.data, mimeType))));
    assert.equal(annotated, appendAttachedMarkerLines("look", lines));
    assert.equal(await store.annotateMessageWithImages("session-1", "", images.slice(0, 1)), lines[0]);
    for (const [index, [, ext]] of cases.entries()) {
      const name = attachmentImageFileName(images[index]!.data, images[index]!.mimeType);
      assert.equal(name, `${sha16(images[index]!.data)}.${ext}`);
      const info = await stat(join(root, "session-1", name));
      assert.equal(info.isFile(), true);
      if (process.platform !== "win32") {
        assert.equal(info.mode & 0o777, 0o600);
        assert.equal((await stat(join(root, "session-1"))).mode & 0o777, 0o700);
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("unfiled sweep removes only old regular files, and removeSessionScope tolerates ENOENT", async () => {
  const root = await mkdtemp(join(tmpdir(), "pix-attach-sweep-"));
  try {
    const now = 1_700_000_000_000;
    const store = createSessiondAttachmentStore({ root, now: () => now, maxUnfiledAgeMs: 1_000 });
    const dir = join(root, UNFILED_ATTACHMENTS_SCOPE);
    await mkdir(dir, { recursive: true });
    const oldFile = join(dir, "old.bin");
    const freshFile = join(dir, "fresh.bin");
    await writeFile(oldFile, "old");
    await writeFile(freshFile, "fresh");
    const oldTime = new Date(now - 5_000);
    const freshTime = new Date(now);
    await utimes(oldFile, oldTime, oldTime);
    await utimes(freshFile, freshTime, freshTime);
    await mkdir(join(dir, "kept-dir"));
    await store.sweepStaleUnfiled();
    const left = await readdir(dir);
    assert.deepEqual(left.filter((entry) => entry !== "kept-dir").sort(), ["fresh.bin"]);
    assert.equal(left.includes("kept-dir"), true);
    await store.removeSessionScope("never-created");
    assert.equal(await attachmentScopeExists(root, "never-created"), false);
    await writeAttachmentFile({ root, scope: "gone", name: "a.bin", data: Buffer.from("a") });
    await store.removeSessionScope("gone");
    assert.equal(await attachmentScopeExists(root, "gone"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("submitTurn persists two images, annotates the dispatched prompt, and keeps the inline images", async () => {
  const root = await mkdtemp(join(tmpdir(), "pix-attach-submit-"));
  const { service, workers } = await harness(root);
  try {
    const activated = await service.activate("s");
    const images = [image(PNG, "image/png"), image(JPEG, "image/jpeg")];
    const admission = await service.submitTurn({
      sessionId: "s",
      operationId: "op-1",
      prompt: "describe",
      images,
      expectedEpoch: activated.epoch,
      expectedRevision: liveRevision(service, "s", activated.epoch),
    });
    assert.notEqual(admission.status, "rejected");
    const sent = submitRequests(workers.workers[0]!.sent);
    assert.equal(sent.length, 1);
    const first = sent[0];
    assert.ok(first && first.type === "worker.submitTurn");
    const request = first.type === "worker.submitTurn" ? first.payload.request : undefined;
    assert.ok(request);
    const expected = appendAttachedMarkerLines("describe", [
      formatAttachedImageMarkerLine(join(root, activated.sessionId, `${sha16(PNG)}.png`)),
      formatAttachedImageMarkerLine(join(root, activated.sessionId, `${sha16(JPEG)}.jpg`)),
    ]);
    assert.equal(request.prompt, expected);
    assert.deepEqual(request.images, images);
    for (const file of [`${sha16(PNG)}.png`, `${sha16(JPEG)}.jpg`]) {
      const info = await stat(join(root, activated.sessionId, file));
      assert.equal(info.isFile(), true);
      if (process.platform !== "win32") {
        assert.equal(info.mode & 0o777, 0o600);
        assert.equal((await lstat(join(root, activated.sessionId))).mode & 0o777, 0o700);
      }
    }
  } finally {
    await service.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

test("resending the same images reuses the content-addressed file", async () => {
  const root = await mkdtemp(join(tmpdir(), "pix-attach-reuse-"));
  const { service, workers } = await harness(root);
  try {
    const activated = await service.activate("s");
    const images = [image(PNG, "image/png")];
    const base = { sessionId: "s", prompt: "again", images, expectedEpoch: activated.epoch, expectedRevision: liveRevision(service, "s", activated.epoch) };
    const first = await service.submitTurn({ ...base, operationId: "op-a" });
    assert.notEqual(first.status, "rejected");
    // Admission publishes a running-state event, so the second send must carry
    // the cursor an attached client would hold after the first one.
    const second = await service.submitTurn({ ...base, operationId: "op-b", expectedRevision: liveRevision(service, "s", activated.epoch) });
    assert.notEqual(second.status, "rejected");
    if (second.status === "rejected") assert.fail(second.error.message);
    const names = await readdir(join(root, activated.sessionId));
    assert.deepEqual(names.filter((name) => !name.startsWith(".")), [`${sha16(PNG)}.png`]);
    assert.equal(submitRequests(workers.workers[0]!.sent).length, 2);
  } finally {
    await service.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

test("steer and follow_up commands annotate the dispatched message", async () => {
  const root = await mkdtemp(join(tmpdir(), "pix-attach-command-"));
  const { service, workers } = await harness(root);
  try {
    const activated = await service.activate("s");
    const images = [image(PNG, "image/gif")];
    const steer = await service.command("s", { type: "steer", commandId: "steer-1", message: "nudge", images }, activated.epoch);
    assert.equal(steer.result.ok, true);
    const follow = await service.command("s", { type: "follow_up", commandId: "follow-1", message: "later", images }, activated.epoch);
    assert.equal(follow.result.ok, true);
    const dispatched = commandMessages(workers.workers[0]!.sent);
    const expected = formatAttachedImageMarkerLine(join(root, activated.sessionId, `${sha16(PNG)}.gif`));
    assert.equal(dispatched.length, 2);
    for (const [index, text] of ["nudge", "later"].entries()) {
      const message = dispatched[index];
      assert.ok(message && message.type === "worker.command");
      const command = message.type === "worker.command" ? message.payload.command : undefined;
      assert.ok(command && (command.type === "steer" || command.type === "follow_up"));
      if (command.type === "steer" || command.type === "follow_up") {
        assert.equal(command.message, appendAttachedMarkerLines(text, [expected]));
        assert.deepEqual(command.images, images);
      }
    }
    const names = await readdir(join(root, activated.sessionId));
    assert.deepEqual(names.filter((name) => !name.startsWith(".")), [`${sha16(PNG)}.gif`]);
  } finally {
    await service.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

test("an unwritable attachment root rejects submitTurn and steer before any worker dispatch", async () => {
  const root = await mkdtemp(join(tmpdir(), "pix-attach-fail-"));
  const blocker = join(root, "not-a-directory");
  await writeFile(blocker, "file");
  const { service, workers } = await harness(blocker);
  try {
    const activated = await service.activate("s");
    const images = [image(PNG, "image/png")];
    const before = workers.workers[0]!.sent.length;
    const admission = await service.submitTurn({
      sessionId: "s",
      operationId: "op-fail",
      prompt: "nope",
      images,
      expectedEpoch: activated.epoch,
      expectedRevision: liveRevision(service, "s", activated.epoch),
    });
    assert.equal(admission.status, "rejected");
    if (admission.status === "rejected") {
      assert.equal(admission.error.code, "unavailable");
      assert.equal(admission.delivery, "not_delivered");
    }
    const steer = await service.command("s", { type: "steer", commandId: "steer-fail", message: "nope", images }, activated.epoch);
    assert.equal(steer.result.ok, false);
    if (!steer.result.ok) assert.equal(steer.result.error.code, "unavailable");
    const added = workers.workers[0]!.sent.slice(before);
    assert.equal(added.some((message) => message.type === "worker.submitTurn" || message.type === "worker.command"), false);
  } finally {
    await service.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

test("deleteSession removes the attachment scope and still succeeds when none exists", async () => {
  const root = await mkdtemp(join(tmpdir(), "pix-attach-delete-"));
  const { service } = await harness(root);
  try {
    await writeAttachmentFile({ root, scope: "s", name: "a.bin", data: Buffer.from("a") });
    assert.equal(await attachmentScopeExists(root, "s"), true);
    await service.deleteSession("s");
    assert.equal(await attachmentScopeExists(root, "s"), false);
    await service.deleteSession("s");
  } finally {
    await service.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

test("production daemon composition wires a non-null attachments store", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pix-attach-daemon-"));
  const handle = await startDaemon({
    directory: dir,
    workerFactory: new FakeWorkerFactory({ readyDelayMs: 0 }),
    sessionCatalog: null,
    projectCatalog: null,
    sessionMutation: null,
    serviceOptions: { idleTimeoutMs: 0 },
  });
  try {
    assert.ok(handle.attachments);
    assert.equal(typeof handle.attachments.root, "string");
    assert.ok(handle.attachments.root.length > 0);
  } finally {
    await handle.shutdown();
    await rm(dir, { recursive: true, force: true });
  }
});
