import { describe, expect, it } from "vitest";
import { HttpError } from "@/api/http-client";
import { describeOpenProjectError } from "./open-project-error";

describe("describeOpenProjectError", () => {
  it("maps Host authorize failures to fixed keys", () => {
    expect(describeOpenProjectError(new HttpError({ path: "/v1/cwd/validate", status: 404, code: "PATH_NOT_FOUND", message: "x" }))).toBe("desktop.projectPathNotFound");
    expect(describeOpenProjectError(new HttpError({ path: "/v1/cwd/validate", status: 403, code: "PATH_FORBIDDEN", message: "x" }))).toBe("desktop.projectPathForbidden");
    expect(describeOpenProjectError(new HttpError({ path: "/v1/cwd/validate", status: 400, code: "INVALID_PATH", message: "x" }))).toBe("desktop.projectPathInvalid");
    expect(describeOpenProjectError(new Error("nope"))).toBe("desktop.projectPathOpenFailed");
  });
});
