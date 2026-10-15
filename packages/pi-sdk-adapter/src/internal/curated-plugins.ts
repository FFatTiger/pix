import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { BUILTIN_CAPABILITY_REGISTRY, type BuiltInCapabilityId, type BuiltInCapabilityState } from "@fffattiger/pix-runtime-core";
import { createAskQuestionnaireExtensionsOverride } from "./ask-questionnaire-bridge.js";
import { readBuiltInCapabilityConfigSync } from "./built-in-capability-store.js";
import { dropBundledMemorySearchTools } from "./pi-memory-bridge.js";
import { readMemoryRuntimeStateSync } from "./memory-provider.js";

/**
 * Curated plugin ids. The first four are BuiltInCapability toggles
 * (pix-builtins.json), derived from the capability registry; the two memory
 * plugins are NOT independent capabilities — they are driven by the
 * settings.json memory provider selection (`pixMemoryProvider`, see
 * memory-provider.ts) and are mutually exclusive by construction.
 */
export const CURATED_PLUGIN_IDS = [
  "subagents",
  "todo",
  "ask_user_question",
  "smart_compact",
  "pi_memory",
  "lore",
] as const;
export type CuratedPluginId = (typeof CURATED_PLUGIN_IDS)[number];

export type BuiltInCuratedPluginId = Exclude<CuratedPluginId, "pi_memory" | "lore">;

/** Registry builtin capabilities that gate a curated plugin (side_chat is not a package). */
const CURATED_BUILT_IN_IDS: readonly BuiltInCuratedPluginId[] = BUILTIN_CAPABILITY_REGISTRY
  .map((entry) => entry.id)
  .filter((id): id is BuiltInCuratedPluginId => (CURATED_PLUGIN_IDS as readonly string[]).includes(id));

const PACKAGE_NAMES = {
  subagents: "pi-claude-subagents",
  todo: "@juicesharp/rpiv-todo",
  ask_user_question: "@juicesharp/rpiv-ask-user-question",
  smart_compact: "pi-smart-compact",
  pi_memory: "pi-memory",
  lore: "@local/lore-pi-extension",
} as const satisfies Record<CuratedPluginId, string>;

const requireFromHere = createRequire(import.meta.url);

export interface BundledPluginRoot {
  id: CuratedPluginId;
  packageName: string;
  root: string;
  entry: string;
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function firstManifestEntry(pkg: Record<string, unknown>): string | undefined {
  const pi = pkg.pi;
  if (pi === null || typeof pi !== "object" || Array.isArray(pi)) return undefined;
  const extensions = (pi as { extensions?: unknown }).extensions;
  return Array.isArray(extensions) && typeof extensions[0] === "string" ? extensions[0] : undefined;
}

function findManifestPath(packageName: string): string {
  try {
    return requireFromHere.resolve(`${packageName}/package.json`);
  } catch {
    let dir = fileURLToPath(new URL(".", import.meta.url));
    while (true) {
      const candidate = join(dir, "node_modules", ...packageName.split("/"), "package.json");
      if (existsSync(candidate)) return candidate;
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    throw new Error(`bundled plugin is missing: ${packageName}`);
  }
}

function resolveBundledRoot(id: CuratedPluginId): BundledPluginRoot {
  const packageName = PACKAGE_NAMES[id];
  const manifestPath = findManifestPath(packageName);
  const root = dirname(manifestPath);
  const pkg = readJson(manifestPath) ?? {};
  const declared = firstManifestEntry(pkg) ?? "./index.ts";
  return { id, packageName, root, entry: resolve(root, declared) };
}

let cachedRoots: readonly BundledPluginRoot[] | undefined;

/** Exact bundled package roots/entries from this adapter's node_modules. */
export function bundledPluginRoots(): readonly BundledPluginRoot[] {
  cachedRoots ??= CURATED_PLUGIN_IDS.map(resolveBundledRoot);
  return cachedRoots;
}

export function bundledPluginRootPaths(): string[] {
  return bundledPluginRoots().map((item) => item.root);
}

export function desiredEnabledSet(capabilities: readonly BuiltInCapabilityState[]): ReadonlySet<BuiltInCuratedPluginId> {
  const enabled = new Set<BuiltInCapabilityId>(capabilities.filter((row) => row.enabled).map((row) => row.id));
  return new Set(CURATED_BUILT_IN_IDS.filter((id) => enabled.has(id)));
}

/**
 * Memory plugins enabled for a provider: exactly the matching one, never
 * both. Startup-time mutual-exclusion assertion: a future bug that tries to
 * enable both memory backends at once fails here, loudly, instead of
 * splitting the user's memory across two stores.
 */
export function memoryEnabledPlugins(provider: "local" | "lore" | "off"): ReadonlySet<"pi_memory" | "lore"> {
  const enabled = new Set<"pi_memory" | "lore">();
  if (provider === "local") enabled.add("pi_memory");
  if (provider === "lore") enabled.add("lore");
  if (enabled.has("pi_memory") && enabled.has("lore")) {
    throw new Error("memory plugins are mutually exclusive: pi-memory and lore must never load together");
  }
  return enabled;
}

export function isExactBundledPath(value: string, root: BundledPluginRoot): boolean {
  const resolved = resolve(value);
  return resolved === root.root || resolved === root.entry;
}

function curatedIdForExactPath(value: string): CuratedPluginId | undefined {
  const resolved = resolve(value);
  for (const root of bundledPluginRoots()) {
    if (resolved === root.root || resolved === root.entry) return root.id;
  }
  return undefined;
}

const NODE_MODULES_PATTERN = /(?:^|[\\/])node_modules[\\/]/;

/**
 * Curated identity by INSTALL PATH: any extension living under a
 * `node_modules/<curated package name>/` tree is that curated plugin — this is
 * how the user's separately installed copy (for example the global
 * `npm:pi-smart-compact` in their own settings.json `packages`) is recognized
 * even though its path differs from the adapter-bundled root. Both POSIX and
 * Windows separators are recognized (`resolve()` emits backslashes on win32).
 * Forks or renamed copies under a different package name never match.
 */
function curatedIdForPackagePath(value: string): CuratedPluginId | undefined {
  const resolved = resolve(value);
  if (!NODE_MODULES_PATTERN.test(resolved)) return undefined;
  for (const root of bundledPluginRoots()) {
    const innerPosix = `node_modules/${root.packageName}/`;
    const innerWin = `node_modules\\${root.packageName}\\`;
    if (resolved.includes(innerPosix) || resolved.includes(innerWin)) return root.id;
  }
  return undefined;
}

export interface ExtensionLike {
  path: string;
  resolvedPath?: string;
  tools?: ReadonlyMap<string, unknown>;
  commands?: ReadonlyMap<string, unknown>;
}

function exactKeys(value: ReadonlyMap<string, unknown> | undefined, expected: readonly string[]): boolean {
  if (value === undefined || value.size !== expected.length) return false;
  return expected.every((name) => value.has(name));
}

/** Tool families the two memory plugins register (pinned pi-memory 0.4.2 / lore 1.5.0). */
const PI_MEMORY_TOOL_FAMILY = /^memory_(?:write|read|forget|restore|search|status)$|^scratchpad$/;
const LORE_TOOL_FAMILY = /^lore_(?:status|boot|get_node|search|list_domains|create_node|update_node|delete_node|move_node|skill_[a-z]+)$/;

/**
 * Tool names the memory capability contributes for the chosen provider among
 * the currently selectable names — the memory capability's registry tools
 * vary by provider, so its contribution is resolved from the plugin families
 * instead of a static registry list.
 */
export function memoryCapabilityToolNames(
  provider: "local" | "lore" | "off",
  selectable: Iterable<string>,
): string[] {
  const family = provider === "local" ? PI_MEMORY_TOOL_FAMILY : provider === "lore" ? LORE_TOOL_FAMILY : null;
  if (family === null) return [];
  const names: string[] = [];
  for (const name of selectable) {
    if (family.test(name)) names.push(name);
  }
  return names;
}

function familySurface(
  extension: ExtensionLike,
  required: readonly string[],
  family: RegExp,
): boolean {
  if (extension.commands !== undefined && extension.commands.size > 0) return false;
  const tools = extension.tools;
  if (tools === undefined) return false;
  for (const name of required) {
    if (!tools.has(name)) return false;
  }
  for (const name of tools.keys()) {
    if (!family.test(name)) return false;
  }
  return true;
}

function curatedIdForExtension(extension: ExtensionLike): CuratedPluginId | undefined {
  const exactPathId = curatedIdForExactPath(extension.resolvedPath ?? extension.path);
  if (exactPathId !== undefined) return exactPathId;
  const packagePathId = curatedIdForPackagePath(extension.resolvedPath ?? extension.path);
  if (packagePathId !== undefined) return packagePathId;
  if (exactKeys(extension.tools, ["Agent", "SendMessage", "TaskOutput", "TaskStop"])
    && exactKeys(extension.commands, ["agents", "pi-subagents-doctor"])) return "subagents";
  if (exactKeys(extension.tools, ["todo"]) && exactKeys(extension.commands, ["todos"])) return "todo";
  if (exactKeys(extension.tools, ["ask_user_question"]) && exactKeys(extension.commands, [])) return "ask_user_question";
  if (exactKeys(extension.tools, ["smart_compact", "smart_recall", "smart_save_memory", "smart_context", "smart_navigation", "smart_tools"])
    && exactKeys(extension.commands, ["smart-compact"])) return "smart_compact";
  // Memory plugins are recognized by a family surface instead of an exact
  // registration list: their tool set legitimately varies with configuration
  // (Lore's skill tools are conditional), so a user-installed copy must match
  // even when it registers more or fewer tools than the bundled one. Every
  // registered name must still belong to the plugin's own family, so partial
  // overlaps and unrelated extensions never match.
  if (familySurface(extension, ["memory_read", "memory_write", "memory_status"], PI_MEMORY_TOOL_FAMILY)) return "pi_memory";
  if (familySurface(extension, ["lore_search", "lore_get_node", "lore_boot"], LORE_TOOL_FAMILY)) return "lore";
  return undefined;
}

export interface LoadExtensionsLike<T extends ExtensionLike, R = unknown> {
  extensions: T[];
  errors: Array<{ path: string; error: string }>;
  runtime: R;
}

/**
 * Curated-instance filter, by EXACT curated identity only.
 *
 * Curated instances are identified by their exact bundled path, by any
 * install path under the curated package name (the user's own global copy),
 * or by their registration surface (exact tool/command set; family surface
 * for the two memory plugins, whose tool set varies with configuration).
 * Enabled features keep exactly the adapter-bundled instance; disabled
 * features keep none. A separately installed copy of the same curated
 * plugin is removed even when it lives at another path (e.g. the user's
 * `~/.lore/pi` symlink under `~/.pi/agent/extensions/lore` — kept in the pi
 * CLI, excluded from Pix sessions), while partial overlaps and unrelated
 * extensions remain untouched. Generic errors and the shared runtime pass
 * through; only load errors tied to a disabled bundled identity are dropped.
 */
export function filterCuratedExtensions<T extends ExtensionLike, R>(
  base: LoadExtensionsLike<T, R>,
  enabled: ReadonlySet<CuratedPluginId>,
): LoadExtensionsLike<T, R> {
  const seen = new Set<CuratedPluginId>();
  const roots = new Map(bundledPluginRoots().map((root) => [root.id, root]));
  const extensions = base.extensions.filter((extension) => {
    const id = curatedIdForExtension(extension);
    if (id === undefined) return true;
    if (!enabled.has(id)) return false;
    const root = roots.get(id)!;
    if (!isExactBundledPath(extension.resolvedPath ?? extension.path, root)) return false;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  const errors = base.errors.filter((row) => {
    const id = curatedIdForExactPath(row.path);
    return id === undefined || enabled.has(id);
  });
  return { extensions, errors, runtime: base.runtime };
}

export function createCuratedExtensionsOverride(agentDir: string, env: NodeJS.ProcessEnv = process.env) {
  const filter = <T extends ExtensionLike, R>(base: LoadExtensionsLike<T, R>): LoadExtensionsLike<T, R> => {
    const config = readBuiltInCapabilityConfigSync(agentDir);
    const memory = readMemoryRuntimeStateSync(agentDir, env);
    const enabled = new Set<CuratedPluginId>([
      ...desiredEnabledSet(config.capabilities),
      ...memoryEnabledPlugins(memory.provider),
    ]);
    return dropBundledMemorySearchTools(filterCuratedExtensions(base, enabled));
  };
  return createAskQuestionnaireExtensionsOverride(filter);
}

export function resourceLoaderOptionsForBuiltIns(agentDir: string) {
  return {
    additionalExtensionPaths: bundledPluginRootPaths(),
    extensionsOverride: createCuratedExtensionsOverride(agentDir),
  };
}
