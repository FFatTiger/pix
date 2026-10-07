import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { syncBuiltinESMExports } from "node:module";
import workerThreads from "node:worker_threads";
import childProcess from "node:child_process";
import fs from "node:fs";
import { DefaultPackageManager, DefaultResourceLoader, loadSkillsFromDir, SettingsManager } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { mkdtemp, rm, mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createPiSdkGlobalResourceCatalog, createPiSdkResourceCatalog, type PiSdkResourceCatalogOptions } from "../src/resources/index.js";
import type {
  PluginInfo,
  ResourceCatalogPort,
  SkillInfo,
  SlashCommandInfo,
} from "@fffattiger/pix-runtime-core";

// Compile-time proof: PiSdkResourceCatalogOptions.cwd is REQUIRED — an options
// object omitting cwd is NOT assignable to the catalog options type.
type Assignable<A, B> = A extends B ? true : false;
const _noImplicitCwd: Assignable<
  { agentDir: string; trusted: boolean },
  PiSdkResourceCatalogOptions
> = false;

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

  it("keeps a contained project skill when the global skills root is absent", async () => {
    const root = await mkdtemp(join(tmpdir(), "pix-resources-project-only-"));
    const agentDir = join(root, "agent");
    const projectCwd = join(root, "project");
    try {
      await mkdir(agentDir, { recursive: true });
      await mkdir(join(projectCwd, ".pi", "skills", "project-only"), {
        recursive: true,
      });
      await writeFile(
        join(projectCwd, ".pi", "skills", "project-only", "SKILL.md"),
        "---\nname: project-only\ndescription: Contained project skill\n---\n# project",
        "utf8",
      );

      const catalog = createPiSdkResourceCatalog({
        cwd: projectCwd,
        agentDir,
        trusted: true,
      });
      assert.ok(
        (await catalog.listSkills()).some((skill) => skill.name === "project-only"),
      );
      assert.ok(
        (await catalog.listCommands()).some(
          (command) => command.name === "skill:project-only",
        ),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("filters project skill symlinks that escape the trusted project root", async (t) => {
    if (process.platform === "win32") {
      t.skip("directory symlinks require platform-specific privileges on Windows");
      return;
    }
    const { root, agentDir, projectCwd } = await fixture();
    try {
      const outside = join(root, "outside", "escaped-skill");
      await mkdir(outside, { recursive: true });
      await writeFile(
        join(outside, "SKILL.md"),
        "---\nname: escaped-skill\ndescription: Must remain outside\n---\n# escaped",
        "utf8",
      );
      await symlink(
        outside,
        join(projectCwd, ".pi", "skills", "escaped-link"),
        "dir",
      );

      const catalog = createPiSdkResourceCatalog({
        cwd: projectCwd,
        agentDir,
        trusted: true,
      });
      const skills = await catalog.listSkills();
      const commands = await catalog.listCommands();
      const names = skills.map((skill) => skill.name);
      assert.ok(names.includes("global-skill"));
      assert.ok(names.includes("proj-skill"));
      assert.ok(!names.includes("escaped-skill"), "outside skill metadata leaked through symlink");
      assert.ok(
        commands.every((command) => command.name !== "skill:escaped-skill"),
        "outside skill command leaked through symlink",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("filters an entire project skills root symlinked outside the project", async (t) => {
    if (process.platform === "win32") {
      t.skip("directory symlinks require platform-specific privileges on Windows");
      return;
    }
    const root = await mkdtemp(join(tmpdir(), "pix-resources-root-link-"));
    const agentDir = join(root, "agent");
    const projectCwd = join(root, "project");
    const outsideSkills = join(root, "outside-skills");
    try {
      await mkdir(join(agentDir, "skills", "global-skill"), { recursive: true });
      await writeFile(
        join(agentDir, "skills", "global-skill", "SKILL.md"),
        "---\nname: global-skill\ndescription: Global\n---\n# global",
        "utf8",
      );
      await mkdir(join(projectCwd, ".pi"), { recursive: true });
      await mkdir(join(outsideSkills, "escaped-root-skill"), { recursive: true });
      await writeFile(
        join(outsideSkills, "escaped-root-skill", "SKILL.md"),
        "---\nname: escaped-root-skill\ndescription: Must remain outside\n---\n# escaped",
        "utf8",
      );
      await symlink(outsideSkills, join(projectCwd, ".pi", "skills"), "dir");

      const catalog = createPiSdkResourceCatalog({
        cwd: projectCwd,
        agentDir,
        trusted: true,
      });
      const names = (await catalog.listSkills()).map((skill) => skill.name);
      assert.ok(names.includes("global-skill"));
      assert.ok(!names.includes("escaped-root-skill"));
      assert.ok(
        (await catalog.listCommands()).every(
          (command) => command.name !== "skill:escaped-root-skill",
        ),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("filters an entire global skills root symlinked outside agentDir", async (t) => {
    if (process.platform === "win32") {
      t.skip("directory symlinks require platform-specific privileges on Windows");
      return;
    }
    const root = await mkdtemp(join(tmpdir(), "pix-resources-global-link-"));
    const agentDir = join(root, "agent");
    const projectCwd = join(root, "project");
    const outsideSkills = join(root, "outside-global-skills");
    try {
      await mkdir(agentDir, { recursive: true });
      await mkdir(projectCwd, { recursive: true });
      await mkdir(join(outsideSkills, "escaped-global-skill"), { recursive: true });
      await writeFile(
        join(outsideSkills, "escaped-global-skill", "SKILL.md"),
        "---\nname: escaped-global-skill\ndescription: Must remain outside\n---\n# escaped",
        "utf8",
      );
      await symlink(outsideSkills, join(agentDir, "skills"), "dir");

      const catalog = createPiSdkResourceCatalog({
        cwd: projectCwd,
        agentDir,
        trusted: true,
      });
      assert.deepEqual(await catalog.listSkills(), []);
      assert.deepEqual(await catalog.listCommands(), []);
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

  it("untrusted read skips project .pi discovery entirely (no parse of malformed project settings)", async () => {
    const root = await mkdtemp(join(tmpdir(), "pix-res-gate-"));
    const agentDir = join(root, "agent");
    const projectCwd = join(root, "project");
    await mkdir(join(agentDir, "skills", "global-skill"), { recursive: true });
    await writeFile(
      join(agentDir, "skills", "global-skill", "SKILL.md"),
      "---\nname: global-skill\ndescription: g\n---\n# global-skill",
      "utf8",
    );
    await mkdir(join(projectCwd, ".pi", "skills", "proj-skill"), { recursive: true });
    await writeFile(
      join(projectCwd, ".pi", "skills", "proj-skill", "SKILL.md"),
      "---\nname: proj-skill\ndescription: p\n---\n# proj-skill",
      "utf8",
    );
    // MALFORMED project settings.json — if the untrusted read parsed it, this
    // would surface as an error/diagnostic. It must never be read.
    await mkdir(join(projectCwd, ".pi"), { recursive: true });
    await writeFile(
      join(projectCwd, ".pi", "settings.json"),
      "{ this is deliberately invalid json {{{",
      "utf8",
    );
    try {
      const untrusted = createPiSdkResourceCatalog({
        cwd: projectCwd,
        agentDir,
        trusted: false,
      });
      // Must not throw despite the malformed project settings.json.
      const skills = await untrusted.listSkills();
      const names = skills.map((s) => s.name);
      assert.ok(names.includes("global-skill"), "global skill loads when untrusted");
      assert.ok(!names.includes("proj-skill"), "project skill skipped when untrusted");
      await untrusted.listPlugins();
      await untrusted.listCommands();

      // Trusted discovers the project skill (project .pi is read).
      const trusted = createPiSdkResourceCatalog({
        cwd: projectCwd,
        agentDir,
        trusted: true,
      });
      const trustedSkills = await trusted.listSkills();
      assert.ok(
        trustedSkills.some((s) => s.name === "proj-skill"),
        "project skill discovered when trusted",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects construction without an explicit canonical cwd (no implicit fallback)", () => {
    assert.throws(
      () =>
        createPiSdkResourceCatalog({ agentDir: "/tmp", trusted: true } as unknown as PiSdkResourceCatalogOptions),
      (error: unknown) => (error as { code?: string }).code === "invalid_input",
    );
    assert.throws(
      () => createPiSdkResourceCatalog({} as PiSdkResourceCatalogOptions),
      (error: unknown) => (error as { code?: string }).code === "invalid_input",
    );
  });
});

describe("resource catalog default trust: malformed trust.json fails closed (D3B-R1A)", () => {
  // The default `trusted` computation shares the corruption-safe logic with the
  // trust catalog: a malformed/unreadable trust.json yields trusted=false so
  // project resources are withheld — with NO throw and no raw path/content/stack.
  it("withholds project resources without throwing when trust.json is corrupt (no `trusted` option)", async () => {
    const root = await mkdtemp(join(tmpdir(), "pix-res-trust-corrupt-"));
    const agentDir = join(root, "agent");
    const projectCwd = join(root, "project");
    await mkdir(join(agentDir, "skills", "global-skill"), { recursive: true });
    await writeFile(
      join(agentDir, "skills", "global-skill", "SKILL.md"),
      "---\nname: global-skill\ndescription: g\n---\n# global-skill",
      "utf8",
    );
    // Trust-requiring project resource (.pi/skills) so the gate is real.
    await mkdir(join(projectCwd, ".pi", "skills", "proj-skill"), {
      recursive: true,
    });
    await writeFile(
      join(projectCwd, ".pi", "skills", "proj-skill", "SKILL.md"),
      "---\nname: proj-skill\ndescription: p\n---\n# proj-skill",
      "utf8",
    );
    // CORRUPT trust.json in the agent dir.
    await writeFile(
      join(agentDir, "trust.json"),
      "{ this is deliberately invalid json {{{",
      "utf8",
    );
    try {
      // No `trusted` option => default computation reads the corrupt trust.json.
      const catalog = createPiSdkResourceCatalog({ cwd: projectCwd, agentDir });
      // Must not throw despite the corrupt trust.json.
      const skills = await catalog.listSkills();
      const names = skills.map((s) => s.name);
      assert.ok(
        names.includes("global-skill"),
        "global skill still loads under corrupt trust",
      );
      assert.ok(
        !names.includes("proj-skill"),
        "project skill withheld when trust.json is corrupt (fail closed)",
      );
      // No raw SDK Error, path, file content, or stack may surface.
      const payload = JSON.stringify(skills);
      assert.ok(!payload.includes("trust.json"), "trust path leaked");
      assert.ok(
        !payload.includes("this is deliberately invalid json"),
        "corrupt file content leaked",
      );
      // Commands + plugins must also not throw under corrupt trust.
      await catalog.listCommands();
      await catalog.listPlugins();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});


describe("global resource catalog", () => {
  it("reads only agent-dir static metadata independent of cwd, execution, workers, installation, or network", async (t) => {
    const { root, agentDir, projectCwd, markerPath } = await fixture();
    const packageDir = join(agentDir, "local-package");
    await mkdir(packageDir);
    await writeFile(join(packageDir, "package.json"), JSON.stringify({
      name: "static-package", version: "1.2.3", type: "module", main: "index.js",
      pi: { extensions: ["index.js"] },
    }));
    await writeFile(join(packageDir, "index.js"),
      `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(markerPath)}, "executed");`);
    await writeFile(join(agentDir, "settings.json"), JSON.stringify({
      packages: ["./local-package", { source: "npm:@fake/never-install" }],
      skills: [join(projectCwd, ".pi", "skills")],
      extensions: [join(packageDir, "index.js")],
    }));
    // A fake project inside agentDir must never be treated as an authorized cwd.
    await symlink(join(projectCwd, ".pi"), join(agentDir, ".pi"), "dir");
    await writeFile(join(projectCwd, ".pi", "settings.json"), "{ broken project trap");
    await writeFile(join(agentDir, "trust.json"), "{ broken trust trap");
    const before = await readdir(agentDir);
    const forbidden = () => { throw new Error("forbidden dynamic catalog dependency"); };
    // SDK resolvePath eagerly evaluates its cwd default even for absolute
    // inputs. Prove that ambient path has no effect on discovery.
    const ambientCwd = t.mock.method(process, "cwd", () => projectCwd);
    const guards = [
      t.mock.method(globalThis, "fetch", forbidden),
      t.mock.method(SettingsManager, "create", forbidden),
      t.mock.method(DefaultResourceLoader.prototype, "reload", forbidden),
      t.mock.method(DefaultPackageManager.prototype, "resolve", forbidden),
      t.mock.method(DefaultPackageManager.prototype, "install", forbidden),
      t.mock.method(workerThreads, "Worker", forbidden),
    ];
    syncBuiltinESMExports();
    try {
      const catalog = createPiSdkGlobalResourceCatalog({ agentDir });
      assert.deepEqual(await catalog.listSkills(), [
        { name: "global-skill", description: "A global skill", enabled: true },
      ]);
      assert.deepEqual(await catalog.listCommands(), [
        { name: "skill:global-skill", description: "A global skill", source: "skill" },
      ]);
      assert.deepEqual(await catalog.listPlugins(), [
        { name: "static-package", version: "1.2.3", enabled: true },
        { name: "npm:@fake/never-install", enabled: false },
      ]);
      ambientCwd.mock.mockImplementation(() => join(root, "deleted-ambient-cwd"));
      const second = createPiSdkGlobalResourceCatalog({ agentDir });
      assert.deepEqual(await second.listSkills(), await catalog.listSkills());
      assert.deepEqual(await second.listPlugins(), await catalog.listPlugins());
      assert.deepEqual(await second.listCommands(), await catalog.listCommands());
      assert.equal(existsSync(markerPath), false);
      for (const guard of guards) assert.equal(guard.mock.callCount(), 0);
      assert.deepEqual(await readdir(agentDir), before);
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reads commented settings with trailing commas without rewriting the file", async () => {
    const { root, agentDir } = await fixture();
    const packageDir = join(agentDir, "jsonc-package");
    const settingsPath = join(agentDir, "settings.json");
    try {
      await mkdir(packageDir);
      await writeFile(join(packageDir, "package.json"), JSON.stringify({ name: "jsonc-package", version: "1.0.0" }));
      const content = `// saved global configuration\n{\n  "packages": [${JSON.stringify(packageDir)},],\n  "unknownUrl": "https://example.invalid//keep",\n}\n`;
      await writeFile(settingsPath, content);
      const catalog = createPiSdkGlobalResourceCatalog({ agentDir });
      assert.deepEqual(await catalog.listPlugins(), [{ name: "jsonc-package", version: "1.0.0", enabled: true }]);
      assert.deepEqual((await catalog.listSkills()).map((skill) => skill.name), ["global-skill"]);
      assert.deepEqual((await catalog.listCommands()).map((command) => command.name), ["skill:global-skill"]);
      assert.equal(await readFile(settingsPath, "utf8"), content);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("missing global settings are empty; malformed or unreadable real settings fail safely", async () => {
    const { root, agentDir } = await fixture();
    try {
      assert.deepEqual(await createPiSdkGlobalResourceCatalog({ agentDir }).listPlugins(), []);
      for (const content of ["", "{ SECRET broken", "[]", "null", '{"packages":null}',
        '{"packages":"bad"}', '{"packages":[{}]}', '{"packages":[null]}']) {
        await writeFile(join(agentDir, "settings.json"), content);
        for (const method of ["listSkills", "listPlugins", "listCommands"] as const) {
          await assert.rejects(createPiSdkGlobalResourceCatalog({ agentDir })[method](),
            (error: unknown) => {
              assert.equal((error as { code: string }).code, "invalid_input");
              assert.ok(!JSON.stringify(error).includes("SECRET"));
              assert.ok(!JSON.stringify(error).includes(agentDir));
              return true;
            });
        }
      }
      await rm(join(agentDir, "settings.json"));
      await mkdir(join(agentDir, "settings.json"));
      await assert.rejects(createPiSdkGlobalResourceCatalog({ agentDir }).listPlugins(),
        (error: unknown) => (error as { code: string }).code === "unavailable");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("filters escaped skill files, directories, and the whole global skills root", async (t) => {
    if (process.platform === "win32") return t.skip("symlink privileges required");
    const { root, agentDir, projectCwd } = await fixture();
    const outside = join(projectCwd, ".pi", "skills", "proj-skill");
    try {
      await symlink(outside, join(agentDir, "skills", "escape"), "dir");
      await symlink(join(outside, "SKILL.md"), join(agentDir, "skills", "escape.md"), "file");
      let catalog = createPiSdkGlobalResourceCatalog({ agentDir });
      assert.deepEqual((await catalog.listSkills()).map((s) => s.name), ["global-skill"]);
      assert.deepEqual((await catalog.listCommands()).map((s) => s.name), ["skill:global-skill"]);
      await rm(join(agentDir, "skills"), { recursive: true });
      await symlink(join(projectCwd, ".pi", "skills"), join(agentDir, "skills"), "dir");
      catalog = createPiSdkGlobalResourceCatalog({ agentDir });
      assert.deepEqual(await catalog.listSkills(), []);
      assert.deepEqual(await catalog.listCommands(), []);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects relative agent directories instead of using ambient cwd", () => {
    assert.throws(() => createPiSdkGlobalResourceCatalog({ agentDir: "relative" }),
      (error: unknown) => (error as { code: string }).code === "invalid_input");
  });
});


for (const scope of ["global", "project", "untrusted project"] as const) {
  it(`${scope} static catalog never runs a configured npmCommand for missing npm references`, async (t) => {
    const { root, agentDir, projectCwd } = await fixture();
    try {
      await writeFile(join(agentDir, "settings.json"), JSON.stringify({
        npmCommand: [process.execPath, join(root, "custom-npm-cli.js")],
        packages: ["npm:@fake/missing@1.2.3", { source: "npm:@fake/filtered" }],
      }));
      await writeFile(join(projectCwd, ".pi", "settings.json"), JSON.stringify({
        packages: ["npm:@fake/project-missing"],
      }));
      const guards = ["spawnSync", "execSync", "execFileSync", "spawn", "exec", "execFile", "fork"]
        .map((method) => t.mock.method(childProcess, method as keyof typeof childProcess, () => {
          throw new Error("subprocess must never be attempted");
        }));
      syncBuiltinESMExports();
      const catalog = scope === "global"
        ? createPiSdkGlobalResourceCatalog({ agentDir })
        : createPiSdkResourceCatalog({ agentDir, cwd: projectCwd, trusted: scope === "project" });
      await catalog.listSkills();
      await catalog.listCommands();
      assert.deepEqual(await catalog.listPlugins(), [
        { name: "npm:@fake/missing@1.2.3", enabled: true },
        { name: "npm:@fake/filtered", enabled: false },
        ...(scope === "project" ? [{ name: "npm:@fake/project-missing", enabled: true }] : []),
      ]);
      // SDK legacy lookup catches command failures: assert attempts, not just
      // rejection or marker absence, to catch swallowed execution errors.
      for (const guard of guards) assert.equal(guard.mock.callCount(), 0);
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
      await rm(root, { recursive: true, force: true });
    }
  });
}

describe("strict global skill reads", () => {
  for (const failure of ["root readdir", "nested readdir", "skill read", "loose skill read", "ignore read", "skill stat"] as const) {
    it(`${failure} EACCES is unavailable, never fake empty metadata`, async (t) => {
      const { root, agentDir } = await fixture();
      const skillsDir = join(agentDir, "skills");
      const skillDir = join(skillsDir, "global-skill");
      await writeFile(join(skillsDir, "loose.md"), "---\nname: loose\ndescription: Loose\n---");
      await writeFile(join(skillsDir, ".ignore"), "unrelated/\n");
      const target = failure === "root readdir" ? skillsDir
        : failure === "nested readdir" ? skillDir
        : failure === "loose skill read" ? join(skillsDir, "loose.md")
        : failure === "ignore read" ? join(skillsDir, ".ignore")
        : join(skillDir, "SKILL.md");
      const denied = () => Object.assign(new Error(`EACCES: SECRET ${target}`), { code: "EACCES" });
      const originalReaddir = fs.readdirSync;
      const originalRead = fs.readFileSync;
      const originalStat = fs.statSync;
      const guards = [
        t.mock.method(fs, "readdirSync", (...args: Parameters<typeof fs.readdirSync>) => {
          if (failure.endsWith("readdir") && String(args[0]) === target) throw denied();
          return originalReaddir(...args);
        }),
        t.mock.method(fs, "readFileSync", (...args: Parameters<typeof fs.readFileSync>) => {
          if (failure.endsWith("read") && String(args[0]) === target) throw denied();
          return originalRead(...args);
        }),
        t.mock.method(fs, "statSync", (...args: Parameters<typeof fs.statSync>) => {
          if (failure === "skill stat" && String(args[0]) === target) throw denied();
          return originalStat(...args);
        }),
      ];
      syncBuiltinESMExports();
      try {
        for (const method of ["listSkills", "listCommands", "listPlugins"] as const) {
          await assert.rejects(createPiSdkGlobalResourceCatalog({ agentDir })[method](), (error: unknown) => {
            assert.equal((error as { code: string }).code, "unavailable");
            assert.ok(!JSON.stringify(error).includes("SECRET"));
            assert.ok(!JSON.stringify(error).includes(agentDir));
            return true;
          });
        }
        assert.ok(guards.some((guard) => guard.mock.callCount() > 0));
      } finally {
        t.mock.restoreAll();
        syncBuiltinESMExports();
        await rm(root, { recursive: true, force: true });
      }
    });
  }

  it("keeps missing roots empty, readable ignored skills hidden, and declared roots terminal", async (t) => {
    const { root, agentDir } = await fixture();
    const skillsDir = join(agentDir, "skills");
    try {
      await rm(skillsDir, { recursive: true });
      assert.deepEqual(await createPiSdkGlobalResourceCatalog({ agentDir }).listSkills(), []);
      await mkdir(join(skillsDir, "declared", "not-discovered"), { recursive: true });
      await writeFile(join(skillsDir, "declared", "SKILL.md"), "---\nname: declared\ndescription: Declared\n---");
      const original = fs.readdirSync;
      const guard = t.mock.method(fs, "readdirSync", (...args: Parameters<typeof fs.readdirSync>) => {
        assert.notEqual(String(args[0]), join(skillsDir, "declared", "not-discovered"));
        return original(...args);
      });
      syncBuiltinESMExports();
      assert.deepEqual((await createPiSdkGlobalResourceCatalog({ agentDir }).listSkills()).map((s) => s.name), ["declared"]);
      guard.mock.restore();
      syncBuiltinESMExports();
      await writeFile(join(skillsDir, ".ignore"), "declared/\nloose.md\n");
      await writeFile(join(skillsDir, "loose.md"), "---\nname: loose\ndescription: Loose\n---");
      assert.deepEqual(await createPiSdkGlobalResourceCatalog({ agentDir }).listSkills(), []);
      assert.deepEqual(await createPiSdkGlobalResourceCatalog({ agentDir }).listCommands(), []);
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("validates descendants when an ignored SKILL.md allows SDK recursion", async (t) => {
    const { root, agentDir } = await fixture();
    const skillDir = join(agentDir, "skills", "global-skill");
    const nested = join(skillDir, "nested");
    await mkdir(nested);
    await writeFile(join(agentDir, "skills", ".ignore"), "global-skill/SKILL.md\n");
    const original = fs.readdirSync;
    t.mock.method(fs, "readdirSync", (...args: Parameters<typeof fs.readdirSync>) => {
      if (String(args[0]) === nested) throw Object.assign(new Error("denied"), { code: "EACCES" });
      return original(...args);
    });
    syncBuiltinESMExports();
    try {
      await assert.rejects(createPiSdkGlobalResourceCatalog({ agentDir }).listSkills(),
        (error: unknown) => (error as { code: string }).code === "unavailable");
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects contained directory cycles as invalid input", async (t) => {
    if (process.platform === "win32") return t.skip("symlink privileges required");
    const { root, agentDir } = await fixture();
    try {
      await symlink(join(agentDir, "skills"), join(agentDir, "skills", "cycle"), "dir");
      await assert.rejects(createPiSdkGlobalResourceCatalog({ agentDir }).listSkills(),
        (error: unknown) => (error as { code: string }).code === "invalid_input");
      await rm(join(agentDir, "skills", "cycle"));
      await symlink("cycle", join(agentDir, "skills", "cycle"));
      await assert.rejects(createPiSdkGlobalResourceCatalog({ agentDir }).listSkills(),
        (error: unknown) => (error as { code: string }).code === "invalid_input");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reads each directory and candidate file once; a former second-pass EACCES is never reached", async (t) => {
    const { root, agentDir } = await fixture();
    const skillsDir = join(agentDir, "skills");
    const skillDir = join(skillsDir, "global-skill");
    const target = join(skillDir, "SKILL.md");
    const originalRead = fs.readFileSync;
    const originalReaddir = fs.readdirSync;
    const attempts = new Map<string, number>();
    const count = (path: string) => {
      const reads = (attempts.get(path) ?? 0) + 1;
      attempts.set(path, reads);
      if (reads === 2) throw Object.assign(new Error("EACCES: former SDK second read"), { code: "EACCES" });
    };
    t.mock.method(fs, "readFileSync", (...args: Parameters<typeof fs.readFileSync>) => {
      if (String(args[0]) === target) count(target);
      return originalRead(...args);
    });
    t.mock.method(fs, "readdirSync", (...args: Parameters<typeof fs.readdirSync>) => {
      const path = String(args[0]);
      if (path === skillsDir || path === skillDir) count(path);
      return originalReaddir(...args);
    });
    syncBuiltinESMExports();
    try {
      const catalog = createPiSdkGlobalResourceCatalog({ agentDir });
      assert.deepEqual(await catalog.listSkills(), [{ name: "global-skill", description: "A global skill", enabled: true }]);
      assert.deepEqual(await catalog.listCommands(), [{ name: "skill:global-skill", description: "A global skill", source: "skill" }]);
      await catalog.listPlugins();
      assert.deepEqual([...attempts].sort(), [[skillsDir, 1], [skillDir, 1], [target, 1]].sort());
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("malformed declared metadata and YAML parse failures are sanitized invalid input", async () => {
    const { root, agentDir } = await fixture();
    const target = join(agentDir, "skills", "global-skill", "SKILL.md");
    try {
      for (const content of [
        "---\ndescription: [SECRET broken\n---", "# Missing description", "---\ndescription: '   '\n---",
        "---\ndescription: [not, a, string]\n---",
      ]) {
        await writeFile(target, content);
        for (const method of ["listSkills", "listCommands"] as const) {
          await assert.rejects(createPiSdkGlobalResourceCatalog({ agentDir })[method](), (error: unknown) => {
            assert.equal((error as { code: string }).code, "invalid_input");
            assert.ok(!JSON.stringify(error).includes("SECRET"));
            assert.ok(!JSON.stringify(error).includes(agentDir));
            return true;
          });
        }
      }
      await rm(target);
      await writeFile(join(agentDir, "skills", "loose.md"), "---\ndescription: [SECRET broken\n---");
      await assert.rejects(createPiSdkGlobalResourceCatalog({ agentDir }).listSkills(),
        (error: unknown) => (error as { code: string }).code === "invalid_input");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not read ignored directories or escaped skill/ignore-file symlinks", async (t) => {
    if (process.platform === "win32") return t.skip("symlink privileges required");
    const { root, agentDir, projectCwd } = await fixture();
    const skillsDir = join(agentDir, "skills");
    const ignored = join(skillsDir, "ignored");
    const escape = join(skillsDir, "escape");
    const outsideSkill = join(projectCwd, ".pi", "skills", "proj-skill");
    await mkdir(ignored);
    await writeFile(join(skillsDir, ".ignore"), "ignored/\n");
    await symlink(outsideSkill, escape, "dir");
    await symlink(join(outsideSkill, "SKILL.md"), join(skillsDir, "escape.md"));
    await symlink(join(outsideSkill, "SKILL.md"), join(skillsDir, ".fdignore"));
    const originalRead = fs.readFileSync;
    const originalReaddir = fs.readdirSync;
    t.mock.method(fs, "readFileSync", (...args: Parameters<typeof fs.readFileSync>) => {
      assert.ok(![join(skillsDir, "escape.md"), join(skillsDir, ".fdignore")].includes(String(args[0])));
      assert.ok(!String(args[0]).startsWith(projectCwd));
      return originalRead(...args);
    });
    t.mock.method(fs, "readdirSync", (...args: Parameters<typeof fs.readdirSync>) => {
      const path = String(args[0]);
      if (path === ignored) throw Object.assign(new Error("EACCES: ignored subtree"), { code: "EACCES" });
      assert.notEqual(path, escape);
      return originalReaddir(...args);
    });
    syncBuiltinESMExports();
    try {
      assert.deepEqual((await createPiSdkGlobalResourceCatalog({ agentDir }).listSkills()).map((s) => s.name), ["global-skill"]);
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("matches native readable discovery, nested ignores, aliases, metadata and commands", async (t) => {
    if (process.platform === "win32") return t.skip("symlink privileges required");
    const { root, agentDir } = await fixture();
    const skillsDir = join(agentDir, "skills");
    const write = async (path: string, content: string) => {
      await mkdir(join(skillsDir, path, ".."), { recursive: true });
      await writeFile(join(skillsDir, path), content);
    };
    const skill = (name: string) => `---\nname: ${JSON.stringify(name)}\ndescription: Description\n---`;
    try {
      await write("loose.md", skill("loose"));
      await write("notes.md", "# Not a skill");
      await write(".hidden/SKILL.md", skill("hidden"));
      await write("node_modules/pkg/SKILL.md", skill("dependency"));
      await write("root-hidden.md", skill("root-hidden"));
      await write("skip-dir/SKILL.md", skill("skip-dir"));
      await write("container/blocked/SKILL.md", skill("blocked"));
      await write("container/ignored/SKILL.md", skill("restored"));
      await write("container/fdhidden/SKILL.md", skill("fdhidden"));
      await write("container/loose.md", skill("nested-loose"));
      await write("container/parent/SKILL.md", skill("parent"));
      await write("container/parent/deeper/SKILL.md", skill("must-not-descend"));
      await write("container/fallback/SKILL.md", "---\nname: ''\ndescription: Fallback\ndisable-model-invocation: true\n---");
      await write("container/unusual/SKILL.md", skill("Nonconforming NAME " + "a".repeat(70)));
      await write("container/!literal/SKILL.md", skill("escaped-bang"));
      await write("container/#literal/SKILL.md", skill("escaped-hash"));
      await write(".gitignore", "# comment\nroot-hidden.md\nskip-dir/\n");
      await write("container/.gitignore", "/blocked/\nignored/SKILL.md\n");
      await write("container/.ignore", "!ignored/SKILL.md\n\\!literal/\n\\#literal/\n");
      await write("container/.fdignore", "fdhidden/\n");
      await symlink(join(skillsDir, "global-skill"), join(skillsDir, "alias"), "dir");
      await symlink(join(skillsDir, "loose.md"), join(skillsDir, "loose-alias.md"));
      const native = loadSkillsFromDir({ dir: skillsDir, source: "user" }).skills;
      const catalog = createPiSdkGlobalResourceCatalog({ agentDir });
      assert.deepEqual(await catalog.listSkills(), native.map((s) => ({
        name: s.name, description: s.description, enabled: !s.disableModelInvocation,
      })));
      assert.deepEqual(await catalog.listCommands(), native.map((s) => ({
        name: `skill:${s.name}`, description: s.description, source: "skill",
      })));
      const names = (await catalog.listSkills()).map((s) => s.name);
      assert.ok(names.includes("restored"));
      assert.ok(names.includes("fallback"));
      assert.ok(names.some((name) => name.startsWith("Nonconforming NAME")));
      for (const excluded of ["hidden", "dependency", "root-hidden", "skip-dir", "blocked", "fdhidden", "nested-loose", "must-not-descend", "escaped-bang", "escaped-hash"]) {
        assert.ok(!names.includes(excluded), excluded);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
