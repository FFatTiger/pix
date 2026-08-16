// D3B trust-mutation slice: Pi-SDK-backed ProjectTrustMutationPort (set trusted
// only) adversarial tests. Exercises the REAL SDK persistence path
// (ProjectTrustStore.set over the agent-dir trust.json) plus the hardening
// passes: serialization/no lost update, permissions (0600/0700), path safety
// (symlinked trust.json fail-closed), immutability on failure, read-after-write
// consistency with the existing read catalog, and no raw leak.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
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

/**
 * Spawn a child process that writes a trust decision through the REAL Pi SDK
 * public API (ProjectTrustStore.set) against the same agent dir, proving our
 * atomic writer and the SDK/CLI share the same proper-lockfile so concurrent
 * writers never lose an update. The child resolves the SDK from the repo root.
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

  it("rejects a hardlinked trust.json fail-closed without touching the shared inode", async () => {
    const { root, agentDir, projectCwd } = await fixture();
    try {
      const victim = join(root, "victim.json");
      await writeFile(victim, '{"keep":true}\n', "utf8");
      await chmod(victim, 0o644);
      await link(victim, trustPathFor(agentDir));
      await assert.rejects(
        createPiSdkTrustMutation({ agentDir }).setProjectTrusted(projectCwd),
        (error: unknown) => {
          assertFixedCode(error, "TRUST_STORE_UNSAFE");
          return true;
        },
      );
      // nlink>1 must fail BEFORE any chmod: the victim's bytes AND mode are
      // untouched and the hardlink pair survives.
      assert.equal(await readFile(victim, "utf8"), '{"keep":true}\n', "victim bytes unchanged");
      assert.equal((await lstat(victim)).mode & 0o077, 0o044, "victim mode unchanged (no chmod through the link)");
      assert.equal((await lstat(victim)).nlink, 2, "hardlink pair preserved");
      assert.equal(await readFile(trustPathFor(agentDir), "utf8"), '{"keep":true}\n');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("crash window #1: failure before the rename leaves the old bytes immutable and cleans the temp", async () => {
    const { root, agentDir, projectCwd } = await fixture();
    try {
      const existing = join(root, "existing-project");
      await mkdir(existing, { recursive: true });
      new ProjectTrustStore(agentDir).set(existing, true);
      const before = await readTrustJson(agentDir);
      const store = createPiSdkTrustMutationStore({
        agentDir,
        faultInjection: { failAfterTempWrite: true },
      });
      await assert.rejects(
        store.setProjectTrusted(projectCwd),
        (error: unknown) => {
          assertFixedCode(error, "TRUST_WRITE_UNVERIFIED");
          return true;
        },
      );
      assert.equal(await readTrustJson(agentDir), before, "old bytes must be immutable");
      assert.deepEqual(
        (await readdir(agentDir)).filter((name) => name.startsWith(".trust-") && name.endsWith(".tmp")),
        [],
        "temp files must be cleaned up",
      );
      // Read surface stays fail-closed-consistent for the unwritten cwd.
      assert.equal(await createPiSdkTrustCatalog({ agentDir }).getProjectTrustState(projectCwd), "unknown");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("crash window #2: rename-then-dir-fsync failure never reports success but publishes a valid store", async () => {
    const { root, agentDir, projectCwd } = await fixture();
    try {
      const store = createPiSdkTrustMutationStore({
        agentDir,
        faultInjection: { failAfterRename: true },
      });
      await assert.rejects(
        store.setProjectTrusted(projectCwd),
        (error: unknown) => {
          assertFixedCode(error, "TRUST_WRITE_UNVERIFIED");
          return true;
        },
      );
      // Honest semantics: the mutation did NOT report success, but the renamed
      // file is valid and readable by the exact SDK read surface + read catalog.
      assert.equal(new ProjectTrustStore(agentDir).get(projectCwd), true);
      assert.equal(await createPiSdkTrustCatalog({ agentDir }).getProjectTrustState(projectCwd), "trusted");
      const parsed = JSON.parse(await readTrustJson(agentDir)) as Record<string, unknown>;
      assert.equal(parsed[projectCwd], true);
      assert.deepEqual(
        (await readdir(agentDir)).filter((name) => name.startsWith(".trust-") && name.endsWith(".tmp")),
        [],
        "no temp files left behind",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("sanitizes a lock-release failure after publish; fresh read-back prevents false success", async () => {
    const { root, agentDir, projectCwd } = await fixture();
    const lockPath = `${trustPathFor(agentDir)}.lock`;
    try {
      const store = createPiSdkTrustMutationStore({
        agentDir,
        faultInjection: {
          beforeReverify: async () => {
            // Replace proper-lockfile's held lock directory with a regular file.
            // Its release callback will reject with a raw ENOTDIR containing
            // lockPath; that raw error must never cross the adapter boundary.
            await rm(lockPath, { recursive: true, force: true });
            await writeFile(lockPath, "planted-lock", "utf8");
          },
        },
      });
      await assert.rejects(
        store.setProjectTrusted(projectCwd),
        (error: unknown) => {
          // The atomic publish completed, but the fresh SDK read-back cannot
          // acquire the retained/broken lock, so success is denied honestly.
          assertFixedCode(error, "TRUST_WRITE_UNVERIFIED");
          return true;
        },
      );
      const parsed = JSON.parse(await readTrustJson(agentDir)) as Record<string, unknown>;
      assert.equal(parsed[projectCwd], true, "the atomic publish remains valid");
      await rm(lockPath, { force: true });
      assert.equal(new ProjectTrustStore(agentDir).get(projectCwd), true);
    } finally {
      await rm(lockPath, { recursive: true, force: true }).catch(() => {});
      await rm(root, { recursive: true, force: true });
    }
  });

  it("a lock-release failure never overrides the primary fixed mutation error", async () => {
    const { root, agentDir, projectCwd } = await fixture();
    const trustPath = trustPathFor(agentDir);
    const lockPath = `${trustPath}.lock`;
    try {
      new ProjectTrustStore(agentDir).set(join(root, "existing"), true);
      const store = createPiSdkTrustMutationStore({
        agentDir,
        faultInjection: {
          beforeReverify: async () => {
            await rm(lockPath, { recursive: true, force: true });
            await writeFile(lockPath, "planted-lock", "utf8");
            await rm(trustPath, { force: true });
            await writeFile(trustPath, '{"impostor":true}\n', "utf8");
          },
        },
      });
      await assert.rejects(
        store.setProjectTrusted(projectCwd),
        (error: unknown) => {
          // Target identity replacement is the primary failure. The raw
          // release ENOTDIR must neither escape nor override this code.
          assertFixedCode(error, "TRUST_STORE_UNSAFE");
          return true;
        },
      );
      assert.equal(await readTrustJson(agentDir), '{"impostor":true}\n');
    } finally {
      await rm(lockPath, { recursive: true, force: true }).catch(() => {});
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails closed when the target is swapped to a different inode between read and rename", async () => {
    const { root, agentDir, projectCwd } = await fixture();
    try {
      new ProjectTrustStore(agentDir).set(join(root, "existing"), true);
      const store = createPiSdkTrustMutationStore({
        agentDir,
        faultInjection: {
          beforeReverify: async (trustPath: string) => {
            await rm(trustPath, { force: true });
            await writeFile(trustPath, '{"impostor":true}\n', "utf8"); // new inode
          },
        },
      });
      await assert.rejects(
        store.setProjectTrusted(projectCwd),
        (error: unknown) => {
          assertFixedCode(error, "TRUST_STORE_UNSAFE");
          return true;
        },
      );
      // The swapped-in impostor is untouched (no write-through).
      assert.equal(await readTrustJson(agentDir), '{"impostor":true}\n');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails closed when a hardlink to a victim is substituted between read and rename", async () => {
    const { root, agentDir, projectCwd } = await fixture();
    try {
      new ProjectTrustStore(agentDir).set(join(root, "existing"), true);
      const victim = join(root, "victim-swap.json");
      await writeFile(victim, '{"keep":true}\n', "utf8");
      const store = createPiSdkTrustMutationStore({
        agentDir,
        faultInjection: {
          beforeReverify: async (trustPath: string) => {
            await rm(trustPath, { force: true });
            await link(victim, trustPath); // nlink becomes 2
          },
        },
      });
      await assert.rejects(
        store.setProjectTrusted(projectCwd),
        (error: unknown) => {
          assertFixedCode(error, "TRUST_STORE_UNSAFE");
          return true;
        },
      );
      assert.equal(await readFile(victim, "utf8"), '{"keep":true}\n', "victim unchanged");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails closed when a symlink is substituted between read and rename (no write-through)", async () => {
    const { root, agentDir, projectCwd } = await fixture();
    try {
      new ProjectTrustStore(agentDir).set(join(root, "existing"), true);
      const target = join(root, "planted-swap.json");
      await writeFile(target, '{"keep":true}\n', "utf8");
      const store = createPiSdkTrustMutationStore({
        agentDir,
        faultInjection: {
          beforeReverify: async (trustPath: string) => {
            await rm(trustPath, { force: true });
            await symlink(target, trustPath);
          },
        },
      });
      await assert.rejects(
        store.setProjectTrusted(projectCwd),
        (error: unknown) => {
          assertFixedCode(error, "TRUST_STORE_UNSAFE");
          return true;
        },
      );
      assert.equal(await readFile(target, "utf8"), '{"keep":true}\n', "symlink target untouched");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails closed when the agent dir is replaced by a symlink between read and rename (dir identity)", async () => {
    const { root, agentDir, projectCwd } = await fixture();
    try {
      const store = createPiSdkTrustMutationStore({
        agentDir,
        faultInjection: {
          beforeReverify: async (_trustPath: string, agent: string) => {
            const swapped = join(root, "swapped-agent");
            await mkdir(swapped, { recursive: true });
            await rename(agent, join(root, "agent-original"));
            await symlink(swapped, agent);
          },
        },
      });
      await assert.rejects(
        store.setProjectTrusted(projectCwd),
        (error: unknown) => {
          assertFixedCode(error, "TRUST_STORE_UNSAFE");
          return true;
        },
      );
      assert.equal((await lstat(agentDir)).isSymbolicLink(), true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails closed when the agent dir is swapped to a different real directory between read and rename", async () => {
    const { root, agentDir, projectCwd } = await fixture();
    try {
      const store = createPiSdkTrustMutationStore({
        agentDir,
        faultInjection: {
          beforeReverify: async (_trustPath: string, agent: string) => {
            const swapped = join(root, "swapped-agent-real");
            await mkdir(swapped, { recursive: true });
            await rename(agent, join(root, "agent-original-2"));
            await mkdir(agent, { recursive: true }); // brand-new directory (different inode)
          },
        },
      });
      await assert.rejects(
        store.setProjectTrusted(projectCwd),
        (error: unknown) => {
          assertFixedCode(error, "TRUST_STORE_UNSAFE");
          return true;
        },
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("cross-process: no lost update against a concurrent real Pi SDK writer", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "pix-trust-mut-xproc-")));
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
      const parsed = JSON.parse(await readTrustJson(agentDir)) as Record<string, unknown>;
      for (const cwd of [...sdkCwds, ...ourCwds]) {
        assert.equal(parsed[cwd], true, `lost update for ${cwd}`);
      }
      // Fresh SDK read agrees on both writers' decisions.
      const fresh = new ProjectTrustStore(agentDir);
      for (const cwd of [...sdkCwds, ...ourCwds]) {
        assert.equal(fresh.get(cwd), true, `SDK read miss for ${cwd}`);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects an oversized trust.json fail-closed without touching it", async () => {
    const { root, agentDir, projectCwd } = await fixture();
    try {
      const huge = JSON.stringify({ ["a".repeat(1024 * 1024 + 16)]: true });
      await writeFile(trustPathFor(agentDir), huge, "utf8");
      await assert.rejects(
        createPiSdkTrustMutation({ agentDir }).setProjectTrusted(projectCwd),
        (error: unknown) => {
          assertFixedCode(error, "TRUST_WRITE_FAILED");
          return true;
        },
      );
      assert.equal(await readTrustJson(agentDir), huge, "oversized store must stay immutable");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails closed and immutable when trust.json is unreadable (mode 000)", async () => {
    const { root, agentDir, projectCwd } = await fixture();
    try {
      const seeded = '{"x":true}\n';
      await writeFile(trustPathFor(agentDir), seeded, "utf8");
      await chmod(trustPathFor(agentDir), 0o000);
      await assert.rejects(
        createPiSdkTrustMutation({ agentDir }).setProjectTrusted(projectCwd),
        (error: unknown) => {
          assertFixedCode(error, "TRUST_WRITE_FAILED");
          return true;
        },
      );
      assert.equal((await lstat(trustPathFor(agentDir))).mode & 0o077, 0o000, "unreadable mode preserved");
      await chmod(trustPathFor(agentDir), 0o600);
      assert.equal(await readTrustJson(agentDir), seeded, "bytes unchanged");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("serializes exactly like the SDK (sorted keys, 2-space indent, trailing newline) and is freshly read back", async () => {
    const { root, agentDir, projectCwd } = await fixture();
    try {
      const other = join(root, "zzz-other");
      await mkdir(other, { recursive: true });
      new ProjectTrustStore(agentDir).set(other, true); // seed out-of-order via the SDK
      await createPiSdkTrustMutation({ agentDir }).setProjectTrusted(projectCwd);
      const bytes = await readTrustJson(agentDir);
      assert.equal(bytes.endsWith("\n"), true, "trailing newline");
      const parsed = JSON.parse(bytes) as Record<string, unknown>;
      assert.deepEqual(Object.keys(parsed), [projectCwd, other].sort(), "keys sorted");
      const expected = `${JSON.stringify(Object.fromEntries(Object.entries(parsed).sort()), null, 2)}\n`;
      assert.equal(bytes, expected, "byte-exact SDK format (2-space indent + trailing newline)");
      // A FRESH public SDK store reads every decision back (CLI parity).
      assert.equal(new ProjectTrustStore(agentDir).get(projectCwd), true);
      assert.equal(new ProjectTrustStore(agentDir).get(other), true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("canonicalizes the filesystem root key consistently with the SDK", async () => {
    const { root, agentDir } = await fixture();
    try {
      await createPiSdkTrustMutation({ agentDir }).setProjectTrusted("/");
      const parsed = JSON.parse(await readTrustJson(agentDir)) as Record<string, unknown>;
      assert.equal(parsed["/"], true, "root cwd persisted under the '/' key");
      assert.equal(new ProjectTrustStore(agentDir).get("/"), true, "fresh SDK read of the root key");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("non-hardened seam: injected projectTrustStore without agentDir uses the real SDK set", async () => {
    const { root, agentDir, projectCwd } = await fixture();
    try {
      const store = createPiSdkTrustMutationStore({ projectTrustStore: new ProjectTrustStore(agentDir) });
      await store.setProjectTrusted(projectCwd);
      assert.equal(new ProjectTrustStore(agentDir).get(projectCwd), true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
