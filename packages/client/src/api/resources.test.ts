import { describe, expect, it, vi } from "vitest";
import { createHttpClient } from "./http-client";
import { createResourcesApi } from "./resources";
import { createConfigurationApi } from "./configuration";

function json(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }); }

describe("resource APIs", () => {
  it("encodes paths for file, git and worktree requests", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(json({ content: "x", language: "text", size: 1 })).mockResolvedValueOnce(json({ supported: false })).mockResolvedValueOnce(json({ projectRoot: "/repo", isGit: true, isTopLevel: true, worktrees: [] }));
    const api = createResourcesApi(createHttpClient({ fetchImpl: fetchImpl as unknown as typeof fetch }));
    await api.files.read("/tmp/a b#c");
    await api.git.diff("/repo a", "/repo a/x&y");
    await api.worktrees.list("/repo?a=b");
    expect(fetchImpl.mock.calls.map((call) => call[0])).toEqual([
      "/v1/files?path=%2Ftmp%2Fa+b%23c&op=read",
      "/v1/git/diff?cwd=%2Frepo+a&path=%2Frepo+a%2Fx%26y",
      "/v1/worktrees?cwd=%2Frepo%3Fa%3Db",
    ]);
  });

  it("sends upload FormData without forcing JSON content type", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json({ uploaded: ["a.txt"], skipped: [] }, 201));
    const api = createResourcesApi(createHttpClient({ fetchImpl: fetchImpl as unknown as typeof fetch }));
    await api.files.upload({ directory: "/tmp", files: [new File(["x"], "a.txt")] });
    const init = fetchImpl.mock.calls[0]?.[1] as RequestInit;
    expect(init.body).toBeInstanceOf(FormData);
    expect(new Headers(init.headers).has("Content-Type")).toBe(false);
  });

  it("passes raw/download responses without invoking JSON parsing", async () => {
    const source = new Response("abc", { status: 206, headers: { "Content-Range": "bytes 0-2/3" } });
    const raw = new Response("\u0000binary", { status: 200, headers: { "Content-Type": "application/octet-stream" } });
    const fetchImpl = vi.fn().mockResolvedValueOnce(source).mockResolvedValueOnce(raw);
    const api = createResourcesApi(createHttpClient({ fetchImpl: fetchImpl as unknown as typeof fetch }));
    await expect(api.files.download("/tmp/a", "bytes=0-2")).resolves.toBe(source);
    await expect(api.files.preview("/tmp/a")).resolves.toMatchObject({ size: 7 });
    expect((fetchImpl.mock.calls[0]?.[1] as RequestInit).headers).toMatchObject({ Range: "bytes=0-2" });
  });
});

describe("configuration APIs", () => {
  it("never places API keys or OAuth codes in URLs", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(json({ ok: true }))
      .mockResolvedValueOnce(json({ ok: true }));
    const api = createConfigurationApi(createHttpClient({ fetchImpl: fetchImpl as unknown as typeof fetch }));
    await api.auth.apiKey("a/b", "sk-secret");
    await api.auth.finishLogin("a/b", "oauth-code");
    const urls = fetchImpl.mock.calls.map((call) => String(call[0]));
    expect(urls).toEqual(["/v1/auth/api-key/a%2Fb", "/v1/auth/login/a%2Fb"]);
    expect(urls.join(" ")).not.toMatch(/secret|oauth-code/);
    expect((fetchImpl.mock.calls[0]?.[1] as RequestInit).body).toBe('{"apiKey":"sk-secret"}');
  });
});
