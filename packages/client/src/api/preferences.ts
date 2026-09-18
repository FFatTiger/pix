import type { HttpClient } from "./http-client";
import { urls } from "./urls";
import { PreferencesResponseSchema, PreferencesUpdateResultSchema } from "./schemas";

export interface PreferencesPatchInput { patch: Record<string, string | null> }

/**
 * Server-side user preferences (pix.json `preferences`): the raw localStorage
 * strings keyed by their `pi-*` names. The client keeps per-domain owners;
 * this transport only moves the mirror.
 */
export function createPreferencesApi(http: HttpClient) {
  return {
    get: (signal?: AbortSignal) => http.get(urls.preferences.get(), { schema: PreferencesResponseSchema, ...(signal === undefined ? {} : { signal }) }),
    update: (input: PreferencesPatchInput, signal?: AbortSignal) => http.put(urls.preferences.update(), input, { schema: PreferencesUpdateResultSchema, ...(signal === undefined ? {} : { signal }) }),
  };
}
export type PreferencesApi = ReturnType<typeof createPreferencesApi>;
