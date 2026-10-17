import { describe, expect, it } from "vitest";
import type { SessionHeader } from "@fffattiger/pix-protocol";
import { projectDisplayName, sessionActivityMs, sessionRowTitle } from "./session-row";

function header(over: Partial<SessionHeader>): SessionHeader {
  return { sessionId: "s123456789", cwd: "/x", projectRoot: "/x", ...over };
}

describe("session-row shared presentation helpers", () => {
  it("sessionActivityMs prefers updatedAt, then lastMessageAt, then createdAt, skipping unusable values", () => {
    expect(sessionActivityMs(header({ updatedAt: 3, lastMessageAt: 2, createdAt: 1 }))).toBe(3);
    expect(sessionActivityMs(header({ lastMessageAt: 2, createdAt: 1 }))).toBe(2);
    expect(sessionActivityMs(header({ createdAt: 1 }))).toBe(1);
    expect(sessionActivityMs(header({ updatedAt: 1e30, createdAt: 5 }))).toBe(5);
    expect(sessionActivityMs(header({}))).toBeUndefined();
  });

  it("sessionRowTitle shows the title, else the one-line first message, else the short id", () => {
    expect(sessionRowTitle(header({ title: "Named" }))).toBe("Named");
    expect(sessionRowTitle(header({ firstMessage: "  hello \n world  " }))).toBe("hello   world");
    const long = "x".repeat(100);
    expect(sessionRowTitle(header({ firstMessage: long }))).toBe(`${"x".repeat(80)}…`);
    expect(sessionRowTitle(header({}))).toBe("s123456789");
  });

  it("projectDisplayName keeps the last non-empty segment across separators and trailing slashes", () => {
    expect(projectDisplayName("/Users/me/work/pix")).toBe("pix");
    expect(projectDisplayName("/Users/me/work/pix/")).toBe("pix");
    expect(projectDisplayName("C:\\Users\\me\\pix")).toBe("pix");
    expect(projectDisplayName("pix")).toBe("pix");
  });
});
