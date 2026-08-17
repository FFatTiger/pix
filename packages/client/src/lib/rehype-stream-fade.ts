/**
 * LobeUI Streamdown-style character fade for streaming Markdown.
 *
 * New characters start at opacity 0 and fade in over 280ms with
 * cubic-bezier(0.33, 0, 0.67, 1). Already-visible characters stay revealed
 * so later tokens do not restart the animation.
 */
import type { Element, ElementContent, Properties, Root } from "hast";
import { visit } from "unist-util-visit";

export const STREAM_FADE_DURATION_MS = 280;

export interface StreamFadeOptions {
  births?: readonly number[];
  fadeDuration?: number;
  nowMs?: number;
}

const BLOCK_TAGS = new Set(["p", "h1", "h2", "h3", "h4", "h5", "h6", "li"]);
const SKIP_TAGS = new Set(["pre", "code", "table", "svg"]);

function classList(node: Element): string[] {
  const value: unknown = node.properties?.className;
  if (Array.isArray(value)) return value.map((item) => String(item));
  if (typeof value === "string") return value.split(/\s+/).filter(Boolean);
  return [];
}

function hasClass(node: Element, className: string): boolean {
  return classList(node).some((item) => item.includes(className));
}

export function rehypeStreamFade(options: StreamFadeOptions = {}) {
  const { births, fadeDuration = STREAM_FADE_DURATION_MS, nowMs } = options;
  const hasBirths = Array.isArray(births) && typeof nowMs === "number";

  return (tree: Root): void => {
    let globalCharIndex = 0;

    const shouldSkip = (node: Element): boolean => (
      SKIP_TAGS.has(node.tagName) || hasClass(node, "katex")
    );

    const wrapText = (node: Element): void => {
      const nextChildren: ElementContent[] = [];
      for (const child of node.children) {
        if (child.type === "text") {
          for (const char of child.value) {
            let className = "stream-char";
            let delay: number | undefined;
            if (hasBirths) {
              const birthTs = births[globalCharIndex];
              if (birthTs === undefined) {
                className = "stream-char stream-char-revealed";
              } else {
                const elapsed = nowMs - birthTs;
                if (elapsed >= fadeDuration) {
                  className = "stream-char stream-char-revealed";
                } else {
                  delay = -elapsed;
                }
              }
            }
            const properties: Properties = { className: [className] };
            if (delay !== undefined && delay !== 0) {
              properties.style = `animation-delay:${delay}ms`;
            }
            nextChildren.push({
              type: "element",
              tagName: "span",
              properties,
              children: [{ type: "text", value: char }],
            });
            globalCharIndex += 1;
          }
        } else if (child.type === "element") {
          if (!shouldSkip(child)) wrapText(child);
          nextChildren.push(child);
        } else {
          nextChildren.push(child);
        }
      }
      node.children = nextChildren;
    };

    visit(tree, "element", (node: Element) => {
      if (shouldSkip(node)) return "skip";
      if (BLOCK_TAGS.has(node.tagName)) {
        wrapText(node);
        return "skip";
      }
      return undefined;
    });
  };
}

/** Record birth timestamps for newly appended streaming characters. */
export function extendStreamBirths(
  previousText: string,
  nextText: string,
  previousBirths: readonly number[],
  nowMs: number,
): number[] {
  if (nextText.startsWith(previousText)) {
    const births = previousBirths.slice(0, previousText.length);
    for (let index = previousText.length; index < nextText.length; index += 1) {
      births[index] = nowMs;
    }
    return births;
  }
  return Array.from({ length: nextText.length }, () => nowMs);
}
