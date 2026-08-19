// D3B trust-mutation slice: Pi-SDK-backed ProjectTrustMutationPort (set trusted
// only) tests under the D-01 delegation contract.
//
// Since D-01 we INHERIT Pi's per-user profile boundary: the adapter delegates
// persistence to the Pi SDK PUBLIC ProjectTrustStore.set(cwd, true) and removes
// the forked atomic writer. The adapter validates input, maps every SDK failure
// to a fixed sanitized PiSdkTrustMutationError, and verifies the persisted
// decision through a FRESH public ProjectTrustStore (the same store the read
// catalogs use) — a write that does not read back as trusted fails closed.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { createPiSdkTrustCatalog, createPiSdkTrustMutation } from "../src/trust/index.js";
import {
  PiSdkTrustMutationError,
  createPiSdkTrustMutationStore,
} from "../src/internal/trust-store.js";

async function fixture(): Promise<{ root: string; agentDir: string; projectCwd: string }> {
  const root = await mkdtemp(join(tmpdir(), "pix-trust-mut-"));
  const agentDir = join(root, "agent");
  const projectCwd = join(root, "project");
  await mkdir(agentDir, { recursive: true });
  await mkdir(projectCwd, { recursive: true });
  // A trust-requiring project resource (.agents/skills) so the gate is real.
  await mkdir(join(projectCwd, ".agents", "skills", "proj-skill"), { recursive: true });
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
    throw new Error("network access is forbidden by the trust mutation port");
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
    return called;
  };
}

function trustPathFor(agentDir: string): string {
  return join(agentDir, "trust.json");
}

function assertFixedCode(error: unknown, code: string): void {
  assert.ok(error instanceof PiSdkTrustMutationError, `expected PiSdkTrustMutationError, got ${error}`);
  assert.equal((error as PiSdkTrustMutationError).code, code);
  // Fixed sanitized message: no path, no raw fs/SDK text, no stack leak.
  assert.equal((error as PiSdkTrustMutationError).message.length > 0, true);
  assert.ok(!/ENOENT|EACCES|\/tmp|trust\.json|pi-coding-agent/i.test((error as Error).message));
}

/**
 * Spawn a child process that writes a trust decision through the REAL Pi SDK
 * public API against the same agent dir, proving our delegated writer and the
 * SDK share the same proper-lockfile so concurrent writers never lose an update.
 */
function sdkSetInChild(agentDir: string, cwd: string, repoRoot: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const script =
      'import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";' +
      "const [agentDir, cwd] = process.argv.slice(1);" +
      "new ProjectTrustStore(agentDir).set(cwd, true);";
    const child = spawn(process.execPath, ["--input-type=module", "-e", script, agentDir, cwd], {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`SDK child failed (${code}): ${stderr}`));
    });
  });
}

describe("trust mutation port (D3B trust-mutation slice, D-01 delegation)", () => {
  it("exposes exactly one method — set trusted only, no denied/level/read surface", async () => {
    const { agentDir, root } = await fixture();
    try {
      const port = createPiSdkTrustMutation({ agentDir });
      const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(port)).filter(
        (name) => name !== "constructor",
      );
      assert.deepEqual(methods, ["setProjectTrusted"]);
      assert.equal(typeof port.setProjectTrusted, "function");
      for (const method of ["getProjectTrustState", "isTrusted", "canReloadResources", "setTrust", "getTrust"]) {
        assert.equal(method in port, false, `${method} must not exist`);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("delegates to the real SDK set() and is immediately visible to the read catalog", async () => {
    const { root, agentDir, projectCwd } = await fixture();
    try {
      const release = installNetworkGuard();
      const mutation = createPiSdkTrustMutation({ agentDir });
      const query = createPiSdkTrustCatalog({ agentDir });

      assert.equal(await query.getProjectTrustState(projectCwd), "unknown");
      assert.equal(await query.isTrusted(projectCwd), false);
      assert.equal((await query.canReloadResources(projectCwd)).allowed, false);

      const status = await mutation.setProjectTrusted(projectCwd);
      release();
      assert.deepEqual(status, { cwd: projectCwd, level: "trusted", source: "saved" });

      // Read-after-write through the EXISTING read catalog (same agent dir).
      assert.equal(await query.getProjectTrustState(projectCwd), "trusted");
      assert.equal(await query.isTrusted(projectCwd), true);
      assert.deepEqual(await query.canReloadResources(projectCwd), {
        allowed: true,
        level: "trusted",
      });
      // The real SDK store itself sees the persisted decision (CLI parity).
      assert.equal(new ProjectTrustStore(agentDir).get(projectCwd), true);
      // trust.json exists and is valid JSON with exactly the canonical key.
      const parsed = JSON.parse(await readFile(trustPathFor(agentDir), "utf8")) as Record<string, unknown>;
      assert.deepEqual(Object.keys(parsed), [projectCwd]);
      assert.equal(parsed[projectCwd], true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects invalid cwd inputs before any filesystem or SDK access", async () => {
    const { root, agentDir } = await fixture();
    try {
      const mutation = createPiSdkTrustMutation({ agentDir });
      for (const bad of ["", "relative/path", "src/../..", "path\0with-nul", 42, null, undefined]) {
        await assert.rejects(
          mutation.setProjectTrusted(bad as unknown as string),
          (error: unknown) => {
            assertFixedCode(error, "TRUST_INPUT_INVALID");
            return true;
          },
          JSON.stringify(bad),
        );
      }
      assert.equal(existsSync(trustPathFor(agentDir)), false, "no trust.json touched");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("maps an SDK write failure to a fixed sanitized error (unwritable agent dir)", async () => {
    const root = await mkdtemp(join(tmpdir(), "pix-trust-mut-ro-"));
    const projectCwd = await mkdtemp(join(tmpdir(), "pix-trust-mut-proj-"));
    try {
      // Make the agent dir path unwritable deterministically on EVERY platform
      // (chmod is not meaningful on Windows): place a FILE where the agent
      // dir's parent is expected, so the SDK's mkdir/write fails (ENOTDIR).
      const blocker = join(root, "blocker");
      await writeFile(blocker, "file-blocking-the-agent-dir", "utf8");
      const agentDir = join(blocker, "agent");
      await assert.rejects(
        createPiSdkTrustMutation({ agentDir }).setProjectTrusted(projectCwd),
        (error: unknown) => {
          assertFixedCode(error, "TRUST_WRITE_FAILED");
          return true;
        },
      );
      // A raw fs/SDK error must never leak through the boundary.
      assert.equal(existsSync(join(blocker, "agent", "trust.json")), false, "no partial write");
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(projectCwd, { recursive: true, force: true });
    }
  });

  it("keeps a pre-existing foreign trust decision (no lost update through the SDK RMW)", async () => {
    const { root, agentDir, projectCwd } = await fixture();
    try {
      const seed = new ProjectTrustStore(agentDir);
      seed.set(join(root, "other-project"), true); // seed via the real SDK API
      await createPiSdkTrustMutation({ agentDir }).setProjectTrusted(projectCwd);
      const parsed = JSON.parse(await readFile(trustPathFor(agentDir), "utf8")) as Record<string, unknown>;
      assert.equal(parsed[join(root, "other-project")], true, "no lost update");
      assert.equal(parsed[projectCwd], true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("concurrent set-trusted calls never lose an update (SDK proper-lockfile serialization)", async () => {
    const root = await mkdtemp(join(tmpdir(), "pix-trust-mut-conc-"));
    try {
      const agentDir = join(root, "agent");
      await mkdir(agentDir, { recursive: true });
      const mutation = createPiSdkTrustMutation({ agentDir });
      const cwds: string[] = [];
      for (let index = 0; index < 24; index += 1) {
        const cwd = join(root, `project-${index}`);
        await mkdir(cwd, { recursive: true });
        cwds.push(cwd);
      }
      await Promise.all(cwds.map((cwd) => mutation.setProjectTrusted(cwd)));
      const parsed = JSON.parse(await readFile(trustPathFor(agentDir), "utf8")) as Record<string, unknown>;
      assert.equal(Object.keys(parsed).length, 24, "every decision must be persisted");
      for (const cwd of cwds) {
        assert.equal(parsed[cwd], true, `lost update for ${cwd}`);
      }
      // Same-cwd races converge on trusted.
      const same = join(root, "same");
      await mkdir(same, { recursive: true });
      await Promise.all(
        Array.from({ length: 12 }, () => mutation.setProjectTrusted(same)),
      );
      assert.equal(new ProjectTrustStore(agentDir).get(same), true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("accepts an injected mutation store (tests/composition seam)", async () => {
    const calls: string[] = [];
    const port = createPiSdkTrustMutation({
      setProjectTrusted: async (cwd: string) => {
        calls.push(cwd);
        return { cwd, level: "trusted", source: "saved" };
      },
    });
    assert.deepEqual(await port.setProjectTrusted("/workspace"), {
      cwd: "/workspace",
      level: "trusted",
      source: "saved",
    });
    assert.deepEqual(calls, ["/workspace"]);
  });

  it("injected projectTrustStore delegates persistence to the real SDK set", async () => {
    const { root, agentDir, projectCwd } = await fixture();
    try {
      const store = createPiSdkTrustMutationStore({
        agentDir,
        projectTrustStore: new ProjectTrustStore(agentDir),
      });
      await store.setProjectTrusted(projectCwd);
      assert.equal(new ProjectTrustStore(agentDir).get(projectCwd), true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("cross-process: no lost update against a concurrent real Pi SDK writer", async () => {
    const root = await mkdtemp(join(tmpdir(), "pix-trust-mut-xproc-"));
    try {
      const agentDir = join(root, "agent");
      await mkdir(agentDir, { recursive: true });
      const mutation = createPiSdkTrustMutation({ agentDir });
      const sdkCwds: string[] = [];
      const ourCwds: string[] = [];
      for (let index = 0; index < 4; index += 1) {
        const sdkCwd = join(root, `sdk-project-${index}`);
        const ourCwd = join(root, `our-project-${index}`);
        await mkdir(sdkCwd, { recursive: true });
        await mkdir(ourCwd, { recursive: true });
        sdkCwds.push(sdkCwd);
        ourCwds.push(ourCwd);
      }
      const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
      const sdkWrites = sdkCwds.map((cwd) => sdkSetInChild(agentDir, cwd, repoRoot));
      const ourWrites = ourCwds.map((cwd) => mutation.setProjectTrusted(cwd));
      await Promise.all([...sdkWrites, ...ourWrites]);
      const parsed = JSON.parse(await readFile(trustPathFor(agentDir), "utf8")) as Record<string, unknown>;
      for (const cwd of [...sdkCwds, ...ourCwds]) {
        assert.equal(parsed[cwd], true, `lost update for ${cwd}`);
      }
      const fresh = new ProjectTrustStore(agentDir);
      for (const cwd of [...sdkCwds, ...ourCwds]) {
        assert.equal(fresh.get(cwd), true, `SDK read miss for ${cwd}`);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("the read catalog stays corruption-safe on a malformed trust.json (fail closed, no leak)", async () => {
    const { root, agentDir, projectCwd } = await fixture();
    try {
      await writeFile(trustPathFor(agentDir), '{"x": tru\n', "utf8");
      // The read side must fail closed to unknown, never throw a raw error.
      assert.equal(await createPiSdkTrustCatalog({ agentDir }).getProjectTrustState(projectCwd), "unknown");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
