import { describe, expect, it } from "vitest";
import {
  baseName,
  breadcrumbs,
  isWithinRoot,
  joinChild,
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
