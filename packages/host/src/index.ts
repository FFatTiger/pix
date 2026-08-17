/**
 * pix Hono Host Foundation (H0A) — protocol-independent.
 *
 * Owns gate, request security (Host/Origin/DNS-rebinding), static client
 * hosting, health/capabilities and the WebSocket upgrade seam. Runtime
 * protocol wiring (H0B) and resource services (H1x) are injected through
 * {@link createHostApp}'s deps; this package imports no Pi SDK, sessiond or
 * protocol code.
 */

export { createHostApp } from "./app.js";
export type { HostApp } from "./app.js";
export { createNodeServer, exposureModeForBind } from "./server.js";
export type { NodeServerHandle, NodeServerOptions } from "./server.js";
export { HttpError, apiErrorBody, isV1Path, unifiedErrorHandler } from "./errors.js";
export type { ApiErrorBody } from "./errors.js";
export { consoleLogger, silentLogger } from "./logger.js";

export { readGateConfig, createEnvGateConfigSource, createNormalizedGateConfigSource, normalizeGateConfig, defaultGateConfigPath } from "./gate/config.js";
export type { ReadGateConfigOptions } from "./gate/config.js";
export { decideGateRequest } from "./gate/decision.js";
export type { GateDecision, GateDecisionInput } from "./gate/decision.js";
export { gateMiddleware } from "./gate/middleware.js";
export { isGatePublicPath, isPublicPwaAssetPath, isPublicViteAssetPath, sanitizeNextPath, PUBLIC_PWA_ASSETS } from "./gate/paths.js";
export { createInMemoryRateLimiter } from "./gate/rate-limit.js";
export type { InMemoryRateLimiterOptions } from "./gate/rate-limit.js";
export { createInMemoryRevocationStore } from "./gate/revocation.js";
export type { InMemoryRevocationOptions } from "./gate/revocation.js";
export { registerGateRoutes } from "./gate/routes.js";
export {
  createSessionToken,
  readSessionToken,
  verifySessionToken,
  passwordsMatch,
  DEFAULT_GATE_COOKIE_NAME,
  DEFAULT_SESSION_TTL_MS,
} from "./gate/token.js";

export { securityMiddleware, isHostTrusted, isOriginAllowed, resolveHostMode, resolveForwardedRequest } from "./middleware/security.js";
export type { SecurityOptions, HostCheckResult, ForwardedRequestInfo } from "./middleware/security.js";
export { requestIdMiddleware } from "./middleware/request-id.js";
export { loggingMiddleware } from "./middleware/logging.js";

export {
  resolveCapabilities,
  createCapabilityResolver,
  defaultReadonlyCapabilities,
  defaultMountedCapabilities,
  catalogCapabilitiesFromDeps,
  normalizeCatalogCapabilities,
  normalizeSessionMutationCapabilities,
  registerHealthRoutes,
  registerBootstrapRoutes,
  resolveBootstrapGateStatus,
} from "./routes/health.js";
export type {
  SessiondState,
  ResolvedCapabilities,
  CapabilityResolver,
  BootstrapGateStatus,
} from "./routes/health.js";
export { registerFileRoutes, parseSingleRange } from "./routes/files.js";
export { registerFileIndexRoutes } from "./routes/file-index.js";
export { registerGitRoutes } from "./routes/git.js";
export { registerWorktreeRoutes } from "./routes/worktrees.js";
export {
  registerSessionRoutes,
  mapSessionCatalogError,
  mapSessionDeleteError,
  mapSessionRenameError,
  SESSIONS_MAX_LIMIT,
  SESSIONS_MAX_OFFSET,
} from "./routes/sessions.js";
export {
  registerCatalogRoutes,
  mapCatalogError,
  requireAuthorizedCwd,
  CATALOG_UNAVAILABLE_MESSAGE,
  TRUST_NOT_TRUSTED_REASON,
  projectModelInfo,
  projectDefaultModel,
  projectAuthProviderInfo,
  projectAuthProviderStatus,
  projectSkillInfo,
  projectPluginInfo,
  projectSlashCommandInfo,
  projectTrustLevel,
  projectCanReloadResources,
} from "./routes/catalogs.js";
export {
  registerThemeRoutes,
  projectThemeSetInfo,
  projectResolvedTheme,
  requireValidThemeName,
  requireValidThemeMode,
  THEME_NAME_PATTERN,
  THEME_UNAVAILABLE_MESSAGE,
  // Projection of the canonical runtime-core theme vocabulary; exported for
  // the semantic-parity contract checks in the theme route tests.
  THEME_CSS_VAR_KEYS,
  isSafeThemeCssValue,
} from "./routes/themes.js";
export { createAllowedRootService, pathContainment } from "./resources/allowed-roots.js";
export type { AllowedRootPolicy, AllowedRootService, AuthorizedPath, RootExpansionPlan, RootExpansionResult } from "./resources/allowed-roots.js";
// D3A-P0 narrow facade: Host-dir location resolver + fixed error class. Raw
// ledger internals (open/parse/serialize/lock names) are intentionally NOT
// exported from the package surface; they are reachable only inside host
// composition and by focused tests via the internal dist module.
export { resolvePixHostDir, TrustedRootsLedgerError } from "./resources/trusted-roots-ledger.js";
export type { TrustedRootsLedger, TrustedRootsReadResult } from "./resources/trusted-roots-ledger.js";
export { createProcessRunner, runChecked } from "./resources/process-runner.js";
export type { ProcessRequest, ProcessResult, ProcessRunner } from "./resources/process-runner.js";
export { createFileWatchManager } from "./resources/file-watch.js";
export type { FileWatchManager } from "./resources/file-watch.js";
export { readBoundedBody, readJsonObject } from "./resources/request-body.js";
export type { DefaultCwdFactory, ResourceDeps, ResourceLimits, WorktreeBusyPreflight } from "./resources/types.js";

export { staticAssetsMiddleware, resolveClientFile } from "./static/static-assets.js";
export type { StaticAssetsOptions } from "./static/static-assets.js";
export { spaOrJsonNotFound } from "./static/spa.js";
export type { SpaFallbackOptions } from "./static/spa.js";

export { createRuntimeWsRoute, DEFAULT_HELLO_TIMEOUT_MS } from "./ws/guard.js";
export type { WsGuardOptions } from "./ws/guard.js";

export { SessiondRuntimeGateway, mapRpcError } from "./composition/runtime-gateway.js";
export type {
  SessiondRuntimeClient,
  SessiondRuntimeGatewayOptions,
  SessiondRuntimeGatewayLimits,
  SessiondRuntimeGatewayOutboundLimits,
  SessiondRuntimeGatewayInboundLimits,
} from "./composition/runtime-gateway.js";

export {
  parseAllowedRootsEnv,
  createProductionResources,
  createProductionCapabilityResolver,
  SessiondWorktreeSafetyAdapter,
  InvalidAllowedRootsError,
  InvalidHostDirError,
  PRODUCTION_MAX_UPLOAD_BYTES,
  PRODUCTION_PING_TIMEOUT_MS,
  PRODUCTION_RESOURCE_LIMITS,
  PRODUCTION_FULL_CAPABILITIES,
  RESOURCE_DEGRADED_CAPABILITIES,
} from "./composition/production-resources.js";
export {
  createProductionCatalogs,
  validateCatalogAgentDir,
  InvalidCatalogAgentDirError,
  CATALOG_CAPABILITY_TOKENS,
} from "./composition/production-catalogs.js";
export type { ProductionCatalogsOptions } from "./composition/production-catalogs.js";
export {
  createSessiondSessionsClient,
  createSessiondSessionDeleteClient,
  createSessiondSessionRenameClient,
} from "./composition/sessions-client.js";
export type { SessiondSessionsClientOptions } from "./composition/sessions-client.js";
export type {
  ProductionResources,
  ProductionResourcesOptions,
  ProductionCapabilityResolver,
  ProductionCapabilityResolverOptions,
} from "./composition/production-resources.js";

export {
  ALL_HOST_CAPABILITIES,
  CATALOG_CAPABILITIES,
  READONLY_HOST_CAPABILITIES,
  EMPTY_HOST_CAPABILITIES,
  HOST_PROTOCOL_VERSION,
} from "./types.js";
export type {
  GateConfig,
  GateConfigSource,
  GateDeps,
  GateStatusKind,
  HostCapability,
  HostCapabilityDeps,
  HostDeps,
  HostLogger,
  HostMode,
  LoginRateLimiter,
  RuntimeWsSeam,
  SessionRevocationStore,
  SessiondProbe,
  SessionHistoryReadClient,
  SessionDeleteClient,
  SessionDeleteSeam,
  SessionRenameClient,
  SessionRenameSeam,
  CatalogDeps,
  CatalogModelsSeam,
  CatalogCredentialsSeam,
  CatalogResourcesSeam,
  CatalogTrustSeam,
  CatalogThemesSeam,
  TrustedProxyOptions,
  WsSession,
} from "./types.js";
