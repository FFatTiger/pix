import type { HttpClient } from "./http-client";
import { urls } from "./urls";
import type { ModelDiscoveryInput, ModelsConfigMutation } from "@fffattiger/pix-protocol";
import { ModelDiscoveryResponseSchema, ModelsConfigResponseSchema, ModelsResponseSchema } from "./schemas";

/** Global model catalog plus the capability-gated models.json editor. */
export function createModelsApi(http: HttpClient) {
  return {
    list: (signal?: AbortSignal) =>
      http.get(urls.models.list(), {
        schema: ModelsResponseSchema,
        ...(signal === undefined ? {} : { signal }),
      }),
    config: (signal?: AbortSignal) =>
      http.get(urls.models.config(), {
        schema: ModelsConfigResponseSchema,
        ...(signal === undefined ? {} : { signal }),
      }),
    saveConfig: (input: ModelsConfigMutation, signal?: AbortSignal) =>
      http.put(urls.models.config(), input, {
        schema: ModelsConfigResponseSchema,
        ...(signal === undefined ? {} : { signal }),
      }),
    discover: (input: ModelDiscoveryInput, signal?: AbortSignal) =>
      http.post(urls.models.discover(), input, {
        schema: ModelDiscoveryResponseSchema,
        timeoutMs: 25_000,
        ...(signal === undefined ? {} : { signal }),
      }),
  };
}
export type ModelsApi = ReturnType<typeof createModelsApi>;
