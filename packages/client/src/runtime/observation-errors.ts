/**
 * Runtime observation error copy owner (LC-02).
 *
 * Auto/foreground observation failures — a missing negotiated
 * `runtime.observe-existing.v1` feature or a failed observation-only attach —
 * are surfaced through THIS centralized helper with fixed i18n keys, never as
 * raw backend messages and never via a silent `.catch`. Code-first copy: the
 * structured ProtocolError code selects the message; no interpolation of
 * backend text, paths or ids.
 */
import type { ProtocolError } from "@fffattiger/pix-protocol";

export const RUNTIME_OBSERVATION_MESSAGE_KEYS = {
  /** The Host did not negotiate the observation-only attach feature. */
  unavailable: "desktop.observation.unavailable",
  /** An observation attempt failed (unavailable runtime, transport, timeout). */
  failed: "desktop.observation.failed",
} as const;

export type RuntimeObservationMessageKind = keyof typeof RUNTIME_OBSERVATION_MESSAGE_KEYS;

const ENGLISH_COPY: Readonly<Record<string, string>> = {
  [RUNTIME_OBSERVATION_MESSAGE_KEYS.unavailable]:
    "This server cannot show a live view of running sessions. History stays available; sending still works.",
  [RUNTIME_OBSERVATION_MESSAGE_KEYS.failed]:
    "Couldn't open the live view for this session. It keeps running in the background.",
};

/** Code-first message kind. Never reads backend message text. */
export function runtimeObservationMessageKind(
  cause: unknown,
): RuntimeObservationMessageKind {
  if (cause !== null && typeof cause === "object") {
    const code = (cause as Partial<ProtocolError>).code;
    if (code === "unsupported_capability") return "unavailable";
  }
  return "failed";
}

/**
 * Fixed user-facing copy for an observation failure. Optional `translate` maps
 * the same keys used by the en/zh-CN registries; the English copy is the
 * fallback so a missing key never ships a raw key or a backend message.
 */
export function describeRuntimeObservationError(
  cause: unknown,
  translate?: (key: string) => string,
): string {
  const key = RUNTIME_OBSERVATION_MESSAGE_KEYS[runtimeObservationMessageKind(cause)];
  if (translate) {
    const translated = translate(key);
    if (typeof translated === "string" && translated.length > 0) return translated;
  }
  return ENGLISH_COPY[key] ?? ENGLISH_COPY[RUNTIME_OBSERVATION_MESSAGE_KEYS.failed]!;
}
