import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import {
  ASSISTANT_PREAMBLE_TEMPLATE,
  applyAssistantSystemPrompt,
  assistantMemorySectionText,
  renderAssistantSegment,
} from "../src/internal/assistant-system-prompt.js";
import { resolveAssistantWorkspaceDir } from "@fffattiger/pix-runtime-core";

const HOME = homedir();
const WORKSPACE = resolveAssistantWorkspaceDir(HOME);

const DEFAULT_SECTIONS = {
  tools: "tool guidance",
  rules: "behavioral rules",
  docs: "documentation pointers",
};

function renderDefaultPiPrompt(): string {
  return [
    "default preamble",
    ...(["tools", "rules", "docs"] as const).map((name) => `<${name}>\n${DEFAULT_SECTIONS[name]}\n</${name}>`),
    "<cwd>\n/repos/pix\n</cwd>",
  ].join("\n\n");
}

function applyLive(provider: "local" | "lore" | "off") {
  const options: { customPrompt?: string; forceSystemPrompt?: string; sections?: Record<string, string> } = {};
  const render = () => {
    const parts = ["default preamble"];
    for (const name of ["tools", "rules", "docs"] as const) {
      if (options.customPrompt !== undefined) continue;
      parts.push(`<${name}>\n${DEFAULT_SECTIONS[name]}\n</${name}>`);
    }
    parts.push("<cwd>\n/repos/pix\n</cwd>");
    for (const [name, value] of Object.entries(options.sections ?? {})) {
      parts.push(`<${name}>\n${value}\n</${name}>`);
    }
    return parts.join("\n\n");
  };
  applyAssistantSystemPrompt(options, render, HOME, WORKSPACE, provider);
  return options;
}

describe("assistant memory prompt section", () => {
  it("local names the bundled pi-memory tools exactly (memory_read / memory_write)", () => {
    const text = assistantMemorySectionText("local");
    assert.equal(
      text,
      "## 记忆\n你和用户是长期合作。涉及过去的偏好、决定和约定时，先用 memory_read 查看记忆；遇到值得长期记住的新事实，用 memory_write 记下来。记忆要精炼，过时的内容及时更新或删除。",
    );
  });

  it("lore keeps the Lore wording", () => {
    assert.equal(
      assistantMemorySectionText("lore"),
      "## 记忆\n你和用户是长期合作。涉及过去的偏好、决定和约定时，先在 Lore 里查；遇到值得长期记住的新事实，记进 Lore。",
    );
  });

  it("off emits no section at all", () => {
    assert.equal(assistantMemorySectionText("off"), "");
  });

  it("renderAssistantSegment substitutes the section and keeps uniform section spacing", () => {
    const local = renderAssistantSegment(HOME, WORKSPACE, "local");
    assert.ok(local.includes("## 记忆\n你和用户是长期合作"));
    assert.ok(local.includes("memory_read"));
    assert.ok(local.includes(WORKSPACE));
    assert.ok(!local.includes("{memorySection}"));

    const lore = renderAssistantSegment(HOME, WORKSPACE, "lore");
    assert.ok(lore.includes("先在 Lore 里查"));
    assert.ok(!lore.includes("memory_read"));

    const off = renderAssistantSegment(HOME, WORKSPACE, "off");
    assert.ok(!off.includes("## 记忆"));
    // No doubled blank lines where the section used to sit.
    assert.ok(!off.includes("\n\n\n"));
    assert.ok(off.includes("## 沟通"));
  });

  it("applyAssistantSystemPrompt carries the provider into the assistant segment", () => {
    for (const provider of ["local", "lore", "off"] as const) {
      const options = applyLive(provider);
      assert.equal(options.customPrompt, ASSISTANT_PREAMBLE_TEMPLATE);
      const segment = options.sections!.assistant!;
      if (provider === "local") assert.ok(segment.includes("memory_read"));
      if (provider === "lore") assert.ok(segment.includes("先在 Lore 里查"));
      if (provider === "off") assert.ok(!segment.includes("## 记忆"));
    }
  });
});
