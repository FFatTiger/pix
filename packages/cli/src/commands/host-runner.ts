import {
  createHostApp,
  createNodeServer,
  exposureModeForBind,
  consoleLogger,
  createEnvGateConfigSource,
  SessiondRuntimeGateway,
  createProductionResources,
  createProductionCatalogs,
  createSessiondSessionsClient,
  InvalidAllowedRootsError,
  InvalidCatalogAgentDirError,
  PRODUCTION_MAX_UPLOAD_BYTES,
  PRODUCTION_FULL_CAPABILITIES,
  RESOURCE_DEGRADED_CAPABILITIES,
  type NodeServerHandle,
  type GateConfig,
  type GateConfigSource,
} from "@fffattiger/pix-host";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { BindOptions } from "../args.js";
import type { SessiondLocation } from "../supervise.js";
import { resolveClientDist } from "../paths.js";
import { readLocalSecret } from "../secret.js";
import { pixLog, pixErr } from "../log.js";

/**
 * Resolve the agent config directory for production catalogs (D3B-R1B).
 * Prefer `PI_CODING_AGENT_DIR` when the variable is present (including empty);
 * otherwise `~/.pi/agent`. Any explicit value must be non-empty absolute with
 * no NUL — empty/relative/NUL never fall back to home. Never reads the real
 * configuration contents.
 */
export function resolveCatalogAgentDir(env: NodeJS.ProcessEnv = process.env): string {
  // `!== undefined` means the operator set the variable (even to "").
  if (env.PI_CODING_AGENT_DIR !== undefined) {
    const fromEnv = env.PI_CODING_AGENT_DIR;
    if (typeof fromEnv !== "string" || fromEnv === "" || fromEnv.includes("\0") || !isAbsolute(fromEnv)) {
      throw new InvalidCatalogAgentDirError("PI_CODING_AGENT_DIR must be a non-empty absolute path");
    }
    return fromEnv;
  }
  return join(homedir(), ".pi", "agent");
}

/**
 * Honest production capability projection (D3A-1 + D1A-2 phase 2 + D3A Worktrees).
 *
 * The resource surface (files/git/watch/upload + read-only worktree list) is
 * mounted on the Host and stays advertised in BOTH states; `agent` (the
 * runtime) and `sessions` (read-only session history) are added only while
 * sessiond is up, since both depend on the sessiond-backed catalog/runtime.
 * `worktree` is the read-only list token (GET /v1/worktrees) and does not
 * depend on sessiond — there is no `worktree.write`. These two lists are
 * shared by the HTTP probe and the WS handshake via the single production
 * resolver, so the four capability surfaces never disagree.
 */

/** Best-effort browser launch; never fatal — `--no-open` is the safe default. */
function openBrowser(url: string): void {
  try {
    let child;
    if (process.platform === "darwin") {
      child = spawn("open", [url], { detached: true, stdio: "ignore" });
    } else if (process.platform === "win32") {
      child = spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" });
    } else {
      child = spawn("xdg-open", [url], { detached: true, stdio: "ignore" });
    }
    child.unref();
  } catch {
    pixLog(`could not open browser automatically; visit ${url}`);
  }
}

/**
 * Gate config for the boot composition. The host gate intentionally fails
 * closed for non-public APIs when no credential is configured, but a local
 * single-user boot with no password should expose the full local surface (e.g.
 * /v1/capabilities) out of the box. So an `unconfigured` local read is mapped to
 * `disabled`. LAN binds remain fail-closed: decideGateRequest forces
 * AUTH_REQUIRED_FOR_LAN for non-public paths whenever mode === "lan" and the
 * credential is not `enabled`, regardless of this mapping. Explicit `enabled`
 * (password set) and explicit `disabled` are passed through unchanged.
 */
export function createBootGateConfigSource(): GateConfigSource {
  const env = createEnvGateConfigSource();
  return {
    read(): GateConfig {
      const base = env.read();
      if (base.status === "unconfigured") {
        return { status: "disabled", source: base.source };
      }
      return base;
    },
  };
}

/** Merge the bind address with operator-configured trusted hostnames. */
export function resolveAllowedHosts(
  bindHostname: string,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const candidates = [
    bindHostname,
    env.PIX_HOSTNAME,
    ...(env.PIX_ALLOWED_HOSTS?.split(",") ?? []),
  ];
  return [...new Set(candidates.map((value) => value?.trim()).filter((value): value is string => Boolean(value)))];
}

/**
 * Boot the Hono Host bound to `options.hostname:options.port`, serving the
 * built Vite client, the sessiond-backed runtime WS gateway and the D3A-1
 * production resource surface (files/git/watch/upload + worktree safety).
 *
 * The sessiond secret is read strictly read-only ONCE at startup and bound to
 * the capability resolver, the runtime WS gateway and the worktree safety
 * adapter — a secret rotation while the Host keeps running surfaces as an auth
 * failure (degraded), never a silent re-read. The same resolver drives the HTTP
 * projection (health/capabilities/bootstrap) and the per-connection WS
 * handshake, so the four capability surfaces stay consistent.
 *
 * `PIX_ALLOWED_ROOTS` is canonicalized before listen: a bad configuration
 * (empty / non-absolute / missing / not-a-directory) prints ONE safe line and
 * exits 1 WITHOUT listening or touching the running sessiond.
 *
 * Only the Host is torn down on SIGINT/SIGTERM: the sessiond is a separate
 * (detached or pre-existing) process and must survive a Host restart.
 */
export async function runHost(
  location: SessiondLocation,
  options: BindOptions,
): Promise<number> {
  const exposureMode = exposureModeForBind(options.hostname);
  const clientDist = resolveClientDist();

  // Read the sessiond local secret strictly read-only ONCE and fail closed
  // when it is missing or unsafe: a Host that cannot authenticate to its own
  // sessiond must not silently advertise a runtime gateway. The captured secret
  // is then bound to the resolver, the WS gateway and the worktree adapter.
  let secret: string | undefined;
  try {
    secret = await readLocalSecret(location.paths.secretFile);
  } catch (error) {
    pixErr(`sessiond secret unavailable (fail closed): ${(error as Error).message}`);
    return 1;
  }
  if (secret === undefined) {
    pixErr(`sessiond secret not published yet (fail closed): ${location.paths.secretFile}`);
    return 1;
  }

  // Assemble production ResourceDeps from PIX_ALLOWED_ROOTS + the fixed
  // sessiond endpoint+secret. This canonicalizes/identity-pins roots BEFORE
  // listen: any configuration failure exits 1 with a single safe line, leaving
  // the running sessiond untouched and binding no socket.
  let production;
  try {
    production = await createProductionResources({
      allowedRootsEnv: process.env.PIX_ALLOWED_ROOTS,
      cwd: process.cwd(),
      endpoint: location.paths.endpoint,
      secret,
      logger: consoleLogger,
    });
  } catch (error) {
    pixErr(
      error instanceof InvalidAllowedRootsError
        ? error.message
        : `allowed roots configuration failed: ${(error as Error).message}`,
    );
    return 1;
  }

  // D3B-R1B: mount production read-only catalogs. agentDir is path-shape only
  // (never reads config contents). Logs never print agentDir or secrets.
  let catalogs;
  try {
    const agentDir = resolveCatalogAgentDir();
    catalogs = createProductionCatalogs({
      agentDir,
      roots: production.deps.allowedRoots,
    });
  } catch (error) {
    pixErr(
      error instanceof InvalidCatalogAgentDirError
        ? error.message
        : `catalog configuration failed: ${(error as Error).message}`,
    );
    return 1;
  }

  const runtimeWs = new SessiondRuntimeGateway({
    endpoint: location.paths.endpoint,
    secret,
    mode: exposureMode,
    // The SAME resolver drives the per-WS-handshake capability projection as
    // the HTTP probe (deps.sessiond below): up ⇒ full caps, down ⇒ degraded.
    resolveCapabilities: () => production.resolver.resolve(),
    // WS advertised upload ceiling mirrors the resource upload limit so the two
    // projections can never drift apart.
    limits: { maxUpload: PRODUCTION_MAX_UPLOAD_BYTES },
    logger: consoleLogger,
  });

  const host = createHostApp({
    exposureMode,
    clientDist,
    allowedHosts: resolveAllowedHosts(options.hostname),
    // HTTP/bootstrap projection: full when sessiond is up, degraded (resource
    // surface only) when down. `agent` + `sessions` are added only while up;
    // `worktree` (read-only list) is advertised in both states.
    sessiond: production.resolver,
    capabilities: {
      full: [...PRODUCTION_FULL_CAPABILITIES],
      readonly: [...RESOURCE_DEGRADED_CAPABILITIES],
    },
    // D3A-1 production resource services: files/git/watch/upload + worktree
    // safety (busy preflight + mutation guard wired from the shared adapter).
    resources: production.deps,
    // D3B-R1B: read-only catalogs (models/auth/skills/plugins/commands/trust).
    // Catalog capability tokens stay advertised even when sessiond is down.
    catalogs,
    // D1A-2 phase 2: read-only session history (/v1/sessions*) backed by the
    // fixed sessiond catalog. The capability token is driven by the resolver
    // above (sessions only while up); while down these routes answer 503.
    sessions: { client: createSessiondSessionsClient({ endpoint: location.paths.endpoint, secret }) },
    gate: { config: createBootGateConfigSource() },
    logger: consoleLogger,
    runtimeWs,
    // WS transport ceiling matches the advertised maxUpload so a full upload is
    // actually receivable instead of being rejected at the frame layer.
    wsMaxPayloadBytes: PRODUCTION_MAX_UPLOAD_BYTES,
  });

  const handle: NodeServerHandle = await createNodeServer(host, {
    port: options.port,
    hostname: options.hostname,
  });
  const url = `http://${options.hostname}:${handle.port}`;
  pixLog(`host listening on ${url}`);
  pixLog(`sessiond at ${location.directory} (endpoint ${location.endpoint})`);
  pixLog(`resource surface mounted (roots: ${production.deps.allowedRoots.roots().length}; capabilities up: ${JSON.stringify(PRODUCTION_FULL_CAPABILITIES)}); sessions history read-only routes mounted; catalog surface mounted; press Ctrl+C to stop the host`);

  if (options.open) openBrowser(url);

  let closing = false;
  let settleShutdown!: () => void;
  const shutdownComplete = new Promise<void>((resolve) => {
    settleShutdown = resolve;
  });
  const shutdown = async (source: NodeJS.Signals | "IPC_SHUTDOWN"): Promise<void> => {
    if (closing) return shutdownComplete;
    closing = true;
    pixLog(`${source} received — closing host (sessiond keeps running)`);
    try {
      await handle.close();
    } catch (error) {
      pixErr(`host close error: ${(error as Error).message}`);
    } finally {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      if (onMessage) process.off("message", onMessage);
      settleShutdown();
    }
  };
  const onSignal = (signal: NodeJS.Signals): void => {
    void shutdown(signal);
  };
  const onMessage = typeof process.send === "function"
    ? (message: unknown): void => {
        if (message === "pix.host.shutdown") void shutdown("IPC_SHUTDOWN");
      }
    : undefined;
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  // Cross-platform parent-process control for E2E/supervisors that explicitly
  // create a Node IPC channel. Ordinary product launches have no IPC channel,
  // so this does not add a remotely reachable shutdown surface.
  if (onMessage) process.on("message", onMessage);

  // The listening server keeps the event loop alive. Return normally after
  // teardown so the outer CLI/bin entry point remains the sole exit-code owner.
  await shutdownComplete;
  return 0;
}
