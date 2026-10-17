import { describe, expect, it } from "vitest";
import {
  base64UrlToBytes,
  currentPushEndpoint,
  detectPushCapability,
  isIosWithoutStandalone,
  registerDevicePush,
  toSubscriptionPayload,
  unregisterDevicePush,
  type PushBrowserEnv,
  type PushSubscriptionLike,
} from "./push-subscription";

const KEYS = { p256dh: "K".repeat(87), auth: "a".repeat(16) };

function subscription(overrides: Partial<PushSubscriptionLike> = {}): PushSubscriptionLike {
  return {
    endpoint: "https://fcm.googleapis.com/fcm/send/abc",
    toJSON: () => ({ endpoint: "https://fcm.googleapis.com/fcm/send/abc", keys: KEYS }),
    unsubscribe: async () => true,
    ...overrides,
  };
}

function env(overrides: Partial<PushBrowserEnv> = {}): PushBrowserEnv {
  return {
    serviceWorker: {
      ready: Promise.resolve({
        pushManager: {
          getSubscription: async () => null,
          subscribe: async () => subscription(),
        },
      }),
    },
    notification: { permission: "default" as NotificationPermission, requestPermission: async () => "granted" },
    hasPushManager: true,
    ...overrides,
  };
}

describe("detectPushCapability", () => {
  it("marks missing service worker / Notification / PushManager as unsupported", () => {
    expect(detectPushCapability(env({ serviceWorker: null })).state).toBe("unsupported");
    expect(detectPushCapability(env({ notification: null })).state).toBe("unsupported");
    expect(detectPushCapability(env({ hasPushManager: false })).state).toBe("unsupported");
    expect(detectPushCapability(env())).toEqual({ state: "supported", permission: "default" });
  });
});

describe("isIosWithoutStandalone", () => {
  it("is true only for iOS outside standalone mode", () => {
    expect(isIosWithoutStandalone("ios", false)).toBe(true);
    expect(isIosWithoutStandalone("ios", true)).toBe(false);
    expect(isIosWithoutStandalone("mac", false)).toBe(false);
  });
});

describe("base64UrlToBytes", () => {
  it("decodes unpadded base64url", () => {
    expect(Array.from(base64UrlToBytes("AAEC"))).toEqual([0, 1, 2]);
    expect(Array.from(base64UrlToBytes("-_8"))).toEqual([251, 255]);
  });
});

describe("toSubscriptionPayload", () => {
  it("normalizes a browser subscription; missing endpoint/keys yield null (never fabricated)", () => {
    expect(toSubscriptionPayload(subscription())).toEqual({
      endpoint: "https://fcm.googleapis.com/fcm/send/abc",
      keys: KEYS,
    });
    expect(toSubscriptionPayload(subscription(), "Mac")).toMatchObject({ deviceName: "Mac" });
    const broken = subscription({ toJSON: () => ({ keys: KEYS }) });
    expect(toSubscriptionPayload(broken)).toBeNull();
    const noKeys = subscription({ toJSON: () => ({ endpoint: "https://push.example/x" }) });
    expect(toSubscriptionPayload(noKeys)).toBeNull();
  });
});

describe("registerDevicePush", () => {
  const config = async () => ({ supported: true, publicKey: "B".repeat(87) });

  it("granted → subscribes with the VAPID key and registers with the host", async () => {
    const subscribed: unknown[] = [];
    const registered: unknown[] = [];
    const outcome = await registerDevicePush({
      env: env(),
      getConfig: config,
      subscribe: async (payload) => {
        registered.push(payload);
      },
    });
    // subscribe options captured via a custom env
    void subscribed;
    expect(outcome).toEqual({ state: "registered", endpoint: "https://fcm.googleapis.com/fcm/send/abc" });
    expect(registered).toHaveLength(1);
  });

  it("passes the decoded applicationServerKey to pushManager.subscribe", async () => {
    let captured: { userVisibleOnly: boolean; applicationServerKey: Uint8Array } | undefined;
    const e = env({
      serviceWorker: {
        ready: Promise.resolve({
          pushManager: {
            getSubscription: async () => null,
            subscribe: async (options) => {
              captured = options as typeof captured;
              return subscription();
            },
          },
        }),
      },
    });
    await registerDevicePush({ env: e, getConfig: config, subscribe: async () => undefined });
    expect(captured!.userVisibleOnly).toBe(true);
    expect(captured!.applicationServerKey).toBeInstanceOf(Uint8Array);
    expect(captured!.applicationServerKey.length).toBe(65);
  });

  it("reuses an existing subscription instead of subscribing again", async () => {
    let subscribeCalls = 0;
    const e = env({
      serviceWorker: {
        ready: Promise.resolve({
          pushManager: {
            getSubscription: async () => subscription(),
            subscribe: async () => {
              subscribeCalls += 1;
              return subscription();
            },
          },
        }),
      },
    });
    await registerDevicePush({ env: e, getConfig: config, subscribe: async () => undefined });
    expect(subscribeCalls).toBe(0);
  });

  it("maps denied and dismissed permission honestly; unsupported env never prompts", async () => {
    const denied = await registerDevicePush({
      env: env({ notification: { permission: "denied", requestPermission: async () => "denied" } }),
      getConfig: config,
      subscribe: async () => undefined,
    });
    expect(denied).toEqual({ state: "permission-denied" });
    const dismissed = await registerDevicePush({
      env: env({ notification: { permission: "default", requestPermission: async () => "default" } }),
      getConfig: config,
      subscribe: async () => undefined,
    });
    expect(dismissed).toEqual({ state: "permission-dismissed" });
    const unsupported = await registerDevicePush({
      env: env({ serviceWorker: null }),
      getConfig: config,
      subscribe: async () => undefined,
    });
    expect(unsupported).toEqual({ state: "unsupported" });
  });

  it("unsupported host config (no key) reports unsupported instead of subscribing", async () => {
    const outcome = await registerDevicePush({
      env: env(),
      getConfig: async () => ({ supported: false, publicKey: "" }),
      subscribe: async () => undefined,
    });
    expect(outcome).toEqual({ state: "unsupported" });
  });

  it("a subscription missing keys fails honestly (throws instead of registering garbage)", async () => {
    await expect(registerDevicePush({
      env: env({
        serviceWorker: {
          ready: Promise.resolve({
            pushManager: {
              getSubscription: async () => subscription({ toJSON: () => ({ endpoint: "https://push.example/x" }) }),
              subscribe: async () => subscription({ toJSON: () => ({}) }),
            },
          }),
        },
      }),
      getConfig: config,
      subscribe: async () => undefined,
    })).rejects.toThrow(/missing endpoint or keys/);
  });
});

describe("unregisterDevicePush / currentPushEndpoint", () => {
  it("unsubscribes the browser and unregisters the endpoint; no local subscription → null", async () => {
    let unsubscribed = false;
    const e = env({
      serviceWorker: {
        ready: Promise.resolve({
          pushManager: {
            getSubscription: async () => subscription({ unsubscribe: async () => { unsubscribed = true; return true; } }),
            subscribe: async () => subscription(),
          },
        }),
      },
    });
    const removed: string[] = [];
    const endpoint = await unregisterDevicePush({ env: e, unsubscribe: async (target) => { removed.push(target); } });
    expect(endpoint).toBe("https://fcm.googleapis.com/fcm/send/abc");
    expect(unsubscribed).toBe(true);
    expect(removed).toEqual(["https://fcm.googleapis.com/fcm/send/abc"]);
    const none = await unregisterDevicePush({ env: env(), unsubscribe: async () => undefined });
    expect(none).toBeNull();
  });

  it("currentPushEndpoint: null without permission or subscription", async () => {
    expect(await currentPushEndpoint(env())).toBeNull();
    expect(await currentPushEndpoint(env({ notification: { permission: "granted", requestPermission: async () => "granted" } }))).toBeNull();
    const withSub = env({
      notification: { permission: "granted", requestPermission: async () => "granted" },
      serviceWorker: {
        ready: Promise.resolve({ pushManager: { getSubscription: async () => subscription(), subscribe: async () => subscription() } }),
      },
    });
    expect(await currentPushEndpoint(withSub)).toBe("https://fcm.googleapis.com/fcm/send/abc");
  });
});
