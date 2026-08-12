import type { HttpClient } from "./http-client";
import { urls } from "./urls";
import { ModelsResponseSchema } from "./schemas";

/**
 * Read-only model catalog API (D3B). Mutation surfaces (config/save/catalog/
 * discover/test) are intentionally absent — Host does not mount them.
 */
export function createModelsApi(http: HttpClient) {
  return {
    list: (cwd: string, signal?: AbortSignal) =>
      http.get(urls.models.list(cwd), {
        schema: ModelsResponseSchema,
        ...(signal === undefined ? {} : { signal }),
      }),
  };
}
export type ModelsApi = ReturnType<typeof createModelsApi>;
