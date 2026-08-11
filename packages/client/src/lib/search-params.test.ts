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

  it("drops empty and non-string values", () => {
    expect(
      parseWorkspaceSearch({ session: "", cwd: 12, next: null }),
    ).toEqual({});
  });

  it("keeps next for login redirect", () => {
    expect(parseWorkspaceSearch({ next: "/?session=1" })).toEqual({
      next: "/?session=1",
    });
  });
});

describe("validateWorkspaceSearch", () => {
  it("is an alias of parse for router validateSearch", () => {
    const input = { session: "s1", cwd: "/tmp" };
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
    expect(params.get("next")).toBeNull();
  });
});

describe("formatCwdLabel", () => {
  it("handles missing cwd", () => {
    expect(formatCwdLabel(undefined)).toBe("No project");
  });

  it("shortens deep paths", () => {
    expect(formatCwdLabel("/Users/proxy/Documents/program/pi-web")).toBe(
      "…/program/pi-web",
    );
  });

  it("keeps short paths", () => {
    expect(formatCwdLabel("/tmp/proj")).toBe("/tmp/proj");
  });
});
