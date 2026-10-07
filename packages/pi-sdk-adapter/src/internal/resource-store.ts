// Read-only resource catalog store backed by the Pi SDK standalone resource
// loaders + package manager static metadata.
//
// This is the ONLY module in the resources domain that touches the Pi SDK. It
// performs pure metadata discovery only — loadSkills / parseFrontmatter
// (filesystem metadata, never an extension module) plus
// DefaultPackageManager.listConfiguredPackages (configured/package static
// metadata, never an install or module import).
//
// Why standalone loaders and NOT DefaultResourceLoader.reload(): the loader's
// reload() resolves configured package sources and AUTO-INSTALLS missing ones
// over the network. The standalone skill/prompt loaders have NO extension
// loading codepath at all — extensions are never imported/executed (strictly
// stronger than noExtensions:true) — and never touch the package installer.
//
// Hard read-only + trust boundary:
//  - No extension module is ever imported/executed (no extension codepath).
//  - Project-local resources are gated by trust: when the project is not
//    trusted, project-scope skills and project-scoped configured packages are
//    withheld (loadSkills tags cwd/.pi/skills as scope "project"; the package
//    manager tags settings-configured project sources as scope "project"). This
//    mirrors the SDK's project-trust gate for project-local resources.
//  - The GLOBAL catalog is a separate factory: agentDir/skills + global
//    settings.json packages only. It never invents a cwd, never reads
//    agentDir/.pi project resources, and never uses SettingsManager.create.
//  - Settings semantics preserved: package enabled state comes from the
//    configured/filtered flag in settings (enabled = !filtered); skill enabled
//    comes from the SKILL.md disableModelInvocation flag.
//  - No install/update/toggle/reload/package-manager write; no network.
//  - Per-store lazy cache (not an unsafe global cache).
//
// The canonical cwd is captured once and threaded into the project loaders +
// settings; catalog inputs never fall back to process.cwd.
import { lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  DefaultPackageManager,
  getAgentDir,
  hasTrustRequiringProjectResources,
  loadSkills,
  parseFrontmatter,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import ignore from "ignore";
import type { Skill } from "@earendil-works/pi-coding-agent";
import type {
  PluginInfo,
  SkillInfo,
  SlashCommandInfo,
} from "@fffattiger/pix-runtime-core";
import { makeRuntimeError } from "@fffattiger/pix-runtime-core";
import type { PiSdkResourceStore } from "../resources/index.js";
import { stripJsonComments } from "./models-json.js";
// Shared corruption-safe trust logic (owned by the trust domain): a
// malformed trust.json fails closed instead of throwing here.
import { readTrustDecision } from "./trust-store.js";

/** Options for the SDK-backed read-only resource store. */
export interface PiSdkResourceStoreOptions {
  /** Canonical absolute working directory; never re-read from process.cwd. */
  cwd: string;
  /** Agent config directory; defaults to the SDK agent dir. */
  agentDir?: string;
  /**
   * Effective project trust gating resource discovery. Defaults to the exact
   * SDK computation: no trust-requiring resources OR saved decision is trusted.
   */
  trusted?: boolean;
  /** Inject a SettingsManager (tests/composition). */
  settingsManager?: SettingsManager;
}

/** Options for the SDK-backed global (no-cwd) resource store. */
export interface PiSdkGlobalResourceStoreOptions {
  /** Agent config directory; defaults to the SDK agent dir. */
  agentDir?: string;
}

interface LoadedResources {
  readonly skills: readonly SkillInfo[];
  readonly commands: readonly SlashCommandInfo[];
  readonly plugins: readonly PluginInfo[];
}

function toSkillInfo(skill: Skill): SkillInfo {
  return {
    name: skill.name,
    ...(skill.description ? { description: skill.description } : {}),
    enabled: !skill.disableModelInvocation,
  };
}

function skillToCommand(skill: Pick<SkillInfo, "name" | "description">): SlashCommandInfo {
  return {
    name: `skill:${skill.name}`,
    ...(skill.description ? { description: skill.description } : {}),
    source: "skill",
  };
}

interface SkillContainmentRoot {
  /** Canonical caller-owned base (agentDir or project cwd). */
  readonly base: string;
  /** The only subtree from that base allowed to contribute skills. */
  readonly skills: string;
}

function isPathWithin(target: string, root: string): boolean {
  const fromRoot = relative(root, target);
  return (
    fromRoot === "" ||
    (!isAbsolute(fromRoot) && fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`))
  );
}

/**
 * Fail-closed containment check for SDK-discovered skills.
 *
 * The SDK intentionally follows symlinks while scanning. Pix catalog reads must
 * not project metadata from outside the injected agent/project roots, so both
 * the lexical discovery path and every resolved real path are checked. Checking
 * the root itself against its base also rejects an entire `skills` directory
 * that is a symlink outside the caller-owned directory.
 */
function isContainedSkill(
  skill: Skill,
  allowedRoots: readonly SkillContainmentRoot[],
): boolean {
  let lexicalFile: string;
  let realFile: string;
  try {
    lexicalFile = resolve(skill.filePath);
    realFile = realpathSync(skill.filePath);
  } catch {
    // A missing, unreadable, or racing skill path cannot be proven contained.
    return false;
  }

  for (const allowed of allowedRoots) {
    try {
      const lexicalBase = resolve(allowed.base);
      const lexicalSkills = resolve(allowed.skills);
      if (!isPathWithin(lexicalSkills, lexicalBase)) continue;
      if (!isPathWithin(lexicalFile, lexicalSkills)) continue;

      const realBase = realpathSync(allowed.base);
      const realSkills = realpathSync(allowed.skills);
      if (!isPathWithin(realSkills, realBase)) continue;
      if (!isPathWithin(realFile, realSkills)) continue;
      if (!isPathWithin(realFile, realBase)) continue;
      return true;
    } catch {
      // One absent/unreadable allowed root must not hide a skill contained by a
      // different allowed root (for example project-only skills with no global
      // `agentDir/skills` directory).
    }
  }
  return false;
}

/** Resolve plugin name/version from a static package.json read (no import). */
async function readPackageManifest(
  installedPath: string,
): Promise<{ name?: string; version?: string }> {
  try {
    const raw = await readFile(join(installedPath, "package.json"), "utf8");
    const manifest = JSON.parse(raw) as { name?: unknown; version?: unknown };
    return {
      ...(typeof manifest.name === "string" ? { name: manifest.name } : {}),
      ...(typeof manifest.version === "string"
        ? { version: manifest.version }
        : {}),
    };
  } catch {
    // Static metadata unavailable — omit name/version, keep the source label.
    return {};
  }
}

/**
 * Create a read-only resource store backed by the Pi SDK standalone resource
 * loaders + package manager static metadata. Discovery is lazy (on first read)
 * and cached per-store (not globally). No extension module is ever imported;
 * project-local resources are gated by trust; no install/network/write.
 */
export function createPiSdkResourceStore(
  options: PiSdkResourceStoreOptions,
): PiSdkResourceStore {
  if (!options.cwd || options.cwd.trim().length === 0) {
    throw makeRuntimeError(
      "invalid_input",
      "PiSdkResourceStore requires an explicit canonical cwd (no implicit process.cwd)",
    );
  }
  const agentDir = options.agentDir ?? getAgentDir();
  // Default effective trust shares the EXACT corruption-safe logic with the
  // trust catalog (readTrustDecision): a malformed/unreadable trust.json yields
  // a null decision => trusted=false => project resources withheld, with NO
  // throw and no raw path/content/stack leaking into the read.
  const trusted =
    options.trusted ??
    (!hasTrustRequiringProjectResources(options.cwd) ||
      readTrustDecision(agentDir, options.cwd) === true);
  let cached: LoadedResources | undefined;

  // Trust gate at the READ layer: when the project is not trusted, project
  // discovery is skipped ENTIRELY (not parsed then filtered) by rooting skill +
  // settings discovery at the trusted agent dir instead of the project cwd. The
  // project's .pi/skills and .pi/settings.json are never read or parsed, so a
  // malformed/permission-trapped/project-local resource cannot affect the
  // untrusted read. Global/user metadata (agentDir) still loads.
  const discoveryCwd = trusted ? options.cwd : agentDir;

  const settings = (): SettingsManager =>
    options.settingsManager ??
    (trusted
      ? SettingsManager.create(options.cwd, agentDir)
      : SettingsManager.create(agentDir, agentDir));

  const discover = async (): Promise<LoadedResources> => {
    if (cached) return cached;

    // Skills: filesystem metadata only; never an extension import. Project
    // discovery is skipped when untrusted (discoveryCwd === agentDir).
    const allowedSkillRoots: SkillContainmentRoot[] = [
      { base: agentDir, skills: join(agentDir, "skills") },
      ...(trusted
        ? [{ base: options.cwd, skills: join(options.cwd, ".pi", "skills") }]
        : []),
    ];
    const loadedSkills = loadSkills({
      cwd: discoveryCwd,
      agentDir,
      skillPaths: [],
      includeDefaults: true,
    }).skills.filter((skill) => isContainedSkill(skill, allowedSkillRoots));
    const skills = loadedSkills.map(toSkillInfo);

    // Commands: skill commands (skill:name). Prompt-template and extension
    // commands are residuals (the SDK does not export loadPromptTemplates from
    // its main entry, and there is no extension codepath); deferred to R1B Host
    // composition with a trust-aware package policy.
    const commands: SlashCommandInfo[] = loadedSkills.map(skillToCommand);

    // Plugins: configured/package static metadata (no module import, no
    // install). Discovery roots at the trusted dir when untrusted, so the
    // project's .pi/settings.json is never read.
    const packages = new StaticCatalogPackageManager({
      cwd: discoveryCwd,
      agentDir,
      settingsManager: settings(),
    }).listConfiguredPackages();
    const plugins = await readPlugins(
      packages.filter((pkg) => trusted || pkg.scope !== "project"),
    );

    cached = { skills, commands, plugins };
    return cached;
  };

  return {
    async listSkills(): Promise<readonly SkillInfo[]> {
      return (await discover()).skills;
    },
    async listPlugins(): Promise<readonly PluginInfo[]> {
      return (await discover()).plugins;
    },
    async listCommands(): Promise<readonly SlashCommandInfo[]> {
      return (await discover()).commands;
    },
  };
}

async function readPlugins(
  packages: ReturnType<DefaultPackageManager["listConfiguredPackages"]>,
): Promise<PluginInfo[]> {
  const plugins: PluginInfo[] = [];
  for (const pkg of packages) {
    const manifest = pkg.installedPath === undefined
      ? {}
      : await readPackageManifest(pkg.installedPath);
    plugins.push({
      name: manifest.name ?? pkg.source,
      ...(manifest.version === undefined ? {} : { version: manifest.version }),
      enabled: !pkg.filtered,
    });
  }
  return plugins;
}

/** Pure global storage: no project settings, writes, or injected merged state. */
function readGlobalSettings(agentDir: string): SettingsManager {
  const manager = SettingsManager.fromStorage({
    withLock(scope, read) {
      let current: string | undefined;
      if (scope === "global") {
        try {
          current = readFileSync(join(agentDir, "settings.json"), "utf8");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        if (current !== undefined) {
          // Validate the consumed data before SDK parsing/migration. In
          // particular, an empty file or an array is not missing settings.
          current = stripJsonComments(current.replace(/^\uFEFF/, ""));
          const parsed: unknown = JSON.parse(current);
          if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
            throw new Error("invalid global resource settings");
          }
          const packages = (parsed as { packages?: unknown }).packages;
          if (packages !== undefined && (!Array.isArray(packages) || packages.some((pkg) => {
            const source = typeof pkg === "string" ? pkg : pkg?.source;
            return typeof source !== "string" || source.trim().length === 0;
          }))) {
            throw new Error("invalid global resource packages");
          }
        }
      }
      if (read(current) !== undefined) {
        throw new Error("global resource settings storage is read-only");
      }
    },
  }, { projectTrusted: false });
  const errors = manager.drainErrors();
  if (errors.length > 0) {
    const code = (errors[0]?.error as NodeJS.ErrnoException | undefined)?.code;
    throw makeRuntimeError(
      code === undefined ? "invalid_input" : "unavailable",
      "global resource settings could not be read",
    );
  }
  return manager;
}

/** Static catalogs describe persisted npm references without running a package CLI.
 * Local/git sources retain the SDK's filesystem manifest lookup policy.
 */
class StaticCatalogPackageManager extends DefaultPackageManager {
  override getInstalledPath(source: string, scope: "user" | "project"): string | undefined {
    return source.startsWith("npm:") ? undefined : super.getInstalledPath(source, scope);
  }
}

/**
 * Own filesystem discovery so every candidate read either succeeds or reports
 * an error. The SDK supplies only pure frontmatter parsing; ignore handles its
 * native gitignore syntax, with nested patterns rooted at the skills directory.
 */
function readGlobalSkills(agentDir: string): SkillInfo[] {
  const skillsDir = join(agentDir, "skills");
  const invalid = makeRuntimeError("invalid_input", "global skills contain invalid metadata or a directory cycle");
  try {
    try {
      lstatSync(skillsDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const realBase = realpathSync(agentDir);
    const realRoot = realpathSync(skillsDir);
    if (!isPathWithin(realRoot, realBase)) return [];
    const ancestors = new Set<string>();
    const matcher = ignore();
    const skills: SkillInfo[] = [];
    const relativePath = (path: string): string => relative(skillsDir, path).split(sep).join("/");
    const contained = (path: string): boolean => {
      const real = realpathSync(path);
      return isPathWithin(real, realRoot) && isPathWithin(real, realBase);
    };
    const readSkill = (path: string, declared: boolean): void => {
      const content = readFileSync(path, "utf8");
      let frontmatter: Record<string, unknown>;
      try {
        frontmatter = parseFrontmatter(content).frontmatter;
      } catch {
        throw invalid;
      }
      const description = frontmatter.description;
      if (typeof description !== "string" || description.trim().length === 0) {
        if (declared) throw invalid;
        return;
      }
      skills.push({
        name: typeof frontmatter.name === "string" && frontmatter.name
          ? frontmatter.name : basename(dirname(path)),
        description,
        enabled: frontmatter["disable-model-invocation"] !== true,
      });
    };
    const visit = (dir: string, includeLooseFiles: boolean): void => {
      const real = realpathSync(dir);
      if (ancestors.has(real)) throw invalid;
      ancestors.add(real);
      try {
        const entries = readdirSync(dir, { withFileTypes: true });
        const prefix = relativePath(dir) ? `${relativePath(dir)}/` : "";
        for (const name of [".gitignore", ".ignore", ".fdignore"]) {
          if (!entries.some((entry) => entry.name === name)) continue;
          const path = join(dir, name);
          if (!contained(path)) continue;
          for (let pattern of readFileSync(path, "utf8").split(/\r?\n/)) {
            if (!pattern.trim() || pattern.trim().startsWith("#")) continue;
            const negated = pattern.startsWith("!");
            if (negated || pattern.startsWith("\\!")) pattern = pattern.slice(1);
            if (pattern.startsWith("/")) pattern = pattern.slice(1);
            matcher.add(`${negated ? "!" : ""}${prefix}${pattern}`);
          }
        }
        const declared = entries.find((entry) => entry.name === "SKILL.md");
        if (declared) {
          const path = join(dir, declared.name);
          if (!matcher.ignores(relativePath(path)) && contained(path) && statSync(path).isFile()) {
            readSkill(path, true);
            return;
          }
        }
        for (const entry of entries) {
          if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
          if (!entry.isDirectory() && !entry.isSymbolicLink() &&
              !(includeLooseFiles && entry.name.endsWith(".md"))) continue;
          const path = join(dir, entry.name);
          const rel = relativePath(path);
          // Exclude known ignored directories before any metadata or content
          // read, including unreadable ignored subtrees.
          if (matcher.ignores(entry.isDirectory() ? `${rel}/` : rel)) continue;
          if (!contained(path)) continue;
          const stats = statSync(path);
          if (matcher.ignores(stats.isDirectory() ? `${rel}/` : rel)) continue;
          if (stats.isDirectory()) visit(path, false);
          else if (stats.isFile() && includeLooseFiles && entry.name.endsWith(".md")) {
            readSkill(path, false);
          }
        }
      } finally {
        ancestors.delete(real);
      }
    };
    visit(skillsDir, true);
    return skills;
  } catch (error) {
    if (error === invalid) throw error;
    if ((error as NodeJS.ErrnoException).code === "ELOOP") throw invalid;
    throw makeRuntimeError("unavailable", "global skills could not be read");
  }
}

/** Agent-dir metadata only; the SDK never receives a project settings source. */
export function createPiSdkGlobalResourceStore(
  options: PiSdkGlobalResourceStoreOptions = {},
): PiSdkResourceStore {
  const agentDir = options.agentDir ?? getAgentDir();
  if (!isAbsolute(agentDir) || agentDir.includes("\0")) {
    throw makeRuntimeError("invalid_input", "global resource catalog requires an absolute agent dir");
  }
  let cached: LoadedResources | undefined;
  const discover = async (): Promise<LoadedResources> => {
    if (cached) return cached;
    const settingsManager = readGlobalSettings(agentDir);
    const skills = readGlobalSkills(agentDir);
    const packages = new StaticCatalogPackageManager({
      // SDK path anchor only: the injected storage exposes no project scope.
      cwd: agentDir,
      agentDir,
      settingsManager,
    }).listConfiguredPackages();
    cached = {
      skills,
      commands: skills.map(skillToCommand),
      plugins: await readPlugins(packages),
    };
    return cached;
  };
  return {
    async listSkills() { return (await discover()).skills; },
    async listPlugins() { return (await discover()).plugins; },
    async listCommands() { return (await discover()).commands; },
  };
}
