import type { HttpClient } from "./http-client";
import { urls } from "./urls";
import { ResolvedThemeSchema, ThemesResponseSchema, type ResolvedThemeDto } from "./schemas";

/**
 * Read-only themes API (mirrors the Host theme catalog):
 * - `GET /v1/themes?cwd=` lists theme sets (global ~/.pi/agent/themes + project
 *   .pi/themes + builtins) — same `{ themeSets }` response shape.
 * - `GET /v1/themes/:name?mode=&cwd=` resolves one variant to CSS vars.
 *
 * `cwd` is REQUIRED end-to-end: the Host themes routes require an absolute
 * authorized project directory (no implicit process.cwd fallback), so every
 * call is project-scoped and every cache key must carry it.
 */
export function createThemesApi(http: HttpClient) {
  return {
    list: (cwd: string, signal?: AbortSignal) =>
      http.get(urls.themes.list(cwd), {
        schema: ThemesResponseSchema,
        ...(signal === undefined ? {} : { signal }),
      }),
    resolve: (name: string, mode: "dark" | "light", cwd: string, signal?: AbortSignal) =>
      http.get(urls.themes.resolve(name, mode, cwd), {
        schema: ResolvedThemeSchema,
        ...(signal === undefined ? {} : { signal }),
      }),
  };
}
export type ThemesApi = ReturnType<typeof createThemesApi>;
export type { ResolvedThemeDto };
