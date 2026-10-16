import { describe, expect, it } from "vitest";
import type { AgentMessage } from "@fffattiger/pix-protocol";
import { openSessionTarget, scanLiveToolEffects, showFilesOpenPath } from "./live-tool-effects";

function result(toolCallId: string, toolName: string, details?: unknown, isError = false): AgentMessage {
  return { role: "toolResult", toolCallId, toolName, content: [{ type: "text", text: "ok" }], isError, details } as AgentMessage;
}

describe("live tool effects", () => {
  it("records everything present at mount and fires only results that arrive later", () => {
    const history = [result("old", "show_files", { open: "/a.png" })];
    const first = scanLiveToolEffects(history, new Set(), false);
    expect(first.fresh).toEqual([]);
    const seen = new Set(first.seen);

    const live = [...history, result("new", "show_files", { files: [], open: "/b.png" })];
    const second = scanLiveToolEffects(live, seen, true);
    expect(second.fresh.map((effect) => effect.toolCallId)).toEqual(["new"]);
    expect(showFilesOpenPath(second.fresh[0]!.details)).toBe("/b.png");

    const again = scanLiveToolEffects(live, new Set([...seen, ...second.seen]), true);
    expect(again.fresh).toEqual([]);
  });

  it("ignores a show_files result that names nothing to open and an errored one", () => {
    const messages = [
      result("a", "show_files", { files: [{ path: "/a.md", kind: "file" }] }),
      result("b", "show_files", { open: "/a.md" }, true),
    ];
    const scan = scanLiveToolEffects(messages, new Set(), true);
    expect(showFilesOpenPath(scan.fresh[0]!.details)).toBeNull();
    expect(scan.fresh[1]!.isError).toBe(true);
  });

  it("reads an open_session target only when both sessionId and cwd are present", () => {
    expect(openSessionTarget({ sessionId: "s-1", cwd: "/repos/pix", title: "修 bug" })).toEqual({
      sessionId: "s-1",
      cwd: "/repos/pix",
      title: "修 bug",
    });
    expect(openSessionTarget({ sessionId: "s-1" })).toBeNull();
    expect(openSessionTarget(undefined)).toBeNull();
  });
});
