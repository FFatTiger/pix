import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpClientProvider } from "@/app/http-context";
import { CapabilityProvider } from "@/features/capability/CapabilityProvider";
import { I18nProvider } from "@/hooks/useI18n";
import { NotificationsConfig, describePushError } from "./NotificationsConfig";
import { HttpError } from "@/api/http-client";
import { PUSH_AUTO_ENABLE_MARKER_KEY } from "@/lib/push-subscription";

function json(value: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" }, ...init });
}

const KEYS = { p256dh: "K".repeat(87), auth: "a".repeat(16) };
const ENDPOINT = "https://fcm.googleapis.com/fcm/send/abc";

interface FakePushWorld {
  permission: NotificationPermission;
  existingEndpoint: string | null;
  subscribeCalls: number;
}

function stubPushBrowser(world: FakePushWorld, options: { userAgent?: string } = {}) {
  const fakeNavigator = {
    userAgent: options.userAgent ?? "Mozilla/5.0 (Macintosh)",
    languages: ["en-US"],
    serviceWorker: {
      ready: Promise.resolve({
        pushManager: {
          getSubscription: async () =>
            world.existingEndpoint === null
              ? null
              : { endpoint: world.existingEndpoint, toJSON: () => ({ endpoint: world.existingEndpoint, keys: KEYS }), unsubscribe: async () => true },
          subscribe: async () => {
            world.subscribeCalls += 1;
            world.existingEndpoint = ENDPOINT;
            return { endpoint: ENDPOINT, toJSON: () => ({ endpoint: ENDPOINT, keys: KEYS }), unsubscribe: async () => true };
          },
        },
      }),
    },
  };
  vi.stubGlobal("navigator", fakeNavigator);
  vi.stubGlobal("Notification", {
    permission: world.permission,
    requestPermission: async () => world.permission,
  });
  vi.stubGlobal("window", Object.assign(window, { PushManager: class {} }));
  // Cleanup: the shared afterEach calls vi.unstubAllGlobals().
}

function mount(fetchImpl: ReturnType<typeof vi.fn>, capabilities: string[] = ["push"]) {
  vi.stubGlobal("fetch", fetchImpl);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <HttpClientProvider>
        <CapabilityProvider host={{ mode: "local", capabilities: capabilities as never }}>
          <I18nProvider><NotificationsConfig /></I18nProvider>
        </CapabilityProvider>
      </HttpClientProvider>
    </QueryClientProvider>,
  );
}

const configFetch = vi.fn(async (input: RequestInfo | URL) => {
  const url = String(input);
  if (url.includes("/v1/push/config")) return json({ supported: true, publicKey: "B".repeat(87) });
  return json({});
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("NotificationsConfig — states", () => {
  it("unsupported browser: badge instead of a switch; test button disabled", async () => {
    // No serviceWorker / Notification / PushManager in jsdom by default.
    mount(configFetch);
    expect(await screen.findByText("Unsupported")).toBeTruthy();
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.getByTestId("push-test-button").hasAttribute("disabled")).toBe(true);
  });

  it("iOS without home-screen install shows the hint banner and disables the switch", async () => {
    stubPushBrowser({ permission: "default", existingEndpoint: null, subscribeCalls: 0 }, {
      userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)",
    });
    mount(configFetch);
    expect(await screen.findByText(/Add to Home Screen/i)).toBeTruthy();
    expect(screen.getByRole("switch").hasAttribute("disabled")).toBe(true);
  });

  it("permission denied by the browser: honest description and disabled switch", async () => {
    stubPushBrowser({ permission: "denied", existingEndpoint: null, subscribeCalls: 0 });
    mount(configFetch);
    await waitFor(() => expect(screen.getByText(/Blocked by the browser/i)).toBeTruthy());
    expect(screen.getByRole("switch").hasAttribute("disabled")).toBe(true);
  });

  it("host without the push capability shows the host-unavailable banner", async () => {
    mount(configFetch, []);
    expect(await screen.findByText(/does not provide notifications/i)).toBeTruthy();
    expect(screen.queryByRole("switch")).toBeNull();
  });
});

describe("NotificationsConfig — toggle + test", () => {
  it("switching on requests permission, subscribes the browser and registers with the host", async () => {
    const world: FakePushWorld = { permission: "granted", existingEndpoint: null, subscribeCalls: 0 };
    stubPushBrowser(world);
    const bodies: unknown[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/v1/push/config")) return json({ supported: true, publicKey: "B".repeat(87) });
      if (url.includes("/v1/push/subscriptions") && init?.method === "POST") {
        bodies.push(JSON.parse(String(init.body)));
        return json({ ok: true });
      }
      return json({});
    });
    mount(fetchMock);
    const toggle = await screen.findByRole("switch");
    await waitFor(() => expect(toggle.hasAttribute("disabled")).toBe(false));
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("true"));
    expect(world.subscribeCalls).toBe(1);
    expect(bodies).toEqual([{ endpoint: ENDPOINT, keys: KEYS }]);
    expect(screen.getByTestId("push-test-button").hasAttribute("disabled")).toBe(false);
  });

  it("switching off unsubscribes the browser, unregisters the endpoint and records the auto-enable marker", async () => {
    const world: FakePushWorld = { permission: "granted", existingEndpoint: ENDPOINT, subscribeCalls: 0 };
    stubPushBrowser(world);
    const bodies: unknown[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/v1/push/config")) return json({ supported: true, publicKey: "B".repeat(87) });
      if (url.includes("/v1/push/subscriptions") && init?.method === "DELETE") {
        bodies.push(JSON.parse(String(init.body)));
        world.existingEndpoint = null;
        return json({ ok: true });
      }
      return json({});
    });
    mount(fetchMock);
    const toggle = await screen.findByRole("switch");
    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("true"));
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("false"));
    expect(bodies).toEqual([{ endpoint: ENDPOINT }]);
    // A deliberate manual "off" also ends the automatic first-send attempt.
    expect(localStorage.getItem(PUSH_AUTO_ENABLE_MARKER_KEY)).toBe("1");
  });

  it("dismissed permission prompt shows honest copy and leaves notifications off", async () => {
    stubPushBrowser({ permission: "default", existingEndpoint: null, subscribeCalls: 0 });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/v1/push/config")) return json({ supported: true, publicKey: "B".repeat(87) });
      return json({});
    });
    mount(fetchMock);
    const toggle = await screen.findByRole("switch");
    await waitFor(() => expect(toggle.hasAttribute("disabled")).toBe(false));
    fireEvent.click(toggle);
    await waitFor(() => expect(screen.getByText(/dismissed without a choice/i)).toBeTruthy());
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(fetchMock).not.toHaveBeenCalledWith(expect.stringContaining("/v1/push/subscriptions"), expect.anything());
  });

  it("test button posts to /v1/push/test and surfaces expiry honestly", async () => {
    stubPushBrowser({ permission: "granted", existingEndpoint: ENDPOINT, subscribeCalls: 0 });
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/v1/push/config")) return json({ supported: true, publicKey: "B".repeat(87) });
      if (url.includes("/v1/push/test")) {
        void init;
        return new Response(JSON.stringify({ error: "expired" }), { status: 410 });
      }
      return json({});
    });
    mount(fetchMock);
    await screen.findByRole("switch");
    fireEvent.click(screen.getByTestId("push-test-button"));
    await waitFor(() => expect(screen.getByText(/expired/i)).toBeTruthy());
  });
});

describe("describePushError", () => {
  const t = (key: string) => key;
  it("maps wire failures to fixed keys", () => {
    expect(describePushError(new HttpError(410, "/v1/push/test", "x"), t)).toBe("desktop.pushExpired");
    expect(describePushError(new HttpError({ status: 404, path: "/v1/push/test", message: "x", code: "PUSH_SUBSCRIPTION_NOT_FOUND" }), t)).toBe("desktop.pushNoSubscription");
    expect(describePushError(new HttpError({ status: 502, path: "/v1/push/test", message: "x", code: "PUSH_SEND_FAILED" }), t)).toBe("desktop.pushSendFailed");
    expect(describePushError(new HttpError(500, "/v1/push/test", "x"), t)).toBe("desktop.pushStoreFailed");
    expect(describePushError(new Error("boom"), t)).toBe("desktop.pushGenericFailure");
  });
});
