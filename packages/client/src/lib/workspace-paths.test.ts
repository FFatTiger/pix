import { describe, expect, it } from "vitest";
import {
  isAgentHomeWorkspacePath,
  isHiddenRailSession,
  isNonProjectWorkspacePath,
  primaryRealProjectPath,
} from "./workspace-paths";

describe("workspace-paths — sidebar project/session rail filter", () => {
  it("keeps real user projects", () => {
    expect(isNonProjectWorkspacePath("/Users/alice/Documents/program/pix")).toBe(false);
    expect(isNonProjectWorkspacePath("/Users/alice/code/sample-project")).toBe(false);
    expect(isHiddenRailSession({ cwd: "/Users/alice/Documents/program/pix", projectRoot: "/Users/alice/Documents/program/pix" })).toBe(false);
  });

  it("hides claude/pi subagent homes and session stores", () => {
    expect(isAgentHomeWorkspacePath("/Users/alice/.pi/agent/pi-claude-subagents/019fef69-fca5-7bd7-8c3d-33659411b32d")).toBe(true);
    expect(isNonProjectWorkspacePath("/Users/alice/.pi/pi-claude-subagents")).toBe(true);
    expect(isNonProjectWorkspacePath("/private/var/folders/ab/abc/T/pi-subagents/78586449-600b-43c0-bc93-d8d34294dba2")).toBe(true);
    expect(isNonProjectWorkspacePath("/Users/alice/.pi/agent/sessions/--Users-alice-Documents-program-pix--")).toBe(true);
    expect(isHiddenRailSession({
      cwd: "/Users/alice/.pi/agent/pi-claude-subagents/abc",
      projectRoot: "/Users/alice/Documents/program/pix",
    })).toBe(true);
  });

  it("hides ephemeral tmp trees even when they look like a project name", () => {
    expect(isNonProjectWorkspacePath("/tmp/pix-stable-composer")).toBe(true);
    expect(isNonProjectWorkspacePath("/private/tmp/num-scope-pix-source")).toBe(true);
  });

  it("picks the primary real project (most sessions) and skips agent homes", () => {
    expect(primaryRealProjectPath([
      { cwd: "/Users/alice/.pi/pi-claude-subagents", updatedAt: 9 },
      { cwd: "/Users/alice/Documents/program/pix", updatedAt: 3 },
      { cwd: "/Users/alice/Documents/program/pix", updatedAt: 7 },
      { cwd: "/Users/alice/code/sample-project", updatedAt: 8 },
    ])).toBe("/Users/alice/Documents/program/pix");
  });

  it("falls back to the most recent project when counts tie", () => {
    expect(primaryRealProjectPath([
      { cwd: "/Users/alice/Documents/program/pix", updatedAt: 3 },
      { cwd: "/Users/alice/code/sample-project", updatedAt: 8 },
    ])).toBe("/Users/alice/code/sample-project");
  });
});
