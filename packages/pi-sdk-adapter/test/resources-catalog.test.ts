import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createPiSdkResourceCatalog } from "../src/resources/index.js";
import type {
  PluginInfo,
  ResourceCatalogPort,
  SkillInfo,
  SlashCommandInfo,
} from "@fffattiger/pix-runtime-core";

async function fixture(): Promise<{
  root: string;
  agentDir: string;
  projectCwd: string;
  markerPath: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "pix-resources-catalog-"));
  const agentDir = join(root, "agent");
  const projectCwd = join(root, "project");
  const markerPath = join(root, "pwned.marker");
  await mkdir(join(agentDir, "skills", "global-skill"), { recursive: true });
  await writeFile(
    join(agentDir, "skills", "global-skill", "SKILL.md"),
    "---\nname: global-skill\ndescription: A global skill\n---\n# global-skill\nA global skill",
    "utf8",
  );
  await mkdir(join(agentDir, "prompts"), { recursive: true });
  await writeFile(
    join(agentDir, "prompts", "global-prompt.md"),
    "# global-prompt\nA prompt template",
    "utf8",
  );
  // Project-local skill (trust-gated) + malicious extension (must never execute).
  await mkdir(join(projectCwd, ".pi", "skills", "proj-skill"), {
    recursive: true,
  });
  await writeFile(
    join(projectCwd, ".pi", "skills", "proj-skill", "SKILL.md"),
    "---\nname: proj-skill\ndescription: A project skill\n---\n# proj-skill\nA project skill",
    "utf8",
  );
  await mkdir(join(projectCwd, ".pi", "extensions"), { recursive: true });
  await writeFile(
    join(projectCwd, ".pi", "extensions", "evil.ts"),
    `import { writeFileSync } from "node:fs";\n` +
      `// MALICIOUS: writes a marker if this module is ever imported/executed.\n` +
      `writeFileSync(${JSON.stringify(markerPath)}, "executed");\n` +
      `export default function () {}\n`,
    "utf8",
  );
  return { root, agentDir, projectCwd, markerPath };
}

/** Network guard: throws if any outbound fetch happens during the probe. */
function installNetworkGuard(): () => boolean {
  let called = false;
  const original = globalThis.fetch;
  globalThis.fetch = (() => {
    called = true;
    throw new Error("network access is forbidden by the read-only resource catalog");
  }) as typeof globalThis.fetch;
  return () => {
    globalThis.fetch = original;
    return called;
  };
}

describe("read-only resource catalog (D3B-R1A)", () => {
  it("trusted project exposes global + project skills; malicious extension never executes", async () => {
    const { root, agentDir, projectCwd, markerPath } = await fixture();
    try {
      const release = installNetworkGuard();
      const catalog = createPiSdkResourceCatalog({
        cwd: projectCwd,
        agentDir,
        trusted: true,
      });
      const skills = await catalog.listSkills();
      release();
      const names = skills.map((s) => s.name);
      assert.ok(names.includes("global-skill"), "global skill always visible");
      assert.ok(names.includes("proj-skill"), "project skill visible when trusted");
      // noExtensions:true must prevent the malicious extension from importing.
      assert.equal(existsSync(markerPath), false, "malicious extension was executed");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("untrusted project withholds project-local skills but keeps global ones", async () => {
    const { root, agentDir, projectCwd, markerPath } = await fixture();
    try {
      const catalog = createPiSdkResourceCatalog({
        cwd: projectCwd,
        agentDir,
        trusted: false,
      });
      const skills = await catalog.listSkills();
      const names = skills.map((s) => s.name);
      assert.ok(names.includes("global-skill"), "global skill always visible");
      assert.ok(!names.includes("proj-skill"), "project skill withheld when untrusted");
      assert.equal(existsSync(markerPath), false, "malicious extension was executed");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("denied trust also withholds project skills", async () => {
    const { root, agentDir, projectCwd } = await fixture();
    try {
      const catalog = createPiSdkResourceCatalog({
        cwd: projectCwd,
        agentDir,
        trusted: false,
      });
      const skills = await catalog.listSkills();
      assert.ok(skills.every((s) => s.name !== "proj-skill"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("commands surface skill commands; no extension commands", async () => {
    const { root, agentDir, projectCwd, markerPath } = await fixture();
    try {
      const catalog = createPiSdkResourceCatalog({
        cwd: projectCwd,
        agentDir,
        trusted: true,
      });
      const commands = await catalog.listCommands();
      const names = commands.map((c) => c.name);
      assert.ok(
        names.includes("skill:global-skill"),
        "skill command present",
      );
      // Canonical source fields only.
      for (const command of commands) {
        const keys = Object.keys(command) as (keyof SlashCommandInfo)[];
        for (const key of keys) {
          assert.ok(
            ["name", "description", "source", "sourceInfo"].includes(key),
            `unexpected SlashCommandInfo field: ${key}`,
          );
        }
      }
      assert.equal(existsSync(markerPath), false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("skill metadata is canonical and backend-neutral", async () => {
    const { root, agentDir, projectCwd } = await fixture();
    try {
      const catalog = createPiSdkResourceCatalog({
        cwd: projectCwd,
        agentDir,
        trusted: true,
      });
      const skills = await catalog.listSkills();
      for (const skill of skills) {
        const keys = Object.keys(skill) as (keyof SkillInfo)[];
        for (const key of keys) {
          assert.ok(
            ["name", "description", "enabled", "version", "updateAvailable"].includes(
              key,
            ),
            `unexpected SkillInfo field: ${key}`,
          );
        }
        assert.equal(typeof skill.enabled, "boolean");
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("plugins list is canonical metadata (no execution)", async () => {
    const { root, agentDir, projectCwd, markerPath } = await fixture();
    try {
      const catalog = createPiSdkResourceCatalog({
        cwd: projectCwd,
        agentDir,
        trusted: true,
      });
      const plugins = await catalog.listPlugins();
      for (const plugin of plugins) {
        const keys = Object.keys(plugin) as (keyof PluginInfo)[];
        for (const key of keys) {
          assert.ok(
            ["name", "version", "enabled"].includes(key),
            `unexpected PluginInfo field: ${key}`,
          );
        }
      }
      assert.equal(existsSync(markerPath), false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("control: importing the malicious module WOULD create the marker", async () => {
    // Proves the marker fixture is sound: if the extension were imported, the
    // marker would appear. Its absence after catalog reads therefore proves
    // noExtensions prevented execution (not a broken fixture).
    const { root, markerPath } = await fixture();
    try {
      const probe = join(root, "probe.mjs");
      await writeFile(
        probe,
        `import { writeFileSync } from "node:fs";` +
          `writeFileSync(${JSON.stringify(markerPath)}, "executed");`,
        "utf8",
      );
      await import(probe);
      assert.equal(existsSync(markerPath), true, "control marker must fire on import");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("no network access occurs during resource discovery", async () => {
    const { root, agentDir, projectCwd } = await fixture();
    try {
      const release = installNetworkGuard();
      const catalog = createPiSdkResourceCatalog({
        cwd: projectCwd,
        agentDir,
        trusted: true,
      });
      await catalog.listSkills();
      await catalog.listPlugins();
      await catalog.listCommands();
      const networkCalled = release();
      assert.equal(networkCalled, false, "resource catalog must not call network");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("plugins surface static configured-package metadata source", async () => {
    const root = await mkdtemp(join(tmpdir(), "pix-resources-pkg-"));
    const agentDir = join(root, "agent");
    const projectCwd = join(root, "project");
    try {
      await mkdir(join(agentDir, "settings"), { recursive: true });
      await mkdir(projectCwd, { recursive: true });
      // Seed a configured (user-scoped) package source in global settings —
      // static metadata only; the package is NOT installed, so no module is
      // imported. The plugin must surface from configured metadata.
      await writeFile(
        join(agentDir, "settings.json"),
        JSON.stringify({ packages: ["npm:@fake/plugin-pkg"] }),
        "utf8",
      );
      const catalog = createPiSdkResourceCatalog({
        cwd: projectCwd,
        agentDir,
        trusted: true,
      });
      const plugins = await catalog.listPlugins();
      const pkg = plugins.find((p) => p.name.includes("@fake/plugin-pkg"));
      assert.ok(pkg, "configured package surfaces as static plugin metadata");
      assert.equal(typeof pkg!.enabled, "boolean");
      // No installed module => version omitted (safe static metadata).
      const keys = Object.keys(pkg!) as (keyof PluginInfo)[];
      assert.ok(keys.every((k) => ["name", "version", "enabled"].includes(k)));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("catalog surface exposes no mutation methods", () => {
    const catalog = createPiSdkResourceCatalog({
      listSkills: () => Promise.resolve([]),
      listPlugins: () => Promise.resolve([]),
      listCommands: () => Promise.resolve([]),
    });
    const proto = Object.getPrototypeOf(catalog);
    const methodNames = Object.getOwnPropertyNames(proto).filter(
      (name) => name !== "constructor",
    );
    assert.deepEqual([...methodNames].sort(), [
      "listCommands",
      "listPlugins",
      "listSkills",
    ]);
    for (const forbidden of [
      "writePlugin", "setPluginEnabled", "installSkill", "updateSkill",
      "setSkillEnabled", "reload",
    ]) {
      assert.equal(forbidden in catalog, false, `mutation method leaked: ${forbidden}`);
    }
  });

  it("implements the read-only ResourceCatalogPort contract", () => {
    const catalog: ResourceCatalogPort = createPiSdkResourceCatalog({
      listSkills: () => Promise.resolve([]),
      listPlugins: () => Promise.resolve([]),
      listCommands: () => Promise.resolve([]),
    });
    assert.equal(typeof catalog.listSkills, "function");
    assert.equal(typeof catalog.listPlugins, "function");
    assert.equal(typeof catalog.listCommands, "function");
  });
});
