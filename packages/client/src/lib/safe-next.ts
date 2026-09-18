/**
 * Safe post-login redirect parsing.
 *
 * Gate stores the full return URL in `?next=` (pathname + search).
 * TanStack Router's `navigate({ to })` expects a route path, not a
 * path+query blob — so we split and map onto known client routes.
 *
 * Security: only same-origin, root-relative paths are accepted.
 * Rejects protocol-relative (`//evil`), absolute external URLs, and
 * anything that is not a single-path root-relative target.
 */

import {
  parseWorkspaceSearch,
  type WorkspaceSearch,
} from "@/lib/search-params";

/** Client routes this shell can navigate to after login. */
export type AppRoutePath = "/" | "/login";

export interface SafeNextTarget {
  /** Route path for TanStack Router `to`. */
  to: AppRoutePath;
  /** Parsed search object for the target route. */
  search: WorkspaceSearch;
  /** Full root-relative href (pathname + search), useful for display/tests. */
  href: string;
}

const FALLBACK: SafeNextTarget = {
  to: "/",
  search: {},
  href: "/",
};

/**
 * Known route prefixes. Anything else falls back to `/` to avoid
 * navigating into host-only or future paths before they exist in the shell.
 */
function mapPathname(pathname: string): AppRoutePath {
  if (pathname === "/login" || pathname.startsWith("/login/")) {
    return "/login";
  }
  // Workstation root and any unknown in-app path → home (search still applied when `/`).
  return "/";
}

function searchRecordFromParams(params: URLSearchParams): Record<string, unknown> {
  const record: Record<string, unknown> = {};
  for (const [key, value] of params.entries()) {
    // First value wins; mirrors typical deep-link usage.
    if (!(key in record)) {
      record[key] = value;
    }
  }
  return record;
}

function hrefFor(to: AppRoutePath, search: WorkspaceSearch): string {
  const params = new URLSearchParams();
  if (search.session) params.set("session", search.session);
  if (search.cwd) params.set("cwd", search.cwd);
  if (search.next) params.set("next", search.next);
  // Login route may carry only `next`; workstation carries session/cwd.
  const qs = params.toString();
  if (!qs) return to;
  return `${to}?${qs}`;
}

/**
 * Parse and sanitize a `next` value from the login query string (or any source).
 *
 * @param raw - Value of `next` (may be encoded or already decoded)
 * @param options.baseOrigin - Origin used when resolving absolute same-origin URLs (defaults to window.location.origin in browser)
 */
export function resolveSafeNext(
  raw: string | null | undefined,
  options: { baseOrigin?: string } = {},
): SafeNextTarget {
  if (raw == null) return FALLBACK;

  let candidate = String(raw).trim();
  if (!candidate) return FALLBACK;

  // Reject backslashes early (path confusion / IE legacy).
  if (candidate.includes("\\")) return FALLBACK;

  // Protocol-relative or scheme URLs need special handling.
  const baseOrigin =
    options.baseOrigin ??
    (typeof window !== "undefined" && window.location?.origin
      ? window.location.origin
      : "http://localhost");

  // Absolute URL: only allow same origin, then treat as path+search.
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(candidate)) {
    let url: URL;
    try {
      url = new URL(candidate);
    } catch {
      return FALLBACK;
    }
    if (url.origin !== baseOrigin) return FALLBACK;
    candidate = `${url.pathname}${url.search}`;
  }

  // Protocol-relative: //evil.com/...
  if (candidate.startsWith("//")) return FALLBACK;

  // Must be root-relative.
  if (!candidate.startsWith("/")) return FALLBACK;

  // Parse with a dummy base so searchParams work without a browser.
  let parsed: URL;
  try {
    parsed = new URL(candidate, baseOrigin);
  } catch {
    return FALLBACK;
  }

  // Defense in depth: if URL constructor rewrote to another origin, reject.
  if (parsed.origin !== baseOrigin) return FALLBACK;

  const pathname = parsed.pathname || "/";
  // Collapse accidental double roots but keep single slash.
  if (!pathname.startsWith("/")) return FALLBACK;

  const to = mapPathname(pathname);
  const rawSearch = searchRecordFromParams(parsed.searchParams);

  // Returning to /login after login would loop — strip to workstation.
  if (to === "/login") {
    return FALLBACK;
  }

  // Only workspace search keys are forwarded to `/`.
  const search = parseWorkspaceSearch(rawSearch);
  // `next` on the workstation route is unused post-login; drop it.
  const { next: _drop, ...workspace } = search;

  return {
    to,
    search: workspace,
    href: hrefFor(to, workspace),
  };
}

/** True when the resolved target is not the plain home fallback. */
export function isMeaningfulNext(target: SafeNextTarget): boolean {
  return target.href !== "/";
}
