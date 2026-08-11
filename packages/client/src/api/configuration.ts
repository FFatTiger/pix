import type { HttpClient } from "./http-client";
import { urls } from "./urls";
import {
  AuthMutationResponseSchema,
  AuthProvidersResponseSchema,
  AuthStatusesResponseSchema,
  PluginMutationResponseSchema,
  PluginsResponseSchema,
  SkillMutationResponseSchema,
  SkillSearchResponseSchema,
  SkillsResponseSchema,
} from "./schemas";

export function createConfigurationApi(http: HttpClient) {
  return {
    skills: {
      list: (cwd?: string, signal?: AbortSignal) => http.get(urls.skills.list(cwd), { schema: SkillsResponseSchema, ...(signal === undefined ? {} : { signal }) }),
      search: (q: string, signal?: AbortSignal) => http.get(urls.skills.search(q), { schema: SkillSearchResponseSchema, ...(signal === undefined ? {} : { signal }) }),
      install: (input: Record<string, unknown>, signal?: AbortSignal) => http.post(urls.skills.install(), input, { schema: SkillMutationResponseSchema, ...(signal === undefined ? {} : { signal }) }),
      update: (input: Record<string, unknown>, signal?: AbortSignal) => http.post(urls.skills.update(), input, { schema: SkillMutationResponseSchema, ...(signal === undefined ? {} : { signal }) }),
      toggle: (input: { name: string; enabled: boolean; cwd?: string }, signal?: AbortSignal) => http.patch(urls.skills.toggle(), input, { schema: SkillMutationResponseSchema, ...(signal === undefined ? {} : { signal }) }),
    },
    plugins: {
      list: (cwd?: string, signal?: AbortSignal) => http.get(urls.plugins.list(cwd), { schema: PluginsResponseSchema, ...(signal === undefined ? {} : { signal }) }),
      mutate: (input: Record<string, unknown>, signal?: AbortSignal) => http.post(urls.plugins.mutate(), input, { schema: PluginMutationResponseSchema, ...(signal === undefined ? {} : { signal }) }),
    },
    auth: {
      providers: (signal?: AbortSignal) => http.get(urls.auth.providers(), { schema: AuthProvidersResponseSchema, ...(signal === undefined ? {} : { signal }) }),
      statuses: (signal?: AbortSignal) => http.get(urls.auth.allProviders(), { schema: AuthStatusesResponseSchema, ...(signal === undefined ? {} : { signal }) }),
      apiKey: (provider: string, apiKey: string, signal?: AbortSignal) => http.post(urls.auth.apiKey(provider), { apiKey }, { schema: AuthMutationResponseSchema, ...(signal === undefined ? {} : { signal }) }),
      startLogin: (provider: string, signal?: AbortSignal) => http.post(urls.auth.login(provider), { type: "start" }, { schema: AuthMutationResponseSchema, ...(signal === undefined ? {} : { signal }) }),
      finishLogin: (provider: string, code: string, signal?: AbortSignal) => http.post(urls.auth.login(provider), { type: "oauth", code }, { schema: AuthMutationResponseSchema, ...(signal === undefined ? {} : { signal }) }),
      logout: (provider: string, signal?: AbortSignal) => http.post(urls.auth.logout(provider), {}, { schema: AuthMutationResponseSchema, ...(signal === undefined ? {} : { signal }) }),
    },
  };
}
export type ConfigurationApi = ReturnType<typeof createConfigurationApi>;
