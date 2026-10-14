import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ASK_TOOL_NAME,
  SMART_COMPACT_COMMAND_NAME,
  SMART_COMPACT_TOOL_NAME,
  SUBAGENT_COMMAND_NAMES,
  SUBAGENT_TOOL_NAMES,
  TODO_COMMAND_NAME,
  TODO_TOOL_NAME,
  buildBuiltInRuntimeState,
  capabilitiesWithLoadedTokens,
  detectLoadedBuiltIns,
} from "../src/internal/built-in-detection.js";
import { defaultBuiltInCapabilities } from "@fffattiger/pix-runtime-core";

const revision = "a".repeat(64);

describe("actual loaded built-in detection", () => {
  it("requires exact tool/command signatures and never loads side_chat", () => {
    const loaded = detectLoadedBuiltIns({
      tools: [
        ...SUBAGENT_TOOL_NAMES.map((name) => ({ name })),
        { name: TODO_TOOL_NAME },
        { name: ASK_TOOL_NAME },
        { name: "side_chat" },
      ],
      commands: [
        ...SUBAGENT_COMMAND_NAMES.map((name) => ({ name })),
        { name: TODO_COMMAND_NAME },
      ],
    });
    assert.deepEqual([...loaded], ["subagents", "todo", "ask_user_question"]);
  });

  it("detects smart_compact by its smart_compact tool + smart-compact command pair", () => {
    const onlyTool = detectLoadedBuiltIns({
      tools: [{ name: SMART_COMPACT_TOOL_NAME }],
      commands: [],
    });
    assert.deepEqual([...onlyTool], []);
    // Detection requires the EXACT full pi-smart-compact tool family (the
    // bundled 10.3.0 surface) plus the smart-compact command.
    const SMART_FAMILY = [
      "smart_compact",
      "smart_recall",
      "smart_save_memory",
      "smart_context",
      "smart_navigation",
      "smart_tools",
    ];
    const both = detectLoadedBuiltIns({
      tools: SMART_FAMILY.map((name) => ({ name })),
      commands: [{ name: SMART_COMPACT_COMMAND_NAME }],
    });
    assert.deepEqual([...both], ["smart_compact"]);
    // A partial family signature must NOT be detected as smart_compact.
    const partial = detectLoadedBuiltIns({
      tools: [{ name: "smart_compact" }, { name: "smart_recall" }],
      commands: [{ name: SMART_COMPACT_COMMAND_NAME }],
    });
    assert.deepEqual([...partial], []);
    // Loaded smart_compact flips NO runtime token (no consumer surface).
    const caps = capabilitiesWithLoadedTokens(["runtime.prompt"], new Set(["smart_compact"]));
    assert.deepEqual(caps, ["runtime.prompt"]);
  });

  it("treats desired-disabled as neither loaded nor failed and accepts the real side-chat seam", () => {
    const state = buildBuiltInRuntimeState({
      config: {
        revision,
        capabilities: [
          { id: "subagents", enabled: false },
          { id: "todo", enabled: true },
          { id: "ask_user_question", enabled: true },
          { id: "side_chat", enabled: true },
        ],
      },
      loaded: new Set(["todo", "side_chat"]),
    });
    assert.deepEqual(state.loaded, ["todo", "side_chat"]);
    assert.deepEqual(state.failures, [
      { id: "ask_user_question", code: "load_failed" },
    ]);
  });

  it("adds only actual loaded availability tokens onto the base factory set", () => {
    const caps = capabilitiesWithLoadedTokens(
      ["runtime.prompt", "runtime.reload"],
      new Set(["todo", "ask_user_question"]),
    );
    assert.deepEqual(caps, ["runtime.prompt", "runtime.reload", "runtime.todo", "runtime.user_question"]);
    assert.equal(caps.includes("runtime.side_chat"), false);
    assert.equal(defaultBuiltInCapabilities().every((row) => row.enabled), true);
  });
});
