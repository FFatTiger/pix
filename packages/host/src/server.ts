import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import type { HostApp } from "./app.js";

export interface NodeServerOptions {
  /** Port; 0 selects an ephemeral port. */
  port: number;
  /** Bind address (default 127.0.0.1). */
  hostname?: string;
  /** Header timeout in ms (default 10s). */
  headersTimeoutMs?: number;
  /** Request timeout in ms (default 30s). */
  requestTimeoutMs?: number;
}

export interface NodeServerHandle {
  /** Underlying node http server (for injection/close). */
  server: ReturnType<typeof serve>;
  /** Actual bound port (resolves ephemeral ports). */
  port: number;
  close(): Promise<void>;
}

export function exposureModeForBind(hostname: string): "local" | "lan" {
  const normalized = hostname.toLowerCase();
  if (normalized === "localhost" || normalized === "::1") return "local";
  if (normalized.startsWith("127.")) return "local";
  return "lan";
}

/** Start the Hono app on a Node http server and wire WebSocket upgrades.
 *  Resolves once the server is actually listening (port is final). */
export async function createNodeServer(
  host: HostApp,
  options: NodeServerOptions,
): Promise<NodeServerHandle> {
  const hostname = options.hostname ?? "127.0.0.1";
  const expectedMode = exposureModeForBind(hostname);
  if (host.exposureMode !== expectedMode) {
    throw new Error(
      `Host exposureMode ${host.exposureMode} does not match bind ${hostname} (${expectedMode}); ` +
        "pass exposureMode to createHostApp from the trusted composition root",
    );
  }
  const server = serve({
    fetch: host.app.fetch,
    port: options.port,
    hostname,
  });
  const timedServer = server as typeof server & {
    headersTimeout?: number;
    requestTimeout?: number;
  };
  if ("headersTimeout" in timedServer) timedServer.headersTimeout = options.headersTimeoutMs ?? 10_000;
  if ("requestTimeout" in timedServer) timedServer.requestTimeout = options.requestTimeoutMs ?? 30_000;
  host.injectWebSocket(server);

  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });

  const address = server.address();
  const port =
    typeof address === "object" && address !== null
      ? (address as AddressInfo).port
      : options.port;

  return {
    server,
    port,
    close: async () => {
      await host.closeWebSockets();
      await new Promise<void>((resolve, reject) => {
        (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
        server.close((error?: Error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
