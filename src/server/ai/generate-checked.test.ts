import { describe, expect, it } from "vitest";
import { extractJsonObject } from "./generate-checked";

// The text-mode parse seam (followups.phase2.md #20): provider-side
// constrained decoding degenerated on some models, so generateChecked now
// reads plain text and extracts the object itself.
describe("extractJsonObject", () => {
  it("passes a bare JSON object through", () => {
    expect(extractJsonObject('{"a":1}')).toBe('{"a":1}');
  });

  it("strips markdown fences and surrounding prose", () => {
    expect(extractJsonObject('Here you go:\n```json\n{"a":1}\n```\nHope that helps!')).toBe('{"a":1}');
  });

  it("keeps nested objects and braces inside strings intact", () => {
    const obj = '{"a":{"b":"{not a brace pair}"},"c":[{"d":2}]}';
    expect(extractJsonObject("```\n" + obj + "\n```")).toBe(obj);
    expect(JSON.parse(extractJsonObject(obj))).toEqual({ a: { b: "{not a brace pair}" }, c: [{ d: 2 }] });
  });

  it("throws (into the repair ladder) when no object is present", () => {
    expect(() => extractJsonObject("I cannot help with that.")).toThrow("no JSON object");
    expect(() => extractJsonObject("")).toThrow("no JSON object");
  });
});
