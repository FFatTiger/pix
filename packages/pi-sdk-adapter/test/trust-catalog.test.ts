import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { createPiSdkTrustCatalog } from "../src/trust/index.js";
import { createPiSdkTrustStore } from "../src/internal/trust-store.js";
import type {
  ProjectTrustQueryPort,
  ProjectTrustState,
} from "@fffattiger/pix-runtime-core";

async function fixture(): Promise<{ root: string; agentDir: string; projectCwd: string }> {
  const root = await mkdtemp(join(tmpdir(), "pix-trust-catalog-"));
  const agentDir = join(root, "agent");
  const projectCwd = join(root, "project");
  await mkdir(agentDir, { recursive: true });
  await mkdir(projectCwd, { recursive: true });
  // A trust-requiring project resource (.agents/skills) so the gate is real.
  await mkdir(join(projectCwd, ".agents", "skills", "proj-skill"), {
    recursive: true,
  });
  await writeFile(
    join(projectCwd, ".agents", "skills", "proj-skill", "SKILL.md"),
    "# proj-skill\nproject skill",
    "utf8",
  );
  return { root, agentDir, projectCwd };
}

/** Network guard: throws if any outbound fetch happens during the probe. */
function installNetworkGuard(): () => boolean {
  let called = false;
  const original = globalThis.fetch;
  globalThis.fetch = (() => {
    called = true;
    throw new Error("network access is forbidden by the read-only trust catalog");
  }) as typeof globalThis.fetch;
  return () => {
    globalThis.fetch = original;
    return called;
  };
}

describe("read-only trust catalog (D3B-R1A)", () => {
  it("maps the saved decision to the exact tri-state", async () => {
    const { root, projectCwd } = await fixture();
    try {
      // Each state uses its own real ProjectTrustStore (own trust.json) so the
      // writes do not collide; .set() exercises real path/key normalization.
      const seedTrusted = new ProjectTrustStore(join(root, "agent-trusted"));
      seedTrusted.set(projectCwd, true);
      const seedDenied = new ProjectTrustStore(join(root, "agent-denied"));
      seedDenied.set(projectCwd, false);
      const seedUnknown = new ProjectTrustStore(join(root, "agent-unknown"));

      const unknown = createPiSdkTrustCatalog(
        createPiSdkTrustStore({ projectTrustStore: seedUnknown }),
      );
      const trusted = createPiSdkTrustCatalog(
        createPiSdkTrustStore({ projectTrustStore: seedTrusted }),
      );
      const denied = createPiSdkTrustCatalog(
        createPiSdkTrustStore({ projectTrustStore: seedDenied }),
      );

      assert.equal(await unknown.getProjectTrustState(projectCwd), "unknown");
      assert.equal(await trusted.getProjectTrustState(projectCwd), "trusted");
      assert.equal(await denied.getProjectTrustState(projectCwd), "denied");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("real ancestor path/key resolution: a parent decision covers a child cwd", async () => {
    const { root, projectCwd } = await fixture();
    try {
      // Trust a PARENT of projectCwd; querying the child must resolve to trusted
      // via the real ProjectTrustStore ancestor walk.
      const parent = join(root, "workspace");
      const child = join(parent, "deep", "project");
      await mkdir(join(child, ".agents", "skills", "x"), { recursive: true });
      const store = new ProjectTrustStore(join(root, "agent-ancestor"));
      store.set(parent, true);
      const catalog = createPiSdkTrustStore({ projectTrustStore: store });
      assert.equal(await catalog.getProjectTrustState(child), "trusted");
      assert.equal(await catalog.isTrusted(child), true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("isTrusted reflects the effective SDK gate (resources + decision)", async () => {
    const { root, agentDir, projectCwd } = await fixture();
    try {
      // projectCwd has trust-requiring resources, so the decision matters.
      const blocked = createPiSdkTrustCatalog(
        createPiSdkTrustStore({ projectTrustStore: new ProjectTrustStore(agentDir) }),
      );
      assert.equal(await blocked.isTrusted(projectCwd), false);
      assert.equal((await blocked.canReloadResources(projectCwd)).allowed, false);

      const seedTrusted = new ProjectTrustStore(agentDir);
      seedTrusted.set(projectCwd, true);
      const allowed = createPiSdkTrustCatalog(
        createPiSdkTrustStore({ projectTrustStore: seedTrusted }),
      );
      assert.equal(await allowed.isTrusted(projectCwd), true);
      assert.equal((await allowed.canReloadResources(projectCwd)).allowed, true);

      // A cwd with NO trust-requiring resources is trusted without a decision.
      const bare = join(root, "bare");
      await mkdir(bare, { recursive: true });
      assert.equal(await blocked.isTrusted(bare), true);
      assert.equal((await blocked.canReloadResources(bare)).allowed, true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("canReloadResources carries the tri-state level and a deny reason", async () => {
    const { root, agentDir, projectCwd } = await fixture();
    try {
      const blocked = createPiSdkTrustCatalog(
        createPiSdkTrustStore({ projectTrustStore: new ProjectTrustStore(agentDir) }),
      );
      const gate = await blocked.canReloadResources(projectCwd);
      assert.equal(gate.allowed, false);
      assert.equal(gate.level, "unknown" as ProjectTrustState);
      assert.ok(gate.reason && gate.reason.length > 0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("no network access occurs during trust reads", async () => {
    const { root, agentDir, projectCwd } = await fixture();
    try {
      const release = installNetworkGuard();
      const catalog = createPiSdkTrustCatalog(
        createPiSdkTrustStore({ projectTrustStore: new ProjectTrustStore(agentDir) }),
      );
      await catalog.getProjectTrustState(projectCwd);
      await catalog.isTrusted(projectCwd);
      await catalog.canReloadResources(projectCwd);
      const networkCalled = release();
      assert.equal(networkCalled, false, "trust catalog must not call network");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("catalog surface exposes no mutation methods", () => {
    const catalog = createPiSdkTrustCatalog({
      getProjectTrustState: () => Promise.resolve("unknown"),
      isTrusted: () => Promise.resolve(false),
      canReloadResources: () =>
        Promise.resolve({ allowed: false, level: "unknown" }),
    });
    const proto = Object.getPrototypeOf(catalog);
    const methodNames = Object.getOwnPropertyNames(proto).filter(
      (name) => name !== "constructor",
    );
    assert.deepEqual([...methodNames].sort(), [
      "canReloadResources",
      "getProjectTrustState",
      "isTrusted",
    ]);
    assert.equal("setTrust" in catalog, false);
    assert.equal("getTrust" in catalog, false);
  });

  it("implements the read-only ProjectTrustQueryPort contract", () => {
    const catalog: ProjectTrustQueryPort = createPiSdkTrustCatalog({
      getProjectTrustState: () => Promise.resolve("unknown"),
      isTrusted: () => Promise.resolve(false),
      canReloadResources: () =>
        Promise.resolve({ allowed: false, level: "unknown" }),
    });
    assert.equal(typeof catalog.getProjectTrustState, "function");
    assert.equal(typeof catalog.isTrusted, "function");
    assert.equal(typeof catalog.canReloadResources, "function");
  });

  it("malformed trust.json fails closed to unknown and withholds resources", async () => {
    const { root, agentDir, projectCwd } = await fixture();
    try {
      // Corrupt the trust store so ProjectTrustStore.get would throw.
      await writeFile(join(agentDir, "trust.json"), "{ this is not valid json ", "utf8");
      const catalog = createPiSdkTrustCatalog({ agentDir });
      // Must not throw, and must fail closed.
      const state = await catalog.getProjectTrustState(projectCwd);
      assert.equal(state, "unknown");
      assert.equal(await catalog.isTrusted(projectCwd), false);
      const gate = await catalog.canReloadResources(projectCwd);
      assert.equal(gate.allowed, false);
      assert.equal(gate.level, "unknown");
      // No raw SDK Error, path, file content, or stack may surface.
      const payload = JSON.stringify({ state, gate });
      assert.ok(!payload.includes("trust.json"), "trust path leaked");
      assert.ok(!payload.includes("Invalid trust store"), "raw SDK error leaked");
      assert.ok(!payload.includes("this is not valid json"), "file content leaked");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
