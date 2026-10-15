/**
 * Slice one CSS rule out of a stylesheet for source-shape assertions.
 *
 * Checkout on Windows may rewrite LF to CRLF (`core.autocrlf`), so a search
 * for the exact bytes `` `${selector} {` `` misses a rule whose `{` sits on
 * the next line as `{\r`. Matching ignores the line ending between the
 * selector and the brace, and folds CRLF inside a multi-line selector, so a
 * test can keep writing the LF form. The returned slice keeps the file's own
 * endings.
 */
export function cssRule(css: string, selector: string): string | undefined {
  const folded = foldNewlines(css);
  const pattern = new RegExp(`${escapeRegExp(foldNewlines(selector).text)}\\s*\\{`);
  const match = pattern.exec(folded.text);
  if (match === null) return undefined;
  const start = folded.toOriginal(match.index);
  const brace = folded.toOriginal(match.index + match[0].length);
  const end = css.indexOf("}", brace);
  if (end < 0) return undefined;
  return css.slice(start, end + 1);
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
