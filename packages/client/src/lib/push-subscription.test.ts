import { describe, expect, it } from "vitest";
import {
  autoEnablePushOnce,
  base64UrlToBytes,
  currentPushEndpoint,
  detectPushCapability,
  isIosWithoutStandalone,
  registerDevicePush,
  toSubscriptionPayload,
  unregisterDevicePush,
  type AutoEnablePushDeps,
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
    const registered: unknown[] = [];
    const outcome = await registerDevicePush({
      env: env(),
      getConfig: config,
      subscribe: async (payload) => {
        registered.push(payload);
      },
    });
    // subscribe options captured via a custom env
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

describe("autoEnablePushOnce", () => {
  function harness(options: {
    marked?: boolean;
    permission?: NotificationPermission;
    requestPermission?: () => Promise<NotificationPermission>;
    subscribeThrows?: boolean;
  } = {}) {
    const state = {
      marked: options.marked ?? false,
      markCalls: 0,
      permissionCalls: 0,
      subscribed: 0,
    };
    const deps: AutoEnablePushDeps = {
      env: env({
        notification: {
          permission: options.permission ?? "default",
          requestPermission: async () => {
            state.permissionCalls += 1;
            return options.requestPermission ? options.requestPermission() : "granted";
          },
        },
      }),
      iosWithoutStandalone: false,
      hostSupportsPush: true,
      isMarked: () => state.marked,
      mark: () => {
        state.marked = true;
        state.markCalls += 1;
      },
      getConfig: async () => ({ supported: true, publicKey: "B".repeat(87) }),
      subscribe: async () => {
        state.subscribed += 1;
        if (options.subscribeThrows === true) throw new Error("host rejected the subscription");
      },
    };
    return { state, deps };
  }

  /** Let the fire-and-forget registration chain run to completion. */
  async function settle(): Promise<void> {
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
  }

  it("first eligible device requests permission, registers and writes the marker", async () => {
    const { state, deps } = harness();
    expect(autoEnablePushOnce(deps)).toBe(true);
    // Permission is requested on the synchronous (user-gesture) stack.
    expect(state.permissionCalls).toBe(1);
    await settle();
    expect(state.markCalls).toBe(1);
    expect(state.marked).toBe(true);
    expect(state.subscribed).toBe(1);
  });

  it("an already-marked device never prompts again", () => {
    const { state, deps } = harness({ marked: true });
    expect(autoEnablePushOnce(deps)).toBe(false);
    expect(state.permissionCalls).toBe(0);
    expect(state.subscribed).toBe(0);
  });

  it("denied permission never prompts, never registers, never marks", async () => {
    const { state, deps } = harness({ permission: "denied" });
    expect(autoEnablePushOnce(deps)).toBe(false);
    await settle();
    expect(state.permissionCalls).toBe(0);
    expect(state.subscribed).toBe(0);
    expect(state.markCalls).toBe(0);
  });

  it("unsupported browsers / iOS non-PWA / host without the push capability are skipped", () => {
    const unsupported = harness();
    expect(autoEnablePushOnce({ ...unsupported.deps, env: env({ serviceWorker: null }) })).toBe(false);
    expect(autoEnablePushOnce({ ...unsupported.deps, iosWithoutStandalone: true })).toBe(false);
    expect(autoEnablePushOnce({ ...unsupported.deps, hostSupportsPush: false })).toBe(false);
    expect(unsupported.state.permissionCalls).toBe(0);
    expect(unsupported.state.markCalls).toBe(0);
  });

  it("a registration failure is swallowed (marker already written, nothing thrown)", async () => {
    const { state, deps } = harness({ subscribeThrows: true });
    expect(autoEnablePushOnce(deps)).toBe(true);
    await settle();
    expect(state.marked).toBe(true);
    expect(state.subscribed).toBe(1);
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
