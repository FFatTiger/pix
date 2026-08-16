// D3B trust-mutation slice: Pi-SDK-backed ProjectTrustMutationPort (set trusted
// only) adversarial tests. Exercises the REAL SDK persistence path
// (ProjectTrustStore.set over the agent-dir trust.json) plus the hardening
// passes: serialization/no lost update, permissions (0600/0700), path safety
// (symlinked trust.json fail-closed), immutability on failure, read-after-write
// consistency with the existing read catalog, and no raw leak.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { createPiSdkTrustCatalog, createPiSdkTrustMutation } from "../src/trust/index.js";
import { PiSdkTrustMutationError } from "../src/internal/trust-store.js";

async function fixture(): Promise<{ root: string; agentDir: string; projectCwd: string }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pix-trust-mut-")));
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

async function readTrustJson(agentDir: string): Promise<string> {
  return readFile(trustPathFor(agentDir), "utf8");
}

function assertFixedCode(error: unknown, code: string): void {
  assert.ok(error instanceof PiSdkTrustMutationError, `expected PiSdkTrustMutationError, got ${error}`);
  assert.equal((error as PiSdkTrustMutationError).code, code);
  // Fixed sanitized message: no path, no raw fs/SDK text, no stack leak in message.
  assert.equal((error as PiSdkTrustMutationError).message.length > 0, true);
  assert.ok(!/ENOENT|EACCES|\/tmp|trust\.json|pi-coding-agent/i.test((error as Error).message));
}

describe("trust mutation port (D3B trust-mutation slice)", () => {
  it("exposes exactly one method — set trusted only, no denied/level/read surface", async () => {
    const { agentDir, root } = await fixture();
    try {
      const port = createPiSdkTrustMutation({ agentDir });
      const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(port)).filter(
        (name) => name !== "constructor",
      );
      assert.deepEqual(methods, ["setProjectTrusted"]);
      assert.equal(typeof port.setProjectTrusted, "function");
      // Not a query port: no read methods leaked onto the mutation surface.
      for (const method of ["getProjectTrustState", "isTrusted", "canReloadResources", "setTrust", "getTrust"]) {
        assert.equal(method in port, false, `${method} must not exist`);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("persists through the real SDK trust.json and is immediately visible to the read catalog", async () => {
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
      // trust.json exists, is valid JSON with exactly the canonical key.
      const parsed = JSON.parse(await readTrustJson(agentDir)) as Record<string, unknown>;
      assert.deepEqual(Object.keys(parsed), [projectCwd]);
      assert.equal(parsed[projectCwd], true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("creates trust.json 0600 (and a new agent dir 0700) and keeps the process umask", async () => {
    const root = await mkdtemp(join(tmpdir(), "pix-trust-mut-fresh-"));
    try {
      const agentDir = join(root, "brand-new-agent"); // does not exist yet
      const projectCwd = await mkdtemp(join(tmpdir(), "pix-trust-mut-proj-"));
      const previousUmask = process.umask();
      const mutation = createPiSdkTrustMutation({ agentDir });
      await mutation.setProjectTrusted(projectCwd);
      assert.equal(process.umask(), previousUmask, "umask must be restored");

      const file = await lstat(trustPathFor(agentDir));
      assert.equal(file.isFile(), true);
      assert.equal(file.isSymbolicLink(), false);
      assert.equal(file.mode & 0o077, 0, "trust.json must be owner-only (0600)");
      const dir = await lstat(agentDir);
      assert.equal(dir.mode & 0o077, 0, "newly created agent dir must be 0700");
      await rm(projectCwd, { recursive: true, force: true });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("tightens a pre-existing group/world-readable trust.json to 0600 before writing", async () => {
    const { root, agentDir, projectCwd } = await fixture();
    try {
      const seed = new ProjectTrustStore(agentDir);
      seed.set(join(root, "other-project"), true); // seed via the real SDK API
      await chmod(trustPathFor(agentDir), 0o644);
      assert.equal((await lstat(trustPathFor(agentDir))).mode & 0o077, 0o044);

      await createPiSdkTrustMutation({ agentDir }).setProjectTrusted(projectCwd);
      const after = await lstat(trustPathFor(agentDir));
      assert.equal(after.mode & 0o077, 0, "loose mode must be tightened to 0600");
      const parsed = JSON.parse(await readTrustJson(agentDir)) as Record<string, unknown>;
      // The pre-existing foreign key survives (no lost update).
      assert.equal(parsed[join(root, "other-project")], true);
      assert.equal(parsed[projectCwd], true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a symlinked trust.json fail-closed without writing through it", async () => {
    const { root, agentDir, projectCwd } = await fixture();
    try {
      const target = join(root, "planted-target.json");
      await writeFile(target, "{\"/keep\": true}\n", "utf8");
      await symlink(target, trustPathFor(agentDir));

      await assert.rejects(
        createPiSdkTrustMutation({ agentDir }).setProjectTrusted(projectCwd),
        (error: unknown) => {
          assertFixedCode(error, "TRUST_STORE_UNSAFE");
          return true;
        },
      );
      // Nothing written through the symlink; target content unchanged.
      assert.equal(await readFile(target, "utf8"), "{\"/keep\": true}\n");
      assert.equal((await readlink(trustPathFor(agentDir))), target);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails immutable on a corrupt trust.json: fixed error, bytes unchanged", async () => {
    const { root, agentDir, projectCwd } = await fixture();
    try {
      const corrupt = "{\"/proj\": tru\n"; // truncated JSON
      await writeFile(trustPathFor(agentDir), corrupt, "utf8");
      await assert.rejects(
        createPiSdkTrustMutation({ agentDir }).setProjectTrusted(projectCwd),
        (error: unknown) => {
          assertFixedCode(error, "TRUST_WRITE_FAILED");
          return true;
        },
      );
      assert.equal(await readTrustJson(agentDir), corrupt, "corrupt store must stay immutable");
      // The read catalog still fails closed to unknown.
      assert.equal(await createPiSdkTrustCatalog({ agentDir }).getProjectTrustState(projectCwd), "unknown");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails immutable when the agent dir is unwritable (no trust.json created)", async () => {
    const root = await mkdtemp(join(tmpdir(), "pix-trust-mut-ro-"));
    const projectCwd = await mkdtemp(join(tmpdir(), "pix-trust-mut-proj-"));
    try {
      const agentDir = join(root, "agent");
      await mkdir(agentDir, { recursive: true });
      await chmod(agentDir, 0o555);
      await assert.rejects(
        createPiSdkTrustMutation({ agentDir }).setProjectTrusted(projectCwd),
        (error: unknown) => {
          assertFixedCode(error, "TRUST_WRITE_FAILED");
          return true;
        },
      );
      assert.equal(existsSync(trustPathFor(agentDir)), false, "no partial write");
    } finally {
      await chmod(join(root, "agent"), 0o755).catch(() => {});
      await rm(root, { recursive: true, force: true });
      await rm(projectCwd, { recursive: true, force: true });
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

  it("concurrent set-trusted calls never lose an update (in-process serialization)", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "pix-trust-mut-conc-")));
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
      // All 24 mutations race on the same agent-dir store.
      await Promise.all(cwds.map((cwd) => mutation.setProjectTrusted(cwd)));
      const parsed = JSON.parse(await readTrustJson(agentDir)) as Record<string, unknown>;
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
});
