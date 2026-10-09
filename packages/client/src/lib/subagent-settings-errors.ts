import { HttpError } from "@/api/http-client";

/** Fixed translation keys; never expose raw Host messages or settings contents. */
export function describeSubagentSettingsError(error: unknown): string {
  if (error instanceof HttpError) {
    if (error.code === "CONFLICT") return "desktop.subagentSettingsChanged";
    if (error.code === "INVALID_INPUT" || error.code === "INVALID_SETTINGS_CONFIG") return "desktop.subagentSettingsInvalid";
    if (error.kind === "network") return "desktop.subagentSettingsNetwork";
    if (error.kind === "timeout") return "desktop.subagentSettingsTimeout";
  }
  return "desktop.subagentSettingsUnavailable";
}
