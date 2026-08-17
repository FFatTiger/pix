import { describe, expect, it, vi } from "vitest";
import { createHttpClient } from "./http-client";
import { createResourcesApi, UploadConflictError } from "./resources";
import { createConfigurationApi } from "./configuration";
import { createModelsApi } from "./models";

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
    const fetchImpl = vi.fn().mockResolvedValue(json({ uploaded: ["a.txt"], skipped: [], errors: [] }, 201));
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

  it("encodes cwd + q for the file index, enforces the strict matches shape and passes signal", async () => {
    const signal = new AbortController().signal;
    const ok = json({ matches: [{ path: "src/a.ts", isDir: false }], truncated: false });
    const bad = json({ matches: [{ path: "a.ts", isDir: true }], truncated: false });
    const fetchImpl = vi.fn().mockResolvedValueOnce(ok).mockResolvedValueOnce(bad);
    const http = createHttpClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const api = createResourcesApi(http);
    await expect(api.files.index("/proj a", "foo bar", signal)).resolves.toEqual({
      matches: [{ path: "src/a.ts", isDir: false }],
      truncated: false,
    });
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe("/v1/file-index?cwd=%2Fproj+a&q=foo+bar");
    expect((fetchImpl.mock.calls[0]?.[1] as RequestInit).signal).toBeInstanceOf(AbortSignal);
    // The schema is strict: isDir must be literal false (files only, no dirs).
    await expect(api.files.index("/proj", "x", signal)).rejects.toMatchObject({ kind: "decode", code: "INVALID_RESPONSE" });
  });
});

describe("catalog configuration APIs", () => {
  it("encodes cwd and provider id for read-only catalog GETs", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(json({ models: [], defaultModel: null }))
      .mockResolvedValueOnce(json({ skills: [] }))
      .mockResolvedValueOnce(json({ plugins: [] }))
      .mockResolvedValueOnce(json({ commands: [] }))
      .mockResolvedValueOnce(json({
        cwd: "/repo a",
        level: "unknown",
        trusted: false,
        canReloadResources: { allowed: false, level: "unknown", reason: "Project resources are not trusted" },
      }))
      .mockResolvedValueOnce(json({ providers: [] }))
      .mockResolvedValueOnce(json({
        status: { providerId: "a/b", authorized: false },
        configured: false,
      }));
    const http = createHttpClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const models = createModelsApi(http);
    const config = createConfigurationApi(http);
    await models.list("/repo a");
    await config.skills.list("/repo a");
    await config.plugins.list("/repo a");
    await config.commands.list("/repo a");
    await config.trust.get("/repo a");
    await config.auth.providers();
    await config.auth.providerStatus("a/b");
    expect(fetchImpl.mock.calls.map((call) => String(call[0]))).toEqual([
      "/v1/models?cwd=%2Frepo+a",
      "/v1/skills?cwd=%2Frepo+a",
      "/v1/plugins?cwd=%2Frepo+a",
      "/v1/commands?cwd=%2Frepo+a",
      "/v1/trust?cwd=%2Frepo+a",
      "/v1/auth/providers",
      "/v1/auth/providers/a%2Fb/status",
    ]);
  });

  it("has no secret-bearing mutation call surface", () => {
    const config = createConfigurationApi(createHttpClient({ fetchImpl: vi.fn() as unknown as typeof fetch }));
    expect(config.auth).not.toHaveProperty("apiKey");
    expect(config.auth).not.toHaveProperty("startLogin");
    expect(config.auth).not.toHaveProperty("finishLogin");
    expect(config.auth).not.toHaveProperty("logout");
    expect(config.skills).not.toHaveProperty("install");
    expect(config.plugins).not.toHaveProperty("mutate");
  });
});

/** Minimal controllable XHR used to exercise the progress-capable upload transport. */
class FakeXHR {
  static instances: FakeXHR[] = [];
  upload = { onprogress: null as ((event: { lengthComputable: boolean; loaded: number; total: number }) => void) | null };
  status = 0;
  responseText = "";
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  openUrl = "";
  open(_method: string, url: string) { this.openUrl = url; }
  send(_body: BodyInit) { FakeXHR.instances.push(this); }
  abort() { this.onabort?.(); }
}

function settleUpload(status: number, body: unknown): void {
  const xhr = FakeXHR.instances[FakeXHR.instances.length - 1]!;
  xhr.status = status;
  xhr.responseText = typeof body === "string" ? body : JSON.stringify(body);
  xhr.onload?.();
}

function stubXhr() {
  FakeXHR.instances = [];
  vi.stubGlobal("XMLHttpRequest", FakeXHR);
}

describe("progress-capable upload transport", () => {
  it("reports progress and validates the success envelope", async () => {
    stubXhr();
    const api = createResourcesApi(createHttpClient({ fetchImpl: vi.fn() as unknown as typeof fetch }));
    const progress: number[] = [];
    const promise = api.files.uploadWithProgress(
      { directory: "/tmp", files: [new File(["x"], "a.txt")], conflict: "error" },
      (p) => progress.push(p.percent),
    );
    const xhr = FakeXHR.instances[0]!;
    expect(xhr.openUrl).toBe("/v1/files?path=%2Ftmp&conflict=error");
    xhr.upload.onprogress?.({ lengthComputable: true, loaded: 40, total: 100 });
    settleUpload(201, { uploaded: ["a.txt"], skipped: [], errors: [] });
    await expect(promise).resolves.toEqual({ uploaded: ["a.txt"], skipped: [], errors: [] });
    expect(progress).toEqual([40]);
  });

  it("rejects a malformed success payload instead of accepting it", async () => {
    stubXhr();
    const api = createResourcesApi(createHttpClient({ fetchImpl: vi.fn() as unknown as typeof fetch }));
    const promise = api.files.uploadWithProgress(
      { directory: "/tmp", files: [new File(["x"], "a.txt")] },
      () => undefined,
    );
    settleUpload(201, { uploaded: "not-an-array", skipped: [], errors: [] });
    await expect(promise).rejects.toMatchObject({ kind: "decode" });
  });

  it("surfaces a 409 FILE_EXISTS as a typed conflict error", async () => {
    stubXhr();
    const api = createResourcesApi(createHttpClient({ fetchImpl: vi.fn() as unknown as typeof fetch }));
    const promise = api.files.uploadWithProgress(
      { directory: "/tmp", files: [new File(["x"], "a.txt")] },
      () => undefined,
    );
    settleUpload(409, { error: "One or more files already exist", code: "FILE_EXISTS", conflicts: ["a.txt"], nonReplaceable: [] });
    const error = await promise.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UploadConflictError);
    expect((error as UploadConflictError).conflicts).toEqual(["a.txt"]);
    expect((error as UploadConflictError).nonReplaceable).toEqual([]);
  });

  it("propagates other HTTP failures as HttpError", async () => {
    stubXhr();
    const api = createResourcesApi(createHttpClient({ fetchImpl: vi.fn() as unknown as typeof fetch }));
    const promise = api.files.uploadWithProgress(
      { directory: "/tmp", files: [new File(["x"], "a.txt")] },
      () => undefined,
    );
    settleUpload(413, { error: "Upload total is too large", code: "UPLOAD_TOO_LARGE" });
    await expect(promise).rejects.toMatchObject({ status: 413, message: "Upload total is too large" });
  });
});
