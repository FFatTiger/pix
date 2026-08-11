/**
 * Public-path allowlist + path helpers for the gate.
 */

/** Exact PWA assets that must be reachable without authentication. */
export const PUBLIC_PWA_ASSETS: readonly string[] = [
  "/manifest.webmanifest",
  "/sw.js",
  "/offline.html",
  "/favicon.ico",
] as const;

/** Gate endpoints the login page needs to reach pre-auth. */
export const PUBLIC_GATE_API_PATHS: readonly string[] = [
  "/v1/gate/status",
  "/v1/gate/login",
  "/v1/gate/logout",
] as const;

/** Health and bootstrap are intentionally public so monitoring/load-balancers can
 *  probe and the client can negotiate the boot surface before authenticating. */
export const PUBLIC_WEB_PATHS: readonly string[] = ["/login", "/v1/health", "/v1/bootstrap"] as const;

/**
 * Exact-match PWA allowlist. `icons/` is the only prefix entry (mirrors the
 * legacy Next middleware). Lookalikes such as `/sw.js.evil`, `/icons.evil` or
 * `/manifest.webmanifest.json` are NOT public.
 */
export function isPublicPwaAssetPath(pathname: string): boolean {
  return PUBLIC_PWA_ASSETS.includes(pathname) || pathname.startsWith("/icons/");
}

/** Exact immutable Vite build assets required to render the login shell. */
export function isPublicViteAssetPath(pathname: string): boolean {
  return pathname.startsWith("/assets/");
}

export function isGatePublicPath(pathname: string): boolean {
  return (
    PUBLIC_GATE_API_PATHS.includes(pathname) ||
    PUBLIC_WEB_PATHS.includes(pathname) ||
    isPublicPwaAssetPath(pathname) ||
    isPublicViteAssetPath(pathname)
  );
}

/** Normalize a `next` value into a safe same-site path (port of legacy logic). */
export function sanitizeNextPath(value: string | null | undefined): string {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return "/";
  if (/[\\\r\n\u0000-\u001f\u007f]/.test(value)) return "/";
  // Reject encoded protocol-relative shapes before the URL parser normalizes them.
  if (/%2f%2f/i.test(value)) return "/";
  const parsed = new URL(value, "http://pix.local");
  if (parsed.origin !== "http://pix.local") return "/";
  if (parsed.pathname === "/login") return "/";
  if (parsed.pathname.startsWith("//") || parsed.pathname.includes("\\")) return "/";
  return `${parsed.pathname}${parsed.search}${parsed.hash}`;
}
