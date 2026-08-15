/**
 * D3B-R1B production read-only catalog composition.
 *
 * The ONE composition place that imports the four independent
 * `@fffattiger/pix-pi-sdk-adapter` subpaths (models / credentials / resources /
 * trust). Never imports the adapter root, agent, runtime-core, or any writable
 * factory. The four seams stay independent — no cross-domain mutation factory.
 *
 * Frozen policy:
 *   - `agentDir` must be a non-empty absolute path (composition validation;
 *     safe error, never reads the real config contents).
 *   - Credentials + Trust are singletons bound to agentDir.
 *   - Models are created per canonical cwd.
 *   - Resources are created per canonical cwd AFTER `trust.isTrusted(cwd)` so
 *     a trust decision cannot go stale behind a long-lived resource catalog.
 *   - Production always reuses the same {@link AllowedRootService} as
 *     resources (`roots` option).
 */
import { isAbsolute } from "node:path";
import { createPiSdkModelCatalog } from "@fffattiger/pix-pi-sdk-adapter/models";
import { createPiSdkCredentialCatalog } from "@fffattiger/pix-pi-sdk-adapter/credentials";
import { createPiSdkResourceCatalog } from "@fffattiger/pix-pi-sdk-adapter/resources";
import { createPiSdkTrustCatalog } from "@fffattiger/pix-pi-sdk-adapter/trust";
import { createPiSdkThemeCatalog } from "@fffattiger/pix-pi-sdk-adapter/themes";
import type { AllowedRootService } from "../resources/allowed-roots.js";
import type {
  CatalogCredentialsSeam,
  CatalogDeps,
  CatalogModelsSeam,
  CatalogResourcesSeam,
  CatalogThemesSeam,
  CatalogTrustSeam,
  HostCapability,
} from "../types.js";

/** Catalog capability tokens advertised when production catalogs are fully mounted. */
export const CATALOG_CAPABILITY_TOKENS: readonly HostCapability[] = [
  "models",
  "auth.providers",
  "skills",
  "plugins",
  "themes",
] as const;

/** Single safe error class for any agentDir configuration failure. */
export class InvalidCatalogAgentDirError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidCatalogAgentDirError";
  }
}

export interface ProductionCatalogsOptions {
  /**
   * Agent config directory. Must be a non-empty absolute path. Composition
   * validates the path shape only — it never reads the real configuration.
   */
  agentDir: string;
  /** Shared allowed-roots service (must be the production resources roots). */
  roots: AllowedRootService;
}

/**
 * Validate agentDir: non-empty absolute path. Does not touch the filesystem.
 * Raises {@link InvalidCatalogAgentDirError} with a single sanitized reason.
 */
export function validateCatalogAgentDir(agentDir: string): string {
  if (typeof agentDir !== "string" || agentDir === "") {
    throw new InvalidCatalogAgentDirError("catalog agentDir is required");
  }
  if (agentDir.includes("\0")) {
    throw new InvalidCatalogAgentDirError("catalog agentDir must not contain a NUL byte");
  }
  if (!isAbsolute(agentDir)) {
    throw new InvalidCatalogAgentDirError("catalog agentDir must be an absolute path");
  }
  return agentDir;
}

/**
 * Assemble production {@link CatalogDeps} from an absolute agentDir and the
 * shared allowed-roots service. Four independent seams; credentials/trust are
 * singletons; models/resources are per-canonical-cwd factories.
 */
export function createProductionCatalogs(options: ProductionCatalogsOptions): CatalogDeps {
  const agentDir = validateCatalogAgentDir(options.agentDir);
  const roots = options.roots;

  const credentialsPort = createPiSdkCredentialCatalog({ agentDir });
  const trustPort = createPiSdkTrustCatalog({ agentDir });

  const models: CatalogModelsSeam = {
    forCwd(cwd: string) {
      const catalog = createPiSdkModelCatalog({ cwd, agentDir });
      return {
        listModels: () => catalog.listModels(),
        getDefaultModel: () => catalog.getDefaultModel(),
      };
    },
  };

  const credentials: CatalogCredentialsSeam = {
    listProviders: () => credentialsPort.listProviders(),
    getProviderStatus: (providerId: string) => credentialsPort.getProviderStatus(providerId),
    isConfigured: (providerId: string) => credentialsPort.isConfigured(providerId),
  };

  const resources: CatalogResourcesSeam = {
    forCwd(cwd: string, trusted: boolean) {
      // Fresh catalog per request cwd+trusted so a trust flip is not masked by
      // a long-lived resource loader cache.
      const catalog = createPiSdkResourceCatalog({ cwd, agentDir, trusted });
      return {
        listSkills: () => catalog.listSkills(),
        listPlugins: () => catalog.listPlugins(),
        listCommands: () => catalog.listCommands(),
      };
    },
  };

  const trust: CatalogTrustSeam = {
    getProjectTrustState: (cwd: string) => trustPort.getProjectTrustState(cwd),
    isTrusted: (cwd: string) => trustPort.isTrusted(cwd),
    canReloadResources: (cwd: string) => trustPort.canReloadResources(cwd),
  };

  // D3B-R6: read-only theme catalog. Fresh catalog per canonical cwd+trust so
  // a trust flip is never masked by a long-lived store; the canonical cwd is
  // passed explicitly to every port call (no implicit process.cwd anywhere).
  // Untrusted projects contribute no project-local themes; global (agent-dir)
  // and built-in themes stay readable in both states (sessiond-independent).
  const themes: CatalogThemesSeam = {
    forCwd(cwd: string, trusted: boolean) {
      const catalog = createPiSdkThemeCatalog({ agentDir, cwd, trusted });
      return {
        listThemeSets: () => catalog.listThemeSets(cwd),
        resolveTheme: (name: string, mode: "dark" | "light") =>
          catalog.resolveTheme(name, mode, cwd),
      };
    },
  };

  return { roots, models, credentials, resources, trust, themes };
}
