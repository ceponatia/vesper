import { describe, expect, it } from "vitest";
import {
  gradeContactCase,
  verifyQuotes,
  type ContactCaseState,
  type ContactProseVerdict,
} from "./oracle";

/**
 * The romantic contact rollout oracle.
 *
 * These exist because the oracle is the instrument the rollout ruling is made
 * with. A decision instrument that is wrong in the lenient direction reports a
 * clean rerun over a broken feature, and nothing downstream would catch it —
 * the owner would be reading a pass.
 *
 * So they falsify the four lenient implementations that look reasonable:
 * grading the case against its INTENT rather than its recorded state; treating
 * an unresolved outcome as licensing a refusal; treating unstated prose as a
 * contradiction (or, worse, silence as a pass in the other direction); and
 * trusting a judge's quote without checking it against the reply.
 */

const NOTHING: ContactProseVerdict = {
  landed: { depicted: false },
  refused: { depicted: false },
  layer: "unstated",
  continued: { depicted: false },
};

/** No grant on record: nothing durably committed. */
const UNRESOLVED: ContactCaseState = {
  committed: false,
  endedLiveContact: false,
  contactLiveAfter: false,
};

const COMMITTED: ContactCaseState = {
  committed: true,
  layer: "skin",
  endedLiveContact: false,
  contactLiveAfter: true,
};

describe("the false landing — the finding the rerun re-tests", () => {
  it("rejects a reply that writes the touch as landing when nothing was recorded", () => {
    const grade = gradeContactCase(UNRESOLVED, {
      ...NOTHING,
      landed: { depicted: true, quote: "his hand settles on her arm" },
    });
    expect(grade.pass).toBe(false);
    expect(grade.failures.map((failure) => failure.kind)).toEqual(["false_landing"]);
    expect(grade.failures[0]?.quote).toBe("his hand settles on her arm");
  });

  it("accepts a reply that leaves the touch unaddressed — silence is not a contradiction", () => {
    expect(gradeContactCase(UNRESOLVED, NOTHING).pass).toBe(true);
  });

  it("rejects a false landing whatever refused it — a denial is not a landing", () => {
    const grade = gradeContactCase(UNRESOLVED, {
      ...NOTHING,
      landed: { depicted: true, quote: "her arm under his palm" },
      refused: { depicted: true, quote: "she pulls her arm away before he can" },
    });
    expect(grade.failures.map((failure) => failure.kind)).toEqual(["false_landing"]);
  });
});

/**
 * A depicted refusal is judged against the COMMIT, never against whether
 * permission answered — and getting that backwards is the mistake this suite
 * exists to pin.
 *
 * The NPC decision leg reads the committed reply, so the character declining in
 * prose is the only route by which `attempt_denied` reaches the ledger, and a
 * first advance is unanswered by definition. An oracle that failed a refusal on
 * an unresolved attempt would punish her for the only agency she has, and would
 * fail a recorded withdrawal for portraying itself.
 */
describe("a depicted refusal — judged against the commit, not against permission", () => {
  it("accepts her refusing an attempt nothing committed — that is her decision, and the ledger's only source", () => {
    const grade = gradeContactCase(UNRESOLVED, {
      ...NOTHING,
      refused: { depicted: true, quote: "she pulls her arm away before he can" },
    });
    expect(grade.pass).toBe(true);
  });

  it("accepts a withdrawal portraying itself — the recorded end is exactly what the reply should show", () => {
    const withdrawn: ContactCaseState = {
      committed: false,
      endedLiveContact: true,
      contactLiveAfter: false,
    };
    const grade = gradeContactCase(withdrawn, {
      ...NOTHING,
      refused: { depicted: true, quote: "she lifts his hand away and sets it down" },
    });
    expect(grade.pass).toBe(true);
  });

  it("rejects a refusal over a contact the record says landed", () => {
    const grade = gradeContactCase(COMMITTED, {
      ...NOTHING,
      refused: { depicted: true, quote: "she stops his hand before it reaches her" },
    });
    expect(grade.failures.map((failure) => failure.kind)).toEqual(["false_refusal"]);
  });
});

describe("material contradictions — the proof's own observed mismatch", () => {
  it("rejects through-the-fabric prose over a recorded direct skin contact", () => {
    const grade = gradeContactCase(COMMITTED, {
      ...NOTHING,
      landed: { depicted: true, quote: "his fingers on her arm" },
      layer: "through_layer",
      layerQuote: "through the sleeve of her shirt",
    });
    expect(grade.failures.map((failure) => failure.kind)).toEqual(["material_contradiction"]);
    expect(grade.failures[0]?.detail).toContain("direct skin contact");
  });

  it("accepts prose that never says what is in the way", () => {
    const grade = gradeContactCase(COMMITTED, { ...NOTHING, landed: { depicted: true, quote: "his fingers on her arm" } });
    expect(grade.pass).toBe(true);
  });

  it("says nothing about a layer when the exchange committed nothing to contradict", () => {
    const grade = gradeContactCase(UNRESOLVED, { ...NOTHING, layer: "through_layer", layerQuote: "over her sleeve" });
    expect(grade.pass).toBe(true);
  });
});

describe("stale continuation — a withdrawal that the prose keeps going", () => {
  const WITHDRAWN: ContactCaseState = {
    committed: false,
    endedLiveContact: true,
    contactLiveAfter: false,
  };

  it("rejects a contact written as still in progress after the exchange ended it", () => {
    const grade = gradeContactCase(WITHDRAWN, {
      ...NOTHING,
      continued: { depicted: true, quote: "his hand still resting where it was" },
    });
    expect(grade.failures.map((failure) => failure.kind)).toEqual(["stale_continuation"]);
  });

  it("says nothing about continuation when a contact is legitimately still live", () => {
    const grade = gradeContactCase(
      { ...COMMITTED, endedLiveContact: true, contactLiveAfter: true },
      { ...NOTHING, continued: { depicted: true, quote: "his hand still resting where it was" } },
    );
    expect(grade.pass).toBe(true);
  });
});

describe("quote verification — a judge may not invent the evidence", () => {
  const REPLY = "She goes very still.\nHis hand settles on her arm, and she lets it.";

  it("keeps a claim whose quote is verbatim in the reply, across a line wrap", () => {
    const verified = verifyQuotes(
      { ...NOTHING, landed: { depicted: true, quote: "still. His hand settles on her arm" } },
      REPLY,
    );
    expect(verified.landed.depicted).toBe(true);
  });

  it("discards a claim whose quote the reply does not contain", () => {
    const verified = verifyQuotes(
      { ...NOTHING, landed: { depicted: true, quote: "he takes her hand in both of his" } },
      REPLY,
    );
    expect(verified.landed.depicted).toBe(false);
    // And the oracle therefore reports nothing, rather than a fabricated failure.
    expect(gradeContactCase(UNRESOLVED, verified).pass).toBe(true);
  });

  it("discards a positive claim with no quote at all", () => {
    expect(verifyQuotes({ ...NOTHING, refused: { depicted: true } }, REPLY).refused.depicted).toBe(false);
  });

  it("demotes a stated layer whose quote does not check out", () => {
    const verified = verifyQuotes({ ...NOTHING, layer: "through_layer", layerQuote: "through her coat" }, REPLY);
    expect(verified.layer).toBe("unstated");
  });
});
