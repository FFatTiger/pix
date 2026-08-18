import { describe, expect, it } from "vitest";
import { resolveLocalFileHref, resolveLocalFilePath } from "./file-links";

describe("resolveLocalFileHref", () => {
  it("keeps a Windows drive-root base as C:/", () => {
    expect(resolveLocalFileHref("Users/name/a.ts", "C:/", "C:/")).toBe("C:/Users/name/a.ts");
    expect(resolveLocalFileHref("../secret.ts", "C:/Users/name", "C:/Users/name")).toBeNull();
  });

  it("compares Windows drive containment case-insensitively", () => {
    expect(resolveLocalFileHref("src/a.ts", "C:/Users/Name", "c:/users/name")).toBe("C:/Users/Name/src/a.ts");
  });

  it("keeps POSIX containment case-sensitive", () => {
    expect(resolveLocalFileHref("sys.log", "/Var/log", "/var/log")).toBeNull();
    expect(resolveLocalFileHref("sys.log", "/var/log", "/var/log")).toBe("/var/log/sys.log");
  });
});

describe("resolveLocalFilePath", () => {
  it("joins a Windows drive root without collapsing it to C:", () => {
    expect(resolveLocalFilePath("Users/name/a.ts", "C:/")).toBe("C:/Users/name/a.ts");
    expect(resolveLocalFilePath("C:\\Users\\name\\a.ts")).toBe("C:/Users/name/a.ts");
  });
});
