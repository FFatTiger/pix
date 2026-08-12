// Read-only resource catalog store backed by the Pi SDK standalone resource
// loaders + package manager static metadata.
//
// This is the ONLY module in the resources domain that touches the Pi SDK. It
// performs pure metadata discovery only — loadSkills / loadPromptTemplates
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
//  - Settings semantics preserved: package enabled state comes from the
//    configured/filtered flag in settings (enabled = !filtered); skill enabled
//    comes from the SKILL.md disableModelInvocation flag.
//  - No install/update/toggle/reload/package-manager write; no network.
//  - Per-store lazy cache (not an unsafe global cache).
//
// The canonical cwd is captured once and threaded into the loaders + settings;
// no method re-reads process.cwd.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  DefaultPackageManager,
  getAgentDir,
  hasTrustRequiringProjectResources,
  loadSkills,
  ProjectTrustStore,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { Skill } from "@earendil-works/pi-coding-agent";
import type {
  PluginInfo,
  SkillInfo,
  SlashCommandInfo,
} from "@fffattiger/pix-runtime-core";
import { makeRuntimeError } from "@fffattiger/pix-runtime-core";
import type { PiSdkResourceStore } from "../resources/index.js";

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

function skillToCommand(skill: Skill): SlashCommandInfo {
  return {
    name: `skill:${skill.name}`,
    ...(skill.description ? { description: skill.description } : {}),
    source: "skill",
  };
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
  const trusted =
    options.trusted ??
    (!hasTrustRequiringProjectResources(options.cwd) ||
      new ProjectTrustStore(agentDir).get(options.cwd) === true);
  let cached: LoadedResources | undefined;

  const settings = (): SettingsManager =>
    options.settingsManager ?? SettingsManager.create(options.cwd, agentDir);

  /** Keep only resources allowed under the current trust state. */
  const allowScope = (scope: string): boolean =>
    trusted || scope !== "project";

  const discover = async (): Promise<LoadedResources> => {
    if (cached) return cached;

    // Skills: filesystem metadata only; never an extension import.
    const loadedSkills = loadSkills({
      cwd: options.cwd,
      agentDir,
      skillPaths: [],
      includeDefaults: true,
    }).skills.filter((skill) => allowScope(skill.sourceInfo.scope));
    const skills = loadedSkills.map(toSkillInfo);

    // Commands: skill commands (skill:name). Prompt-template and extension
    // commands are residuals (the SDK does not export loadPromptTemplates from
    // its main entry, and there is no extension codepath); deferred to R1B Host
    // composition with a trust-aware package policy.
    const commands: SlashCommandInfo[] = loadedSkills.map(skillToCommand);

    // Plugins: configured/package static metadata (no module import, no
    // install). Project-scoped configured packages are trust-gated.
    const packages = new DefaultPackageManager({
      cwd: options.cwd,
      agentDir,
      settingsManager: settings(),
    }).listConfiguredPackages();
    const plugins: PluginInfo[] = [];
    for (const pkg of packages) {
      if (!allowScope(pkg.scope)) continue;
      const manifest =
        pkg.installedPath === undefined
          ? {}
          : await readPackageManifest(pkg.installedPath);
      plugins.push({
        name: manifest.name ?? pkg.source,
        ...(manifest.version === undefined ? {} : { version: manifest.version }),
        enabled: !pkg.filtered,
      });
    }

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
