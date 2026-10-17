// Keyword session search (`sessions.list` `query`) — sessiond layer.
//
// Covers the port plumbing (query normalization at the application boundary,
// archived organization state forwarded as catalog exclusions) and the legacy
// catalog path's matching semantics through the shared runtime-core matcher:
// three match sources, tier ordering, case-insensitivity, archived exclusion
// and blank/over-long query handling.
import assert from "node:assert/strict";
import test from "node:test";
import { SessionsListParamsSchema } from "@fffattiger/pix-protocol";
import type { SessionCatalogPort, SessionHeader, SessionPageRequest } from "@fffattiger/pix-runtime-core";
import { makeRuntimeError } from "@fffattiger/pix-runtime-core";
import { SessiondApplication } from "../src/application.js";
import { SessiondError } from "../src/errors.js";
import { SessiondService } from "../src/service.js";
import { InMemoryWorkspaceStateStore } from "../src/workspace-state.js";
import { FakeWorkerFactory } from "../src/testing/fake-worker.js";

function header(input: Partial<SessionHeader> & Pick<SessionHeader, "sessionId" | "cwd" | "projectRoot">): SessionHeader {
  return input;
}

const CORPUS: SessionHeader[] = [
  { sessionId: "s-title", cwd: "/repos/alpha", projectRoot: "/repos/alpha", title: "侧栏改版方案", firstMessage: "把搜索改成居中面板", updatedAt: 5000 },
  { sessionId: "s-message", cwd: "/repos/beta", projectRoot: "/repos/beta", title: "周报整理", firstMessage: "把搜索改成居中面板", updatedAt: 4000 },
  { sessionId: "s-project", cwd: "/repos/gamma", projectRoot: "/repos/gamma", title: "因子清洗", firstMessage: "成交量处理", updatedAt: 9000 },
  { sessionId: "s-none", cwd: "/repos/alpha", projectRoot: "/repos/alpha", title: "别的", firstMessage: "无关内容", updatedAt: 8000 },
  { sessionId: "s-case", cwd: "/repos/zeta", projectRoot: "/repos/zeta", title: "Release Notes", firstMessage: "changelog", updatedAt: 3000 },
  { sessionId: "s-untitled", cwd: "/repos/eta", projectRoot: "/repos/eta", firstMessage: "独有锚点词", updatedAt: 2000 },
];

/** Catalog WITHOUT listSessionPage → exercises sessiond's legacy path. */
function legacyCatalog(sessions: readonly SessionHeader[]): SessionCatalogPort {
  return {
    async listSessions() { return [...sessions]; },
    async readSession(sessionId) { return { sessionId, cwd: "/w", projectRoot: "/w", entries: [] }; },
    async readSessionContext(sessionId) { return { sessionId, entries: [], pageInfo: { hasMore: false } }; },
    async readSessionThinking(sessionId, entryId) { throw makeRuntimeError("not_found", `session not found: ${sessionId}/${entryId}`); },
    async readSessionTree(sessionId) { return { sessionId, roots: [], entryCount: 0 }; },
    async deleteSession() {},
  };
}

interface Harness {
  service: SessiondService;
  listCalls: SessionPageRequest[];
}

function searchHarness(options: { catalog: SessionCatalogPort; workspaceState?: InMemoryWorkspaceStateStore | null }): Harness {
  const listCalls: SessionPageRequest[] = [];
  const catalog: SessionCatalogPort = options.catalog.listSessionPage === undefined
    ? options.catalog
    : {
        ...options.catalog,
        async listSessionPage(request) {
          listCalls.push(request);
          return { sessions: [], page: request.page, pageSize: request.pageSize, total: 0, totalPages: 0, catalogRevision: 1 };
        },
      };
  const service = new SessiondService({
    sessionLocator: { async locate(sessionId) { return { sessionId, sessionFile: `/s/${sessionId}.jsonl`, exists: true }; }, async resolveLeafId() { return "leaf"; } },
    activationContext: { async resolve(_id, _loc, cwd) { return { cwd: cwd ?? "/w", projectRoot: cwd ?? "/w" }; } },
    workerFactory: new FakeWorkerFactory(),
    sessionCatalog: catalog,
    ...(options.workspaceState === undefined ? {} : { workspaceState: options.workspaceState }),
  }, { workerStartTimeoutMs: 500, commandTimeoutMs: 500, idleTimeoutMs: 0 });
  return { service, listCalls };
}

test("legacy keyword pages match title/project/message with tier ordering, case-insensitively", async () => {
  const { service } = searchHarness({ catalog: legacyCatalog(CORPUS) });
  try {
    // Message hits on titled sessions rank as `message`; latest activity
    // breaks ties within the tier.
    const titleAndMessage = await service.listSessionPage({ page: 1, pageSize: 50, query: "搜索" });
    assert.deepEqual(titleAndMessage.sessions.map((s) => [s.sessionId, s.matchSource]), [
      ["s-title", "message"],
      ["s-message", "message"],
    ]);
    assert.equal(titleAndMessage.total, 2);

    // A user-title hit ranks as `title`.
    const byTitle = await service.listSessionPage({ page: 1, pageSize: 50, query: "周报" });
    assert.deepEqual(byTitle.sessions.map((s) => [s.sessionId, s.matchSource]), [["s-message", "title"]]);

    // Project-name hit: basename of projectRoot.
    const project = await service.listSessionPage({ page: 1, pageSize: 50, query: "gamma" });
    assert.deepEqual(project.sessions.map((s) => [s.sessionId, s.matchSource]), [["s-project", "project"]]);

    // Case-insensitive both directions.
    const cased = await service.listSessionPage({ page: 1, pageSize: 50, query: "RELEASE" });
    assert.deepEqual(cased.sessions.map((s) => s.sessionId), ["s-case"]);
    const casedLower = await service.listSessionPage({ page: 1, pageSize: 50, query: "notes" });
    assert.deepEqual(casedLower.sessions.map((s) => s.sessionId), ["s-case"]);

    // A title hit outranks a project hit regardless of activity recency.
    const ranked = await service.listSessionPage({ page: 1, pageSize: 50, query: "a" });
    const kinds = ranked.sessions.map((s) => s.matchSource);
    assert.ok(kinds.indexOf("title") < kinds.indexOf("project"), JSON.stringify(kinds));

    // Untitled sessions rank their first message as the title (the display
    // name a row renders) — never as a message hit.
    const display = await service.listSessionPage({ page: 1, pageSize: 50, query: "锚点" });
    assert.deepEqual(display.sessions.map((s) => [s.sessionId, s.matchSource]), [["s-untitled", "title"]]);
  } finally {
    await service.shutdown();
  }
});

test("legacy keyword pages exclude archived sessions and archived projects before totals", async () => {
  const store = new InMemoryWorkspaceStateStore();
  await store.setSessionFlags("s-title", { archived: true });
  await store.setProjectFlags("/repos/gamma", { archived: true });
  const { service } = searchHarness({ catalog: legacyCatalog(CORPUS), workspaceState: store });
  try {
    const page = await service.listSessionPage({ page: 1, pageSize: 50, query: "o" });
    const ids = page.sessions.map((s) => s.sessionId);
    assert.ok(!ids.includes("s-title"), "archived session must not surface");
    assert.ok(!ids.includes("s-project"), "session of archived project must not surface");
    assert.equal(page.total, page.sessions.length);

    // Plain pages keep the flag-merge contract (no exclusions applied).
    const plain = await service.listSessionPage({ page: 1, pageSize: 50 });
    assert.ok(plain.sessions.some((s) => s.sessionId === "s-title"));
    assert.equal(plain.sessions.find((s) => s.sessionId === "s-title")?.archived, true);
  } finally {
    await service.shutdown();
  }
});

test("sessions.list forwards the archived organization state as catalog exclusions on keyword pages only", async () => {
  const store = new InMemoryWorkspaceStateStore();
  await store.setSessionFlags("gone", { archived: true });
  await store.setProjectFlags("/repos/gone-project", { archived: true });
  const { service, listCalls } = searchHarness({
    catalog: {
      async listSessionPage(request) {
        return { sessions: [], page: request.page, pageSize: request.pageSize, total: 0, totalPages: 0, catalogRevision: 1 };
      },
      async listSessions() { return []; },
      async readSession(sessionId) { return { sessionId, cwd: "/w", projectRoot: "/w", entries: [] }; },
      async readSessionContext(sessionId) { return { sessionId, entries: [], pageInfo: { hasMore: false } }; },
      async readSessionThinking(sessionId, entryId) { throw makeRuntimeError("not_found", `session not found: ${sessionId}/${entryId}`); },
      async readSessionTree(sessionId) { return { sessionId, roots: [], entryCount: 0 }; },
      async deleteSession() {},
    },
    workspaceState: store,
  });
  const app = new SessiondApplication(service);
  try {
    await app.handle("sessions.list", { page: 1, pageSize: 20, query: "pix" });
    await app.handle("sessions.list", { page: 1, pageSize: 20 });
    assert.deepEqual(listCalls.map((request) => ({
      query: request.query,
      excludeSessionIds: request.excludeSessionIds,
      excludeProjectRoots: request.excludeProjectRoots,
    })), [
      { query: "pix", excludeSessionIds: ["gone"], excludeProjectRoots: ["/repos/gone-project"] },
      { query: undefined, excludeSessionIds: undefined, excludeProjectRoots: undefined },
    ]);
  } finally {
    await service.shutdown();
  }
});

test("sessions.list normalizes a blank query to absent and trims surrounding whitespace", async () => {
  const { service, listCalls } = searchHarness({
    catalog: {
      async listSessionPage(request) {
        return { sessions: [], page: request.page, pageSize: request.pageSize, total: 0, totalPages: 0, catalogRevision: 1 };
      },
      async listSessions() { return []; },
      async readSession(sessionId) { return { sessionId, cwd: "/w", projectRoot: "/w", entries: [] }; },
      async readSessionContext(sessionId) { return { sessionId, entries: [], pageInfo: { hasMore: false } }; },
      async readSessionThinking(sessionId, entryId) { throw makeRuntimeError("not_found", `session not found: ${sessionId}/${entryId}`); },
      async readSessionTree(sessionId) { return { sessionId, roots: [], entryCount: 0 }; },
      async deleteSession() {},
    },
  });
  const app = new SessiondApplication(service);
  try {
    await app.handle("sessions.list", { page: 1, pageSize: 20, query: "" });
    await app.handle("sessions.list", { page: 1, pageSize: 20, query: "   " });
    await app.handle("sessions.list", { page: 1, pageSize: 20, query: "  pix  " });
    assert.deepEqual(listCalls.map((request) => request.query), [undefined, undefined, "pix"]);
  } finally {
    await service.shutdown();
  }
});

test("the sessions.list RPC schema fails closed for over-long or empty-string queries", () => {
  assert.equal(SessionsListParamsSchema.safeParse({ page: 1, pageSize: 20, query: "x".repeat(201) }).success, false);
  assert.equal(SessionsListParamsSchema.safeParse({ page: 1, pageSize: 20, query: "" }).success, false);
  assert.equal(SessionsListParamsSchema.safeParse({ page: 1, pageSize: 20, query: "x".repeat(200) }).success, true);
  // Unknown sibling keys stay rejected (strictObject).
  assert.equal(SessionsListParamsSchema.safeParse({ page: 1, pageSize: 20, query: "x", extra: 1 }).success, false);
});

test("legacy keyword pagination slices after ranking with honest totals", async () => {
  const many: SessionHeader[] = Array.from({ length: 5 }, (_, index) => ({
    sessionId: `m${index}`,
    cwd: "/repos/many",
    projectRoot: "/repos/many",
    title: ` pix 发布 ${index} `,
    firstMessage: "x",
    updatedAt: index,
  }));
  const { service } = searchHarness({ catalog: legacyCatalog(many) });
  try {
    const first = await service.listSessionPage({ page: 1, pageSize: 2, query: "发布" });
    assert.deepEqual(first.sessions.map((s) => s.sessionId), ["m4", "m3"]);
    assert.equal(first.total, 5);
    assert.equal(first.totalPages, 3);
    const last = await service.listSessionPage({ page: 3, pageSize: 2, query: "发布" });
    assert.deepEqual(last.sessions.map((s) => s.sessionId), ["m0"]);
  } finally {
    await service.shutdown();
  }
});

test("legacy keyword pages never surface parent-linked rows", async () => {
  const withChild: SessionHeader[] = [
    ...CORPUS,
    { sessionId: "child", cwd: "/repos/alpha", projectRoot: "/repos/alpha", title: "搜索子代理", parentSessionId: "s-title", updatedAt: 9999 },
  ];
  const { service } = searchHarness({ catalog: legacyCatalog(withChild) });
  try {
    const page = await service.listSessionPage({ page: 1, pageSize: 50, query: "搜索" });
    assert.deepEqual(page.sessions.map((s) => s.sessionId), ["s-title", "s-message"]);
  } finally {
    await service.shutdown();
  }
});

test("keyword pages fail closed when the catalog is unavailable", async () => {
  const service = new SessiondService({
    sessionLocator: { async locate(sessionId) { return { sessionId, sessionFile: `/s/${sessionId}.jsonl`, exists: true }; }, async resolveLeafId() { return "leaf"; } },
    activationContext: { async resolve(_id, _loc, cwd) { return { cwd: cwd ?? "/w", projectRoot: cwd ?? "/w" }; } },
    workerFactory: new FakeWorkerFactory(),
  }, { idleTimeoutMs: 0 });
  try {
    await assert.rejects(
      () => service.listSessionPage({ page: 1, pageSize: 50, query: "x" }),
      (error: unknown) => error instanceof SessiondError && error.code === "unavailable",
    );
  } finally {
    await service.shutdown();
  }
});
