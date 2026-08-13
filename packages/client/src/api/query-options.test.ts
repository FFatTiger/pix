import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { createHttpClient } from "./http-client";
import { createMutationOptions } from "./mutations";
import { createQueryOptions, queryKeys } from "./query-keys";

function json(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }); }
const session = { sessionId: "s", cwd: "/repo", projectRoot: "/repo" };

function invalidationHarness(body: unknown) {
  const http = createHttpClient({ fetchImpl: vi.fn().mockResolvedValue(json(body, 201)) as unknown as typeof fetch });
  const queryClient = new QueryClient();
  const invalidate = vi.spyOn(queryClient, "invalidateQueries").mockResolvedValue(undefined);
  return { options: createMutationOptions(http, queryClient), invalidate };
}

describe("query keys and options", () => {
  it("uses stable hierarchical keys including cwd and provider id", () => {
    expect(queryKeys.sessions.list("/repo")).toEqual(queryKeys.sessions.list("/repo"));
    expect(queryKeys.sessions.detail("s").slice(0, 4)).toEqual(queryKeys.sessions.byId("s"));
    expect(queryKeys.files.read("/a")).not.toEqual(queryKeys.files.read("/b"));
    expect(queryKeys.models.list("/a")).toEqual(["pix", "models", "list", "/a"]);
    expect(queryKeys.models.list("/a")).not.toEqual(queryKeys.models.list("/b"));
    expect(queryKeys.skills.list("/repo")).toEqual(["pix", "skills", "list", "/repo"]);
    expect(queryKeys.plugins.list("/repo")).toEqual(["pix", "plugins", "list", "/repo"]);
    expect(queryKeys.commands.list("/repo")).toEqual(["pix", "commands", "list", "/repo"]);
    expect(queryKeys.trust.get("/repo")).toEqual(["pix", "trust", "get", "/repo"]);
    expect(queryKeys.auth.providerStatus("openai")).toEqual(["pix", "auth", "provider-status", "openai"]);
    expect(queryKeys.auth.providerStatus("a")).not.toEqual(queryKeys.auth.providerStatus("b"));
  });

  it("file index options key by cwd + q with cwd/q isolation and pass signal", async () => {
    expect(queryKeys.files.index("/a", "foo")).toEqual(["pix", "files", "index", "/a", "foo"]);
    expect(queryKeys.files.index("/a", "foo")).not.toEqual(queryKeys.files.index("/b", "foo"));
    expect(queryKeys.files.index("/a", "foo")).not.toEqual(queryKeys.files.index("/a", "bar"));

    const fetchImpl = vi.fn().mockResolvedValue(json({ matches: [{ path: "a.ts", isDir: false }], truncated: false }));
    const http = createHttpClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const options = createQueryOptions(http);
    const option = options.files.index("/repo", "foo");
    expect(option.queryKey).toEqual(["pix", "files", "index", "/repo", "foo"]);
    expect(option.enabled).toBe(true);
    expect(options.files.index("/repo", "").enabled).toBe(true); // cwd-gated; component adds q-length gate

    const signal = new AbortController().signal;
    await option.queryFn!({ signal } as never);
    expect(fetchImpl).toHaveBeenCalledWith(
      "/v1/file-index?cwd=%2Frepo&q=foo",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("parses Protocol session DTOs and rejects a deep mismatch", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(json({ sessions: [session], revision: 4 })).mockResolvedValueOnce(json({ sessions: [{ ...session, messageCount: -1 }] }));
    const http = createHttpClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const option = createQueryOptions(http).sessions.list("/repo");
    await expect(option.queryFn!({ signal: new AbortController().signal } as never)).resolves.toEqual({ sessions: [session], revision: 4 });
    await expect(option.queryFn!({ signal: new AbortController().signal } as never)).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("catalog options require cwd, pass signal, set staleTime 15s and retry false", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json({
      models: [{ id: "m", provider: "p" }],
      defaultModel: null,
    }));
    const http = createHttpClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const options = createQueryOptions(http);

    const models = options.models.list("/repo");
    expect(models.enabled).toBe(true);
    expect(models.staleTime).toBe(15_000);
    expect(models.retry).toBe(false);
    expect(options.models.list("").enabled).toBe(false);

    const signal = new AbortController().signal;
    await models.queryFn!({ signal } as never);
    expect(fetchImpl).toHaveBeenCalledWith(
      "/v1/models?cwd=%2Frepo",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );

    const skills = options.skills.list("/repo");
    expect(skills.enabled).toBe(true);
    expect(skills.staleTime).toBe(15_000);
    expect(skills.retry).toBe(false);
    expect(options.skills.list("").enabled).toBe(false);

    const plugins = options.plugins.list("/x");
    expect(plugins.staleTime).toBe(15_000);
    expect(plugins.retry).toBe(false);

    const commands = options.commands.list("/x");
    expect(commands.staleTime).toBe(15_000);
    expect(commands.retry).toBe(false);

    const trust = options.trust.get("/x");
    expect(trust.staleTime).toBe(15_000);
    expect(trust.retry).toBe(false);
    expect(options.trust.get("").enabled).toBe(false);

    const providers = options.auth.providers();
    expect(providers.staleTime).toBe(15_000);
    expect(providers.retry).toBe(false);

    const status = options.auth.providerStatus("openai");
    expect(status.enabled).toBe(true);
    expect(status.staleTime).toBe(15_000);
    expect(status.retry).toBe(false);
    expect(options.auth.providerStatus("").enabled).toBe(false);

    // No placeholderData that would cross cwd boundaries.
    expect(models.placeholderData).toBeUndefined();
    expect(skills.placeholderData).toBeUndefined();
  });
});

describe("table-driven mutation invalidation", () => {
  it("invalidates session list and only the affected session prefix", async () => {
    const { options, invalidate } = invalidationHarness({ ok: true });
    const mutation = options.sessions.rename();
    const input = { id: "s", name: "new" };
    await mutation.mutationFn(input); await mutation.onSuccess(undefined, input);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.sessions.lists });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.sessions.byId("s") });
  });

  it("invalidates only upload directory, its index and git status", async () => {
    const { options, invalidate } = invalidationHarness({ uploaded: ["a"], skipped: [] });
    const input = { directory: "/repo", files: [new File(["x"], "a")] };
    const mutation = options.files.upload();
    await mutation.mutationFn(input); await mutation.onSuccess(undefined, input);
    expect(invalidate.mock.calls.map((call) => call[0])).toEqual([
      { queryKey: queryKeys.files.list("/repo") },
      { queryKey: queryKeys.files.indexRoot("/repo") },
      { queryKey: queryKeys.git.status("/repo") },
    ]);
  });

  it("invalidates the affected worktree list and cwd roots", async () => {
    const { options, invalidate } = invalidationHarness({ path: "/wt", branch: "b" });
    const input = { cwd: "/repo", branch: "b" };
    const mutation = options.worktrees.create();
    await mutation.mutationFn(input); await mutation.onSuccess(undefined, input);
    expect(invalidate.mock.calls.map((call) => call[0])).toEqual([
      { queryKey: queryKeys.worktrees.list("/repo") },
      { queryKey: queryKeys.cwd.roots() },
    ]);
  });

  it("retains gate/cwd invalidation and has no D3B catalog mutation domains", async () => {
    const { options, invalidate } = invalidationHarness({ ok: true });
    await options.gate.login().onSuccess();
    expect(invalidate.mock.calls.map((call) => call[0])).toEqual([
      { queryKey: queryKeys.gate.all },
      { queryKey: queryKeys.capabilities.all },
    ]);

    invalidate.mockClear();
    await options.cwd.validate().onSuccess();
    expect(invalidate.mock.calls.map((call) => call[0])).toEqual([
      { queryKey: queryKeys.cwd.all },
    ]);

    // Frozen: no models/skills/plugins/auth catalog mutations.
    expect(options).not.toHaveProperty("models");
    expect(options).not.toHaveProperty("skills");
    expect(options).not.toHaveProperty("plugins");
    expect(options).not.toHaveProperty("auth");
  });
});
