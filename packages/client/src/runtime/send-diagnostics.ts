import type { SendFailureReport } from "@fffattiger/pix-protocol";
import { createDiagnosticsApi } from "@/api/diagnostics";
import type { HttpClient } from "@/api/http-client";

/**
 * Send-failure diagnostic sink for the runtime owner.
 *
 * HttpClientProvider registers the client; the runtime calls
 * {@link reportSendFailure} and never waits. A missing client (tests, a
 * runtime constructed outside the provider) or a failed POST is silent —
 * diagnostics must not change whether the message was sent.
 */
let currentHttpClient: () => HttpClient | null = () => null;

export function registerDiagnosticsHttpClient(get: () => HttpClient | null): void {
  currentHttpClient = get;
}

export function reportSendFailure(report: SendFailureReport): void {
  const http = currentHttpClient();
  if (!http) return;
  void createDiagnosticsApi(http).reportSendFailure(report).catch(() => {});
}
