import { describe, expect, it } from "vitest";
import { toCwdRelativeMentions } from "./file-mentions";

// Ported verbatim from the legacy desktop source lib/file-mentions.test.mjs.
describe("toCwdRelativeMentions", () => {
  it("converts absolute paths under cwd to relative mentions", () => {
    const { mentions, rejected } = toCwdRelativeMentions(
      ["/repo/src/app.ts", "/repo/package.json"],
      "/repo",
    );
    expect(mentions).toEqual(["src/app.ts", "package.json"]);
    expect(rejected).toEqual([]);
  });

  it("normalizes backslashes (Windows paths)", () => {
    const { mentions, rejected } = toCwdRelativeMentions(
      ["C:\\repo\\src\\app.ts", "C:/repo/README.md"],
      "C:\\repo",
      "windows-drive",
    );
    expect(mentions).toEqual(["src/app.ts", "README.md"]);
    expect(rejected).toEqual([]);
  });

  it("matches Windows drive paths case-insensitively", () => {
    const { mentions, rejected } = toCwdRelativeMentions(
      ["c:/REPO/src/app.ts"],
      "C:\\Repo",
      "windows-drive",
    );
    expect(mentions).toEqual(["src/app.ts"]);
    expect(rejected).toEqual([]);
  });

  it("rejects paths outside cwd", () => {
    const { mentions, rejected } = toCwdRelativeMentions(
      ["/repo/src/app.ts", "/other/file.ts", "/repo-adjacent/x.ts"],
      "/repo",
    );
    expect(mentions).toEqual(["src/app.ts"]);
    expect(rejected).toEqual(["/other/file.ts", "/repo-adjacent/x.ts"]);
  });

  it("rejects the cwd itself and paths that collapse to it", () => {
    const { mentions, rejected } = toCwdRelativeMentions(["/repo", "/repo/"], "/repo");
    expect(mentions).toEqual([]);
    expect(rejected).toEqual(["/repo", "/repo/"]);
  });

  it("rejects a sibling with a shared string prefix", () => {
    const { mentions, rejected } = toCwdRelativeMentions(
      ["/home/user/projects/foo-bar/a.ts"],
      "/home/user/projects/foo",
    );
    expect(mentions).toEqual([]);
    expect(rejected).toEqual(["/home/user/projects/foo-bar/a.ts"]);
  });

  it("keeps a Windows drive-root cwd as C:/", () => {
    const { mentions, rejected } = toCwdRelativeMentions(
      ["C:\\Users\\name\\a.ts", "D:\\other\\b.ts"],
      "C:/",
    );
    expect(mentions).toEqual(["Users/name/a.ts"]);
    expect(rejected).toEqual(["D:\\other\\b.ts"]);
  });

  it("handles empty inputs", () => {
    const { mentions, rejected } = toCwdRelativeMentions([], "/repo");
    expect(mentions).toEqual([]);
    expect(rejected).toEqual([]);
    const empty = toCwdRelativeMentions(["/repo/a.ts"], "");
    expect(empty.mentions).toEqual([]);
    expect(empty.rejected).toEqual(["/repo/a.ts"]);
  });
});
