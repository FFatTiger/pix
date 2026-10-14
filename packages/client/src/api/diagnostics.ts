import { SendFailureReportResponseSchema, type SendFailureReport } from "@fffattiger/pix-protocol";
import type { HttpClient } from "./http-client";
import { urls } from "./urls";

/**
 * Send-failure diagnostic transport. Fire-and-forget: the caller never awaits
 * it and a failed report never changes the send outcome. Owned here so no
 * component reaches for fetch.
 */
export function createDiagnosticsApi(http: HttpClient) {
  return {
    reportSendFailure: (report: SendFailureReport) =>
      http.post(urls.diagnostics.sendFailure(), report, { schema: SendFailureReportResponseSchema }),
  };
}
export type DiagnosticsApi = ReturnType<typeof createDiagnosticsApi>;
