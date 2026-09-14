import { describe, expect, it } from "vitest";
import { mergeRenderAdvisoryReview } from "./render-advisories-review";

/**
 * Kills two defects: (1) a re-validation that silently drops a PRIOR review
 * when a second one is merged (the exact failure a strict re-parse of the
 * producer-side `renderAdvisorySchema` would cause, since that schema has no
 * `review` field and zod strips unknown keys by default); and (2) a merge
 * that fabricates a 404-worthy "found" result for a code the render never
 * actually measured.
 */

const AT = "2026-09-13T00:00:00.000Z";

function metaWithAdvisories(advisories: unknown[]): unknown {
  return { render: { modelId: "m1" }, advisories };
}

describe("mergeRenderAdvisoryReview", () => {
  it("attaches a review onto the matching advisory and leaves siblings untouched", () => {
    const meta = metaWithAdvisories([
      { version: 1, code: "blank_output", level: "advisory", reason: "r1", evidence: {}, offers: ["retry_same"] },
      { version: 1, code: "harmful_crop_loss", level: "advisory", reason: "r2", evidence: {}, offers: ["new_variation"] },
    ]);
    const result = mergeRenderAdvisoryReview(meta, { code: "blank_output", verdict: "agree" }, AT);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.advisory).toEqual({
      version: 1,
      code: "blank_output",
      level: "advisory",
      reason: "r1",
      evidence: {},
      offers: ["retry_same"],
      review: { verdict: "agree", at: AT },
    });
    // The untouched sibling entry and the unrelated `render` key survive.
    expect(result.meta.render).toEqual({ modelId: "m1" });
    expect((result.meta.advisories as unknown[])[1]).toEqual({
      version: 1,
      code: "harmful_crop_loss",
      level: "advisory",
      reason: "r2",
      evidence: {},
      offers: ["new_variation"],
    });
  });

  it("includes the note only when one was given", () => {
    const meta = metaWithAdvisories([{ code: "blank_output" }]);
    const withNote = mergeRenderAdvisoryReview(meta, { code: "blank_output", verdict: "disagree", note: "looked fine to me" }, AT);
    if (!withNote.ok) throw new Error("unreachable");
    expect(withNote.advisory.review).toEqual({ verdict: "disagree", note: "looked fine to me", at: AT });

    const withoutNote = mergeRenderAdvisoryReview(meta, { code: "blank_output", verdict: "agree" }, AT);
    if (!withoutNote.ok) throw new Error("unreachable");
    expect(withoutNote.advisory.review).toEqual({ verdict: "agree", at: AT });
  });

  it("a second review REPLACES the first rather than stacking or averaging", () => {
    const meta = metaWithAdvisories([{ code: "blank_output", review: { verdict: "agree", at: "2020-01-01T00:00:00.000Z" } }]);
    const result = mergeRenderAdvisoryReview(meta, { code: "blank_output", verdict: "disagree", note: "changed my mind" }, AT);
    if (!result.ok) throw new Error("unreachable");
    expect(result.advisory.review).toEqual({ verdict: "disagree", note: "changed my mind", at: AT });
  });

  it("preserves a prior review on an advisory it does not touch (the passthrough-versus-strict-reparse defect)", () => {
    const meta = metaWithAdvisories([
      { code: "blank_output", review: { verdict: "agree", at: "2020-01-01T00:00:00.000Z" } },
      { code: "harmful_crop_loss" },
    ]);
    const result = mergeRenderAdvisoryReview(meta, { code: "harmful_crop_loss", verdict: "agree" }, AT);
    if (!result.ok) throw new Error("unreachable");
    const untouched = (result.meta.advisories as Array<Record<string, unknown>>)[0];
    expect(untouched?.review).toEqual({ verdict: "agree", at: "2020-01-01T00:00:00.000Z" });
  });

  it("refuses (ok:false) for a code this render never measured", () => {
    const meta = metaWithAdvisories([{ code: "blank_output" }]);
    const result = mergeRenderAdvisoryReview(meta, { code: "severe_blur", verdict: "agree" }, AT);
    expect(result.ok).toBe(false);
  });

  it("refuses (ok:false) when the row carries no advisories at all", () => {
    const result = mergeRenderAdvisoryReview({ render: { modelId: "m1" } }, { code: "blank_output", verdict: "agree" }, AT);
    expect(result.ok).toBe(false);
  });

  it("degrades to refused rather than throwing on a malformed advisories value", () => {
    const result = mergeRenderAdvisoryReview({ advisories: "not an array" }, { code: "blank_output", verdict: "agree" }, AT);
    expect(result.ok).toBe(false);
  });

  it("merges the valid target and preserves malformed siblings byte-for-byte in place (per-entry parse, not whole-array)", () => {
    // A whole-array `z.array(storedAdvisorySchema).safeParse(...)` would fail
    // on ANY of these three siblings and answer 404 for a code that is
    // genuinely present right beside them.
    const stringSibling = "not an advisory at all";
    const numberSibling = 42;
    const noCodeSibling = { level: "advisory", reason: "no code field" };
    const target = { code: "blank_output", version: 1 };
    const meta = metaWithAdvisories([stringSibling, numberSibling, target, noCodeSibling]);

    const result = mergeRenderAdvisoryReview(meta, { code: "blank_output", verdict: "agree" }, AT);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");

    expect(result.advisory).toEqual({ code: "blank_output", version: 1, review: { verdict: "agree", at: AT } });

    const advisories = result.meta.advisories as unknown[];
    expect(advisories).toHaveLength(4);
    // Every non-matching element survives EXACTLY as given — same value,
    // same position — never dropped, never reshaped.
    expect(advisories[0]).toBe(stringSibling);
    expect(advisories[1]).toBe(numberSibling);
    expect(advisories[2]).toEqual({ code: "blank_output", version: 1, review: { verdict: "agree", at: AT } });
    expect(advisories[3]).toBe(noCodeSibling);
  });

  it("refuses (ok:false) when the only entry is malformed, rather than treating it as a match", () => {
    const meta = metaWithAdvisories(["not an advisory", 7, { level: "advisory" }]);
    const result = mergeRenderAdvisoryReview(meta, { code: "blank_output", verdict: "agree" }, AT);
    expect(result.ok).toBe(false);
  });
});
