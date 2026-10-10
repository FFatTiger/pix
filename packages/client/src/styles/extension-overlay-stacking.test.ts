/** @vitest-environment node */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

function rule(source: string, selector: string): string {
  const start = source.indexOf(`${selector} {`);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = source.indexOf("}", start);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe("extension overlay stacking", () => {
  it("keeps Ask above streaming composer controls while preserving the conversation container contract", () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), "..");
    const questionnaireCss = readFileSync(join(root, "components/chat/ExtensionQuestionnaire.css"), "utf8");
    const dialog = readFileSync(join(root, "components/chat/ExtensionDialog.tsx"), "utf8");
    const chatInput = readFileSync(join(root, "components/chat/ChatInput.tsx"), "utf8");
    const overlay = rule(questionnaireCss, ".questionnaire-overlay");

    expect(overlay).toContain("position: absolute");
    expect(overlay).not.toContain("position: fixed");
    expect(overlay).toContain("z-index: 140");
    expect(Number(overlay.match(/z-index:\s*(\d+)/)?.[1])).toBeGreaterThan(130);
    expect(Number(overlay.match(/z-index:\s*(\d+)/)?.[1])).toBeLessThan(199);
    expect(dialog).toContain('zIndex: 140');
    expect(chatInput).toContain("zIndex: 130");
  });
});
