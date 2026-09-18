import { describe, expect, it } from "vitest";
import {
  baseName,
  breadcrumbs,
  isWithinRoot,
  joinChild,
  joinRelative,
  parentWithinRoot,
  relativePath,
} from "./paths";

describe("isWithinRoot", () => {
  it("matches the root itself and nested children", () => {
    expect(isWithinRoot("/proj", "/proj")).toBe(true);
    expect(isWithinRoot("/proj/src", "/proj")).toBe(true);
    expect(isWithinRoot("/proj/src/a.ts", "/proj")).toBe(true);
  });

  it("rejects siblings, parents and look-alike prefixes", () => {
    expect(isWithinRoot("/project", "/proj")).toBe(false);
    expect(isWithinRoot("/proj-secret", "/proj")).toBe(false);
    expect(isWithinRoot("/home", "/home/proj")).toBe(false);
  });

  it("normalizes backslashes and trailing separators", () => {
    expect(isWithinRoot("C:\\proj\\src", "C:\\proj")).toBe(true);
    expect(isWithinRoot("/proj/", "/proj")).toBe(true);
  });
});

describe("joinChild", () => {
  it("appends a single entry name without duplicating separators", () => {
    expect(joinChild("/proj", "src")).toBe("/proj/src");
    expect(joinChild("/proj/", "src")).toBe("/proj/src");
    expect(joinChild("/", "home")).toBe("/home");
  });

  it("rejects any name that could escape the parent", () => {
    expect(() => joinChild("/proj", "..")).toThrow();
    expect(() => joinChild("/proj", ".")).toThrow();
    expect(() => joinChild("/proj", "a/b")).toThrow();
    expect(() => joinChild("/proj", "a\\b")).toThrow();
    expect(() => joinChild("/proj", "")).toThrow();
    // The UI must never synthesize a root-escape even with crafted names.
    expect(() => joinChild("/proj", "..%2fetc")).not.toThrow();
    expect(joinChild("/proj", "..%2fetc")).toBe("/proj/..%2fetc");
  });
});

describe("parentWithinRoot", () => {
  it("walks up but clamps at the project root", () => {
    expect(parentWithinRoot("/proj/src/a", "/proj")).toBe("/proj/src");
    expect(parentWithinRoot("/proj/src", "/proj")).toBe("/proj");
    expect(parentWithinRoot("/proj", "/proj")).toBeNull();
  });

  it("never offers a path above the root", () => {
    expect(parentWithinRoot("/home", "/home/proj")).toBeNull();
    expect(parentWithinRoot("/elsewhere/x", "/home/proj")).toBeNull();
  });

  it("survives a symlinked macOS prefix (canonical root vs canonical dir)", () => {
    // /var is a symlink to /private/var on macOS; the canonical root the Host
    // returns must still clamp a canonical child correctly.
    expect(parentWithinRoot("/private/var/proj/src", "/private/var/proj")).toBe("/private/var/proj");
  });
});

describe("breadcrumbs", () => {
  it("builds a crumb per segment from root to dir", () => {
    expect(breadcrumbs("/proj", "/proj")).toEqual([{ label: "proj", path: "/proj" }]);
    expect(breadcrumbs("/proj/src/a.ts", "/proj")).toEqual([
      { label: "proj", path: "/proj" },
      { label: "src", path: "/proj/src" },
      { label: "a.ts", path: "/proj/src/a.ts" },
    ]);
  });

  it("returns nothing when dir is outside root", () => {
    expect(breadcrumbs("/etc/passwd", "/proj")).toEqual([]);
  });

  it("handles a filesystem-root project", () => {
    expect(breadcrumbs("/", "/")).toEqual([{ label: "/", path: "/" }]);
    expect(breadcrumbs("/home", "/")).toEqual([
      { label: "/", path: "/" },
      { label: "home", path: "/home" },
    ]);
  });
});

describe("joinRelative", () => {
  it("joins valid nested relative POSIX paths onto the root", () => {
    expect(joinRelative("/proj", "a.ts")).toBe("/proj/a.ts");
    expect(joinRelative("/proj", "sub/a.ts")).toBe("/proj/sub/a.ts");
    expect(joinRelative("/proj", "src/deep/nested file (2).ts")).toBe("/proj/src/deep/nested file (2).ts");
    expect(joinRelative("/", "a/b.ts")).toBe("/a/b.ts");
  });

  it("rejects absolute paths and traversal segments", () => {
    expect(joinRelative("/proj", "/etc/passwd")).toBeNull();
    expect(joinRelative("/proj", "../etc/passwd")).toBeNull();
    expect(joinRelative("/proj", "sub/../../etc")).toBeNull();
    expect(joinRelative("/proj", ".")).toBeNull();
    expect(joinRelative("/proj", "..")).toBeNull();
    expect(joinRelative("/proj", "sub/.")).toBeNull();
  });

  it("rejects empty, repeated and trailing segments plus backslash and NUL", () => {
    expect(joinRelative("/proj", "")).toBeNull();
    expect(joinRelative("/proj", "a//b")).toBeNull();
    expect(joinRelative("/proj", "a/b/")).toBeNull();
    expect(joinRelative("/proj", "a/ b")).toBe("/proj/a/ b");
    expect(joinRelative("/proj", "a\\b")).toBeNull();
    expect(joinRelative("/proj", "a\u0000b")).toBeNull();
  });

  it("keeps the result inside the canonical root (defense-in-depth)", () => {
    const joined = joinRelative("/private/tmp/proj", "src/b.ts");
    expect(joined).toBe("/private/tmp/proj/src/b.ts");
    expect(isWithinRoot(joined ?? "", "/private/tmp/proj")).toBe(true);
    // A crafted result is never allowed to walk above root even when segments are odd.
    expect(joinRelative("/proj", "..%2fetc")).toBe("/proj/..%2fetc");
    expect(isWithinRoot(joinRelative("/proj", "..%2fetc") ?? "", "/proj")).toBe(true);
    // Empty root cannot be joined onto.
    expect(joinRelative("", "a.ts")).toBeNull();
  });
});

describe("relativePath / baseName", () => {
  it("renders file paths relative to the repository root", () => {
    expect(relativePath("/repo", "/repo/src/a.ts")).toBe("src/a.ts");
    expect(relativePath("/repo", "/repo")).toBe("repo");
  });

  it("falls back to a base name for unrelated paths", () => {
    expect(relativePath("/repo", "/elsewhere/x.ts")).toBe("x.ts");
  });

  it("extracts the trailing label", () => {
    expect(baseName("/proj/src/a.ts")).toBe("a.ts");
    expect(baseName("/proj")).toBe("proj");
    expect(baseName("/")).toBe("/");
  });
});
