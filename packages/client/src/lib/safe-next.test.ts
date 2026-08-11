import { describe, expect, it } from "vitest";
import { isMeaningfulNext, resolveSafeNext } from "./safe-next";

const ORIGIN = "http://localhost:5173";

describe("resolveSafeNext", () => {
  it("defaults empty / nullish to home", () => {
    expect(resolveSafeNext(undefined, { baseOrigin: ORIGIN })).toEqual({
      to: "/",
      search: {},
      href: "/",
    });
    expect(resolveSafeNext(null, { baseOrigin: ORIGIN }).href).toBe("/");
    expect(resolveSafeNext("", { baseOrigin: ORIGIN }).href).toBe("/");
    expect(resolveSafeNext("   ", { baseOrigin: ORIGIN }).href).toBe("/");
  });

  it("accepts bare /", () => {
    const target = resolveSafeNext("/", { baseOrigin: ORIGIN });
    expect(target).toEqual({ to: "/", search: {}, href: "/" });
  });

  it("splits pathname and search for session/cwd deep links", () => {
    const target = resolveSafeNext("/?session=abc&cwd=%2Ftmp%2Fproj", {
      baseOrigin: ORIGIN,
    });
    expect(target.to).toBe("/");
    expect(target.search).toEqual({ session: "abc", cwd: "/tmp/proj" });
    expect(target.href).toBe("/?session=abc&cwd=%2Ftmp%2Fproj");
  });

  it("preserves already-decoded query values", () => {
    const target = resolveSafeNext("/?session=s1&cwd=/Users/me/repo", {
      baseOrigin: ORIGIN,
    });
    expect(target.search).toEqual({ session: "s1", cwd: "/Users/me/repo" });
    expect(target.href).toContain("session=s1");
    expect(target.href).toContain("cwd=");
  });

  it("prevents /login redirect loops", () => {
    expect(resolveSafeNext("/login", { baseOrigin: ORIGIN })).toEqual({
      to: "/",
      search: {},
      href: "/",
    });
    expect(
      resolveSafeNext("/login?next=%2F", { baseOrigin: ORIGIN }).href,
    ).toBe("/");
  });

  it("rejects protocol-relative //evil", () => {
    expect(resolveSafeNext("//evil.example/phish", { baseOrigin: ORIGIN })).toEqual({
      to: "/",
      search: {},
      href: "/",
    });
    expect(resolveSafeNext("//evil", { baseOrigin: ORIGIN }).href).toBe("/");
  });

  it("rejects absolute external URLs", () => {
    expect(
      resolveSafeNext("https://evil.example/steal", { baseOrigin: ORIGIN }).href,
    ).toBe("/");
    expect(
      resolveSafeNext("http://evil.example/?session=x", { baseOrigin: ORIGIN })
        .href,
    ).toBe("/");
  });

  it("allows absolute same-origin URLs", () => {
    const target = resolveSafeNext(
      `${ORIGIN}/?session=local&cwd=%2Fapp`,
      { baseOrigin: ORIGIN },
    );
    expect(target.to).toBe("/");
    expect(target.search).toEqual({ session: "local", cwd: "/app" });
  });

  it("rejects non-root-relative paths", () => {
    expect(resolveSafeNext("relative/path", { baseOrigin: ORIGIN }).href).toBe(
      "/",
    );
    expect(resolveSafeNext("./x", { baseOrigin: ORIGIN }).href).toBe("/");
    expect(resolveSafeNext("login", { baseOrigin: ORIGIN }).href).toBe("/");
  });

  it("rejects backslash confusion", () => {
    expect(resolveSafeNext("/\\evil", { baseOrigin: ORIGIN }).href).toBe("/");
  });

  it("maps unknown in-app paths to home without carrying foreign search as next", () => {
    const target = resolveSafeNext("/settings?tab=1", { baseOrigin: ORIGIN });
    expect(target.to).toBe("/");
    // tab is not a workspace key — dropped by parseWorkspaceSearch
    expect(target.search).toEqual({});
    expect(target.href).toBe("/");
  });

  it("drops nested next on workstation targets", () => {
    const target = resolveSafeNext("/?session=a&next=%2Fother", {
      baseOrigin: ORIGIN,
    });
    expect(target.search).toEqual({ session: "a" });
    expect(target.search.next).toBeUndefined();
  });
});

describe("isMeaningfulNext", () => {
  it("is false for home fallback", () => {
    expect(isMeaningfulNext(resolveSafeNext("/", { baseOrigin: ORIGIN }))).toBe(
      false,
    );
  });

  it("is true when session is present", () => {
    expect(
      isMeaningfulNext(
        resolveSafeNext("/?session=x", { baseOrigin: ORIGIN }),
      ),
    ).toBe(true);
  });
});
