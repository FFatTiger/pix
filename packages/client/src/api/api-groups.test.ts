import { describe, expect, it, vi } from "vitest";
import { createHttpClient } from "./http-client";
import { createSessionsApi } from "./sessions";
import { createModelsApi } from "./models";
import { createResourcesApi } from "./resources";
import { createConfigurationApi } from "./configuration";

function json(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }); }
function client(body: unknown) { return createHttpClient({ fetchImpl: vi.fn().mockResolvedValue(json(body)) as unknown as typeof fetch }); }
function recordingClient(calls: { url: string; method: string; body?: unknown }[]) {
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({
      url,
      method: (init?.method ?? "GET").toUpperCase(),
      ...(init?.body === undefined ? {} : { body: JSON.parse(String(init.body)) as unknown }),
    });
    return json({ success: true });
  }) as unknown as typeof fetch;
  return createHttpClient({ fetchImpl });
}

const header = { sessionId: "s", cwd: "/repo", projectRoot: "/repo" };

describe("API domain response parsing", () => {
  it("parses session list/detail/context baselines with revision", async () => {
    await expect(createSessionsApi(client({ sessions: [header], revision: 2 })).list()).resolves.toEqual({ sessions: [header], revision: 2 });
    await expect(createSessionsApi(client({ session: header, revision: 3 })).detail("s")).resolves.toEqual({ session: header, revision: 3 });
    await expect(createSessionsApi(client({ context: { sessionId: "s", entries: [], pageInfo: { hasMore: false } }, revision: 4 })).context("s")).resolves.toEqual({ context: { sessionId: "s", entries: [], pageInfo: { hasMore: false } }, revision: 4 });
  });

  it("rejects malformed sessions", async () => {
    await expect(createSessionsApi(client({ sessions: [{ sessionId: "s" }] })).list()).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("parses the Host DELETE / PATCH success envelope and keeps the autoName contract", async () => {
    // D4: DELETE and PATCH both settle with `{ success: true }` (SuccessSchema).
    await expect(createSessionsApi(client({ success: true })).remove("s")).resolves.toEqual({ success: true });
    await expect(createSessionsApi(client({ success: true })).rename("s", "New")).resolves.toEqual({ success: true });
    // The OkSchema shape is NOT accepted for rename/delete — a latent
    // { ok: true } response is a decode failure, never a false success.
    await expect(createSessionsApi(client({ ok: true })).remove("s")).rejects.toMatchObject({ kind: "decode", code: "INVALID_RESPONSE" });
    await expect(createSessionsApi(client({ ok: true })).rename("s", "New")).rejects.toMatchObject({ kind: "decode", code: "INVALID_RESPONSE" });
    // autoName keeps its own contract (OkSchema) unchanged.
    await expect(createSessionsApi(client({ ok: true })).autoName("s")).resolves.toEqual({ ok: true });
    await expect(createSessionsApi(client({ success: true })).autoName("s")).rejects.toMatchObject({ kind: "decode", code: "INVALID_RESPONSE" });
  });

  it("rename sends exactly PATCH /v1/sessions/:id with body { name } and an AbortSignal", async () => {
    const calls: { url: string; method: string; body?: unknown }[] = [];
    const signal = new AbortController().signal;
    await createSessionsApi(recordingClient(calls)).rename("s", "New Name", signal);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ url: "/v1/sessions/s", method: "PATCH", body: { name: "New Name" } });
  });

  it("parses Host model catalog and rejects legacy Next model shape", async () => {
    const valid = {
      models: [{ id: "m", provider: "p", displayName: "M", thinking: true, contextWindow: 128000 }],
      defaultModel: { id: "m", provider: "p" },
    };
    await expect(createModelsApi(client(valid)).list("/repo")).resolves.toEqual(valid);
    // Legacy Next union shape (modelList/thinkingLevels) must be rejected.
    const legacy = {
      models: { "p:m": "M" },
      modelList: [{ id: "m", name: "M", provider: "p" }],
      defaultModel: null,
      thinkingLevels: {},
      thinkingLevelMaps: {},
      thinkingLevelPins: {},
    };
    await expect(createModelsApi(client(legacy)).list("/repo")).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    await expect(createModelsApi(client({ models: [{ id: 1 }], defaultModel: null })).list("/repo")).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("trust setTrusted sends exactly POST /v1/trust with body {cwd, level:\"trusted\"}", async () => {
    const state = { cwd: "/repo", level: "trusted", trusted: true, canReloadResources: { allowed: true, level: "trusted" } };
    const calls: { url: string; method: string; body?: unknown }[] = [];
    const recording = createHttpClient({
      fetchImpl: vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({
          url: String(input),
          method: (init?.method ?? "GET").toUpperCase(),
          ...(init?.body === undefined ? {} : { body: JSON.parse(String(init.body)) as unknown }),
        });
        return json(state);
      }) as unknown as typeof fetch,
    });
    const signal = new AbortController().signal;
    await expect(createConfigurationApi(recording).trust.setTrusted("/repo", signal)).resolves.toEqual(state);
    expect(calls).toEqual([{ url: "/v1/trust", method: "POST", body: { cwd: "/repo", level: "trusted" } }]);
    // Strict response: an extra field is a decode failure, never a silent accept.
    const extra = createConfigurationApi(client({ ...state, source: "saved" }));
    await expect(extra.trust.setTrusted("/repo")).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    // A response missing the strict state fields is a decode failure too.
    const partial = createConfigurationApi(client({ cwd: "/repo", level: "trusted" }));
    await expect(partial.trust.setTrusted("/repo")).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("parses cwd/git/worktree domains and rejects malformed values", async () => {
    await expect(createResourcesApi(client({ roots: ["/repo"], defaultCwd: "/repo" })).cwd.roots()).resolves.toEqual({ roots: ["/repo"], defaultCwd: "/repo" });
    await expect(createResourcesApi(client({ isGitRepository: false, repositoryRoot: null, files: [], additions: 0, deletions: 0 })).git.status("/repo")).resolves.toMatchObject({ isGitRepository: false });
    await expect(createResourcesApi(client({ projectRoot: "/repo", isGit: true, isTopLevel: true, worktrees: [{ path: "/x", branch: null, isMain: false, authorized: false, managedByPix: false }] })).worktrees.list("/repo")).resolves.toMatchObject({ isGit: true });
    await expect(createResourcesApi(client({ roots: [1], defaultCwd: null })).cwd.roots()).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("parses auth/skills/plugins/commands/trust Host shapes without mutation surface", async () => {
    const configuration = createConfigurationApi(client({ providers: [{ id: "anthropic", methods: ["oauth", "apiKey"] }] }));
    const providers = await configuration.auth.providers();
    expect(providers.providers[0]).toEqual({ id: "anthropic", methods: ["oauth", "apiKey"] });
    expect(JSON.stringify(providers)).not.toMatch(/sdk|rpc/i);

    await expect(createConfigurationApi(client({ skills: [{ name: "s", enabled: true }] })).skills.list("/repo")).resolves.toEqual({ skills: [{ name: "s", enabled: true }] });
    await expect(createConfigurationApi(client({ plugins: [{ name: "p", enabled: false }] })).plugins.list("/repo")).resolves.toEqual({ plugins: [{ name: "p", enabled: false }] });
    await expect(createConfigurationApi(client({ commands: [{ name: "cmd", source: "skill" }] })).commands.list("/repo")).resolves.toEqual({ commands: [{ name: "cmd", source: "skill" }] });

    const trustBody = {
      cwd: "/repo",
      level: "trusted",
      trusted: true,
      canReloadResources: { allowed: true, level: "trusted" },
    };
    await expect(createConfigurationApi(client(trustBody)).trust.get("/repo")).resolves.toEqual(trustBody);

    const statusBody = {
      status: { providerId: "anthropic", authorized: true, accountName: "a@b" },
      configured: true,
    };
    await expect(createConfigurationApi(client(statusBody)).auth.providerStatus("anthropic")).resolves.toEqual(statusBody);

    // No mutation methods on the API surface.
    expect(configuration.skills).not.toHaveProperty("search");
    expect(configuration.skills).not.toHaveProperty("install");
    expect(configuration.skills).not.toHaveProperty("update");
    expect(configuration.skills).not.toHaveProperty("toggle");
    expect(configuration.plugins).not.toHaveProperty("mutate");
    expect(configuration.auth).not.toHaveProperty("apiKey");
    expect(configuration.auth).not.toHaveProperty("startLogin");
    expect(configuration.auth).not.toHaveProperty("finishLogin");
    expect(configuration.auth).not.toHaveProperty("logout");
    expect(configuration.auth).not.toHaveProperty("statuses");
  });
});
