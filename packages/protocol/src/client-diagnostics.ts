import { z } from "zod";
import { ProtocolErrorCodeSchema } from "./common.js";

/**
 * Client send-failure diagnostic (POST /v1/diagnostics/send-failure).
 *
 * Reported by the runtime send owner, never by a component. Carries the
 * structured error and the connection state at the moment of the failure or
 * its one-shot recovery — never the prompt, images, or any credential.
 * `message` is the ProtocolError message, capped so a log line stays one line.
 */

export const SendFailureDiagnosticKindSchema = z.enum([
  "send_failure",
  "send_recovered",
  "send_recovery_failed",
  /**
   * The shared runtime reducer refused an inbound event. A rejected event must
   * never be retried by a reconnect (replaying it would throw again), so this
   * single report is the only signal that the controller refused authority
   * input. Additive value: an older Host rejects it with 400 and the client's
   * fire-and-forget report is dropped, which changes no behavior.
   */
  "event_apply_failure",
]);
export type SendFailureDiagnosticKind = z.infer<typeof SendFailureDiagnosticKindSchema>;

export const SendFailureReportSchema = z.strictObject({
  kind: SendFailureDiagnosticKindSchema,
  code: ProtocolErrorCodeSchema,
  phase: z.enum(["activation", "dispatch"]),
  message: z.string().max(200),
  retryable: z.boolean(),
  connectionState: z.string().max(40),
  epoch: z.string().max(200).nullable(),
  sessionKind: z.enum(["assistant", "session"]),
  sessionId: z.string().min(1).max(200),
});
export type SendFailureReport = z.infer<typeof SendFailureReportSchema>;

export const SendFailureReportResponseSchema = z.strictObject({
  ok: z.literal(true),
});
export type SendFailureReportResponse = z.infer<typeof SendFailureReportResponseSchema>;
