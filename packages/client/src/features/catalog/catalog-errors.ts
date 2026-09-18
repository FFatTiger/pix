import { HttpError } from "@/api/http-client";

/**
 * Fixed catalog error copy. Never renders body/stack/raw dynamic host messages.
 *
 * Mapping is by HttpError.code first, then kind for network/timeout.
 */
export function describeCatalogError(error: unknown): string {
  if (error instanceof HttpError) {
    switch (error.code) {
      case "CWD_REQUIRED":
      case "INVALID_PATH":
      case "INVALID_INPUT":
        return "Invalid project path.";
      case "PATH_FORBIDDEN":
      case "ROOT_REPLACED":
        return "Project path is outside the allowed roots.";
      case "PATH_NOT_FOUND":
        return "Project path was not found.";
      case "CATALOG_UNAVAILABLE":
        return "Catalog unavailable.";
      default:
        break;
    }
    if (error.kind === "network") return "Network error — catalog unavailable.";
    if (error.kind === "timeout") return "Request timed out — catalog unavailable.";
  }
  return "Catalog unavailable.";
}
