/**
 * Pure client branch-name validator mirroring Host `safeBranch` exactly
 * (packages/host/src/routes/worktrees.ts).
 *
 * The user's raw input is validated as-is: it must already equal its trim
 * (no leading/trailing whitespace), be non-empty, ≤ 255 chars, and contain
 * none of the forbidden characters/sequences. We never auto-trim or
 * reinterpret — the exact raw accepted value is what gets sent.
 *
 * Returns `null` when valid, otherwise a fixed sanitized error string that
 * never echoes the input.
 */
export const WORKTREE_BRANCH_MAX_LENGTH = 255;

export const INVALID_BRANCH_MESSAGE = "Invalid branch name.";

export function validateBranchName(input: string): string | null {
  if (
    input.length === 0 ||
    input.length > WORKTREE_BRANCH_MAX_LENGTH ||
    input.trim() !== input ||
    input.startsWith("-") ||
    /[\0\s~^:?*[\\]/.test(input) ||
    input.includes("..") ||
    input.endsWith(".") ||
    input.endsWith("/") ||
    input.includes("//") ||
    input.includes("@{")
  ) {
    return INVALID_BRANCH_MESSAGE;
  }
  return null;
}
