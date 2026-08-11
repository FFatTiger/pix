import type { HttpClient } from "./http-client";
import { urls } from "./urls";
import { ModelCatalogResponseSchema, ModelDiscoverResponseSchema, ModelsConfigSchema, ModelsResponseSchema, ModelTestResponseSchema, SuccessSchema } from "./schemas";

export function createModelsApi(http: HttpClient) {
  return {
    list: (cwd?: string, signal?: AbortSignal) => http.get(urls.models.list(cwd), { schema: ModelsResponseSchema, ...(signal === undefined ? {} : { signal }) }),
    config: (signal?: AbortSignal) => http.get(urls.models.config(), { schema: ModelsConfigSchema, ...(signal === undefined ? {} : { signal }) }),
    saveConfig: (config: Record<string, unknown>, signal?: AbortSignal) => http.put(urls.models.config(), config, { schema: SuccessSchema, ...(signal === undefined ? {} : { signal }) }),
    catalog: (input?: { q?: string; provider?: string; baseUrl?: string; limit?: number; signal?: AbortSignal }) => {
      const query = input === undefined
        ? undefined
        : {
            ...(input.q === undefined ? {} : { q: input.q }),
            ...(input.provider === undefined ? {} : { provider: input.provider }),
            ...(input.baseUrl === undefined ? {} : { baseUrl: input.baseUrl }),
            ...(input.limit === undefined ? {} : { limit: input.limit }),
          };
      return http.get(urls.models.catalog(query), { schema: ModelCatalogResponseSchema, ...(input?.signal === undefined ? {} : { signal: input.signal }) });
    },
    discover: (input: Record<string, unknown>, signal?: AbortSignal) => http.post(urls.models.discover(), input, { schema: ModelDiscoverResponseSchema, ...(signal === undefined ? {} : { signal }) }),
    test: (input: Record<string, unknown>, signal?: AbortSignal) => http.post(urls.models.test(), input, { schema: ModelTestResponseSchema, ...(signal === undefined ? {} : { signal }) }),
  };
}
export type ModelsApi = ReturnType<typeof createModelsApi>;
