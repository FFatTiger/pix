import type { HttpClient } from "./http-client";
import { urls } from "./urls";
import { ResolvedThemeSchema, ThemesResponseSchema, type ResolvedThemeDto } from "./schemas";

/**
 * Read-only themes API. Mirrors the upstream desktop theme system:
 * - `GET /v1/themes` lists theme sets (global ~/.pi/agent/themes + project
 *   .pi/themes + builtins) — same `{ themeSets }` response shape.
 * - `GET /v1/themes/:name?mode=dark|light` resolves one variant to CSS vars.
 *
 * The Host themes routes are a separate slice; until they land every call
 * fails and callers degrade to the built-in/default theme (never a raw error).
 */
export function createThemesApi(http: HttpClient) {
  return {
    list: (cwd?: string, signal?: AbortSignal) =>
      http.get(urls.themes.list(cwd), {
        schema: ThemesResponseSchema,
        ...(signal === undefined ? {} : { signal }),
      }),
    resolve: (name: string, mode: "dark" | "light", signal?: AbortSignal) =>
      http.get(urls.themes.resolve(name, mode), {
        schema: ResolvedThemeSchema,
        ...(signal === undefined ? {} : { signal }),
      }),
  };
}
export type ThemesApi = ReturnType<typeof createThemesApi>;

/**
 * Context-free resolved-theme fetch for `useTheme` (ported verbatim from
 * upstream desktop client; it keeps its own `name::mode` cache). Preserves the source
 * semantics: null on HTTP failure / malformed body / schema mismatch, null on
 * network error — the hook then falls back to the default CSS theme.
 */
export async function fetchResolvedTheme(
  name: string,
  mode: "dark" | "light",
): Promise<ResolvedThemeDto | null> {
  try {
    const resp = await fetch(urls.themes.resolve(name, mode));
    if (!resp.ok) return null;
    const data: unknown = await resp.json();
    const parsed = ResolvedThemeSchema.safeParse(data);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
