import { HttpError } from "@/api/http-client";

export type OpenProjectErrorKey =
  | "desktop.projectPathNotFound"
  | "desktop.projectPathForbidden"
  | "desktop.projectPathInvalid"
  | "desktop.projectPathOpenFailed";

/** Fixed open-project copy. Host authorize/expand failures stay code-first. */
export function describeOpenProjectError(error: unknown): OpenProjectErrorKey {
  if (error instanceof HttpError) {
    switch (error.code) {
      case "PATH_NOT_FOUND":
        return "desktop.projectPathNotFound";
      case "PATH_FORBIDDEN":
      case "ROOT_REPLACED":
        return "desktop.projectPathForbidden";
      case "CWD_REQUIRED":
      case "INVALID_PATH":
      case "INVALID_INPUT":
      case "NOT_DIRECTORY":
        return "desktop.projectPathInvalid";
      default:
        break;
    }
  }
  return "desktop.projectPathOpenFailed";
}
