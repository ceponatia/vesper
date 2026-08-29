import { describe, expect, it } from "vitest";
import {
  negativeBlockDelta,
  parseManifestProvenance,
  parseNegativeBlockCsv,
  resumedRenderRecord,
  summarizeNegativeBlockRows,
} from "./negative-block-report";

/**
 * The counting the negative-block verdicts are read off of. Two defects this
 * kills: a blank (ungraded) cell silently counted as "no", which would
 * manufacture a failure-free arm out of an unfinished grading pass; and a
 * quoted notes cell with commas shifting every column after it.
 */
describe("negative block summarizer", () => {
  const csv = [
    "trial,fixture,arm,seed,file,support_visible,drape_1_5,notes",
    'B1,scarf,off,101,a.webp,yes,3,"soft, slight fold"',
    "B1,scarf,off,102,b.webp,no,4,",
    "B1,scarf,off,103,c.webp,,,",
    "B1,scarf,on,101,d.webp,no,4,",
    "B1,scarf,on,102,e.webp,no,2,",
  ].join("\n");

  it("excludes ungraded cells from n instead of counting them as no", () => {
    const summary = summarizeNegativeBlockRows(parseNegativeBlockCsv(csv));
    const off = summary.find((cell) => cell.arm === "off")?.metrics.find((m) => m.metric === "support_visible");
    // Three rows, one blank: n is 2 and the rate is 1/2 — not 1/3.
    expect(off).toMatchObject({ n: 2, yes: 1, rate: 0.5 });
    const drape = summary.find((cell) => cell.arm === "on")?.metrics.find((m) => m.metric === "drape_1_5");
    expect(drape).toMatchObject({ rate: null, mean: 3 });
  });

  it("computes the off-to-on delta only when both arms are graded", () => {
    const summary = summarizeNegativeBlockRows(parseNegativeBlockCsv(csv));
    const q = { trial: "B1", fixture: "scarf", metric: "support_visible", offArm: "off", onArm: "on" };
    expect(negativeBlockDelta(summary, q)).toEqual({ off: 0.5, on: 0, delta: -0.5 });
    expect(negativeBlockDelta(summary, { ...q, metric: "missing" })).toBeNull();
  });
});

/**
 * The defect this kills: a resumed --render run rebuilds the manifest, and the
 * old harness initialized every skipped (already-rendered) file's record with
 * null executedVersionId/predictionId — so resuming an interrupted trial
 * silently erased which provider version rendered the surviving images, and a
 * mid-trial provider re-point became invisible (PR #372 review finding).
 */
describe("manifest provenance resume", () => {
  const priorManifest = JSON.stringify({
    trial: "A",
    records: [
      { file: "out/A/apple_mug-on-s101.webp", seed: 101, arm: "on", fixture: "apple_mug", executedVersionId: "v-2026-08-28", predictionId: "pred-1" },
      { file: "out/A/apple_mug-off-s101.webp", seed: 101, arm: "off", fixture: "apple_mug", executedVersionId: null, predictionId: null },
    ],
  });

  it("carries a skipped render's recorded provenance and separates carried nulls from provenance-unknown", () => {
    const prior = parseManifestProvenance(priorManifest);
    const resumed = resumedRenderRecord({ file: "out/A/apple_mug-on-s101.webp", seed: 101, arm: "on", fixture: "apple_mug" }, prior);
    expect(resumed).toMatchObject({ executedVersionId: "v-2026-08-28", predictionId: "pred-1" });
    expect(resumed.provenanceUnknown).toBeUndefined();
    // A prior record that honestly held nulls (provider reported no version) is
    // carried as-is — not relabeled unknown.
    const carriedNull = resumedRenderRecord({ file: "out/A/apple_mug-off-s101.webp", seed: 101, arm: "off", fixture: "apple_mug" }, prior);
    expect(carriedNull).toMatchObject({ executedVersionId: null, predictionId: null });
    expect(carriedNull.provenanceUnknown).toBeUndefined();
    // No prior record at all (e.g. the first run died before its manifest
    // write) is marked, never a fresh null pair that reads as "not executed".
    const unknown = resumedRenderRecord({ file: "out/A/apple_mug-on-s102.webp", seed: 102, arm: "on", fixture: "apple_mug" }, prior);
    expect(unknown).toMatchObject({ executedVersionId: null, predictionId: null, provenanceUnknown: true });
  });

  it("treats a missing or malformed prior manifest as empty instead of aborting the resume", () => {
    expect(parseManifestProvenance(null).size).toBe(0);
    expect(parseManifestProvenance("{ truncated").size).toBe(0);
    expect(parseManifestProvenance('{"records":"nope"}').size).toBe(0);
  });
});
