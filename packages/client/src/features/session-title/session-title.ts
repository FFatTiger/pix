/**
 * Session-title generation (Settings → Chat → Session Title).
 *
 * The settings (`pi-title-auto` / `pi-title-model`, see `lib/title-settings`)
 * previously had NO consumer: the toggle and model picker were dead config.
 * This module is the single client-side owner of the capability:
 *
 *  - `generate_session_title` is sent as a TYPED runtime command over the
 *    exact controller's ordinary command lane (no second transport, no raw
 *    fetch). sessiond FIFO-serializes it with renames on the per-session
 *    "rename" lane, requires a live runtime (zero-worker sessions fail
 *    closed), and publishes the revisioned §51 title overlay from the RPC
 *    result — the single source of truth for the new title.
 *  - An optional configured title model rides the additive Protocol-v2
 *    `model` field; absent = the session's current model.
 *  - Callers invalidate the sessions catalog caches on success (the overlay
 *    changed the authoritative title); failures surface as typed errors and
 *    are never swallowed into a fake success.
 */
import { createDefaultIdFactory } from "@/runtime/correlation";
import type { ExactRuntimeApi, RuntimeConnectionApi } from "@/runtime/exact-runtime";
import { getTitleAutoEnabled, getTitleModel } from "@/lib/title-settings";

const nextCommandId = createDefaultIdFactory();

/** Configured title model (`{ provider, modelId }`) or null when unset. */
export function configuredTitleModel(): { provider: string; modelId: string } | null {
  return getTitleModel();
}

/** Auto-generation is armed by the toggle alone; without a configured model
 *  the generation rides the session's current model (manual-rename policy). */
export function isAutoTitleArmed(): boolean {
  return getTitleAutoEnabled();
}

/**
 * Request title generation for the exact attached session. The ordinary
 * command lane resolves the CORRELATED result envelope
 * `{ commandId, result: RuntimeCommandOutcome }` (same unwrap contract as
 * `runTypedCommand`); the outcome must be the exact `generate_session_title`
 * success shape or this rejects — never a fallback title, never a swallowed
 * error.
 */
export async function requestSessionTitle(
  exact: Pick<ExactRuntimeApi, "sendCommand">,
  model: { provider: string; modelId: string } | null,
): Promise<string> {
  return requestTitleThroughCommand((command) => exact.sendCommand(command), model);
}

/**
 * Generate a title for an already-live session without taking the Browser's
 * semantic attachment lease. RuntimeConnection first resolves the live
 * record's exact epoch and sessiond fails closed if it stopped/rekeyed; this
 * explicit metadata action never activates an offline Worker.
 */
export async function requestLiveSessionTitle(
  connection: Pick<RuntimeConnectionApi, "sendLiveSessionCommand">,
  sessionId: string,
  model: { provider: string; modelId: string } | null,
): Promise<string> {
  return requestTitleThroughCommand(
    (command) => connection.sendLiveSessionCommand(sessionId, command),
    model,
  );
}

async function requestTitleThroughCommand(
  sendCommand: (command: Parameters<ExactRuntimeApi["sendCommand"]>[0]) => Promise<unknown>,
  model: { provider: string; modelId: string } | null,
): Promise<string> {
  const envelope: unknown = await sendCommand({
    commandId: `session-title:${nextCommandId()}`,
    type: "generate_session_title",
    ...(model === null ? {} : { model: { provider: model.provider, modelId: model.modelId } }),
  });
  const outcome = typeof envelope === "object" && envelope !== null && "result" in envelope
    ? (envelope as { result: unknown }).result
    : undefined;
  if (
    typeof outcome === "object" && outcome !== null
    && (outcome as { ok?: unknown }).ok === true
    && (outcome as { type?: unknown }).type === "generate_session_title"
    && typeof (outcome as { title?: unknown }).title === "string"
  ) {
    return (outcome as { title: string }).title;
  }
  throw new Error("session title generation returned an unexpected result");
}
