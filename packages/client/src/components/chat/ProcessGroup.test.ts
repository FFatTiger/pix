import { describe, expect, it } from "vitest";
import { buildProcessSteps, computeProcessSummary, formatProcessDuration } from "./ProcessGroup";
import type { ProcessContentBlock } from "@/lib/process-content";

const passthroughT = (key: string): string => key;

const messages: Record<string, string> = {
  "desktop.processDuration": "Worked for {duration}",
  "desktop.processElapsed": "Elapsed {duration}",
  "desktop.processDurationUnknown": "Duration unknown",
  "desktop.processDurationHours": "{hours}h",
  "desktop.processDurationMinutes": "{minutes}m",
  "desktop.processDurationSeconds": "{seconds}s",
};

const translateT = (
  key: string,
  params: Record<string, string | number> = {},
): string =>
  (messages[key] ?? key).replace(/\{([\w.]+)\}/g, (_, name: string) =>
    params[name] === undefined ? `{${name}}` : String(params[name]),
  );

function thought(id: string, thinking: string): ProcessContentBlock {
  return {
    id,
    type: "thinking",
    thinking,
    origin: { phase: "process", placement: "standalone", sourceMessageIndex: 0 },
  };
}

function tool(id: string): ProcessContentBlock {
  return {
    id,
    type: "toolCall",
    toolCallId: id,
    toolName: "read",
    input: {},
    status: "success",
    origin: { phase: "process", placement: "standalone", sourceMessageIndex: 0 },
  };
}

describe("buildProcessSteps — thought visibility", () => {
  it("keeps each tool-preceding thought as an explicit chronological step", () => {
    const steps = buildProcessSteps([
      thought("think-1", "inspect source"),
      tool("tool-1"),
      thought("think-2", "compare behavior"),
      tool("tool-2"),
    ], passthroughT);

    expect(steps.map((step) => step.kind)).toEqual(["thinking", "tool", "thinking", "tool"]);
    expect(steps[0]).toMatchObject({ kind: "thinking", id: "think-1" });
    expect(steps[2]).toMatchObject({ kind: "thinking", id: "think-2" });
    expect(steps[1]).toMatchObject({ kind: "tool", leadBlocks: [] });
    expect(steps[3]).toMatchObject({ kind: "tool", leadBlocks: [] });
  });

  it("still merges genuinely consecutive same-tone tools when no thought separates them", () => {
    const steps = buildProcessSteps([tool("tool-1"), tool("tool-2")], passthroughT);
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ kind: "toolGroup" });
  });
});

describe("computeProcessSummary — shared elapsed title", () => {
  it("formats seconds, minutes and hours without dropping lower units", () => {
    expect(formatProcessDuration(translateT, 5_000)).toBe("5s");
    expect(formatProcessDuration(translateT, 125_000)).toBe("2m 5s");
    expect(formatProcessDuration(translateT, 3_725_000)).toBe("1h 2m 5s");
  });

  it("uses elapsed wording while the process is still running", () => {
    expect(computeProcessSummary(translateT, { isStreaming: true, durationMs: 65_000 }))
      .toBe("Elapsed 1m 5s");
  });

  it("uses final duration wording after the process settles", () => {
    expect(computeProcessSummary(translateT, { isStreaming: false, durationMs: 3_725_000 }))
      .toBe("Worked for 1h 2m 5s");
  });

  it("does not present a missing settled duration as zero seconds", () => {
    expect(computeProcessSummary(translateT, { isStreaming: false, durationMs: undefined }))
      .toBe("Duration unknown");
  });
});
