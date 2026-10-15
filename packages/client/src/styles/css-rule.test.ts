/** @vitest-environment node */
import { describe, expect, it } from "vitest";
import { cssRule } from "./css-rule";

describe("cssRule", () => {
  const lf = ".frame {\n  color: red;\n}\n.other { color: blue; }";
  const crlf = lf.replace(/\n/g, "\r\n");

  it("finds a rule whether the stylesheet uses LF or CRLF", () => {
    expect(cssRule(lf, ".frame")).toContain("color: red");
    expect(cssRule(crlf, ".frame")).toContain("color: red");
    expect(cssRule(crlf, ".other")).toContain("color: blue");
  });

  it("returns undefined when the selector is absent", () => {
    expect(cssRule(lf, ".missing")).toBeUndefined();
  });

  it("does not treat a prefix of a longer selector as a match", () => {
    const css = ".frame-extra {\n  color: blue;\n}";
    expect(cssRule(css, ".frame")).toBeUndefined();
  });

  it("matches a multi-line selector written with LF against a CRLF stylesheet", () => {
    const css = ".a::before,\r\n.a::after {\r\n  content: \"\";\r\n}";
    expect(cssRule(css, ".a::before,\n.a::after")).toContain("content");
  });
});
