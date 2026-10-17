import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import vm from "node:vm";

/**
 * Drive the REAL public/sw.js (the file the Host serves) inside a sandboxed
 * service-worker-like environment: push → showNotification, notificationclick
 * → focus/navigate/openWindow. No mirrored copy of the logic — the shipped
 * bytes are what gets tested.
 */
const __dirname = dirname(fileURLToPath(import.meta.url));
const SW_SOURCE = readFileSync(join(__dirname, "../../public/sw.js"), "utf8");

interface FakeClient {
  url: string;
  navigatedTo: string | null;
  focused: boolean;
  navigate(url: string): Promise<FakeClient>;
  focus(): Promise<FakeClient>;
}

function client(url: string): FakeClient {
  const entry: FakeClient = {
    url,
    navigatedTo: null,
    focused: false,
    async navigate(next) {
      entry.navigatedTo = next;
      entry.url = new URL(next, "https://pix.local").toString();
      return entry;
    },
    async focus() {
      entry.focused = true;
      return entry;
    },
  };
  return entry;
}

interface SwHarness {
  shown: { title: string; options: unknown }[];
  opened: string[];
  windows: FakeClient[];
  push(payload: unknown): Promise<void>;
  click(data: unknown): Promise<void>;
}

function loadServiceWorker(initialWindows: FakeClient[] = []): SwHarness {
  const listeners = new Map<string, Array<(event: unknown) => void>>();
  const shown: { title: string; options: unknown }[] = [];
  const opened: string[] = [];
  const windows = initialWindows;
  const cache = { add: async () => undefined, put: async () => undefined, match: async () => undefined };
  const selfObj = {
    location: { origin: "https://pix.local", href: "https://pix.local/sw.js?v=test" },
    skipWaiting: async () => undefined,
    addEventListener: (type: string, handler: (event: unknown) => void) => {
      const list = listeners.get(type) ?? [];
      list.push(handler);
      listeners.set(type, list);
    },
    clients: {
      matchAll: async () => [...windows],
      openWindow: async (url: string) => {
        opened.push(url);
        return null;
      },
    },
    registration: {
      showNotification: async (title: string, options: unknown) => {
        shown.push({ title, options });
      },
    },
  };
  const context = {
    self: selfObj,
    caches: {
      open: async () => cache,
      keys: async () => [] as string[],
      delete: async () => true,
      match: async () => undefined,
    },
    fetch: async () => {
      throw new Error("offline in test");
    },
    Response,
    URL,
  };
  vm.createContext(context);
  vm.runInContext(SW_SOURCE, context, { filename: "sw.js" });

  const dispatch = async (type: string, event: Record<string, unknown>): Promise<void> => {
    const pending: Promise<unknown>[] = [];
    const wrapped = {
      ...event,
      waitUntil: (promise: Promise<unknown>) => {
        pending.push(promise);
      },
    };
    for (const handler of listeners.get(type) ?? []) handler(wrapped);
    await Promise.all(pending);
  };

  return {
    shown,
    opened,
    windows,
    push: (payload: unknown) =>
      dispatch("push", { data: { json: () => payload } }),
    click: (data: unknown) =>
      dispatch("notificationclick", { notification: { close: () => undefined, data } }),
  };
}

afterEach(() => {
  // vitest jsdom is unaffected; nothing global was stubbed here.
});

describe("sw.js — push", () => {
  it("shows the Host-composed notification with icon/badge/tag/data.url", async () => {
    const sw = loadServiceWorker();
    await sw.push({
      title: "已完成",
      body: "修复构建：done",
      url: "/?session=s1&cwd=%2Fw",
      tag: "s1",
    });
    expect(sw.shown).toHaveLength(1);
    expect(sw.shown[0]!.title).toBe("已完成");
    expect(sw.shown[0]!.options).toMatchObject({
      body: "修复构建：done",
      icon: "/icons/icon-192.png",
      badge: "/icons/icon-192.png",
      tag: "s1",
      data: { url: "/?session=s1&cwd=%2Fw" },
    });
  });

  it("ignores pushes without a parsable payload or title (fail closed, no fake notification)", async () => {
    const sw = loadServiceWorker();
    await sw.push(null);
    await sw.push({ body: "no title" });
    await sw.push({ title: "t" });
    expect(sw.shown).toHaveLength(1); // only the title-bearing payload
    expect(sw.shown[0]!.options).toMatchObject({ data: { url: "/" } });
  });
});

describe("sw.js — notificationclick", () => {
  it("focuses and navigates an existing app window", async () => {
    const existing = client("https://pix.local/?session=other");
    const sw = loadServiceWorker([existing]);
    await sw.click({ url: "/?session=s1" });
    expect(existing.focused).toBe(true);
    expect(existing.navigatedTo).toBe("/?session=s1");
    expect(sw.opened).toEqual([]);
  });

  it("skips navigate when the window is already at the target URL (focus only)", async () => {
    const existing = client("https://pix.local/?assistant=1");
    const sw = loadServiceWorker([existing]);
    await sw.click({ url: "/?assistant=1" });
    expect(existing.focused).toBe(true);
    expect(existing.navigatedTo).toBeNull();
    expect(sw.opened).toEqual([]);
  });

  it("prefers an app window over a /login window, but reuses /login when it is the only one", async () => {
    const login = client("https://pix.local/login?next=/");
    const app = client("https://pix.local/?session=x");
    const sw = loadServiceWorker([login, app]);
    await sw.click({ url: "/?session=s1" });
    expect(app.focused).toBe(true);
    expect(login.focused).toBe(false);

    const onlyLogin = client("https://pix.local/login?next=/");
    const sw2 = loadServiceWorker([onlyLogin]);
    await sw2.click({ url: "/?session=s1" });
    expect(onlyLogin.focused).toBe(true);
    expect(onlyLogin.navigatedTo).toBe("/?session=s1");
    expect(sw2.opened).toEqual([]);
  });

  it("opens a new window when none exists", async () => {
    const sw = loadServiceWorker();
    await sw.click({ url: "/?session=s1" });
    expect(sw.opened).toEqual(["/?session=s1"]);
  });

  it("treats a non-same-origin-looking url as the app root (never navigates off-origin)", async () => {
    const existing = client("https://pix.local/?session=other");
    const sw = loadServiceWorker([existing]);
    await sw.click({ url: "//evil.example/x" });
    expect(existing.navigatedTo).toBe("/");
    const sw2 = loadServiceWorker();
    await sw2.click({ url: "https://evil.example/x" });
    expect(sw2.opened).toEqual(["/"]);
  });

  it("defaults to the app root when the notification carries no url", async () => {
    const sw = loadServiceWorker();
    await sw.click(undefined);
    expect(sw.opened).toEqual(["/"]);
  });
});
