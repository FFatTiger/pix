import { describe, expect, it } from "vitest";
import { filePathCompareKey, getFileDirectory, getRelativeFilePath, joinFilePath, normalizeFilePathSlashes } from "./file-paths";

describe("file-paths Windows drive helpers", () => {
  it("keeps a drive root as C:/ and does not collapse it to C:", () => {
    expect(getFileDirectory("C:/Users/name/file.txt")).toBe("C:/Users/name");
    expect(getFileDirectory("C:/file.txt")).toBe("C:/");
  });

  it("computes relative paths case-insensitively on Windows drives", () => {
    expect(getRelativeFilePath("C:/Users/Name/src/a.ts", "c:/users/name")).toBe("src/a.ts");
    expect(getRelativeFilePath("C:/Users/Name", "C:/Users/Name")).toBe(".");
    expect(getRelativeFilePath("C:/Users/Name/src/a.ts", "C:/")).toBe("Users/Name/src/a.ts");
    expect(getRelativeFilePath("/var/log/sys.log", "/var/log")).toBe("sys.log");
    expect(getRelativeFilePath("/Var/log/sys.log", "/var/log")).toBe("/Var/log/sys.log");
  });

  it("normalizes slashes without inventing a POSIX path", () => {
    expect(normalizeFilePathSlashes("C:\\Users\\Name")).toBe("C:/Users/Name");
    expect(joinFilePath("C:/Users/Name", "src")).toBe("C:/Users/Name/src");
  });

  it("keeps a drive-root compare key as c:/", () => {
    expect(filePathCompareKey("C:/")).toBe("c:/");
    expect(filePathCompareKey("C:\\Users\\Name")).toBe("c:/users/name");
    expect(filePathCompareKey("/Var/log")).toBe("/Var/log");
  });
});
