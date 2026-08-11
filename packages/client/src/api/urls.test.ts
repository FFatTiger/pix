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
    expect(urls.git.diff("/repo x", "/repo x/a&b")).toBe("/v1/git/diff?cwd=%2Frepo+x&path=%2Frepo+x%2Fa%26b");
    expect(urls.worktrees.list("/repo?a=b")).toBe("/v1/worktrees?cwd=%2Frepo%3Fa%3Db");
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
