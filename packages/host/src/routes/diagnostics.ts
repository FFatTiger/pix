import type { Hono } from "hono";
import { SendFailureReportSchema } from "@fffattiger/pix-protocol";
import type { HostEnv } from "../env.js";
import { HttpError } from "../errors.js";
import { readJsonObject } from "../resources/request-body.js";
import type { HostLogger } from "../types.js";

const REPORT_BODY_LIMIT = 4 * 1024;
/** One address may report this many times per window. A stuck client cannot fill the log. */
const REPORTS_PER_WINDOW = 30;
const WINDOW_MS = 60_000;
const MAX_KEYS = 1_000;

/**
 * Per-address sliding window. In-memory: a Host restart clears it, which is
 * the right scope for a diagnostic that only exists to explain a live failure.
 */
export function createReportWindow(now: () => number = Date.now) {
  const buckets = new Map<string, number[]>();
  return {
    /** True when this report is within the budget (and records it). */
    allow(key: string): boolean {
      const t = now();
      const recent = (buckets.get(key) ?? []).filter((at) => t - at < WINDOW_MS);
      if (recent.length >= REPORTS_PER_WINDOW) {
        buckets.set(key, recent);
        return false;
      }
      recent.push(t);
      buckets.delete(key);
      buckets.set(key, recent);
      while (buckets.size > MAX_KEYS) {
        const oldest = buckets.keys().next().value as string | undefined;
        if (!oldest) break;
        buckets.delete(oldest);
      }
      return true;
    },
  };
}

/**
 * POST /v1/diagnostics/send-failure — one structured log line per client send
 * failure and per silent recovery. Registered after the gate, so it inherits
 * auth; it is not on the public allowlist.
 */
export function registerDiagnosticsRoutes(app: Hono<HostEnv>, logger: HostLogger, now?: () => number): void {
  const window = createReportWindow(now);
  app.post("/v1/diagnostics/send-failure", async (c) => {
    if (new URL(c.req.url).search !== "") {
      throw new HttpError(400, "INVALID_QUERY", "This endpoint does not accept query parameters");
    }
    const key = c.get("clientAddress") || "unknown";
    if (!window.allow(key)) throw new HttpError(429, "RATE_LIMITED", "Too many diagnostic reports");
    const input = SendFailureReportSchema.safeParse(await readJsonObject(c, REPORT_BODY_LIMIT));
    if (!input.success) throw new HttpError(400, "INVALID_INPUT", "Invalid diagnostic report");
    const report = input.data;
    logger.warn?.("client send failure", {
      requestId: c.get("requestId"),
      kind: report.kind,
      code: report.code,
      phase: report.phase,
      message: report.message,
      retryable: report.retryable,
      connectionState: report.connectionState,
      epoch: report.epoch,
      sessionKind: report.sessionKind,
      sessionId: report.sessionId,
    });
    return c.json({ ok: true as const });
  });
}
