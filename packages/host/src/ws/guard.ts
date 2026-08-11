import type { Context, MiddlewareHandler } from "hono";
import type { NodeWebSocket } from "@hono/node-ws";
import type { HostEnv } from "../env.js";
import type { HostLogger, RuntimeWsSeam, WsSession } from "../types.js";

export interface WsGuardOptions {
  /** H0B seam; when absent the socket is closed with 1002 after the hello. */
  runtimeWs?: RuntimeWsSeam;
  /** Hello-frame timeout in ms (default 10_000). */
  helloTimeoutMs?: number;
  /** Maximum initial hello-frame bytes (default 64 KiB). */
  helloMaxBytes?: number;
  logger?: HostLogger;
}

export const DEFAULT_HELLO_TIMEOUT_MS = 10_000;
export const DEFAULT_HELLO_MAX_BYTES = 64 * 1024;
export const CLOSE_HELLO_TIMEOUT = 1008;
export const CLOSE_NOT_WIRED = 1002;
export const CLOSE_MESSAGE_TOO_BIG = 1009;
export const CLOSE_ATTACH_FAILED = 1011;

function frameBytes(data: unknown): number {
  if (typeof data === "string") return Buffer.byteLength(data, "utf8");
  if (data instanceof ArrayBuffer) return data.byteLength;
  if (ArrayBuffer.isView(data)) return data.byteLength;
  return Buffer.byteLength(String(data), "utf8");
}

export type RuntimeWsRoute = MiddlewareHandler<HostEnv, string, { outputFormat: "ws" }>;

/**
 * Protocol-independent runtime upgrade guard. Security/gate middleware has
 * already run. A bounded hello is required before handing the socket to H0B.
 */
export function createRuntimeWsRoute(
  upgradeWebSocket: NodeWebSocket["upgradeWebSocket"],
  options: WsGuardOptions = {},
): RuntimeWsRoute {
  const helloTimeoutMs = options.helloTimeoutMs ?? DEFAULT_HELLO_TIMEOUT_MS;
  const helloMaxBytes = options.helloMaxBytes ?? DEFAULT_HELLO_MAX_BYTES;
  const runtimeWs = options.runtimeWs;
  const logger = options.logger ?? {};

  return upgradeWebSocket((c: Context<HostEnv>) => {
    let helloTimer: ReturnType<typeof setTimeout> | null = null;
    const requestId = c.get("requestId") as string | undefined;

    function attachFailed(
      ws: import("hono/ws").WSContext<import("ws").WebSocket>,
      error: unknown,
    ): void {
      logger.error?.("runtime WebSocket attach failed", {
        requestId,
        path: c.req.path,
        error: error instanceof Error ? error.message : String(error),
      });
      try {
        ws.close(CLOSE_ATTACH_FAILED, "runtime attach failed");
      } catch {
        // already closed
      }
    }

    return {
      onOpen(_evt: Event, ws: import("hono/ws").WSContext<import("ws").WebSocket>) {
        helloTimer = setTimeout(() => {
          try {
            ws.close(CLOSE_HELLO_TIMEOUT, "hello timeout");
          } catch {
            // socket already gone
          }
        }, helloTimeoutMs);
      },
      onMessage(evt: MessageEvent, ws: import("hono/ws").WSContext<import("ws").WebSocket>) {
        if (!helloTimer) return;
        clearTimeout(helloTimer);
        helloTimer = null;
        const data: unknown = (evt as { data?: unknown }).data;
        if (frameBytes(data) > helloMaxBytes) {
          ws.close(CLOSE_MESSAGE_TOO_BIG, "hello too large");
          return;
        }
        const hello = typeof data === "string" ? data : String(data);
        if (!runtimeWs) {
          try {
            ws.close(CLOSE_NOT_WIRED, "runtime protocol not wired");
          } catch {
            // already closed
          }
          return;
        }
        const session: WsSession = createWsSession(c.req.url, ws);
        try {
          Promise.resolve(runtimeWs.attach(session, hello)).catch((error: unknown) => {
            attachFailed(ws, error);
          });
        } catch (error) {
          attachFailed(ws, error);
        }
      },
      onClose() {
        if (helloTimer) {
          clearTimeout(helloTimer);
          helloTimer = null;
        }
      },
    };
  });
}

function createWsSession(
  url: string,
  ws: import("hono/ws").WSContext<import("ws").WebSocket>,
): WsSession {
  const raw = ws.raw;
  return {
    url,
    send: (data: string) => ws.send(data),
    close: (code?: number, reason?: string) => ws.close(code, reason),
    onMessage: (listener: (data: string) => void) => {
      if (!raw) return () => {};
      const handler = (data: import("ws").RawData) => {
        listener(data.toString());
      };
      raw.on("message", handler);
      return () => {
        raw.off("message", handler);
      };
    },
  };
}
