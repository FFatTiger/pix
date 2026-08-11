import {
  createHostApp,
  createNodeServer,
  exposureModeForBind,
  consoleLogger,
  EMPTY_HOST_CAPABILITIES,
  createEnvGateConfigSource,
  type NodeServerHandle,
  type GateConfig,
  type GateConfigSource,
} from "@fffattiger/pix-host";
import { spawn } from "node:child_process";
import type { BindOptions } from "../args.js";
import type { SessiondLocation } from "../supervise.js";
import { createSessiondProbe } from "../probe.js";
import { resolveClientDist } from "../paths.js";
import { pixLog, pixErr } from "../log.js";

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

/**
 * Boot the Hono Host bound to `options.hostname:options.port`, serving the
 * built Vite client and a real sessiond capability probe. Capabilities are
 * honestly empty for M1 (no agent/files/resources wired), so the host never
 * advertises a capability it has not mounted.
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

  const host = createHostApp({
    exposureMode,
    clientDist,
    allowedHosts: [options.hostname],
    capabilities: { full: EMPTY_HOST_CAPABILITIES, readonly: EMPTY_HOST_CAPABILITIES },
    sessiond: createSessiondProbe(location.paths),
    gate: { config: createBootGateConfigSource() },
    logger: consoleLogger,
  });

  const handle: NodeServerHandle = await createNodeServer(host, {
    port: options.port,
    hostname: options.hostname,
  });
  const url = `http://${options.hostname}:${handle.port}`;
  pixLog(`host listening on ${url}`);
  pixLog(`sessiond at ${location.directory} (endpoint ${location.endpoint})`);
  pixLog(`capabilities: [] (M1 boot composition) — press Ctrl+C to stop the host`);

  if (options.open) openBrowser(url);

  let closing = false;
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (closing) return;
    closing = true;
    pixLog(`${signal} received — closing host (sessiond keeps running)`);
    try {
      await handle.close();
    } catch (error) {
      pixErr(`host close error: ${(error as Error).message}`);
    }
    process.exit(0);
  };
  process.on("SIGINT", (signal) => void shutdown(signal));
  process.on("SIGTERM", (signal) => void shutdown(signal));

  // The listening server keeps the event loop alive; block until a signal.
  await new Promise<void>(() => {});
  return 0;
}
