import { describe, expect, it } from "vitest";
import { negativeBlockDelta, parseNegativeBlockCsv, summarizeNegativeBlockRows } from "./negative-block-report";

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
