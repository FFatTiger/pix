// Public resources surface of the pix Pi SDK Adapter (D3B-R1A).
//
// Read-only ResourceCatalogPort backed by the Pi SDK standalone resource
// loaders + package manager static metadata. This module satisfies
// runtime-core ResourceCatalogPort WITHOUT importing the Pi SDK: the SDK-coupled
// store lives in src/internal/resource-store.ts. It returns canonical
// skill/plugin/command metadata only; no extension module is ever
// imported/executed (the standalone loaders have no extension codepath —
// strictly stronger than noExtensions:true), project-local resources are gated
// by trust, and there is no install/update/toggle/reload/write. No network, no
// Worker/Agent.
import type {
  PluginInfo,
  ResourceCatalogPort,
  SkillInfo,
  SlashCommandInfo,
} from "@fffattiger/pix-runtime-core";
import { createPiSdkResourceStore } from "../internal/resource-store.js";

/**
 * Injectable read-only resource store contract. The default implementation
 * (created by the internal store factory) discovers skill/plugin/command
 * metadata from a no-extension Pi SDK resource loader; tests and composition may
 * supply their own to exercise the catalog in isolation. Every method is a pure
 * read-only metadata read; no extension execution, no write.
 */
export interface PiSdkResourceStore {
  listSkills(): Promise<readonly SkillInfo[]>;
  listPlugins(): Promise<readonly PluginInfo[]>;
  listCommands(): Promise<readonly SlashCommandInfo[]>;
}

/** Options for the default SDK-backed store (ignored when a store is injected). */
export interface PiSdkResourceCatalogOptions {
  /**
   * Canonical absolute working directory. REQUIRED — project-scoped resource
   * discovery never falls back to an implicit working directory; the caller
   * supplies the canonical cwd.
   */
  readonly cwd: string;
  /** Agent config directory; defaults to the SDK agent dir. */
  readonly agentDir?: string;
  /** Effective project trust gating resource discovery. */
  readonly trusted?: boolean;
}

class PiSdkResourceCatalog implements ResourceCatalogPort {
  constructor(private readonly store: PiSdkResourceStore) {}

  listSkills(): Promise<readonly SkillInfo[]> {
    return this.store.listSkills();
  }

  listPlugins(): Promise<readonly PluginInfo[]> {
    return this.store.listPlugins();
  }

  listCommands(): Promise<readonly SlashCommandInfo[]> {
    return this.store.listCommands();
  }
}

function isResourceStore(value: unknown): value is PiSdkResourceStore {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { listSkills?: unknown }).listSkills === "function"
  );
}

/**
 * Create a read-only ResourceCatalogPort backed by the Pi SDK standalone
 * resource loaders + package manager static metadata. The canonical cwd is
 * REQUIRED (project-scoped discovery never falls back to an implicit working
 * directory): pass an explicit {@link PiSdkResourceCatalogOptions} with
 * cwd/agentDir/trusted, or inject a {@link PiSdkResourceStore} for
 * tests/composition. Reads are metadata discovery only — no extension
 * execution, no write, no network, zero Workers/Agents.
 */
export function createPiSdkResourceCatalog(
  options: PiSdkResourceStore | PiSdkResourceCatalogOptions,
): ResourceCatalogPort {
  const store = isResourceStore(options)
    ? options
    : createPiSdkResourceStore({
        cwd: options.cwd,
        ...(options.agentDir === undefined ? {} : { agentDir: options.agentDir }),
        ...(options.trusted === undefined ? {} : { trusted: options.trusted }),
      });
  return new PiSdkResourceCatalog(store);
}
