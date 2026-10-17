/**
 * Web Push HTTP surface (D-PUSH), behind the gate like every /v1 API:
 *   GET    /v1/push/config         → { supported, publicKey }
 *   POST   /v1/push/subscriptions  → register a device subscription (by endpoint)
 *   DELETE /v1/push/subscriptions  → unregister (by endpoint)
 *   POST   /v1/push/test           → send a test notification to one endpoint
 *
 * All bodies are strict-validated against the Protocol `/push` DTOs (fail
 * closed; unknown fields rejected). Store failures surface as fixed-code 500s
 * — never a fake success — and never echo endpoints or key material.
 */
import type { Context, Hono } from "hono";
import {
  PushConfigResponseSchema,
  PushSubscriptionPayloadSchema,
  PushTestPayloadSchema,
  PushUnsubscribePayloadSchema,
  PushSuccessResponseSchema,
} from "@fffattiger/pix-protocol/push";
import { HttpError } from "../errors.js";
import { readBoundedBody } from "../resources/request-body.js";
import type { HostEnv } from "../env.js";
import type { WebPushStore } from "../resources/web-push-store.js";
import type { WebPushSender } from "../resources/web-push-sender.js";

async function readPushBody<T>(
  c: Context<HostEnv>,
  schema: { safeParse(input: unknown): { success: true; data: T } | { success: false } },
  message: string,
): Promise<T> {
  const type = c.req.header("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (type !== "application/json") throw new HttpError(415, "UNSUPPORTED_MEDIA_TYPE", "application/json is required");
  const bytes = await readBoundedBody(c.req.raw, 8 * 1024);
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new HttpError(400, "INVALID_JSON", "Invalid JSON body");
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new HttpError(400, "INVALID_INPUT", message);
  return parsed.data;
}

export interface PushRouteDeps {
  store: WebPushStore;
  sender: WebPushSender;
  /** Sends the test notification through the shared sender seam. */
  sendTest: (endpoint: string) => Promise<"sent" | "gone" | "missing">;
}

export function registerPushRoutes(app: Hono<HostEnv>, deps: PushRouteDeps): void {
  app.get("/v1/push/config", async (c) => {
    c.header("Cache-Control", "no-store");
    let publicKey: string;
    try {
      const keys = await deps.store.getOrCreateVapidKeys(() => deps.sender.generateVapidKeys());
      publicKey = keys.publicKey;
    } catch {
      // Corrupt store / write failure is honest 500 with a fixed code; the
      // public key is the only key material that could ever appear here.
      throw new HttpError(500, "PUSH_STORE_UNAVAILABLE", "Web Push store is unavailable");
    }
    const body = PushConfigResponseSchema.parse({ supported: true, publicKey });
    return c.json(body);
  });

  app.post("/v1/push/subscriptions", async (c) => {
    const parsed = await readPushBody(c, PushSubscriptionPayloadSchema, "Invalid push subscription payload");
    try {
      // Registering a device implies the Host can send to it: make sure the
      // VAPID keypair exists (created once; the client's config GET normally
      // already did this). A subscription without keys could never be served —
      // that would be a fake success.
      await deps.store.getOrCreateVapidKeys(() => deps.sender.generateVapidKeys());
      await deps.store.upsertSubscription({
        endpoint: parsed.endpoint,
        p256dh: parsed.keys.p256dh,
        auth: parsed.keys.auth,
        ...(parsed.deviceName === undefined ? {} : { deviceName: parsed.deviceName }),
      });
    } catch {
      throw new HttpError(500, "PUSH_STORE_WRITE_FAILED", "Failed to persist push subscription");
    }
    return c.json(PushSuccessResponseSchema.parse({ ok: true }));
  });

  app.delete("/v1/push/subscriptions", async (c) => {
    const parsed = await readPushBody(c, PushUnsubscribePayloadSchema, "Invalid push unsubscribe payload");
    try {
      await deps.store.removeSubscription(parsed.endpoint);
    } catch {
      throw new HttpError(500, "PUSH_STORE_WRITE_FAILED", "Failed to persist push subscription");
    }
    return c.json(PushSuccessResponseSchema.parse({ ok: true }));
  });

  app.post("/v1/push/test", async (c) => {
    const parsed = await readPushBody(c, PushTestPayloadSchema, "Invalid push test payload");
    let outcome: "sent" | "gone" | "missing";
    try {
      outcome = await deps.sendTest(parsed.endpoint);
    } catch {
      throw new HttpError(502, "PUSH_SEND_FAILED", "Test notification could not be delivered");
    }
    if (outcome === "missing") {
      throw new HttpError(404, "PUSH_SUBSCRIPTION_NOT_FOUND", "No push subscription registered for this device");
    }
    if (outcome === "gone") {
      throw new HttpError(410, "PUSH_SUBSCRIPTION_EXPIRED", "Push subscription expired; re-enable notifications");
    }
    return c.json(PushSuccessResponseSchema.parse({ ok: true }));
  });
}
