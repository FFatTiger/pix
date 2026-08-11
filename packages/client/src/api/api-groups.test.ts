import { describe, expect, it, vi } from "vitest";
import { createHttpClient } from "./http-client";
import { createSessionsApi } from "./sessions";
import { createModelsApi } from "./models";
import { createResourcesApi } from "./resources";
import { createConfigurationApi } from "./configuration";

function json(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }); }
function client(body: unknown) { return createHttpClient({ fetchImpl: vi.fn().mockResolvedValue(json(body)) as unknown as typeof fetch }); }

const header = { sessionId: "s", cwd: "/repo", projectRoot: "/repo" };

describe("API domain response parsing", () => {
  it("parses session list/detail/context baselines with revision", async () => {
    await expect(createSessionsApi(client({ sessions: [header], revision: 2 })).list()).resolves.toEqual({ sessions: [header], revision: 2 });
    await expect(createSessionsApi(client({ session: header, revision: 3 })).detail("s")).resolves.toEqual({ session: header, revision: 3 });
    await expect(createSessionsApi(client({ context: { sessionId: "s", entries: [] }, revision: 4 })).context("s")).resolves.toEqual({ context: { sessionId: "s", entries: [] }, revision: 4 });
  });

  it("rejects malformed sessions", async () => {
    await expect(createSessionsApi(client({ sessions: [{ sessionId: "s" }] })).list()).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("parses model lists and rejects malformed model data", async () => {
    const valid = { models: { "p:m": "M" }, modelList: [{ id: "m", name: "M", provider: "p" }], defaultModel: null, thinkingLevels: {}, thinkingLevelMaps: {}, thinkingLevelPins: {} };
    await expect(createModelsApi(client(valid)).list()).resolves.toEqual(valid);
    await expect(createModelsApi(client({ ...valid, modelList: [{ id: 1 }] })).list()).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("parses cwd/git/worktree domains and rejects malformed values", async () => {
    await expect(createResourcesApi(client({ roots: ["/repo"], defaultCwd: "/repo" })).cwd.roots()).resolves.toEqual({ roots: ["/repo"], defaultCwd: "/repo" });
    await expect(createResourcesApi(client({ isGitRepository: false, repositoryRoot: null, files: [], additions: 0, deletions: 0 })).git.status("/repo")).resolves.toMatchObject({ isGitRepository: false });
    await expect(createResourcesApi(client({ projectRoot: "/repo", isGit: true, isTopLevel: true, worktrees: [{ path: "/x", branch: null, isMain: false, authorized: false }] })).worktrees.list("/repo")).resolves.toMatchObject({ isGit: true });
    await expect(createResourcesApi(client({ roots: [1], defaultCwd: null })).cwd.roots()).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("parses auth/skills/plugins without leaking backend identity", async () => {
    const configuration = createConfigurationApi(client({ providers: [{ id: "anthropic", methods: ["oauth", "apiKey"] }] }));
    const providers = await configuration.auth.providers();
    expect(providers.providers[0]).toEqual({ id: "anthropic", methods: ["oauth", "apiKey"] });
    expect(JSON.stringify(providers)).not.toMatch(/sdk|rpc/i);
    await expect(createConfigurationApi(client({ skills: [{ name: "s", enabled: true }] })).skills.list()).resolves.toEqual({ skills: [{ name: "s", enabled: true }] });
    await expect(createConfigurationApi(client({ plugins: [{ name: "p", enabled: false }] })).plugins.list()).resolves.toEqual({ plugins: [{ name: "p", enabled: false }] });
  });
});
