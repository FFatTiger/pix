import type { PushSubscriptionPayload } from "@fffattiger/pix-protocol";

/**
 * Browser-side Web Push registration core (D-PUSH).
 *
 * Owns exactly the browser half: support detection, the permission request
 * (always triggered from a user gesture by the settings page), the
 * pushManager subscription with the Host's VAPID key, and the typed
 * registration/unregistration calls. Every browser surface is injected so the
 * logic is deterministically testable; HTTP goes through the typed transport
 * the caller wires in.
 */

export interface PushSubscriptionLike {
  readonly endpoint: string;
  toJSON(): { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
  unsubscribe(): Promise<boolean>;
}

export interface PushManagerLike {
  getSubscription(): Promise<PushSubscriptionLike | null>;
  subscribe(options: { userVisibleOnly: boolean; applicationServerKey: BufferSource }): Promise<PushSubscriptionLike>;
}

export interface ServiceWorkerRegistrationLike {
  readonly pushManager: PushManagerLike;
}

export interface ServiceWorkerContainerLike {
  readonly ready: Promise<ServiceWorkerRegistrationLike>;
}

export interface NotificationStaticLike {
  readonly permission: NotificationPermission;
  requestPermission(): Promise<NotificationPermission>;
}

/** The browser surfaces this module needs; `null` where the platform lacks them. */
export interface PushBrowserEnv {
  readonly serviceWorker: ServiceWorkerContainerLike | null;
  readonly notification: NotificationStaticLike | null;
  readonly hasPushManager: boolean;
}

/** What the user's browser actually allows, derived once per render. */
export type PushCapability =
  | { state: "unsupported" }
  | { state: "supported"; permission: NotificationPermission };

export function detectPushCapability(env: PushBrowserEnv): PushCapability {
  if (env.serviceWorker === null || env.notification === null || !env.hasPushManager) {
    return { state: "unsupported" };
  }
  return { state: "supported", permission: env.notification.permission };
}

/**
 * iOS Safari only delivers push to installed home-screen PWAs: when the
 * platform is iOS and the page is not standalone, the settings page shows the
 * "add to home screen first" hint instead of a toggle that can never work.
 */
export function isIosWithoutStandalone(
  platform: string,
  standalone: boolean,
): boolean {
  return platform === "ios" && !standalone;
}

/** Decode an unpadded base64url VAPID key into the bytes pushManager wants. */
export function base64UrlToBytes(base64Url: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64Url.length % 4)) % 4);
  const base64 = (base64Url + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const output = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index += 1) {
    output[index] = raw.charCodeAt(index);
  }
  return output;
}

/** Normalize a browser subscription into the wire payload (strict, no guessing). */
export function toSubscriptionPayload(
  subscription: PushSubscriptionLike,
  deviceName?: string,
): PushSubscriptionPayload | null {
  const json = subscription.toJSON();
  const endpoint = json.endpoint;
  const p256dh = json.keys?.p256dh;
  const auth = json.keys?.auth;
  if (typeof endpoint !== "string" || endpoint === "" || typeof p256dh !== "string" || typeof auth !== "string") {
    return null;
  }
  return { endpoint, keys: { p256dh, auth }, ...(deviceName === undefined ? {} : { deviceName }) };
}

/** Typed outcomes for {@link registerDevicePush} (all honest; none fake success). */
export type RegisterPushOutcome =
  | { state: "registered"; endpoint: string }
  | { state: "permission-denied" }
  | { state: "permission-dismissed" }
  | { state: "unsupported" };

export interface RegisterPushDeps {
  readonly env: PushBrowserEnv;
  /** Fetch the Host push config (VAPID public key). */
  readonly getConfig: () => Promise<{ supported: boolean; publicKey: string }>;
  /** Register the normalized subscription with the Host. */
  readonly subscribe: (payload: PushSubscriptionPayload) => Promise<unknown>;
}

/**
 * Permission → subscribe → register. Must be invoked from a user gesture
 * (the browser enforces the permission prompt otherwise).
 */
export async function registerDevicePush(deps: RegisterPushDeps): Promise<RegisterPushOutcome> {
  const capability = detectPushCapability(deps.env);
  if (capability.state === "unsupported") return { state: "unsupported" };
  const notification = deps.env.notification!;
  const permission = await notification.requestPermission();
  if (permission === "denied") return { state: "permission-denied" };
  if (permission !== "granted") return { state: "permission-dismissed" };

  const config = await deps.getConfig();
  if (!config.supported || config.publicKey === "") return { state: "unsupported" };

  const registration = await deps.env.serviceWorker!.ready;
  const existing = await registration.pushManager.getSubscription();
  const subscription = existing ?? await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: base64UrlToBytes(config.publicKey),
  });
  const payload = toSubscriptionPayload(subscription);
  if (payload === null) {
    throw new Error("Push subscription is missing endpoint or keys");
  }
  await deps.subscribe(payload);
  return { state: "registered", endpoint: payload.endpoint };
}

export interface UnregisterPushDeps {
  readonly env: PushBrowserEnv;
  /** Remove the endpoint registration on the Host. */
  readonly unsubscribe: (endpoint: string) => Promise<unknown>;
}

/**
 * Unsubscribe this browser (pushManager.unsubscribe) and unregister the
 * endpoint with the Host. Returns the removed endpoint, or null when this
 * browser had no local subscription (nothing to remove — honest no-op).
 */
export async function unregisterDevicePush(deps: UnregisterPushDeps): Promise<string | null> {
  const capability = detectPushCapability(deps.env);
  if (capability.state === "unsupported") return null;
  const registration = await deps.env.serviceWorker!.ready;
  const subscription = await registration.pushManager.getSubscription();
  if (subscription === null) return null;
  const endpoint = subscription.endpoint;
  await subscription.unsubscribe();
  await deps.unsubscribe(endpoint);
  return endpoint;
}

/** Read this browser's current endpoint without touching permission state. */
export async function currentPushEndpoint(env: PushBrowserEnv): Promise<string | null> {
  const capability = detectPushCapability(env);
  if (capability.state === "unsupported") return null;
  if (capability.permission !== "granted") return null;
  const registration = await env.serviceWorker!.ready;
  const subscription = await registration.pushManager.getSubscription();
  return subscription?.endpoint ?? null;
}
