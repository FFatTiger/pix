/**
 * Web Push sender over the vendored `web-push` npm library (D-PUSH).
 *
 * One narrow port: `send(subscription, payload)` plus a VAPID keypair
 * generator. Concrete failures are classified so callers can prune dead
 * subscriptions (404/410) without a retry storm — everything else is logged
 * by the caller, never retried here.
 */
import * as webPush from "web-push";
import type { PushNotificationPayload } from "@fffattiger/pix-protocol/push";
import type { WebPushSubscriptionRecord, WebPushVapidKeys } from "./web-push-store.js";

/** Fixed VAPID subject (operator contact required by the Web Push protocol). */
export const WEB_PUSH_VAPID_SUBJECT = "https://github.com/FFatTiger/pix";

/** Outcome of one send attempt. */
export type WebPushSendResult = "delivered" | "gone";

export interface WebPushSender {
  /** Generate a fresh VAPID keypair (unpadded base64url). */
  generateVapidKeys(): WebPushVapidKeys;
  /**
   * Send one payload. Resolves `gone` when the push service reports the
   * subscription dead (HTTP 404/410 — caller must remove it); rejects with a
   * sanitized error otherwise (caller logs, never retries).
   */
  send(subscription: WebPushSubscriptionRecord, keys: WebPushVapidKeys, payload: PushNotificationPayload): Promise<WebPushSendResult>;
}

/** Extract the HTTP status from a web-push WebPushError, when present. */
export function webPushErrorStatusCode(error: unknown): number | null {
  if (error !== null && typeof error === "object" && "statusCode" in error) {
    const code = (error as { statusCode?: unknown }).statusCode;
    return typeof code === "number" ? code : null;
  }
  return null;
}

/** Production sender: per-call VAPID options (no global mutable state). */
export function createWebPushSender(): WebPushSender {
  return {
    generateVapidKeys() {
      const generated = webPush.generateVAPIDKeys();
      return { publicKey: generated.publicKey, privateKey: generated.privateKey };
    },
    async send(subscription, keys, payload) {
      try {
        await webPush.sendNotification(
          {
            endpoint: subscription.endpoint,
            keys: { p256dh: subscription.p256dh, auth: subscription.auth },
          },
          JSON.stringify(payload),
          {
            vapidDetails: {
              subject: WEB_PUSH_VAPID_SUBJECT,
              publicKey: keys.publicKey,
              privateKey: keys.privateKey,
            },
          },
        );
        return "delivered";
      } catch (error) {
        const status = webPushErrorStatusCode(error);
        if (status === 404 || status === 410) return "gone";
        throw error instanceof Error ? error : new Error("web push send failed");
      }
    },
  };
}
