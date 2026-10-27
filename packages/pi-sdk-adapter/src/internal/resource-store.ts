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
//  - The GLOBAL catalog is a separate factory. It never invents a cwd, never
//    reads project (.pi) resources, and never uses SettingsManager.create.
//    Its skill set matches what the SDK runtime loads in the user scope:
//    configured plugin packages (installed paths only), settings.json `skills`
//    explicit paths, agentDir/skills, and ~/.agents/skills — symlink-following
//    and dedup precedence included (see readGlobalSkills). Only skill files
//    (SKILL.md and in-tree .md) under those roots are read, like the SDK.
//  - Settings semantics preserved: package enabled state comes from the
//    configured/filtered flag in settings (enabled = !filtered); skill enabled
//    comes from the SKILL.md disableModelInvocation flag; settings `skills`
//    override patterns (+/-/!) disable entries without deleting them.
//  - No install/update/toggle/reload/package-manager write; no network.
//  - Per-store lazy cache (not an unsafe global cache).
//
// The canonical cwd is captured once and threaded into the project loaders +
// settings; catalog inputs never fall back to process.cwd.
import { existsSync, globSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
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
import { resolveLoreHomeDir } from "./lore-config-store.js";
import { readMemoryRuntimeStateSync } from "./memory-provider.js";
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
  /** Home dir for ~/.agents/skills auto-discovery; defaults like the SDK (env HOME). */
  homeDir?: string;
  /** Lore state directory; defaults to LORE_HOME or ~/.lore. */
  loreHome?: string;
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

/** Bounded skill origin (mirrors SDK sources plus Lore's native work copies). */
type SkillOrigin =
  | { readonly kind: "user" }
  | { readonly kind: "settings" }
  | { readonly kind: "plugin"; readonly packageName: string }
  | { readonly kind: "lore" };

interface SkillEntry {
  readonly path: string;
  readonly origin: SkillOrigin;
  readonly enabled: boolean;
  readonly version?: string;
}

/** Directory modes for loose .md collection, mirroring the SDK collectors:
 * "pi" collects loose .md only at the collection root, "agents" only below it. */
type SkillDirMode = "pi" | "agents";

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
          const skills = (parsed as { skills?: unknown }).skills;
          if (skills !== undefined && (!Array.isArray(skills) || skills.some((entry) =>
            typeof entry !== "string" || entry.trim().length === 0))) {
            throw new Error("invalid global resource skills");
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

/** Minimal construction surface for StaticCatalogPackageManager (the SDK does
 * not export PackageManagerOptions from its main entry). */
interface StaticCatalogOptions {
  cwd: string;
  agentDir: string;
  settingsManager: SettingsManager;
}

/** Static catalogs describe persisted npm references without running a package CLI.
 * Local/git sources retain the SDK's filesystem manifest lookup policy.
 */
class StaticCatalogPackageManager extends DefaultPackageManager {
  private readonly catalogAgentDir: string;

  constructor(options: StaticCatalogOptions) {
    super(options);
    this.catalogAgentDir = options.agentDir;
  }

  override getInstalledPath(source: string, scope: "user" | "project"): string | undefined {
    // npm: never reaches super — the SDK's fallback probes the legacy global
    // npm root by executing a package-manager command. The managed install
    // dir is checked directly instead (pure existsSync, see npmManagedInstallPath).
    if (source.startsWith("npm:")) {
      return npmManagedInstallPath(this.catalogAgentDir, source);
    }
    return super.getInstalledPath(source, scope);
  }
}

/** Pure managed-install lookup for npm sources: `agentDir/npm/node_modules/<name>`.
 * Returns undefined when the package is not installed there; NEVER probes the
 * legacy global npm root (which would execute an npm command). */
function npmManagedInstallPath(agentDir: string, source: string): string | undefined {
  const spec = source.slice("npm:".length).trim();
  if (!spec) return undefined;
  let name: string;
  if (spec.startsWith("@")) {
    const at = spec.indexOf("@", 1);
    name = at === -1 ? spec : spec.slice(0, at);
  } else {
    const at = spec.indexOf("@");
    name = at === -1 ? spec : spec.slice(0, at);
  }
  if (!name || name.includes("/") && !name.startsWith("@")) return undefined;
  const path = join(agentDir, "npm", "node_modules", name);
  return existsSync(path) ? path : undefined;
}

/** Read the `pi.skills` manifest field like the SDK readPiManifest: a present
 * `pi` object means "manifest package" (no convention-dir fallback), with the
 * skills entries validated like the SDK (non-string entries drop the field).
 * Any parse failure means "no manifest". */
function readPiSkillsManifest(packageJsonPath: string): { exists: boolean; entries: string[] } | undefined {
  let raw: string;
  try {
    raw = readFileSync(packageJsonPath, "utf8").replace(/^\uFEFF/, "");
  } catch {
    return undefined;
  }
  let pkg: unknown;
  try {
    pkg = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof pkg !== "object" || pkg === null || Array.isArray(pkg)) return undefined;
  const pi = (pkg as { pi?: unknown }).pi;
  if (typeof pi !== "object" || pi === null || Array.isArray(pi)) return undefined;
  const skills = (pi as { skills?: unknown }).skills;
  if (!Array.isArray(skills) || !skills.every((entry) => typeof entry === "string")) {
    return { exists: true, entries: [] };
  }
  return { exists: true, entries: skills };
}

function isOverridePattern(entry: string): boolean {
  return entry.startsWith("!") || entry.startsWith("+") || entry.startsWith("-");
}

function hasGlobWildcard(entry: string): boolean {
  return entry.includes("*") || entry.includes("?");
}

/** Mini glob→regex for override patterns and manifest globs (no new dependency;
 * covers the realistic `*`, `**`, `?` forms the SDK passes to minimatch/glob). */
function globToRegExp(pattern: string): RegExp {
  let source = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        i++;
        if (pattern[i + 1] === "/") i++;
        source += ".*";
      } else {
        source += "[^/]*";
      }
    } else if (ch === "?") {
      source += "[^/]";
    } else {
      source += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${source}$`);
}

function matchesGlob(subject: string, pattern: string): boolean {
  return globToRegExp(pattern).test(subject);
}

const toPosix = (path: string): string => path.split(sep).join("/");

/** matchesAnyPattern equivalent: rel path, basename, or full posix path. */
function matchesAnySkillPattern(
  filePath: string,
  patterns: readonly string[],
  baseDir: string,
): boolean {
  const rel = toPosix(relative(baseDir, filePath));
  const name = basename(filePath);
  const filePathPosix = toPosix(filePath);
  return patterns.some((pattern) =>
    matchesGlob(rel, pattern) || matchesGlob(name, pattern) || matchesGlob(filePathPosix, pattern));
}

/** matchesAnyExactPattern equivalent, including the SKILL.md parent-dir
 * matching the SDK uses so `-<skill-dir-name>` disables a declared skill. */
function matchesAnyExactSkillPattern(
  filePath: string,
  patterns: readonly string[],
  baseDir: string,
): boolean {
  if (patterns.length === 0) return false;
  const rel = toPosix(relative(baseDir, filePath));
  const filePathPosix = toPosix(filePath);
  if (basename(filePath) !== "SKILL.md") {
    return patterns.some((pattern) => pattern === rel || pattern === filePathPosix);
  }
  const parentDir = dirname(filePath);
  const parentRel = toPosix(relative(baseDir, parentDir));
  const parentDirPosix = toPosix(parentDir);
  return patterns.some((pattern) =>
    pattern === rel || pattern === filePathPosix || pattern === parentRel || pattern === parentDirPosix);
}

/** applyPatterns equivalent over collected skill files. */
function applySkillOverridePatterns(
  allPaths: readonly string[],
  patterns: readonly string[],
  baseDir: string,
): Set<string> {
  const includes: string[] = [];
  const excludes: string[] = [];
  const forceIncludes: string[] = [];
  const forceExcludes: string[] = [];
  for (const pattern of patterns) {
    if (pattern.startsWith("+")) forceIncludes.push(pattern.slice(1));
    else if (pattern.startsWith("-")) forceExcludes.push(pattern.slice(1));
    else if (pattern.startsWith("!")) excludes.push(pattern.slice(1));
    else includes.push(pattern);
  }
  let result = includes.length === 0
    ? [...allPaths]
    : allPaths.filter((filePath) => matchesAnySkillPattern(filePath, includes, baseDir));
  if (excludes.length > 0) {
    result = result.filter((filePath) => !matchesAnySkillPattern(filePath, excludes, baseDir));
  }
  if (forceIncludes.length > 0) {
    for (const filePath of allPaths) {
      if (!result.includes(filePath) && matchesAnyExactSkillPattern(filePath, forceIncludes, baseDir)) {
        result.push(filePath);
      }
    }
  }
  if (forceExcludes.length > 0) {
    result = result.filter((filePath) => !matchesAnyExactSkillPattern(filePath, forceExcludes, baseDir));
  }
  return new Set(result);
}

/** isEnabledByOverrides equivalent for auto-discovered skill files. */
function isEnabledBySkillOverrides(
  filePath: string,
  patterns: readonly string[],
  baseDir: string,
): boolean {
  const overrides = patterns.filter((pattern) => isOverridePattern(pattern));
  const excludes = overrides.filter((p) => p.startsWith("!")).map((p) => p.slice(1));
  const forceIncludes = overrides.filter((p) => p.startsWith("+")).map((p) => p.slice(1));
  const forceExcludes = overrides.filter((p) => p.startsWith("-")).map((p) => p.slice(1));
  let enabled = true;
  if (excludes.length > 0 && matchesAnySkillPattern(filePath, excludes, baseDir)) enabled = false;
  if (forceIncludes.length > 0 && matchesAnyExactSkillPattern(filePath, forceIncludes, baseDir)) enabled = true;
  if (forceExcludes.length > 0 && matchesAnyExactSkillPattern(filePath, forceExcludes, baseDir)) enabled = false;
  return enabled;
}

/** resolvePathFromBase equivalent for settings skill paths: trim, `~`,
 * file:// URLs, absolute, else relative to baseDir (never process.cwd). */
function resolveSettingsSkillPath(input: string, baseDir: string, homeDir: string): string {
  const normalized = input.trim();
  if (normalized === "~") return homeDir;
  if (normalized.startsWith("~/") || normalized.startsWith("~\\")) {
    return join(homeDir, normalized.slice(2));
  }
  if (/^file:\/\//.test(normalized)) return fileURLToPath(normalized);
  return isAbsolute(normalized) ? resolve(normalized) : resolve(baseDir, normalized);
}

/**
 * Strict two-phase skill collector aligned with the SDK loaders
 * (skills.js collectSkillEntries / loadSkillsFromDirInternal):
 *  - follows symlinks (files AND directories), including links pointing
 *    outside the collection root — exactly like the runtime;
 *  - a directory containing SKILL.md is a skill root (no deeper recursion);
 *  - loose .md files per {@link SkillDirMode};
 *  - skips dot entries and node_modules, honors .gitignore/.ignore/.fdignore
 *    with patterns rooted at the collection root;
 *  - directory cycles (realpath ancestor set) fail as invalid_input.
 */
class StrictSkillCollector {
  private readonly ancestors = new Set<string>();
  constructor(private readonly invalid: unknown) {}

  /** Missing directories are a legal empty collection, like the SDK. */
  collect(dir: string, mode: SkillDirMode): string[] {
    let stats;
    try {
      stats = statSync(dir);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return [];
      if (code === "ELOOP") throw this.invalid;
      throw makeRuntimeError("unavailable", "skill directory could not be read");
    }
    if (!stats.isDirectory()) return [];
    return this.visit(dir, dir, mode, ignore());
  }

  private visit(dir: string, root: string, mode: SkillDirMode, matcher: ReturnType<typeof ignore>): string[] {
    let real: string;
    try {
      real = realpathSync(dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ELOOP") throw this.invalid;
      throw makeRuntimeError("unavailable", "skill directory could not be read");
    }
    if (this.ancestors.has(real)) throw this.invalid;
    this.ancestors.add(real);
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      const relativeToRoot = (path: string): string => toPosix(relative(root, path));
      const prefix = relativeToRoot(dir) ? `${relativeToRoot(dir)}/` : "";
      for (const name of [".gitignore", ".ignore", ".fdignore"]) {
        if (!entries.some((entry) => entry.name === name)) continue;
        const patterns = readFileSync(join(dir, name), "utf8")
          .split(/\r?\n/)
          .flatMap((line) => {
            const trimmed = line.trim();
            if (!trimmed || (trimmed.startsWith("#") && !trimmed.startsWith("\\#"))) return [];
            let pattern = line;
            let negated = false;
            if (pattern.startsWith("!")) {
              negated = true;
              pattern = pattern.slice(1);
            } else if (pattern.startsWith("\\!")) {
              pattern = pattern.slice(1);
            }
            if (pattern.startsWith("/")) pattern = pattern.slice(1);
            return [`${negated ? "!" : ""}${prefix}${pattern}`];
          });
        if (patterns.length > 0) matcher.add(patterns);
      }
      // SKILL.md at this directory marks a skill root; collect nothing deeper.
      const declared = entries.find((entry) => entry.name === "SKILL.md");
      if (declared) {
        const path = join(dir, declared.name);
        let isFile = declared.isFile();
        if (declared.isSymbolicLink()) {
          try {
            isFile = statSync(path).isFile();
          } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code === "ENOENT") isFile = false; // broken symlink: skipped like the SDK
            else if (code === "ELOOP") throw this.invalid;
            else throw makeRuntimeError("unavailable", "skill candidate could not be read");
          }
        }
        if (isFile && !matcher.ignores(relativeToRoot(path))) return [path];
      }
      const files: string[] = [];
      for (const entry of entries) {
        if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
        const path = join(dir, entry.name);
        const rel = relativeToRoot(path);
        let isDirectory = entry.isDirectory();
        let isFile = entry.isFile();
        if (entry.isSymbolicLink()) {
          try {
            const stats = statSync(path);
            isDirectory = stats.isDirectory();
            isFile = stats.isFile();
          } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code === "ENOENT") continue; // broken symlink: skipped like the SDK
            if (code === "ELOOP") throw this.invalid;
            throw makeRuntimeError("unavailable", "skill candidate could not be read");
          }
        }
        const looseFileAllowed =
          isFile && entry.name.endsWith(".md") &&
          ((mode === "pi" && dir === root) || (mode === "agents" && dir !== root));
        if (looseFileAllowed && !matcher.ignores(rel)) {
          files.push(path);
          continue;
        }
        if (!isDirectory) continue;
        if (matcher.ignores(`${rel}/`)) continue;
        files.push(...this.visit(path, root, mode, matcher));
      }
      return files;
    } finally {
      this.ancestors.delete(real);
    }
  }
}

/** collectFilesFromPaths equivalent: files pass through, directories collect. */
function collectSkillFilesFromPaths(
  paths: readonly string[],
  collector: StrictSkillCollector,
): string[] {
  const files: string[] = [];
  for (const path of paths) {
    if (!existsSync(path)) continue;
    try {
      const stats = statSync(path);
      if (stats.isFile()) files.push(path);
      else if (stats.isDirectory()) files.push(...collector.collect(path, "pi"));
    } catch {
      // Skip unreadable candidates like the SDK collector.
      continue;
    }
  }
  return files;
}

/** Package skill files per the SDK collectPackageResources rules: `pi.skills`
 * manifest entries (globs + override patterns) or the `skills/` convention
 * directory, then the package-level filter patterns from settings (regular
 * filter, or delta filter when the package is configured with autoload:false). */
function collectPackageSkillFiles(
  packageRoot: string,
  filter: { readonly skills?: readonly string[]; readonly autoload?: boolean } | undefined,
  collector: StrictSkillCollector,
): string[] {
  const manifest = readPiSkillsManifest(join(packageRoot, "package.json"));
  let files: string[];
  if (manifest !== undefined) {
    const sourceEntries = manifest.entries.filter((entry) => !isOverridePattern(entry));
    const resolved: string[] = [];
    for (const entry of sourceEntries) {
      if (hasGlobWildcard(entry)) {
        resolved.push(
          ...globSync(entry, { cwd: packageRoot })
            .map((match) => resolve(packageRoot, match))
            .filter((path) =>
              relative(packageRoot, path).split(sep).every((segment) => segment === ".." || !segment.startsWith("."))),
        );
      } else {
        resolved.push(resolve(packageRoot, entry));
      }
    }
    files = collectSkillFilesFromPaths(resolved, collector);
    const manifestPatterns = manifest.entries.filter((entry) => isOverridePattern(entry));
    if (manifestPatterns.length > 0) {
      files = [...applySkillOverridePatterns(files, manifestPatterns, packageRoot)];
    }
  } else {
    const conventionDir = join(packageRoot, "skills");
    files = existsSync(conventionDir) ? collector.collect(conventionDir, "pi") : [];
  }
  const filterPatterns = filter !== undefined && Array.isArray(filter.skills) ? filter.skills : undefined;
  if (filterPatterns !== undefined) {
    if (filter?.autoload === false) {
      // Delta filter: patterns only DISABLE; everything else stays enabled.
      const disabled = new Set<string>();
      for (const pattern of filterPatterns) {
        const target = pattern.slice(isOverridePattern(pattern) ? 1 : 0);
        const exact = pattern.startsWith("+") || pattern.startsWith("-");
        const enabled = !pattern.startsWith("-") && !pattern.startsWith("!");
        if (!enabled) {
          for (const file of files) {
            if (exact ? matchesAnyExactSkillPattern(file, [target], packageRoot) : matchesAnySkillPattern(file, [target], packageRoot)) {
              disabled.add(file);
            }
          }
        }
      }
      files = files.filter((file) => !disabled.has(file));
    } else {
      files = [...applySkillOverridePatterns(files, filterPatterns, packageRoot)];
    }
  }
  return files;
}

/** Read one skill file with the strict metadata contract: declared SKILL.md
 * must parse and carry a description (invalid_input otherwise); loose .md
 * without a description is silently skipped, like the SDK. */
function readSkillFile(
  path: string,
  invalid: unknown,
): { name: string; description: string; enabled: boolean } | undefined {
  const declared = basename(path) === "SKILL.md";
  const content = readFileSync(path, "utf8");
  let frontmatter: Record<string, unknown>;
  try {
    frontmatter = parseFrontmatter(content).frontmatter;
  } catch {
    throw invalid;
  }
  const description = frontmatter.description;
  const hasDescription = typeof description === "string" && description.trim() !== "";
  if (!hasDescription) {
    if (declared) throw invalid;
    return undefined;
  }
  return {
    name: typeof frontmatter.name === "string" && frontmatter.name
      ? frontmatter.name
      : basename(dirname(path)),
    description,
    enabled: frontmatter["disable-model-invocation"] !== true,
  };
}

const LORE_SKILL_MARKER = ".lore-skill-marker.json";
const LORE_SKILL_SCHEMA = "lore.skill.workcopy.v1";

interface LoreSkillMarker {
  readonly schema?: unknown;
  readonly project_id?: unknown;
  readonly skill_id?: unknown;
  readonly name?: unknown;
  readonly version?: unknown;
}

function isContainedLorePath(filePath: string, loreHome: string): boolean {
  const loreSkills = join(loreHome, "skills");
  try {
    const lexicalFile = resolve(filePath);
    const lexicalSkills = resolve(loreSkills);
    if (!isPathWithin(lexicalSkills, resolve(loreHome)) || !isPathWithin(lexicalFile, lexicalSkills)) return false;
    const realHome = realpathSync(loreHome);
    const realSkills = realpathSync(loreSkills);
    const realFile = realpathSync(filePath);
    return isPathWithin(realSkills, realHome) && isPathWithin(realFile, realSkills) && isPathWithin(realFile, realHome);
  } catch {
    return false;
  }
}

/** Return metadata only for a marked, contained Lore work copy. */
function readLoreSkillMarker(filePath: string, loreHome: string): { name: string; version: string } | undefined {
  if (basename(filePath) !== "SKILL.md") return undefined;
  if (!isContainedLorePath(filePath, loreHome)) return undefined;
  const markerPath = join(dirname(filePath), LORE_SKILL_MARKER);
  if (!isContainedLorePath(markerPath, loreHome)) return undefined;
  let marker: LoreSkillMarker;
  try {
    const parsed: unknown = JSON.parse(readFileSync(markerPath, "utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    marker = parsed as LoreSkillMarker;
  } catch {
    return undefined;
  }
  if (
    marker.schema !== LORE_SKILL_SCHEMA ||
    typeof marker.project_id !== "string" ||
    marker.project_id.trim() === "" ||
    typeof marker.skill_id !== "string" ||
    marker.skill_id.trim() === "" ||
    typeof marker.name !== "string" ||
    marker.name.trim() === "" ||
    (typeof marker.version !== "string" && typeof marker.version !== "number")
  ) {
    return undefined;
  }
  return { name: marker.name as string, version: String(marker.version) };
}

/**
 * Global (user-scope) skill catalog aligned with the set the SDK runtime
 * actually loads, in the SDK's precedence order:
 *  1. configured plugin packages (installed paths only, read-only);
 *  2. settings.json `skills` explicit paths (patterns included);
 *  3. `agentDir/skills` auto-discovery ("pi" mode);
 *  4. `~/.agents/skills` auto-discovery ("agents" mode).
 *  5. Lore's marked `~/.lore/skills/<project-id>/` work copies when the Lore
 *     memory provider is selected.
 * Dedup mirrors loadSkills: the same file reached twice (e.g. via the
 * `agentDir/skills` symlinks and `~/.agents/skills`) is skipped silently, and
 * for a name collision the earlier entry wins. Strictness stays pix's: cycles
 * and bad metadata fail closed as invalid_input, IO errors as unavailable.
 */
function readGlobalSkills(
  agentDir: string,
  homeDir: string,
  loreHome: string,
  settings: SettingsManager,
  packageManager: StaticCatalogPackageManager,
): SkillInfo[] {
  const invalid = makeRuntimeError("invalid_input", "global skills contain invalid metadata or a directory cycle");
  try {
    const globalSettings = settings.getGlobalSettings();
    const skillsSetting: readonly string[] = globalSettings.skills ?? [];
    const entries: SkillEntry[] = [];
    const collector = new StrictSkillCollector(invalid);

    // 1. Configured plugin packages (user scope): installed paths only.
    for (const pkg of globalSettings.packages ?? []) {
      const source = typeof pkg === "string" ? pkg : pkg.source;
      const installedPath = packageManager.getInstalledPath(source, "user");
      if (installedPath === undefined) continue;
      const filter = typeof pkg === "object"
        ? {
            ...(Array.isArray(pkg.skills) ? { skills: pkg.skills } : {}),
            ...(pkg.autoload === undefined ? {} : { autoload: pkg.autoload }),
          }
        : undefined;
      const files = collectPackageSkillFiles(installedPath, filter, collector);
      let packageName: string | undefined;
      try {
        const raw = JSON.parse(readFileSync(join(installedPath, "package.json"), "utf8").replace(/^\uFEFF/, "")) as {
          name?: unknown;
        };
        if (typeof raw.name === "string" && raw.name.trim() !== "") packageName = raw.name;
      } catch {
        // Static metadata unavailable — fall back to the configured source.
      }
      const origin: SkillOrigin = { kind: "plugin", packageName: packageName ?? source };
      for (const file of files) {
        entries.push({ path: file, origin, enabled: true });
      }
    }

    // 2. settings.json explicit skill paths (plain entries + patterns).
    const plainEntries = skillsSetting.filter((entry) => !isOverridePattern(entry));
    const overridePatterns = skillsSetting.filter((entry) => isOverridePattern(entry));
    const resolvedPlain = plainEntries.map((entry) => resolveSettingsSkillPath(entry, agentDir, homeDir));
    const settingsFiles = collectSkillFilesFromPaths(resolvedPlain, collector);
    const enabledFiles = applySkillOverridePatterns(settingsFiles, overridePatterns, agentDir);
    for (const file of settingsFiles) {
      entries.push({ path: file, origin: { kind: "settings" }, enabled: enabledFiles.has(file) });
    }

    // 3. User skills dir (~agentDir/skills, "pi" mode).
    const userSkillsDir = join(agentDir, "skills");
    for (const file of collector.collect(userSkillsDir, "pi")) {
      entries.push({ path: file, origin: { kind: "user" }, enabled: isEnabledBySkillOverrides(file, skillsSetting, agentDir) });
    }

    // 4. ~/.agents/skills auto-discovery ("agents" mode).
    const agentsSkillsDir = join(homeDir, ".agents", "skills");
    for (const file of collector.collect(agentsSkillsDir, "agents")) {
      entries.push({
        path: file,
        origin: { kind: "user" },
        enabled: isEnabledBySkillOverrides(file, skillsSetting, join(homeDir, ".agents")),
      });
    }

    // Lore's native resource directory is active only when the Lore memory
    // provider is selected. It is a managed projection, not a second user
    // skills source: only marked work copies under ~/.lore/skills are admitted.
    if (readMemoryRuntimeStateSync(agentDir).provider === "lore") {
      const loreFiles = collector.collect(join(loreHome, "skills"), "agents");
      for (const file of loreFiles) {
        const marker = readLoreSkillMarker(file, loreHome);
        if (marker === undefined) continue;
        entries.push({
          path: file,
          origin: { kind: "lore" },
          enabled: true,
          version: marker.version,
        });
      }
    }

    // Load + dedup: realpath identity silently, name first-wins (SDK order).
    const skills: SkillInfo[] = [];
    const seenNames = new Set<string>();
    const seenRealPaths = new Set<string>();
    for (const entry of entries) {
      if (!entry.enabled) continue;
      const parsed = readSkillFile(entry.path, invalid);
      if (parsed === undefined) continue;
      if (entry.origin.kind === "lore") {
        const marker = readLoreSkillMarker(entry.path, loreHome);
        if (marker === undefined || marker.name !== parsed.name) continue;
      }
      let real: string;
      try {
        real = realpathSync(entry.path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ELOOP") throw invalid;
        throw makeRuntimeError("unavailable", "global skills could not be read");
      }
      if (seenRealPaths.has(real)) continue;
      if (seenNames.has(parsed.name)) continue;
      seenNames.add(parsed.name);
      seenRealPaths.add(real);
      skills.push({
        ...parsed,
        ...(entry.version === undefined ? {} : { version: entry.version }),
        source: entry.origin,
      });
    }
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
  const homeDir = options.homeDir ?? process.env.HOME ?? homedir();
  const loreHome = options.loreHome ?? (options.homeDir === undefined ? resolveLoreHomeDir() : join(homeDir, ".lore"));
  let cached: LoadedResources | undefined;
  const discover = async (): Promise<LoadedResources> => {
    if (cached) return cached;
    const settingsManager = readGlobalSettings(agentDir);
    const packageManager = new StaticCatalogPackageManager({
      // SDK path anchor only: the injected storage exposes no project scope.
      cwd: agentDir,
      agentDir,
      settingsManager,
    });
    const skills = readGlobalSkills(agentDir, homeDir, loreHome, settingsManager, packageManager);
    const packages = packageManager.listConfiguredPackages();
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
