import { useCallback, useMemo } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { PushSubscriptionPayload } from "@fffattiger/pix-protocol";
import { createMutationOptions, createPushApi } from "@/api";
import { useHttpClient } from "@/app/http-context";

/**
 * Browser-side Web Push registration core (D-PUSH).
 *
 * Owns exactly the browser half: support detection, the permission request
 * (always triggered from a user gesture — the settings switch or the first
 * message send), the pushManager subscription with the Host's VAPID key, and
 * the typed registration/unregistration calls. Every browser surface is
 * injected so the logic is deterministically testable; HTTP goes through the
 * typed transport the caller wires in.
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

/** Collect the (nullable) browser surfaces once per mount, guarded for SSR. */
export function readPushBrowserEnv(globalish: {
  navigator?: { userAgent?: string; serviceWorker?: unknown } | undefined;
  Notification?: unknown | undefined;
  matchMedia?: ((q: string) => { matches: boolean }) | undefined;
  window?: { PushManager?: unknown } | undefined;
}): { env: PushBrowserEnv; iosWithoutStandalone: boolean } {
  const serviceWorker = globalish.navigator?.serviceWorker ?? null;
  const hasPushManager = typeof globalish.window !== "undefined" && "PushManager" in globalish.window;
  const env: PushBrowserEnv = {
    serviceWorker: (serviceWorker ?? null) as ServiceWorkerContainerLike | null,
    notification: (globalish.Notification ?? null) as NotificationStaticLike | null,
    hasPushManager,
  };
  const userAgent = globalish.navigator?.userAgent ?? "";
  const platform = /iPhone|iPad|iPod/i.test(userAgent) ? "ios" : "other";
  const standalone = globalish.matchMedia?.("(display-mode: standalone)")?.matches === true;
  return { env, iosWithoutStandalone: isIosWithoutStandalone(platform, standalone) };
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

/** Injectable Web Crypto digest surface (tests pass a fake). */
export interface SubtleDigestLike {
  digest(algorithm: "SHA-256", data: Uint8Array<ArrayBuffer>): Promise<ArrayBuffer>;
}

/**
 * Lowercase SHA-256 hex of a string — the exact digest the Host compares
 * (`hashPushEndpoint`): both sides hash the push endpoint this way so the
 * endpoint itself never leaves the browser.
 */
export async function sha256Hex(value: string, subtle: SubtleDigestLike = globalThis.crypto.subtle): Promise<string> {
  const digest = await subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Current push endpoint hash for the runtime attention report. Undefined when
 * this browser has no usable subscription (unsupported / not granted / none) —
 * such a page's "attended" report suppresses nothing.
 */
export async function currentPushEndpointHash(env: PushBrowserEnv): Promise<string | undefined> {
  const endpoint = await currentPushEndpoint(env);
  return endpoint === null ? undefined : sha256Hex(endpoint);
}

/**
 * Per-DEVICE marker: this browser already spent its one automatic push-enable
 * attempt. Device-local on purpose (never synced through the Host preference
 * map — each browser must attempt its own permission prompt once), and set by
 * a manual settings toggle too, so a deliberate "off" is never silently
 * re-enabled by a later first message.
 */
export const PUSH_AUTO_ENABLE_MARKER_KEY = "pi-push-auto-enable-attempted";

function markerStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** True when this browser already attempted the automatic enable. */
export function hasPushAutoEnableMarker(): boolean {
  const storage = markerStorage();
  if (storage === null) return false;
  try {
    return storage.getItem(PUSH_AUTO_ENABLE_MARKER_KEY) !== null;
  } catch {
    return false;
  }
}

/**
 * Record the attempt. Written BEFORE the permission request so a second send
 * (or a second composer mount) never prompts again; when storage is
 * unavailable the browser itself still pins the decided permission.
 */
export function markPushAutoEnableAttempted(): void {
  const storage = markerStorage();
  if (storage === null) return;
  try {
    storage.setItem(PUSH_AUTO_ENABLE_MARKER_KEY, "1");
  } catch {
    // Storage unavailable: degrade to the browser's own permission state.
  }
}

export interface AutoEnablePushDeps {
  readonly env: PushBrowserEnv;
  /** iPhone not installed as a home-screen PWA can never receive push. */
  readonly iosWithoutStandalone: boolean;
  /** The Host advertises the `push` capability (its seam is wired). */
  readonly hostSupportsPush: boolean;
  readonly isMarked: () => boolean;
  readonly mark: () => void;
  readonly getConfig: () => Promise<{ supported: boolean; publicKey: string }>;
  readonly subscribe: (payload: PushSubscriptionPayload) => Promise<unknown>;
}

/**
 * The ONE automatic push-enable attempt a device gets, fired from the first
 * message send.
 *
 * Browsers only show the notification permission prompt inside a user
 * gesture, so this must run synchronously inside the send handler: the marker
 * is written first (at most one attempt per device), then
 * {@link registerDevicePush} starts — its `requestPermission()` call lands on
 * this same synchronous stack. The outcome (granted / dismissed / denied /
 * transport failure) is never surfaced and never awaited: enabling
 * notifications must not block, delay or fail a send.
 *
 * Returns true when the attempt was started (marker written).
 */
export function autoEnablePushOnce(deps: AutoEnablePushDeps): boolean {
  if (!deps.hostSupportsPush || deps.iosWithoutStandalone) return false;
  const capability = detectPushCapability(deps.env);
  if (capability.state !== "supported" || capability.permission === "denied") return false;
  if (deps.isMarked()) return false;
  deps.mark();
  void registerDevicePush({ env: deps.env, getConfig: deps.getConfig, subscribe: deps.subscribe })
    .catch(() => undefined);
  return true;
}

/**
 * Composer-facing wrapper: assembles the browser env, the Host push transport
 * and the same subscribe mutation the settings page uses, and returns a
 * SYNCHRONOUS trigger to call from the send handler (before any await).
 *
 * `hostSupportsPush` is the caller's capability answer (`can("push")`) so this
 * module stays free of feature-layer imports.
 */
export function useAutoEnablePush(hostSupportsPush: boolean): () => void {
  const http = useHttpClient();
  const queryClient = useQueryClient();
  const { env, iosWithoutStandalone } = useMemo(
    () => readPushBrowserEnv({
      navigator: typeof navigator === "undefined" ? undefined : navigator,
      Notification: typeof Notification === "undefined" ? undefined : Notification,
      matchMedia: typeof matchMedia === "function" ? matchMedia.bind(window) : undefined,
      window: typeof window === "undefined" ? undefined : window,
    }),
    [],
  );
  const pushApi = useMemo(() => createPushApi(http), [http]);
  const mutations = useMemo(() => createMutationOptions(http, queryClient).push, [http, queryClient]);
  const subscribeMutation = useMutation(mutations.subscribe());
  return useCallback(() => {
    autoEnablePushOnce({
      env,
      iosWithoutStandalone,
      hostSupportsPush,
      isMarked: hasPushAutoEnableMarker,
      mark: markPushAutoEnableAttempted,
      getConfig: () => pushApi.config(),
      subscribe: (payload) => subscribeMutation.mutateAsync(payload),
    });
  }, [env, iosWithoutStandalone, hostSupportsPush, pushApi, subscribeMutation]);
}
