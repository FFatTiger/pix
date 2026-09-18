import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createPiSdkSessionStore } from "../src/internal/session-store.js";
import { SdkRuntimeDriverFactory } from "../src/internal/sdk-runtime.js";

/** Stop at the first initialization step, before model/resource loading or writes. */
const resolved = new Error("session identity resolved");

async function corpus() {
  const root = await mkdtemp(join(tmpdir(), "pix-runtime-open-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  const sessionDir = join(agentDir, "sessions", "project");
  await mkdir(sessionDir, { recursive: true });
  await mkdir(cwd);
  const sessionId = "11111111-1111-4111-8111-111111111111";
  const file = join(sessionDir, `2026-09-09T00-00-00-000Z_${sessionId}.jsonl`);
  const content = JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: "2026-09-09T00:00:00.000Z", cwd }) + "\n";
  await writeFile(file, content);
  return { root, agentDir, cwd, sessionId, file, content };
}

describe("runtime opens reuse the session catalog identity owner", () => {
  for (const scenario of ["indexed", "missing", "removed", "replaced"] as const) {
    it(`${scenario}: avoids SDK-wide history scans and fails closed on identity races`, async (t) => {
      const fixture = await corpus();
      const previous = process.env.PI_CODING_AGENT_DIR;
      process.env.PI_CODING_AGENT_DIR = fixture.agentDir;
      t.after(async () => {
        t.mock.restoreAll();
        if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previous;
        await rm(fixture.root, { recursive: true, force: true });
      });
      // Simulate the catalog prepared by sessiond before Worker activation.
      const store = createPiSdkSessionStore({ projection: { enabled: true } });
      assert.equal((await store.locate(fixture.sessionId)).exists, true);
      const listAll = t.mock.method(SessionManager, "listAll", async () => {
        throw new Error("runtime open must not re-parse all historical sessions");
      });
      const open = SessionManager.open;
      let finalOpen = false;
      if (scenario === "removed" || scenario === "replaced") {
        t.mock.method(SessionManager, "open", (...args: Parameters<typeof SessionManager.open>) => {
          if (args[2] !== undefined) {
            // The locator already validated the original identity. Swap it
            // immediately before the final SDK open to exercise the race.
            finalOpen = true;
            if (scenario === "removed") unlinkSync(fixture.file);
            else writeFileSync(fixture.file, readFileSync(fixture.file, "utf8").replace(fixture.sessionId, "22222222-2222-4222-8222-222222222222"));
          }
          return open.apply(SessionManager, args);
        });
      }
      let initializationStarted = false;
      const factory = new SdkRuntimeDriverFactory({ record: () => { initializationStarted = true; throw resolved; } });
      const id = scenario === "missing" ? "33333333-3333-4333-8333-333333333333" : fixture.sessionId;
      await assert.rejects(factory.open(id, fixture.cwd, undefined, {}), (error: unknown) =>
        scenario === "indexed" ? error === resolved : (error as { code?: string }).code === "not_found");
      assert.equal(listAll.mock.callCount(), 0);
      assert.equal(initializationStarted, scenario === "indexed");
      if (scenario === "removed") {
        assert.equal(finalOpen, true);
        assert.equal(existsSync(fixture.file), false, "missing JSONL must not be recreated");
      } else {
        const expected = scenario === "replaced"
          ? fixture.content.replace(fixture.sessionId, "22222222-2222-4222-8222-222222222222")
          : fixture.content;
        assert.equal(await readFile(fixture.file, "utf8"), expected, "runtime open must not append or rewrite the JSONL");
        if (scenario === "replaced") assert.equal(finalOpen, true);
      }
    });
  }
});
