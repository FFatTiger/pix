import type { HttpClient } from "./http-client";
import { AboutCheckUpdateResponseSchema, AboutResponseSchema } from "@fffattiger/pix-protocol";
import { urls } from "./urls";

/**
 * About transports (`/v1/about`): read-only version facts plus the on-demand
 * npm update probe. `checkUpdate` is POST (a user action with an outbound
 * side effect on the host, never auto-prefetched by the browser).
 */
export function createAboutApi(http: HttpClient) {
  return {
    get: (signal?: AbortSignal) => http.get(urls.about.get(), { schema: AboutResponseSchema, ...(signal === undefined ? {} : { signal }) }),
    checkUpdate: (signal?: AbortSignal) => http.post(urls.about.checkUpdate(), undefined, { schema: AboutCheckUpdateResponseSchema, ...(signal === undefined ? {} : { signal }) }),
  };
}
export type AboutApi = ReturnType<typeof createAboutApi>;
