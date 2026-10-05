import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { BuiltInCapabilityId, BuiltInCapabilityState } from "@fffattiger/pix-runtime-core";
import { createAskQuestionnaireExtensionsOverride } from "./ask-questionnaire-bridge.js";
import { readBuiltInCapabilityConfigSync } from "./built-in-capability-store.js";

export const CURATED_PLUGIN_IDS = ["subagents", "todo", "ask_user_question"] as const;
export type CuratedPluginId = (typeof CURATED_PLUGIN_IDS)[number];

const PACKAGE_NAMES = {
  subagents: "pi-claude-subagents",
  todo: "@juicesharp/rpiv-todo",
  ask_user_question: "@juicesharp/rpiv-ask-user-question",
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

export function desiredEnabledSet(capabilities: readonly BuiltInCapabilityState[]): ReadonlySet<BuiltInCapabilityId> {
  return new Set(capabilities.filter((row) => row.enabled).map((row) => row.id));
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

function curatedIdForExtension(extension: ExtensionLike): CuratedPluginId | undefined {
  const exactPathId = curatedIdForExactPath(extension.resolvedPath ?? extension.path);
  if (exactPathId !== undefined) return exactPathId;
  if (exactKeys(extension.tools, ["Agent", "SendMessage", "TaskOutput", "TaskStop"])
    && exactKeys(extension.commands, ["agents", "pi-subagents-doctor"])) return "subagents";
  if (exactKeys(extension.tools, ["todo"]) && exactKeys(extension.commands, ["todos"])) return "todo";
  if (exactKeys(extension.tools, ["ask_user_question"]) && exactKeys(extension.commands, [])) return "ask_user_question";
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
 * Curated instances are identified either by their exact bundled path or by
 * their exact complete tool/command registration surface. Enabled features
 * keep exactly the adapter-bundled instance; disabled features keep none.
 * A separately installed copy of the same curated plugin is removed even when
 * it lives at another path, while partial overlaps and unrelated extensions
 * remain untouched. Generic errors and the shared runtime pass through; only
 * load errors tied to a disabled bundled identity are dropped.
 */
export function filterCuratedExtensions<T extends ExtensionLike, R>(
  base: LoadExtensionsLike<T, R>,
  enabled: ReadonlySet<BuiltInCapabilityId>,
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

export function createCuratedExtensionsOverride(agentDir: string) {
  const filter = <T extends ExtensionLike, R>(base: LoadExtensionsLike<T, R>): LoadExtensionsLike<T, R> => {
    const config = readBuiltInCapabilityConfigSync(agentDir);
    return filterCuratedExtensions(base, desiredEnabledSet(config.capabilities));
  };
  return createAskQuestionnaireExtensionsOverride(filter);
}

export function resourceLoaderOptionsForBuiltIns(agentDir: string) {
  return {
    additionalExtensionPaths: bundledPluginRootPaths(),
    extensionsOverride: createCuratedExtensionsOverride(agentDir),
  };
}
