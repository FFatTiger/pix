import { z } from "zod";
import { NonEmptyStringSchema } from "./common.js";

/**
 * Web Push wire DTOs (Host HTTP surface `/v1/push/*` + client typed transport).
 *
 * The Host owns Web Push (VAPID keys, subscriptions, sending); these schemas
 * are the single wire contract shared by the Host routes and the client
 * transport. Exposed both from the package root and the narrow `/push`
 * subpath (the Host foundation imports only the subpath).
 */

/**
 * Unpadded base64url VAPID public key (P-256 65 raw bytes → 87 chars; a small
 * tolerance window keeps the check shape-based instead of brittle).
 */
export const PUSH_VAPID_PUBLIC_KEY_PATTERN = /^[A-Za-z0-9_-]{80,120}$/;

export const PushConfigResponseSchema = z.strictObject({
  /** False when this Host build cannot send pushes at all. */
  supported: z.boolean(),
  /** Unpadded base64url VAPID public key (empty string when unsupported). */
  publicKey: z.string(),
});
export type PushConfigResponse = z.infer<typeof PushConfigResponseSchema>;

/** Unpadded base64url encryption keys a browser subscription carries. */
export const PushSubscriptionKeysSchema = z.strictObject({
  p256dh: z.string().regex(PUSH_VAPID_PUBLIC_KEY_PATTERN, "p256dh must be an unpadded base64url key"),
  auth: z.string().regex(/^[A-Za-z0-9_-]{10,60}$/, "auth must be an unpadded base64url key"),
});
export type PushSubscriptionKeys = z.infer<typeof PushSubscriptionKeysSchema>;

/** Maximum accepted push-service endpoint length (bytes). */
export const MAX_PUSH_ENDPOINT_LENGTH = 2_048;

/** Maximum accepted device-name length (chars). */
export const MAX_PUSH_DEVICE_NAME_LENGTH = 64;

/**
 * Browser `PushSubscription.toJSON()` payload the client registers with the
 * Host. Endpoint must be an absolute https URL without credentials (fail
 * closed: plain-http push services are never accepted).
 */
export const PushSubscriptionPayloadSchema = z.strictObject({
  endpoint: z.string().min(1).max(MAX_PUSH_ENDPOINT_LENGTH).superRefine((value, ctx) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      ctx.addIssue({ code: "custom", message: "endpoint must be an absolute https URL" });
      return;
    }
    if (url.protocol !== "https:" || url.hostname.length === 0 || url.username.length > 0 || url.password.length > 0) {
      ctx.addIssue({ code: "custom", message: "endpoint must be an absolute https URL without credentials" });
    }
  }),
  keys: PushSubscriptionKeysSchema,
  /** Optional human label for the device list (bounded). */
  deviceName: z.string().trim().min(1).max(MAX_PUSH_DEVICE_NAME_LENGTH).optional(),
});
export type PushSubscriptionPayload = z.infer<typeof PushSubscriptionPayloadSchema>;

/** Unregister by exact endpoint. */
export const PushUnsubscribePayloadSchema = z.strictObject({
  endpoint: z.string().min(1).max(MAX_PUSH_ENDPOINT_LENGTH),
});
export type PushUnsubscribePayload = z.infer<typeof PushUnsubscribePayloadSchema>;

/** Send the test notification to the device identified by this endpoint. */
export const PushTestPayloadSchema = z.strictObject({
  endpoint: z.string().min(1).max(MAX_PUSH_ENDPOINT_LENGTH),
});
export type PushTestPayload = z.infer<typeof PushTestPayloadSchema>;

/** Shared strict success body for push mutations. */
export const PushSuccessResponseSchema = z.strictObject({ ok: z.literal(true) });
export type PushSuccessResponse = z.infer<typeof PushSuccessResponseSchema>;

/**
 * Notification payload delivered (encrypted) to the service worker. `url` is
 * a same-origin app route the worker navigates to on click.
 */
export const PushNotificationPayloadSchema = z.strictObject({
  title: NonEmptyStringSchema,
  body: z.string(),
  url: z.string().startsWith("/"),
  /** Same-session notifications replace each other in the OS tray. */
  tag: NonEmptyStringSchema,
});
export type PushNotificationPayload = z.infer<typeof PushNotificationPayloadSchema>;
