import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { openListedSessionExact, type ExactOpenSessionSdk } from "../src/internal/sdk-runtime.js";

function isNotFound(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && (error as { code?: string }).code === "not_found"
    && (error as { message?: string }).message === "session not found";
}

function manager(id: string, cwd = "/repo") {
  return { getSessionId: () => id, getCwd: () => cwd } as ReturnType<ExactOpenSessionSdk["open"]>;
}

describe("openListedSessionExact", () => {
  it("opens only when the on-disk session id matches the requested id", async () => {
    const sdk: ExactOpenSessionSdk = {
      async listAll() {
        return [{ id: "requested", path: "/repo/sessions/requested.jsonl" }];
      },
      open() {
        return manager("requested");
      },
    };
    const opened = await openListedSessionExact({ sessionId: "requested" }, sdk);
    assert.equal(opened.cwd, "/repo");
    assert.equal(opened.manager.getSessionId(), "requested");
  });

  it("fails closed when the listed path was reused by another session", async () => {
    let openCalls = 0;
    const sdk: ExactOpenSessionSdk = {
      async listAll() {
        return [{ id: "requested", path: "/repo/sessions/shared.jsonl" }];
      },
      open() {
        openCalls += 1;
        return manager("different-session");
      },
    };
    await assert.rejects(() => openListedSessionExact({ sessionId: "requested" }, sdk), isNotFound);
    assert.equal(openCalls, 1);
  });

  it("fails closed when the session is absent or open throws", async () => {
    await assert.rejects(
      () => openListedSessionExact({ sessionId: "missing" }, {
        async listAll() { return []; },
        open() { throw new Error("must not open"); },
      }),
      isNotFound,
    );
    await assert.rejects(
      () => openListedSessionExact({ sessionId: "requested" }, {
        async listAll() { return [{ id: "requested", path: "/repo/sessions/requested.jsonl" }]; },
        open() { throw new Error("ENOENT /repo/sessions/requested.jsonl"); },
      }),
      (error) => isNotFound(error) && !String((error as { message?: string }).message ?? error).includes("/repo"),
    );
  });
});
