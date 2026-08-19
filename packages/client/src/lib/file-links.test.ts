import { describe, expect, it } from "vitest";
import { resolveLocalFileHref, resolveLocalFilePath } from "./file-links";

describe("resolveLocalFileHref", () => {
  it("keeps a Windows drive-root base as C:/", () => {
    expect(resolveLocalFileHref("Users/name/a.ts", "C:/", "C:/", "windows-drive")).toBe("C:/Users/name/a.ts");
    expect(resolveLocalFileHref("../secret.ts", "C:/Users/name", "C:/Users/name", "windows-drive")).toBeNull();
  });

  it("compares Windows drive containment only when Host pathFlavor says so", () => {
    expect(resolveLocalFileHref("src/a.ts", "C:/Users/Name", "c:/users/name", "windows-drive")).toBe("C:/Users/Name/src/a.ts");
    expect(resolveLocalFileHref("src/a.ts", "C:/Users/Name", "c:/users/name", "posix")).toBeNull();
  });

  it("keeps POSIX containment case-sensitive", () => {
    expect(resolveLocalFileHref("sys.log", "/Var/log", "/var/log", "posix")).toBeNull();
    expect(resolveLocalFileHref("sys.log", "/var/log", "/var/log", "posix")).toBe("/var/log/sys.log");
  });
});

describe("resolveLocalFilePath", () => {
  it("joins a Windows drive root without collapsing it to C:", () => {
    expect(resolveLocalFilePath("Users/name/a.ts", "C:/", "windows-drive")).toBe("C:/Users/name/a.ts");
    expect(resolveLocalFilePath("C:\\Users\\name\\a.ts", undefined, "windows-drive")).toBe("C:/Users/name/a.ts");
  });
});
