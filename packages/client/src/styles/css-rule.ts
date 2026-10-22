/**
 * Slice one CSS rule out of a stylesheet for source-shape assertions.
 *
 * Comments are stripped first: a declaration block may carry `}` inside a
 * comment (`max(340px, …)` prose, for example), and a slice that stopped there
 * would report a partial rule.
 *
 * Checkout on Windows may rewrite LF to CRLF (`core.autocrlf`), so a search
 * for the exact bytes `` `${selector} {` `` misses a rule whose `{` sits on
 * the next line as `{\r`. Matching ignores the line ending between the
 * selector and the brace, and folds CRLF inside a multi-line selector, so a
 * test can keep writing the LF form. The returned slice keeps the file's own
 * endings.
 */
export function cssRule(css: string, selector: string): string | undefined {
  return listRule(css, selector) ?? exactRule(css, selector);
}

/**
 * Slice a rule whose selector list is exactly `selector` (not a member of a
 * shared list), so a shape declared once for several elements and extended per
 * element can be asserted separately.
 */
export function exactRule(css: string, selector: string): string | undefined {
  const body = `\\s*${escapeRegExp(foldNewlines(selector).text)}\\s*\\{`;
  return matchRule(css, `(?:^|\\})(\\s*${body})`, 1, /^\s*/);
}

/** Slice the first rule whose selector list contains `selector`. */
function listRule(css: string, selector: string): string | undefined {
  return matchRule(css, `${escapeRegExp(foldNewlines(selector).text)}\\s*\\{`);
}

/**
 * Slice the rule matched by `patternSource`. `group` names the capture holding
 * the rule itself when the pattern anchors on the preceding character, and
 * `lead` trims the whitespace that capture starts with.
 */
function matchRule(css: string, patternSource: string, group?: number, lead?: RegExp): string | undefined {
  const text = stripComments(css);
  const folded = foldNewlines(text);
  const match = new RegExp(patternSource).exec(folded.text);
  if (match === null) return undefined;
  const captured = group === undefined ? match[0] : match[group]!;
  const leadLength = lead === undefined ? 0 : (lead.exec(captured)?.[0].length ?? 0);
  const start = folded.toOriginal(match.index + match[0].length - captured.length + leadLength);
  const brace = folded.toOriginal(match.index + match[0].length);
  const end = text.indexOf("}", brace);
  if (end < 0) return undefined;
  return text.slice(start, end + 1);
}

/** Drop CSS comments, keeping every other byte (and offset) in place. */
function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "));
}

/** LF view of a string plus a map back to indexes in the original. */
function foldNewlines(value: string): { text: string; toOriginal: (index: number) => number } {
  let text = "";
  const map: number[] = [];
  for (let i = 0; i < value.length; i += 1) {
    if (value[i] === "\r" && value[i + 1] === "\n") continue;
    map.push(i);
    text += value[i];
  }
  return {
    text,
    toOriginal: (index) => map[index] ?? value.length,
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
