import { z } from "zod";
import { describe, expect, it, vi } from "vitest";
import { HttpError, buildLoginRedirect, createHttpClient } from "./http-client";

function response(body: unknown, status = 200, statusText = "") {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, statusText, headers: { "Content-Type": "application/json" } });
}

describe("HttpError", () => {
  it("supports legacy construction and flags 401", () => {
    const error = new HttpError(401, "/v1/gate/status", "Unauthorized");
    expect(error.isUnauthorized).toBe(true);
    expect(error.kind).toBe("http");
  });
});

describe("createHttpClient", () => {
  it("rejects non-v1 and cross-origin paths before fetch", async () => {
    const fetchImpl = vi.fn();
    const http = createHttpClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const legacy = ["", "api", "gate", "status"].join("/");
    await expect(http.get(legacy)).rejects.toThrow(/Only \/v1/);
    await expect(http.get("https://evil.example/v1/x")).rejects.toThrow(/Only \/v1/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("strictly parses a schema and rejects malformed JSON or shape", async () => {
    const schema = z.strictObject({ ok: z.literal(true) });
    const valid = createHttpClient({ fetchImpl: vi.fn().mockResolvedValue(response({ ok: true })) as unknown as typeof fetch });
    await expect(valid.get("/v1/x", { schema })).resolves.toEqual({ ok: true });
    const malformed = createHttpClient({ fetchImpl: vi.fn().mockResolvedValue(response("{")) as unknown as typeof fetch });
    await expect(malformed.get("/v1/x", { schema })).rejects.toMatchObject({ kind: "decode" });
    const mismatch = createHttpClient({ fetchImpl: vi.fn().mockResolvedValue(response({ ok: false })) as unknown as typeof fetch });
    await expect(mismatch.get("/v1/x", { schema })).rejects.toMatchObject({ kind: "decode", code: "INVALID_RESPONSE" });
  });

  it.each([401, 403, 404, 409, 413, 429, 503])("normalizes HTTP %s", async (status) => {
    const http = createHttpClient({ fetchImpl: vi.fn().mockResolvedValue(response({ message: `status-${status}`, code: "E", retryAfterSeconds: 4 }, status)) as unknown as typeof fetch });
    await expect(http.get("/v1/x", { skipAuthRedirect: true })).rejects.toMatchObject({ status, code: "E", message: `status-${status}`, retryAfterSeconds: 4 });
  });

  it("coalesces concurrent 401 navigation until a successful request", async () => {
    const onUnauthorized = vi.fn();
    const fetchImpl = vi.fn().mockResolvedValueOnce(response({ message: "auth" }, 401)).mockResolvedValueOnce(response({ message: "auth" }, 401)).mockResolvedValueOnce(response({ ok: true })).mockResolvedValueOnce(response({ message: "auth" }, 401));
    const http = createHttpClient({ fetchImpl: fetchImpl as unknown as typeof fetch, onUnauthorized });
    await Promise.allSettled([http.get("/v1/a"), http.get("/v1/b")]);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    await http.get("/v1/success");
    await expect(http.get("/v1/c")).rejects.toBeInstanceOf(HttpError);
    expect(onUnauthorized).toHaveBeenCalledTimes(2);
  });

  it("skips auth redirect for login", async () => {
    const onUnauthorized = vi.fn();
    const http = createHttpClient({ fetchImpl: vi.fn().mockResolvedValue(response({}, 401)) as unknown as typeof fetch, onUnauthorized });
    await expect(http.post("/v1/gate/login", {}, { skipAuthRedirect: true })).rejects.toBeInstanceOf(HttpError);
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it("distinguishes abort, timeout and network failure", async () => {
    const aborted = new AbortController(); aborted.abort();
    const hanging: typeof fetch = vi.fn((_input, init) => new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("abort", "AbortError")), { once: true }))) as unknown as typeof fetch;
    const http = createHttpClient({ fetchImpl: hanging, timeoutMs: 5 });
    await expect(http.get("/v1/x", { signal: aborted.signal })).rejects.toMatchObject({ kind: "aborted" });
    await expect(http.get("/v1/x")).rejects.toMatchObject({ kind: "timeout" });
    const offline = createHttpClient({ fetchImpl: vi.fn().mockRejectedValue(new TypeError("offline")) as unknown as typeof fetch });
    await expect(offline.get("/v1/x")).rejects.toMatchObject({ kind: "network" });
  });

  it("uses same-origin credentials, JSON bodies, raw bodies and response modes", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(response({ ok: true })).mockResolvedValueOnce(new Response("hello")).mockResolvedValueOnce(new Response("blob"));
    const http = createHttpClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
    await http.post("/v1/x", { value: 1 });
    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({ credentials: "same-origin", body: '{"value":1}' });
    await expect(http.get<string>("/v1/text", { responseMode: "text" })).resolves.toBe("hello");
    const blob = await http.get<Blob>("/v1/blob", { responseMode: "blob" });
    expect(blob.size).toBe(4);
    expect(blob.type).toContain("text/plain");
  });
});

describe("buildLoginRedirect", () => {
  it("preserves path + search and avoids login loops", () => {
    expect(buildLoginRedirect("/?session=a&cwd=%2Frepo")).toBe("/login?next=%2F%3Fsession%3Da%26cwd%3D%252Frepo");
    expect(buildLoginRedirect("/login")).toBe("/login");
  });
});
