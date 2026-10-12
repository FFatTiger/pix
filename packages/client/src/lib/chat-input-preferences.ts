import { reportPreferenceWrite } from "./preferences/preference-sync";

export type StreamingSendMode = "steer" | "follow-up";

export const STREAMING_SEND_MODE_KEY = "pi-streaming-send-mode";

export function getStreamingSendMode(): StreamingSendMode {
  try {
    return window.localStorage.getItem(STREAMING_SEND_MODE_KEY) === "steer" ? "steer" : "follow-up";
  } catch {
    return "follow-up";
  }
}

export function setStreamingSendMode(value: StreamingSendMode): void {
  try {
    window.localStorage.setItem(STREAMING_SEND_MODE_KEY, value);
    reportPreferenceWrite(STREAMING_SEND_MODE_KEY, value);
    window.dispatchEvent(new StorageEvent("storage", { key: STREAMING_SEND_MODE_KEY, newValue: value }));
  } catch {
    // Local preferences are optional; keep the current session usable when storage is unavailable.
  }
}
