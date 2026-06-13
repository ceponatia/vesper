import { describe, expect, it } from "vitest";
import { parseInlineMarkup } from "./inline-markup";

describe("parseInlineMarkup", () => {
  it("passes plain text through", () => {
    expect(parseInlineMarkup("The lantern gutters.")).toEqual([
      { kind: "text", text: "The lantern gutters." },
    ]);
  });

  it("returns no tokens for an empty string", () => {
    expect(parseInlineMarkup("")).toEqual([]);
  });

  it("parses *italic*", () => {
    expect(parseInlineMarkup("She *almost* smiles.")).toEqual([
      { kind: "text", text: "She " },
      { kind: "em", text: "almost" },
      { kind: "text", text: " smiles." },
    ]);
  });

  it("parses **bold**", () => {
    expect(parseInlineMarkup("**Don't.**")).toEqual([{ kind: "strong", text: "Don't." }]);
  });

  it("handles bold and italic in one string", () => {
    expect(parseInlineMarkup("*soft* and **loud**")).toEqual([
      { kind: "em", text: "soft" },
      { kind: "text", text: " and " },
      { kind: "strong", text: "loud" },
    ]);
  });

  it("leaves unmatched asterisks literal", () => {
    expect(parseInlineMarkup("2 * 3 = 6")).toEqual([{ kind: "text", text: "2 * 3 = 6" }]);
    expect(parseInlineMarkup("*unclosed")).toEqual([{ kind: "text", text: "*unclosed" }]);
  });

  it("leaves empty markers literal", () => {
    expect(parseInlineMarkup("****two**")).toEqual([
      { kind: "text", text: "**" },
      { kind: "strong", text: "two" },
    ]);
  });

  it("does not span italics across newlines", () => {
    expect(parseInlineMarkup("*a\nb*")).toEqual([{ kind: "text", text: "*a\nb*" }]);
  });

  it("preserves newlines inside text tokens", () => {
    expect(parseInlineMarkup("one\n\ntwo")).toEqual([{ kind: "text", text: "one\n\ntwo" }]);
  });
});
