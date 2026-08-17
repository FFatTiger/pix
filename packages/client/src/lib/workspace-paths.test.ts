import { describe, expect, it } from "vitest";
import {
  isAgentHomeWorkspacePath,
  isHiddenRailSession,
  isNonProjectWorkspacePath,
  primaryRealProjectPath,
} from "./workspace-paths";

describe("workspace-paths — sidebar project/session rail filter", () => {
  it("keeps real user projects", () => {
    expect(isNonProjectWorkspacePath("/Users/proxy/Documents/program/pix")).toBe(false);
    expect(isNonProjectWorkspacePath("/Users/proxy/code/kegel-reminder")).toBe(false);
    expect(isHiddenRailSession({ cwd: "/Users/proxy/Documents/program/pix", projectRoot: "/Users/proxy/Documents/program/pix" })).toBe(false);
  });

  it("hides claude/pi subagent homes and session stores", () => {
    expect(isAgentHomeWorkspacePath("/Users/proxy/.pi/agent/pi-claude-subagents/019fef69-fca5-7bd7-8c3d-33659411b32d")).toBe(true);
    expect(isNonProjectWorkspacePath("/Users/proxy/.pi/pi-claude-subagents")).toBe(true);
    expect(isNonProjectWorkspacePath("/private/var/folders/ts/abc/T/pi-subagents/78586449-600b-43c0-bc93-d8d34294dba2")).toBe(true);
    expect(isNonProjectWorkspacePath("/Users/proxy/.pi/agent/sessions/--Users-proxy-Documents-program-pix--")).toBe(true);
    expect(isHiddenRailSession({
      cwd: "/Users/proxy/.pi/agent/pi-claude-subagents/abc",
      projectRoot: "/Users/proxy/Documents/program/pix",
    })).toBe(true);
  });

  it("hides ephemeral tmp trees even when they look like a project name", () => {
    expect(isNonProjectWorkspacePath("/tmp/pix-stable-composer")).toBe(true);
    expect(isNonProjectWorkspacePath("/private/tmp/num-scope-pix-source")).toBe(true);
  });

  it("picks the primary real project (most sessions) and skips agent homes", () => {
    expect(primaryRealProjectPath([
      { cwd: "/Users/proxy/.pi/pi-claude-subagents", updatedAt: 9 },
      { cwd: "/Users/proxy/Documents/program/pix", updatedAt: 3 },
      { cwd: "/Users/proxy/Documents/program/pix", updatedAt: 7 },
      { cwd: "/Users/proxy/code/kegel-reminder", updatedAt: 8 },
    ])).toBe("/Users/proxy/Documents/program/pix");
  });

  it("falls back to the most recent project when counts tie", () => {
    expect(primaryRealProjectPath([
      { cwd: "/Users/proxy/Documents/program/pix", updatedAt: 3 },
      { cwd: "/Users/proxy/code/kegel-reminder", updatedAt: 8 },
    ])).toBe("/Users/proxy/code/kegel-reminder");
  });
});
