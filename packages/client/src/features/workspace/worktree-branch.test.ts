import { describe, expect, it } from "vitest";
import {
  INVALID_BRANCH_MESSAGE,
  WORKTREE_BRANCH_MAX_LENGTH,
  validateBranchName,
} from "./worktree-branch";

/**
 * Client validator parity table mirroring Host `safeBranch` (worktrees.ts).
 * Every server forbidden form must be rejected identically, and the 255-char
 * boundary must be accepted by client parity (the server may later fail the
 * Git ref safely — the client never blocks a value the server would accept at
 * the validation boundary).
 */
describe("validateBranchName (Host safeBranch parity)", () => {
  it("accepts valid branch names", () => {
    const valid = [
      "main",
      "feature/foo",
      "v1.2.3",
      "release/2026-01",
      "a",
      "x_y-z.dot",
      "refs/heads/custom",
      "a".repeat(WORKTREE_BRANCH_MAX_LENGTH), // 255 chars accepted by client parity
    ];
    for (const name of valid) {
      expect(validateBranchName(name), JSON.stringify(name)).toBeNull();
    }
  });

  it("rejects empty and whitespace-only input", () => {
    expect(validateBranchName("")).toBe(INVALID_BRANCH_MESSAGE);
    expect(validateBranchName(" ")).toBe(INVALID_BRANCH_MESSAGE);
    expect(validateBranchName("\t")).toBe(INVALID_BRANCH_MESSAGE);
    expect(validateBranchName("\n")).toBe(INVALID_BRANCH_MESSAGE);
  });

  it("rejects input longer than 255 chars (256 boundary)", () => {
    expect(validateBranchName("a".repeat(256))).toBe(INVALID_BRANCH_MESSAGE);
  });

  it("never auto-trims: leading/trailing whitespace stays invalid", () => {
    expect(validateBranchName(" main")).toBe(INVALID_BRANCH_MESSAGE);
    expect(validateBranchName("main ")).toBe(INVALID_BRANCH_MESSAGE);
    expect(validateBranchName("  main  ")).toBe(INVALID_BRANCH_MESSAGE);
    expect(validateBranchName("\tmain")).toBe(INVALID_BRANCH_MESSAGE);
  });

  it("rejects internal whitespace (not trimmed away)", () => {
    expect(validateBranchName("my branch")).toBe(INVALID_BRANCH_MESSAGE);
    expect(validateBranchName("my\tbranch")).toBe(INVALID_BRANCH_MESSAGE);
    expect(validateBranchName("my\nbranch")).toBe(INVALID_BRANCH_MESSAGE);
  });

  it("rejects a leading dash", () => {
    expect(validateBranchName("-foo")).toBe(INVALID_BRANCH_MESSAGE);
    expect(validateBranchName("--foo")).toBe(INVALID_BRANCH_MESSAGE);
    // A dash mid-name is fine.
    expect(validateBranchName("foo-bar")).toBeNull();
  });

  it("rejects every forbidden control/operator character (Host regex)", () => {
    // NUL, whitespace, ~, ^, :, ?, *, [, backslash — in the exact Host class
    // /[\0\s~^:?*[\\]/.
    const forbiddenChars = ["\0", "~", "^", ":", "?", "*", "[", "\\"];
    for (const ch of forbiddenChars) {
      expect(validateBranchName(`foo${ch}bar`), `char ${JSON.stringify(ch)}`).toBe(
        INVALID_BRANCH_MESSAGE,
      );
    }
    // ']' alone is not in the Host class (it is not forbidden by itself).
    expect(validateBranchName("foo]bar")).toBeNull();
  });

  it("rejects '..' anywhere", () => {
    expect(validateBranchName("a..b")).toBe(INVALID_BRANCH_MESSAGE);
    expect(validateBranchName("..")).toBe(INVALID_BRANCH_MESSAGE);
    expect(validateBranchName("...")).toBe(INVALID_BRANCH_MESSAGE);
    expect(validateBranchName("foo/../bar")).toBe(INVALID_BRANCH_MESSAGE);
  });

  it("rejects a trailing dot", () => {
    expect(validateBranchName("foo.")).toBe(INVALID_BRANCH_MESSAGE);
    expect(validateBranchName("foo..")).toBe(INVALID_BRANCH_MESSAGE);
  });

  it("rejects a trailing slash", () => {
    expect(validateBranchName("foo/")).toBe(INVALID_BRANCH_MESSAGE);
  });

  it("rejects '//' anywhere", () => {
    expect(validateBranchName("a//b")).toBe(INVALID_BRANCH_MESSAGE);
    expect(validateBranchName("//")).toBe(INVALID_BRANCH_MESSAGE);
    expect(validateBranchName("foo//bar/baz")).toBe(INVALID_BRANCH_MESSAGE);
  });

  it("rejects '@{' anywhere (reflog marker)", () => {
    expect(validateBranchName("foo@{")).toBe(INVALID_BRANCH_MESSAGE);
    expect(validateBranchName("foo@{1}")).toBe(INVALID_BRANCH_MESSAGE);
    expect(validateBranchName("a@{b")).toBe(INVALID_BRANCH_MESSAGE);
  });

  it("returns a fixed message that never echoes the input", () => {
    const message = validateBranchName("secret..leak@{");
    expect(message).toBe(INVALID_BRANCH_MESSAGE);
    expect(message).not.toMatch(/secret|leak|\.\.|\{/);
  });
});
