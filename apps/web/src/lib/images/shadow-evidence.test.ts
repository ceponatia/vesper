import { describe, expect, it } from "vitest";
import {
  SHADOW_EVIDENCE_ABSENT,
  summarizeShadowEvidence,
  type ShadowEvidenceComparison,
  type ShadowEvidenceRecord,
  type ShadowEvidenceVerdict,
} from "@/lib/images/shadow-evidence";

/**
 * The arithmetic a cutover decision is read off (issue #256).
 *
 * Every case here kills a defect that would produce a CONFIDENT WRONG NUMBER
 * rather than a visible failure — which is the only kind of defect this module
 * can have, since a summary nobody can check is indistinguishable from a
 * summary that is right. Nothing below re-tests the comparator itself
 * (`server/images/shadow-comparison.test.ts` owns the verdicts) or the report
 * driver's query.
 */

/** A parity record with everything measured — the base every case mutates. */
function comparison(over: Partial<ShadowEvidenceComparison> = {}): ShadowEvidenceComparison {
  return {
    lane: "variant",
    verdict: "parity",
    codes: [],
    coverage: { matches: true, missing: [], unexpected: [], duplicated: [], staleAllowlist: [] },
    transport: { parity: true, firstMismatch: null },
    mandatory: { survived: true, missing: [] },
    payload: { legacyChars: 400, compiledChars: 500 },
    ...over,
  };
}

function record(over: Partial<ShadowEvidenceComparison>, identity: Omit<ShadowEvidenceRecord, "comparison"> = {}): ShadowEvidenceRecord {
  return { comparison: comparison(over), ...identity };
}

/** The record `shadowErrorComparison` writes, verbatim in shape: FALSE, not null. */
function errorRecord(): ShadowEvidenceRecord {
  return record({
    verdict: "error",
    codes: ["image_shadow.comparator_failed"],
    coverage: { matches: false, missing: [], unexpected: [], duplicated: [], staleAllowlist: [] },
    transport: { parity: null, firstMismatch: null },
    mandatory: { survived: false, missing: [] },
    payload: { legacyChars: 400, compiledChars: 0 },
  });
}

describe("summarizeShadowEvidence", () => {
  it("keeps the four verdicts apart and never counts unmeasured or error as measured", () => {
    // Falsifies the natural shortcut `measured = total - divergence`, and the
    // worse one where "not diverged" is reported as parity: a window that is
    // mostly refusals would then read as a cutover go-ahead.
    const verdicts: readonly ShadowEvidenceVerdict[] = [
      "parity",
      "parity",
      "divergence",
      "unmeasured",
      "unmeasured",
      "unmeasured",
      "error",
    ];
    const summary = summarizeShadowEvidence(verdicts.map((verdict) => record({ verdict })));

    expect(summary.total).toBe(7);
    expect(summary.verdicts).toEqual({ parity: 2, divergence: 1, unmeasured: 3, error: 1 });
    expect(summary.measured).toBe(3);
  });

  it("does not attribute a comparator failure's placeholder falses as real coverage or mandatory losses", () => {
    // The trap: `shadowErrorComparison` fills the record's shape with
    // `coverage.matches: false` and `mandatory.survived: false` because the
    // stored schema has no room for "not applicable". An aggregator that reads
    // those as measurements reports every comparator crash as a lost fact AND a
    // lost mandatory anchor — the two findings that would block a promotion.
    const summary = summarizeShadowEvidence([
      errorRecord(),
      errorRecord(),
      record({
        verdict: "divergence",
        codes: ["image_shadow.fact_lost", "image_shadow.mandatory_lost"],
        coverage: { matches: false, missing: ["horns"], unexpected: [], duplicated: [], staleAllowlist: [] },
        mandatory: { survived: false, missing: ["identity.gender"] },
      }),
    ]);

    expect(summary.coverage.attributed).toBe(1);
    expect(summary.coverage.withMissing).toBe(1);
    expect(summary.coverage.missingFacts).toEqual([{ value: "horns", count: 1 }]);
    expect(summary.mandatory.attributed).toBe(1);
    expect(summary.mandatory.failures).toBe(1);
    expect(summary.mandatory.missingFacts).toEqual([{ value: "identity.gender", count: 1 }]);
    // The error records are still records, and their transport half is honestly
    // uncaptured rather than dropped.
    expect(summary.total).toBe(3);
    expect(summary.transport.uncaptured).toBe(2);
  });

  it("excludes records with no compiled prompt from the payload statistics and counts them separately", () => {
    // `compiledChars: 0` is the unmeasured/error signature — there was no
    // compiled prompt at all. Averaging those in reports a payload shrink that
    // is really an absence, which is exactly the figure a cutover would cite.
    const summary = summarizeShadowEvidence([
      record({ payload: { legacyChars: 300, compiledChars: 100 } }),
      record({ payload: { legacyChars: 400, compiledChars: 200 } }),
      record({ payload: { legacyChars: 500, compiledChars: 600 } }),
      record({ verdict: "unmeasured", payload: { legacyChars: 900, compiledChars: 0 } }),
    ]);

    expect(summary.payload.measured).toBe(3);
    expect(summary.payload.excludedNoCompiled).toBe(1);
    expect(summary.payload.compiled).toEqual({ count: 3, min: 100, median: 200, max: 600, mean: 300 });
    expect(summary.payload.legacy).toEqual({ count: 3, min: 300, median: 400, max: 500, mean: 400 });
  });

  it("orders every frequency table by count then value, and tallies codes from unmeasured records too", () => {
    // Two claims, one fixture. Insertion-order ties would make two runs of one
    // report disagree because the query returned rows in a different order; and
    // the unmeasured-half codes are appended AFTER the verdict is computed, so a
    // summary that skipped them would hide WHY a window is unmeasured.
    const summary = summarizeShadowEvidence([
      record({ verdict: "unmeasured", codes: ["image_shadow.transport_uncaptured"] }),
      record({ verdict: "unmeasured", codes: ["image_shadow.coverage_unmeasured", "image_shadow.transport_uncaptured"] }),
      record({ verdict: "divergence", codes: ["image_shadow.fact_lost"] }),
    ]);

    expect(summary.codes).toEqual([
      { value: "image_shadow.transport_uncaptured", count: 2 },
      { value: "image_shadow.coverage_unmeasured", count: 1 },
      { value: "image_shadow.fact_lost", count: 1 },
    ]);
    // Codes present is not divergence: two of these three records diverged nothing.
    expect(summary.verdicts.divergence).toBe(1);
  });

  it("splits verdicts per variant kind and names an absent binding instead of dropping or defaulting it", () => {
    // A row that failed a precondition never reaches `produce`, so it carries a
    // shadow verdict and no `meta.render`. Dropping it would shrink the
    // denominator silently; defaulting it would attribute its verdict to
    // whichever model the other rows ran on.
    const summary = summarizeShadowEvidence([
      record({ verdict: "parity" }, { variantKind: "pose", modelSlug: "qwen/qwen-image-edit-2511" }),
      record({ verdict: "divergence" }, { variantKind: "pose", modelSlug: "qwen/qwen-image-edit-2511" }),
      record({ verdict: "parity" }, { variantKind: "outfit", modelSlug: "qwen/qwen-image-edit-2511" }),
      record({ verdict: "unmeasured" }, { variantKind: null, modelSlug: null }),
    ]);

    expect(summary.byVariantKind).toEqual([
      { variantKind: "pose", total: 2, verdicts: { parity: 1, divergence: 1, unmeasured: 0, error: 0 } },
      { variantKind: SHADOW_EVIDENCE_ABSENT, total: 1, verdicts: { parity: 0, divergence: 0, unmeasured: 1, error: 0 } },
      { variantKind: "outfit", total: 1, verdicts: { parity: 1, divergence: 0, unmeasured: 0, error: 0 } },
    ]);
    expect(summary.binding.modelSlug).toEqual([
      { value: "qwen/qwen-image-edit-2511", count: 3 },
      { value: SHADOW_EVIDENCE_ABSENT, count: 1 },
    ]);
  });
});
