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
  it("uses stable hierarchical keys", () => {
    expect(queryKeys.sessions.list("/repo")).toEqual(queryKeys.sessions.list("/repo"));
    expect(queryKeys.sessions.detail("s").slice(0, 4)).toEqual(queryKeys.sessions.byId("s"));
    expect(queryKeys.files.read("/a")).not.toEqual(queryKeys.files.read("/b"));
  });

  it("parses Protocol session DTOs and rejects a deep mismatch", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(json({ sessions: [session], revision: 4 })).mockResolvedValueOnce(json({ sessions: [{ ...session, messageCount: -1 }] }));
    const http = createHttpClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const option = createQueryOptions(http).sessions.list("/repo");
    await expect(option.queryFn!({ signal: new AbortController().signal } as never)).resolves.toEqual({ sessions: [session], revision: 4 });
    await expect(option.queryFn!({ signal: new AbortController().signal } as never)).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
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

  it("audits the remaining mutation domains with precise invalidation plans", async () => {
    const { options, invalidate } = invalidationHarness({ ok: true });
    const cases = [
      { run: () => options.gate.login().onSuccess(), expected: [queryKeys.gate.all, queryKeys.capabilities.all] },
      { run: () => options.models.saveConfig().onSuccess(), expected: [queryKeys.models.all] },
      { run: () => options.cwd.validate().onSuccess(), expected: [queryKeys.cwd.all] },
      { run: () => options.skills.toggle().onSuccess(), expected: [queryKeys.skills.all] },
      { run: () => options.plugins.mutate().onSuccess(), expected: [queryKeys.plugins.all] },
      { run: () => options.auth.logout().onSuccess(), expected: [queryKeys.auth.statuses(), queryKeys.models.lists] },
    ];
    for (const entry of cases) {
      invalidate.mockClear();
      await entry.run();
      expect(invalidate.mock.calls.map((call) => call[0])).toEqual(entry.expected.map((queryKey) => ({ queryKey })));
    }
  });

  it("auth mutation invalidates statuses and model lists without caching secrets", async () => {
    const { options, invalidate } = invalidationHarness({ ok: true });
    const input = { provider: "p", apiKey: "sk-secret" };
    const mutation = options.auth.apiKey();
    await mutation.mutationFn(input); await mutation.onSuccess();
    expect(invalidate.mock.calls.map((call) => call[0])).toEqual([
      { queryKey: queryKeys.auth.statuses() },
      { queryKey: queryKeys.models.lists },
    ]);
    expect(JSON.stringify(mutation.mutationKey)).not.toContain(input.apiKey);
    expect(JSON.stringify(queryKeys)).not.toContain(input.apiKey);
  });
});
