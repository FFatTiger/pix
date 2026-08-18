import { describe, expect, it } from "vitest";
import { assertV1Path, urls, v1Url } from "./urls";

describe("v1 URL builders", () => {
  it("builds and encodes path segments", () => {
    expect(v1Url("gate", "status")).toBe("/v1/gate/status");
    expect(urls.bootstrap()).toBe("/v1/bootstrap");
    expect(urls.sessions.byId("a/b ?#")).toBe("/v1/sessions/a%2Fb%20%3F%23");
    expect(urls.sessions.thinking("s/1", "e/2")).toBe("/v1/sessions/s%2F1/entries/e%2F2/thinking");
  });

  it("encodes cwd and file paths as query values", () => {
    expect(urls.files.resource("/tmp/a b#c", "read")).toBe("/v1/files?path=%2Ftmp%2Fa+b%23c&op=read");
    expect(urls.files.watch("/tmp/a b#c")).toBe("/v1/files/watch?path=%2Ftmp%2Fa+b%23c");
    expect(urls.git.diff("/repo x", "/repo x/a&b")).toBe("/v1/git/diff?cwd=%2Frepo+x&path=%2Frepo+x%2Fa%26b");
    expect(urls.worktrees.list("/repo?a=b")).toBe("/v1/worktrees?cwd=%2Frepo%3Fa%3Db");
  });

  it("builds D3B catalog URLs with required cwd and encoded provider id", () => {
    expect(urls.models.list("/repo a")).toBe("/v1/models?cwd=%2Frepo+a");
    expect(urls.skills.list("/repo?x=1")).toBe("/v1/skills?cwd=%2Frepo%3Fx%3D1");
    expect(urls.plugins.list("/tmp/a b")).toBe("/v1/plugins?cwd=%2Ftmp%2Fa+b");
    expect(urls.commands.list("/proj#1")).toBe("/v1/commands?cwd=%2Fproj%231");
    expect(urls.trust.get("/proj/x")).toBe("/v1/trust?cwd=%2Fproj%2Fx");
    // Trust mutation (POST): the bare resource, body carries {cwd, level}.
    expect(urls.trust.mutate()).toBe("/v1/trust");
    expect(urls.auth.providers()).toBe("/v1/auth/providers");
    expect(urls.auth.providerStatus("a/b ?#")).toBe("/v1/auth/providers/a%2Fb%20%3F%23/status");
    expect(urls.settings.sessionIdleTimeout()).toBe("/v1/settings/session-idle-timeout");
  });

  it("does not export removed catalog mutation paths", () => {
    const catalog = urls as Record<string, unknown>;
    expect(catalog).not.toHaveProperty("models-config");
    // models is read-only list only
    expect(Object.keys(urls.models)).toEqual(["list"]);
    expect(Object.keys(urls.skills)).toEqual(["list"]);
    expect(Object.keys(urls.plugins)).toEqual(["list"]);
    expect(Object.keys(urls.auth)).toEqual(["providers", "providerStatus"]);
    expect(urls).toHaveProperty("commands");
    expect(urls).toHaveProperty("trust");
    // legacy mutation builders must not exist
    expect(urls.models).not.toHaveProperty("config");
    expect(urls.models).not.toHaveProperty("catalog");
    expect(urls.models).not.toHaveProperty("discover");
    expect(urls.models).not.toHaveProperty("test");
    expect(urls.skills).not.toHaveProperty("search");
    expect(urls.skills).not.toHaveProperty("install");
    expect(urls.skills).not.toHaveProperty("update");
    expect(urls.skills).not.toHaveProperty("toggle");
    expect(urls.plugins).not.toHaveProperty("mutate");
    expect(urls.auth).not.toHaveProperty("allProviders");
    expect(urls.auth).not.toHaveProperty("apiKey");
    expect(urls.auth).not.toHaveProperty("login");
    expect(urls.auth).not.toHaveProperty("logout");
  });
});

describe("assertV1Path", () => {
  it("accepts only root-relative same-origin v1 paths", () => {
    expect(() => assertV1Path("/v1")).not.toThrow();
    expect(() => assertV1Path("/v1/x?q=1")).not.toThrow();
    const legacy = ["", "api", "x"].join("/");
    for (const value of [legacy, "/v2/x", "v1/x", "https://evil.test/v1/x", "//evil.test/v1/x"]) {
      expect(() => assertV1Path(value)).toThrow(/Only \/v1/);
    }
  });
});
