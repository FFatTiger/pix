import { describe, expect, it } from "vitest";
import { assertV1Path, urls, v1Url } from "./urls";

describe("v1 URL builders", () => {
  it("builds and encodes path segments", () => {
    expect(v1Url("gate", "status")).toBe("/v1/gate/status");
    expect(urls.bootstrap()).toBe("/v1/bootstrap");
    expect(urls.sessions.byId("a/b ?#")).toBe("/v1/sessions/a%2Fb%20%3F%23");
    expect(urls.sessions.list({ page: 3, pageSize: 50, cwd: "/repo x" })).toBe("/v1/sessions?page=3&pageSize=50&cwd=%2Frepo+x");
    expect(urls.projects.list({ page: 2, pageSize: 10 })).toBe("/v1/projects?page=2&pageSize=10");
    expect(urls.sessions.thinking("s/1", "e/2", 3)).toBe("/v1/sessions/s%2F1/entries/e%2F2/thinking?blockIndex=3");
    expect(urls.sessions.context("s1", { deferThinking: true, deferMedia: true })).toBe("/v1/sessions/s1/context?deferThinking=1&deferMedia=1");
    expect(urls.sessions.context("s1", { leafId: "l1", deferThinking: true })).toBe("/v1/sessions/s1/context?leafId=l1&deferThinking=1");
    expect(urls.sessions.context("s1")).toBe("/v1/sessions/s1/context");
  });

  it("encodes cwd and file paths as query values", () => {
    expect(urls.files.resource("/tmp/a b#c", "read")).toBe("/v1/files?path=%2Ftmp%2Fa+b%23c&op=read");
    expect(urls.files.watch("/tmp/a b#c")).toBe("/v1/files/watch?path=%2Ftmp%2Fa+b%23c");
    expect(urls.git.diff("/repo x", "/repo x/a&b")).toBe("/v1/git/diff?cwd=%2Frepo+x&path=%2Frepo+x%2Fa%26b");
    expect(urls.worktrees.list("/repo?a=b")).toBe("/v1/worktrees?cwd=%2Frepo%3Fa%3Db");
  });

  it("builds D3B catalog URLs with required cwd and encoded provider id", () => {
    expect(urls.models.list()).toBe("/v1/models");
    expect(urls.models.config()).toBe("/v1/models/config");
    expect(urls.models.discover()).toBe("/v1/models/discover");
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

  it("exports only the mounted model-config mutation and no other removed catalog paths", () => {
    const catalog = urls as Record<string, unknown>;
    expect(catalog).not.toHaveProperty("models-config");
    expect(Object.keys(urls.models)).toEqual(["list", "config", "discover"]);
    expect(Object.keys(urls.skills)).toEqual(["list"]);
    expect(Object.keys(urls.plugins)).toEqual(["list"]);
    expect(Object.keys(urls.auth)).toEqual(["providers", "providerStatus"]);
    expect(urls).toHaveProperty("commands");
    expect(urls).toHaveProperty("trust");
    // legacy mutation builders must not exist
    expect(urls.models).toHaveProperty("config");
    expect(urls.models).not.toHaveProperty("catalog");
    expect(urls.models).toHaveProperty("discover");
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
