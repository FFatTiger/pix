import { describe, expect, it } from "vitest";
import {
  formatCwdLabel,
  parseWorkspaceSearch,
  validateWorkspaceSearch,
  workspaceSearchToParams,
} from "./search-params";

describe("parseWorkspaceSearch", () => {
  it("extracts session and cwd strings", () => {
    expect(
      parseWorkspaceSearch({
        session: "abc",
        cwd: "/Users/me/proj",
        other: 1,
      }),
    ).toEqual({ session: "abc", cwd: "/Users/me/proj" });
  });

  it("extracts an optional file selector with its cwd", () => {
    expect(
      parseWorkspaceSearch({ cwd: "/repo", file: "/repo/src/a.ts" }),
    ).toEqual({ cwd: "/repo", file: "/repo/src/a.ts" });
  });

  it("drops empty and non-string values", () => {
    expect(
      parseWorkspaceSearch({ session: "", cwd: 12, next: null, file: 4 }),
    ).toEqual({});
  });

  it("keeps next for login redirect", () => {
    expect(parseWorkspaceSearch({ next: "/?session=1" })).toEqual({
      next: "/?session=1",
    });
  });

  it("file wins over session when both are present (mutually exclusive active selectors)", () => {
    expect(
      parseWorkspaceSearch({ cwd: "/repo", session: "s1", file: "/repo/a.ts" }),
    ).toEqual({ cwd: "/repo", file: "/repo/a.ts" });
  });

  it("drops a file selector when no cwd is present (file requires cwd)", () => {
    expect(parseWorkspaceSearch({ file: "/repo/a.ts" })).toEqual({});
    // An invalid file never shadows a valid session selector.
    expect(parseWorkspaceSearch({ session: "s1", file: "/repo/a.ts" })).toEqual({
      session: "s1",
    });
  });
});

describe("validateWorkspaceSearch", () => {
  it("is an alias of parse for router validateSearch", () => {
    const input = { session: "s1", cwd: "/tmp", file: "/tmp/f.ts" };
    expect(validateWorkspaceSearch(input)).toEqual(parseWorkspaceSearch(input));
  });
});

describe("workspaceSearchToParams", () => {
  it("serializes defined keys only", () => {
    const params = workspaceSearchToParams({
      session: "s1",
      cwd: "/repo",
    });
    expect(params.get("session")).toBe("s1");
    expect(params.get("cwd")).toBe("/repo");
    expect(params.get("file")).toBeNull();
    expect(params.get("next")).toBeNull();
  });

  it("serializes a file selector and never a session (one active selector)", () => {
    const params = workspaceSearchToParams({
      session: "s1",
      cwd: "/repo",
      file: "/repo/a.ts",
    });
    expect(params.get("file")).toBe("/repo/a.ts");
    expect(params.get("session")).toBeNull();
    expect(params.get("cwd")).toBe("/repo");
  });

  it("serializes a file selector alone with its cwd", () => {
    const params = workspaceSearchToParams({ cwd: "/repo", file: "/repo/b.ts" });
    expect(params.get("file")).toBe("/repo/b.ts");
    expect(params.get("session")).toBeNull();
    expect(params.get("cwd")).toBe("/repo");
  });

  it("does not serialize a file without its required cwd", () => {
    const params = workspaceSearchToParams({ session: "s1", file: "/repo/b.ts" });
    expect(params.get("file")).toBeNull();
    expect(params.get("session")).toBe("s1");
  });
});

describe("formatCwdLabel", () => {
  it("handles missing cwd", () => {
    expect(formatCwdLabel(undefined)).toBe("No project");
  });

  it("shortens deep paths", () => {
    expect(formatCwdLabel("/Users/alice/Documents/program/pix")).toBe(
      "…/program/pix",
    );
  });

  it("keeps short paths", () => {
    expect(formatCwdLabel("/tmp/proj")).toBe("/tmp/proj");
  });
});
