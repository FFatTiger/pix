import { describe, expect, it } from "vitest";
import { HttpError } from "@/api/http-client";
import { describeCatalogError } from "./catalog-errors";

describe("describeCatalogError", () => {
  it.each([
    ["CWD_REQUIRED", "Invalid project path."],
    ["INVALID_PATH", "Invalid project path."],
    ["INVALID_INPUT", "Invalid project path."],
    ["PATH_FORBIDDEN", "Project path is outside the allowed roots."],
    ["ROOT_REPLACED", "Project path is outside the allowed roots."],
    ["PATH_NOT_FOUND", "Project path was not found."],
    ["CATALOG_UNAVAILABLE", "Catalog unavailable."],
    ["OTHER", "Catalog unavailable."],
  ] as const)("maps code %s", (code, copy) => {
    const error = new HttpError({
      status: 400,
      path: "/v1/models",
      message: "LEAKED RAW MESSAGE /secret",
      code,
    });
    expect(describeCatalogError(error)).toBe(copy);
  });

  it("maps network and timeout kinds", () => {
    expect(
      describeCatalogError(
        new HttpError({ kind: "network", path: "/v1/models", message: "Unable to reach the host", code: "NETWORK_ERROR" }),
      ),
    ).toBe("Network error — catalog unavailable.");
    expect(
      describeCatalogError(
        new HttpError({ kind: "timeout", path: "/v1/models", message: "Request timed out", code: "TIMEOUT" }),
      ),
    ).toBe("Request timed out — catalog unavailable.");
  });

  it("never returns raw unknown error text", () => {
    expect(describeCatalogError(new Error("stack /Users/secret"))).toBe("Catalog unavailable.");
    expect(describeCatalogError("boom")).toBe("Catalog unavailable.");
  });
});
