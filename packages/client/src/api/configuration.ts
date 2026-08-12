import type { HttpClient } from "./http-client";
import { urls } from "./urls";
import {
  AuthProvidersResponseSchema,
  AuthProviderStatusResponseSchema,
  CommandsResponseSchema,
  PluginsResponseSchema,
  SkillsResponseSchema,
  TrustResponseSchema,
} from "./schemas";

/**
 * Read-only configuration / catalog APIs (D3B).
 *
 * Frozen product decision: Client does not expose Host-unmounted mutation /
 * OAuth call surfaces (skills search/install/update/toggle, plugins mutate,
 * auth allProviders/apiKey/login/logout). Only honest GET wrappers remain.
 */
export function createConfigurationApi(http: HttpClient) {
  return {
    skills: {
      list: (cwd: string, signal?: AbortSignal) =>
        http.get(urls.skills.list(cwd), {
          schema: SkillsResponseSchema,
          ...(signal === undefined ? {} : { signal }),
        }),
    },
    plugins: {
      list: (cwd: string, signal?: AbortSignal) =>
        http.get(urls.plugins.list(cwd), {
          schema: PluginsResponseSchema,
          ...(signal === undefined ? {} : { signal }),
        }),
    },
    commands: {
      list: (cwd: string, signal?: AbortSignal) =>
        http.get(urls.commands.list(cwd), {
          schema: CommandsResponseSchema,
          ...(signal === undefined ? {} : { signal }),
        }),
    },
    trust: {
      get: (cwd: string, signal?: AbortSignal) =>
        http.get(urls.trust.get(cwd), {
          schema: TrustResponseSchema,
          ...(signal === undefined ? {} : { signal }),
        }),
    },
    auth: {
      providers: (signal?: AbortSignal) =>
        http.get(urls.auth.providers(), {
          schema: AuthProvidersResponseSchema,
          ...(signal === undefined ? {} : { signal }),
        }),
      providerStatus: (providerId: string, signal?: AbortSignal) =>
        http.get(urls.auth.providerStatus(providerId), {
          schema: AuthProviderStatusResponseSchema,
          ...(signal === undefined ? {} : { signal }),
        }),
    },
  };
}
export type ConfigurationApi = ReturnType<typeof createConfigurationApi>;
