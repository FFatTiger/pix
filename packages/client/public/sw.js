/**
 * pix client service worker (Vite / host static assets).
 * Rules:
 * - /v1/* is never cached (live protocol traffic)
 * - Vite /assets/* may be cache-first
 * - Navigation is network-first with offline fallback
 * - Web Push: `push` shows the Host-composed notification; `notificationclick`
 *   focuses/navigates an existing window or opens one (D-PUSH)
 */
const CACHE_PREFIX = "pix-client";
const CACHE_VERSION =
  new URL(self.location.href).searchParams.get("v") || "dev";
const STATIC_CACHE = `${CACHE_PREFIX}-static-${CACHE_VERSION}`;
const OFFLINE_URL = "/offline.html";
const NOTIFICATION_ICON = "/icons/icon-192.png";
const PRECACHE_URLS = [
  OFFLINE_URL,
  "/manifest.webmanifest",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(STATIC_CACHE)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter(
              (key) =>
                key.startsWith(`${CACHE_PREFIX}-`) && key !== STATIC_CACHE,
            )
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Protocol traffic and the SW itself must never be cached.
  if (url.pathname.startsWith("/v1/") || url.pathname === "/sw.js") {
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith(networkFirstNavigation(request));
    return;
  }

  const isViteAsset = url.pathname.startsWith("/assets/");
  const isPrecached = PRECACHE_URLS.includes(url.pathname);

  if (isViteAsset || isPrecached) {
    event.respondWith(cacheFirst(request));
  }
});

async function networkFirstNavigation(request) {
  try {
    const response = await fetch(request);
    return response;
  } catch {
    const fallback = await caches.match(OFFLINE_URL);
    return fallback ?? Response.error();
  }
}

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;

  const response = await fetch(request);
  if (response.ok && response.type === "basic") {
    const cache = await caches.open(STATIC_CACHE);
    await cache.put(request, response.clone());
  }
  return response;
}

// --- Web Push (D-PUSH) ------------------------------------------------------

/**
 * Pick the notification-click target among open clients: an existing pix
 * window (same-origin; a non-login window is preferred) is navigated and
 * focused; otherwise a new window opens. Pure — loaded and tested directly
 * by src/push/sw-behavior.test.ts.
 */
function pickNotificationTarget(data, clients) {
  const raw = data && typeof data === "object" && typeof data.url === "string" ? data.url : "/";
  const url = raw.startsWith("/") && !raw.startsWith("//") ? raw : "/";
  const sameOrigin = clients.filter((client) => client.url.startsWith(self.location.origin + "/"));
  const appWindow = sameOrigin.find((client) => !client.url.startsWith(self.location.origin + "/login"));
  const client = appWindow ?? sameOrigin[0];
  return client ? { action: "focus", client, url } : { action: "open", url };
}

self.addEventListener("push", (event) => {
  let payload = null;
  try {
    payload = event.data ? event.data.json() : null;
  } catch {
    payload = null;
  }
  if (!payload || typeof payload.title !== "string") return;
  const title = payload.title;
  const options = {
    body: typeof payload.body === "string" ? payload.body : "",
    icon: NOTIFICATION_ICON,
    badge: NOTIFICATION_ICON,
    tag: typeof payload.tag === "string" ? payload.tag : undefined,
    data: { url: typeof payload.url === "string" ? payload.url : "/" },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      const resolved = pickNotificationTarget(event.notification.data, clients);
      if (resolved.action === "focus") {
        const client = resolved.client;
        const sameUrl = client.url === self.location.origin + resolved.url;
        return ("navigate" in client && !sameUrl ? client.navigate(resolved.url) : Promise.resolve(client))
          .then(() => client.focus());
      }
      return self.clients.openWindow(resolved.url);
    }),
  );
});
