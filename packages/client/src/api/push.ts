import {
  PushConfigResponseSchema,
  PushSuccessResponseSchema,
  type PushSubscriptionPayload,
} from "@fffattiger/pix-protocol";
import type { HttpClient } from "./http-client";
import { urls } from "./urls";

export type { PushSubscriptionPayload } from "@fffattiger/pix-protocol";

/**
 * Web Push typed transport (D-PUSH). Strict per-response schemas; every
 * failure surfaces as a typed HttpError (never a silent fallback).
 */
export function createPushApi(http: HttpClient) {
  return {
    config: (signal?: AbortSignal) =>
      http.get(urls.push.config(), { schema: PushConfigResponseSchema, ...(signal === undefined ? {} : { signal }) }),
    subscribe: (payload: PushSubscriptionPayload) =>
      http.post(urls.push.subscriptions(), payload, { schema: PushSuccessResponseSchema }),
    unsubscribe: (endpoint: string) =>
      http.delete(urls.push.subscriptions(), { endpoint }, { schema: PushSuccessResponseSchema }),
    test: (endpoint: string) =>
      http.post(urls.push.test(), { endpoint }, { schema: PushSuccessResponseSchema }),
  };
}
export type PushApi = ReturnType<typeof createPushApi>;
