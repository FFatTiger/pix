import { describe, expect, it, vi } from "vitest";
import { createHttpClient } from "./http-client";
import { createResourcesApi } from "./resources";
import {
  WorktreeCreateResponseSchema,
  WorktreeDeleteResponseSchema,
  WorktreeInfoSchema,
} from "./schemas";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("client Worktree schema contract (D3A managed-worktree)", () => {
  it("WorktreeInfoSchema strictly requires managedByPix (boolean)", () => {
    expect(
      WorktreeInfoSchema.safeParse({ path: "/w", branch: "b", isMain: false, authorized: true, managedByPix: true }).success,
    ).toBe(true);
    // Missing managedByPix ⇒ rejected (strict).
    expect(
      WorktreeInfoSchema.safeParse({ path: "/w", branch: "b", isMain: false, authorized: true }).success,
    ).toBe(false);
    // External/legacy entries must carry managedByPix:false explicitly.
    expect(
      WorktreeInfoSchema.safeParse({ path: "/w", branch: null, isMain: true, authorized: true, managedByPix: false }).success,
    ).toBe(true);
  });

  it("create response parses managedByPix:true and rejects false/missing", async () => {
    expect(WorktreeCreateResponseSchema.safeParse({ path: "/w", branch: "b", managedByPix: true }).success).toBe(true);
    expect(WorktreeCreateResponseSchema.safeParse({ path: "/w", branch: "b", managedByPix: false }).success).toBe(false);
    expect(WorktreeCreateResponseSchema.safeParse({ path: "/w", branch: "b" }).success).toBe(false);

    const fetchImpl = vi.fn().mockResolvedValue(json({ path: "/w", branch: "b", managedByPix: true }, 201));
    const api = createResourcesApi(createHttpClient({ fetchImpl: fetchImpl as unknown as typeof fetch }));
    const result = await api.worktrees.create({ cwd: "/repo", branch: "b" });
    expect(result).toEqual({ path: "/w", branch: "b", managedByPix: true });

    const bad = vi.fn().mockResolvedValue(json({ path: "/w", branch: "b", managedByPix: false }, 201));
    const badApi = createResourcesApi(createHttpClient({ fetchImpl: bad as unknown as typeof fetch }));
    await expect(badApi.worktrees.create({ cwd: "/repo", branch: "b" })).rejects.toThrow();
  });

  it("delete response parses fallbackCwd + branchRetained and rejects missing fields", async () => {
    expect(
      WorktreeDeleteResponseSchema.safeParse({ success: true, fallbackCwd: "/main", branchRetained: true }).success,
    ).toBe(true);
    expect(WorktreeDeleteResponseSchema.safeParse({ success: true, fallbackCwd: "/main" }).success).toBe(false);
    expect(WorktreeDeleteResponseSchema.safeParse({ success: true, branchRetained: true }).success).toBe(false);
    expect(WorktreeDeleteResponseSchema.safeParse({ success: false, fallbackCwd: "/main", branchRetained: true }).success).toBe(false);

    const fetchImpl = vi.fn().mockResolvedValue(json({ success: true, fallbackCwd: "/main", branchRetained: true }));
    const api = createResourcesApi(createHttpClient({ fetchImpl: fetchImpl as unknown as typeof fetch }));
    const result = await api.worktrees.remove({ cwd: "/repo", path: "/w", force: true });
    expect(result).toEqual({ success: true, fallbackCwd: "/main", branchRetained: true });
    expect((fetchImpl.mock.calls[0]?.[1] as RequestInit).method).toBe("DELETE");
    expect(JSON.parse(String((fetchImpl.mock.calls[0]?.[1] as RequestInit).body))).toEqual({ cwd: "/repo", path: "/w", force: true });

    const bad = vi.fn().mockResolvedValue(json({ success: true, fallbackCwd: "/main" }));
    const badApi = createResourcesApi(createHttpClient({ fetchImpl: bad as unknown as typeof fetch }));
    await expect(badApi.worktrees.remove({ cwd: "/repo", path: "/w" })).rejects.toThrow();
  });
});
