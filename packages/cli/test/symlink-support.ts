import type { TestContext } from "node:test";
import { symlink } from "node:fs/promises";

const UNSUPPORTED_CODES = new Set(["EPERM", "EACCES", "ENOTSUP", "EINVAL"]);

/** Create a real link when supported; explicitly skip only for capability errors. */
export async function symlinkOrSkip(
  t: TestContext,
  target: string,
  linkPath: string,
  type?: "dir" | "file" | "junction",
): Promise<boolean> {
  const effectiveType = process.platform === "win32" && type === "dir" ? "junction" : type;
  try {
    await symlink(target, linkPath, effectiveType);
    return true;
  } catch (error) {
    if (UNSUPPORTED_CODES.has((error as NodeJS.ErrnoException).code ?? "")) {
      t.skip("filesystem links are unavailable for this user/environment");
      return false;
    }
    throw error;
  }
}
