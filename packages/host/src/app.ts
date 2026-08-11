import { Hono } from "hono";
import { createNodeWebSocket } from "@hono/node-ws";
import type { ServerType } from "@hono/node-server";
import type { HostEnv } from "./env.js";
import { unifiedErrorHandler, HttpError } from "./errors.js";
import { requestIdMiddleware } from "./middleware/request-id.js";
import { loggingMiddleware } from "./middleware/logging.js";
import { securityMiddleware } from "./middleware/security.js";
import { gateMiddleware } from "./gate/middleware.js";
import { registerGateRoutes } from "./gate/routes.js";
import { registerHealthRoutes, registerBootstrapRoutes } from "./routes/health.js";
import { createEnvGateConfigSource, createNormalizedGateConfigSource } from "./gate/config.js";
import { createInMemoryRevocationStore } from "./gate/revocation.js";
import { staticAssetsMiddleware } from "./static/static-assets.js";
import { spaOrJsonNotFound } from "./static/spa.js";
import { createRuntimeWsRoute } from "./ws/guard.js";
import { consoleLogger } from "./logger.js";
import type { GateDeps, HostDeps, HostLogger } from "./types.js";
import { registerFileRoutes } from "./routes/files.js";
import { registerFileIndexRoutes } from "./routes/file-index.js";
import { registerGitRoutes } from "./routes/git.js";
import { registerWorktreeRoutes } from "./routes/worktrees.js";
import { createFileWatchManager } from "./resources/file-watch.js";

export interface HostApp {
  app: Hono<HostEnv>;
  /** Wire WebSocket upgrades into the Node server created by createNodeServer. */
  injectWebSocket: (server: ServerType) => void;
  /** Explicitly terminate upgraded clients during host shutdown. */
  closeWebSockets: () => Promise<void>;
  /** Trusted exposure mode used by security/gate decisions. */
  exposureMode: "local" | "lan";
}

/**
 * Middleware order (H0A spec):
 * 1. request ID / logging
 * 2. Host/Origin/DNS-rebinding protection
 * 3. gate (public PWA allowlist + auth)
 * 4. /v1/* routes
 * 5. static assets
 * 6. SPA fallback (notFound)
 * 7. error mapping (onError)
 */
export function createHostApp(deps: HostDeps = {}): HostApp {
  const app = new Hono<HostEnv>();
  const ws = createNodeWebSocket({ app });
  ws.wss.options.maxPayload = deps.wsMaxPayloadBytes ?? 1024 * 1024;
  const logger: HostLogger = deps.logger ?? consoleLogger;
  const exposureMode = deps.exposureMode ?? "local";
  const watchManager = deps.resources
    ? createFileWatchManager(deps.resources.limits?.maxWatchers ?? 32)
    : undefined;

  const revocations =
    deps.gate?.revocations ??
    createInMemoryRevocationStore(
      deps.gate?.now ? { now: deps.gate.now } : {},
    );
  const gateSource = createNormalizedGateConfigSource(
    deps.gate?.config ?? createEnvGateConfigSource(),
  );
  const gateDeps: GateDeps = {
    requireForLan: true,
    ...deps.gate,
    config: gateSource,
    revocations,
  };

  // 1. request id / logging
  app.use("*", requestIdMiddleware());
  app.use("*", loggingMiddleware(logger));

  // 2. Host/Origin/DNS-rebinding protection
  const securityOptions = {
    exposureMode,
    ...(deps.allowedHosts ? { allowedHosts: deps.allowedHosts } : {}),
    ...(deps.trustedProxy
      ? {
          trustedProxyAddresses: deps.trustedProxy.addresses,
          ...(deps.trustedProxy.maxHops !== undefined
            ? { trustedProxyMaxHops: deps.trustedProxy.maxHops }
            : {}),
          ...(deps.trustedProxy.maxHeaderBytes !== undefined
            ? { trustedProxyMaxHeaderBytes: deps.trustedProxy.maxHeaderBytes }
            : {}),
        }
      : {}),
  };
  app.use("*", securityMiddleware(securityOptions));

  // 3. gate
  app.use("*", gateMiddleware(gateDeps));

  // 4. /v1 routes
  registerGateRoutes(app, gateDeps, logger);
  registerHealthRoutes(app, deps);
  registerBootstrapRoutes(app, deps, gateDeps);
  if (deps.resources) {
    registerFileRoutes(app, { roots: deps.resources.allowedRoots, ...(deps.resources.limits ? { limits: deps.resources.limits } : {}), ...(deps.resources.defaultCwd ? { defaultCwd: deps.resources.defaultCwd } : {}), ...(deps.resources.defaultCwdFactory ? { defaultCwdFactory: deps.resources.defaultCwdFactory } : {}) });
    if (watchManager) {
      app.get("/v1/files/watch", async (c) => {
        const target = c.req.query("path");
        if (!target) throw new HttpError(400, "PATH_REQUIRED", "path query parameter is required");
        const authorized = await deps.resources!.allowedRoots.authorizeExisting(target, "file");
        return watchManager.open(authorized.canonicalPath, c.req.raw.signal);
      });
    }
    registerFileIndexRoutes(app, { roots: deps.resources.allowedRoots, ...(deps.resources.processRunner ? { runner: deps.resources.processRunner } : {}), ...(deps.resources.limits ? { limits: deps.resources.limits } : {}) });
    registerGitRoutes(app, { roots: deps.resources.allowedRoots, ...(deps.resources.processRunner ? { runner: deps.resources.processRunner } : {}), ...(deps.resources.limits ? { limits: deps.resources.limits } : {}) });
    registerWorktreeRoutes(app, { roots: deps.resources.allowedRoots, logger, ...(deps.resources.processRunner ? { runner: deps.resources.processRunner } : {}), ...(deps.resources.busyPreflight ? { busyPreflight: deps.resources.busyPreflight } : {}), ...(deps.resources.limits ? { limits: deps.resources.limits } : {}) });
  }
  const wsGuardOptions = {
    logger,
    ...(deps.runtimeWs ? { runtimeWs: deps.runtimeWs } : {}),
    ...(deps.helloTimeoutMs !== undefined
      ? { helloTimeoutMs: deps.helloTimeoutMs }
      : {}),
    ...(deps.wsHelloMaxBytes !== undefined
      ? { helloMaxBytes: deps.wsHelloMaxBytes }
      : {}),
  };
  app.get("/v1/runtime", createRuntimeWsRoute(ws.upgradeWebSocket, wsGuardOptions));

  // 5. static assets (Vite client dist)
  const staticOptions = deps.clientDist ? { clientDist: deps.clientDist } : {};
  app.use("*", staticAssetsMiddleware(staticOptions));

  // 6. SPA fallback / JSON 404
  app.notFound(spaOrJsonNotFound(staticOptions));

  // 7. unified error mapping
  app.onError(unifiedErrorHandler(logger));

  return {
    app,
    injectWebSocket: ws.injectWebSocket,
    exposureMode,
    closeWebSockets: () =>
      new Promise<void>((resolve) => {
        watchManager?.closeAll();
        for (const client of ws.wss.clients) client.terminate();
        ws.wss.close(() => resolve());
      }),
  };
}
