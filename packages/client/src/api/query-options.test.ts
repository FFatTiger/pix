import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { createHttpClient } from "./http-client";
import { createMutationOptions } from "./mutations";
import { createQueryOptions, queryKeys } from "./query-keys";

function json(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }); }
const session = { sessionId: "s", cwd: "/repo", projectRoot: "/repo", workspaceAccess: { state: "authorized", reason: "allowed_root" } };

function invalidationHarness(body: unknown) {
  const http = createHttpClient({ fetchImpl: vi.fn().mockResolvedValue(json(body, 201)) as unknown as typeof fetch });
  const queryClient = new QueryClient();
  const invalidate = vi.spyOn(queryClient, "invalidateQueries").mockResolvedValue(undefined);
  return { options: createMutationOptions(http, queryClient), invalidate };
}

describe("query keys and options", () => {
  it("uses stable hierarchical keys including cwd and provider id", () => {
    expect(queryKeys.sessions.page(2, 50, "/repo")).toEqual(queryKeys.sessions.page(2, 50, "/repo"));
    expect(queryKeys.projects.page(1, 10)).not.toEqual(queryKeys.projects.page(2, 10));
    expect(queryKeys.sessions.detail("s").slice(0, 4)).toEqual(queryKeys.sessions.byId("s"));
    expect(queryKeys.files.read("/a")).not.toEqual(queryKeys.files.read("/b"));
    expect(queryKeys.models.list()).toEqual(["pix", "models", "list"]);
    expect(queryKeys.skills.list("/repo")).toEqual(["pix", "skills", "list", "/repo"]);
    expect(queryKeys.plugins.list("/repo")).toEqual(["pix", "plugins", "list", "/repo"]);
    expect(queryKeys.commands.list("/repo")).toEqual(["pix", "commands", "list", "/repo"]);
    expect(queryKeys.trust.get("/repo")).toEqual(["pix", "trust", "get", "/repo"]);
    expect(queryKeys.auth.providerStatus("openai")).toEqual(["pix", "auth", "provider-status", "openai"]);
    expect(queryKeys.auth.providerStatus("a")).not.toEqual(queryKeys.auth.providerStatus("b"));
    expect(queryKeys.settings.sessionIdleTimeout()).toEqual(["pix", "settings", "session-idle-timeout"]);
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

  it("read/meta keys and options preserve the optional session scope", async () => {
    expect(queryKeys.files.read("/a")).toEqual(["pix", "files", "read", "/a", null]);
    expect(queryKeys.files.read("/a", "s1")).toEqual(["pix", "files", "read", "/a", "s1"]);
    expect(queryKeys.files.read("/a", "s1")).not.toEqual(queryKeys.files.read("/a"));
    expect(queryKeys.files.meta("/a", "s2")).toEqual(["pix", "files", "meta", "/a", "s2"]);

    const fetchImpl = vi.fn().mockResolvedValue(json({ content: "x", language: "text", size: 1 }));
    const http = createHttpClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const option = createQueryOptions(http).files.read("/a", "s1");
    expect(option.queryKey).toEqual(["pix", "files", "read", "/a", "s1"]);
    await option.queryFn!({ signal: new AbortController().signal } as never);
    expect(fetchImpl).toHaveBeenCalledWith(
      "/v1/files?path=%2Fa&op=read&sessionId=s1",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("parses Protocol session DTOs and rejects a deep mismatch", async () => {
    const valid = { sessions: [session], page: 1, pageSize: 50, total: 1, totalPages: 1, catalogRevision: 4 };
    const fetchImpl = vi.fn().mockResolvedValueOnce(json(valid)).mockResolvedValueOnce(json({ ...valid, sessions: [{ ...session, messageCount: -1 }] }));
    const http = createHttpClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const option = createQueryOptions(http).sessions.page(1, 50, { cwd: "/repo" });
    await expect(option.queryFn!({ signal: new AbortController().signal } as never)).resolves.toEqual(valid);
    await expect(option.queryFn!({ signal: new AbortController().signal } as never)).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("session/project page options are independent and issue one numbered request", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json({ sessions: [session], page: 1, pageSize: 50, total: 1, totalPages: 1, catalogRevision: 4 }));
    const http = createHttpClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const options = createQueryOptions(http);

    const byCwd = options.sessions.page(2, 50, { cwd: "/repo" });
    expect(byCwd.staleTime).toBe(30_000);
    expect(byCwd.queryKey).toEqual(["pix", "sessions", "page", 2, 50, "/repo", null]);
    const signal = new AbortController().signal;
    await byCwd.queryFn!({ signal } as never);
    expect(fetchImpl).toHaveBeenCalledWith(
      "/v1/sessions?page=2&pageSize=50&cwd=%2Frepo",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("models options are global and always enabled; cwd catalogs require cwd", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json({
      models: [{ id: "m", provider: "p" }],
      defaultModel: null,
    }));
    const http = createHttpClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const options = createQueryOptions(http);

    // Models are a GLOBAL read-only catalog: no cwd identity in the key or
    // URL, and the option carries no `enabled:false` gate (callers gate on
    // the `models` capability).
    const models = options.models.list();
    expect(models.enabled ?? true).toBe(true);
    expect(models.staleTime).toBe(15_000);
    expect(models.retry).toBe(false);

    const signal = new AbortController().signal;
    await models.queryFn!({ signal } as never);
    expect(fetchImpl).toHaveBeenCalledWith(
      "/v1/models",
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
    const { options, invalidate } = invalidationHarness({ success: true });
    const mutation = options.sessions.rename();
    const input = { id: "s", name: "new" };
    await mutation.mutationFn(input); await mutation.onSuccess(undefined, input);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.sessions.lists });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.sessions.byId("s") });
  });

  it("rename success primes cached list/detail titles BEFORE invalidation (best available order)", async () => {
    // A stale refetch (old title) cannot roll back the just-renamed title as
    // long as the invalidation resolves after the cache primer — and the Host
    // + sessiond overlay (§51) makes the refetch converge to the new title.
    // Exact limitation: the client query model has no optimistic revision
    // merge, so an in-flight refetch that resolved BEFORE the overlay published
    // could still momentarily show the old title; the primer closes the
    // mutation→refetch window and is the best available ordering.
    const http = createHttpClient({ fetchImpl: vi.fn().mockResolvedValue(json({ success: true })) as unknown as typeof fetch });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const listKey = queryKeys.sessions.page(1, 50, "/repo");
    const detailKey = queryKeys.sessions.detail("s");
    // Pre-populate the current query scopes with the OLD title.
    queryClient.setQueryData(listKey, { sessions: [{ ...session, title: "Old" }], page: 1, pageSize: 50, total: 1, totalPages: 1, catalogRevision: 1 });
    queryClient.setQueryData(detailKey, { session: { ...session, title: "Old", entries: [] } });
    const invalidate = vi.spyOn(queryClient, "invalidateQueries").mockResolvedValue(undefined);
    const mutation = createMutationOptions(http, queryClient).sessions.rename();
    await mutation.mutationFn({ id: "s", name: "New" });
    await mutation.onSuccess({ success: true }, { id: "s", name: "New" });
    // The cached list + detail titles are primed with the new name immediately.
    const list = queryClient.getQueryData<{ sessions: Array<{ sessionId: string; title?: string; cwd: string; projectRoot: string }> }>(listKey);
    expect(list?.sessions[0]?.title).toBe("New");
    const detail = queryClient.getQueryData<{ session: { sessionId: string; title?: string } }>(detailKey);
    expect(detail?.session.title).toBe("New");
    // Only the title field is written — path/id/timestamps/counts are preserved.
    expect(list?.sessions[0]).toMatchObject({ sessionId: "s", cwd: "/repo", projectRoot: "/repo" });
    // Invalidation still runs for the relevant list/detail scopes.
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.sessions.lists });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.sessions.byId("s") });
    // A different session in the same cached list is untouched.
    queryClient.setQueryData(listKey, { sessions: [{ ...session, sessionId: "other", title: "Keep" }], page: 1, pageSize: 50, total: 1, totalPages: 1, catalogRevision: 1 });
    const mutation2 = createMutationOptions(http, queryClient).sessions.rename();
    await mutation2.onSuccess({ success: true }, { id: "s", name: "Other-new" });
    const list2 = queryClient.getQueryData<{ sessions: Array<{ sessionId: string; title?: string }> }>(listKey);
    expect(list2?.sessions[0]).toMatchObject({ sessionId: "other", title: "Keep" });
  });

  it("upload success invalidates every files/git/index/viewer query", async () => {
    const { options, invalidate } = invalidationHarness({ uploaded: ["a"], skipped: [], errors: [] });
    const input = { directory: "/repo", files: [new File(["x"], "a")] };
    const mutation = options.files.upload();
    await mutation.mutationFn(input); await mutation.onSuccess();
    // One remote-state authority: the whole files (list/meta/read/index) and
    // git (status/diff) domains invalidate, so subdirectory listings, the
    // search index and every open viewer path refetch on upload success.
    expect(invalidate.mock.calls.map((call) => call[0])).toEqual([
      { queryKey: queryKeys.files.all },
      { queryKey: queryKeys.git.all },
    ]);
  });

  it("invalidates the affected worktree list and cwd roots", async () => {
    const { options, invalidate } = invalidationHarness({ path: "/wt", branch: "b", managedByPix: true });
    const input = { cwd: "/repo", branch: "b" };
    const mutation = options.worktrees.create();
    await mutation.mutationFn(input); await mutation.onSuccess(undefined, input);
    expect(invalidate.mock.calls.map((call) => call[0])).toEqual([
      { queryKey: queryKeys.worktrees.list("/repo") },
      { queryKey: queryKeys.cwd.roots() },
      { queryKey: queryKeys.projects.all },
    ]);
  });

  it("invalidates the trust summary and every trust-gated catalog after set-trusted", async () => {
    const body = { cwd: "/repo", level: "trusted", trusted: true, canReloadResources: { allowed: true, level: "trusted" } };
    const { options, invalidate } = invalidationHarness(body);
    const input = { cwd: "/repo" };
    const mutation = options.trust.setTrusted();
    await mutation.mutationFn(input);
    await mutation.onSuccess(undefined, input);
    expect(invalidate.mock.calls.map((call) => call[0])).toEqual([
      { queryKey: queryKeys.trust.get("/repo") },
      { queryKey: queryKeys.skills.list("/repo") },
      { queryKey: queryKeys.plugins.list("/repo") },
      { queryKey: queryKeys.commands.list("/repo") },
    ]);
    // Other cwd scopes and unrelated domains are untouched.
    for (const call of invalidate.mock.calls) {
      const key = (call[0] as { queryKey: readonly unknown[] }).queryKey;
      expect(key).not.toEqual(queryKeys.trust.get("/other"));
      expect(key).not.toEqual(queryKeys.sessions.lists);
    }
  });

  it("retains gate/cwd invalidation and exposes only the models.json + trust catalog mutations", async () => {
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

    // Models exposes only the global models.json save; skills/plugins/auth
    // remain read-only. Trust remains its independent single-method mutation.
    expect(Object.keys(options.models)).toEqual(["saveConfig", "discover"]);
    expect(options).not.toHaveProperty("skills");
    expect(options).not.toHaveProperty("plugins");
    expect(options).not.toHaveProperty("auth");
    expect(Object.keys(options.trust)).toEqual(["setTrusted"]);
    expect(Object.keys(options.settings)).toEqual(["sessionIdleTimeout", "saveConfigFile"]);
  });

  it("invalidates the session idle-timeout settings key after a successful write", async () => {
    const { options, invalidate } = invalidationHarness({ idleTimeoutMs: 3_600_000 });
    const mutation = options.settings.sessionIdleTimeout();
    await mutation.mutationFn(3_600_000);
    await mutation.onSuccess();
    expect(invalidate.mock.calls.map((call) => call[0])).toEqual([
      { queryKey: queryKeys.settings.all },
    ]);
  });
});
