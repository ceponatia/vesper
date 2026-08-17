import { describe, expect, it } from "vitest";
import { parseOr } from "@/lib/parse";
import {
  applyVisualCueMentions,
  capVisualCueRecords,
  emptyVisualCueState,
  observeVisualCues,
  recordVisualCuesSpoken,
  visualCueRecentlySpoken,
  visualCueFamilyFingerprint,
  visualCueNovelty,
  visualCueStateSchema,
  visualCueVisibilityStatus,
  VISUAL_CUE_NOVELTY_FIRST_VISIBLE,
  VISUAL_CUE_RECORDS_MAX,
  type VisualCueRecord,
  type VisualCueState,
} from "./cue-state";

/**
 * Slice-7 cue-state tests (visual-state.plan.md §Open questions → "how
 * repetition and first visibility are tracked for facts recognition does not
 * hold", ruled 2026-08-17).
 *
 * The two questions this record exists to answer, proved separately: was this
 * family in view LAST cut, and when did the narrator last say it. Plus the
 * property that makes both trustworthy — a retake replays from the restored
 * state and lands on identical counts.
 */

const SLEEVE = "recognition.garment_presentation.garment_part:g1:sleeve_left";
const POSTURE = "recognition.body_posture.subject:npc";

function observed(state: VisualCueState, atMinutes: number, keys: readonly string[]): VisualCueState {
  return observeVisualCues(state, {
    atMinutes,
    observations: keys.map((repeatKey) => ({ repeatKey, familyFingerprint: `fp_${repeatKey}` })),
  });
}

describe("visualCueFamilyFingerprint", () => {
  it("describes the family's truth, not the order an adapter emitted it in", () => {
    const forward = visualCueFamilyFingerprint([
      { key: "a", truthFingerprint: "fp_a" },
      { key: "b", truthFingerprint: "fp_b" },
    ]);
    const reversed = visualCueFamilyFingerprint([
      { key: "b", truthFingerprint: "fp_b" },
      { key: "a", truthFingerprint: "fp_a" },
    ]);
    expect(reversed).toBe(forward);
  });

  it("moves when any member's truth moves", () => {
    const before = visualCueFamilyFingerprint([{ key: "a", truthFingerprint: "fp_a" }]);
    const after = visualCueFamilyFingerprint([{ key: "a", truthFingerprint: "fp_a2" }]);
    expect(after).not.toBe(before);
  });
});

describe("visualCueVisibilityStatus", () => {
  it("calls a family nobody has recorded first_visible", () => {
    const status = visualCueVisibilityStatus({
      state: emptyVisualCueState(),
      repeatKey: SLEEVE,
      familyFingerprint: "fp",
    });
    expect(status).toBe("first_visible");
    expect(visualCueNovelty(status)).toBe(VISUAL_CUE_NOVELTY_FIRST_VISIBLE);
  });

  it("calls a family in continuous, unchanged view steady — the quiet case", () => {
    const state = observed(emptyVisualCueState(), 10, [SLEEVE]);
    expect(
      visualCueVisibilityStatus({ state, repeatKey: SLEEVE, familyFingerprint: `fp_${SLEEVE}` }),
    ).toBe("steady");
  });

  it("calls a family that missed a cut revealed — visibility returned without the truth moving", () => {
    // Cut 1: the sleeve is in view. Cut 2: a coat covers it, so only the
    // posture is observed. Cut 3 asks about the sleeve again — its own
    // fingerprint never changed, and nothing but this record can tell.
    let state = observed(emptyVisualCueState(), 10, [SLEEVE, POSTURE]);
    state = observed(state, 20, [POSTURE]);
    expect(
      visualCueVisibilityStatus({ state, repeatKey: SLEEVE, familyFingerprint: `fp_${SLEEVE}` }),
    ).toBe("revealed");
    // …while the posture, in view throughout, stays quiet.
    expect(
      visualCueVisibilityStatus({ state, repeatKey: POSTURE, familyFingerprint: `fp_${POSTURE}` }),
    ).toBe("steady");
  });

  it("calls a moved fingerprint changed, and change outranks a reappearance", () => {
    let state = observed(emptyVisualCueState(), 10, [SLEEVE]);
    state = observed(state, 20, []);
    expect(visualCueVisibilityStatus({ state, repeatKey: SLEEVE, familyFingerprint: "fp_rolled" })).toBe("changed");
  });

  it("counts cuts, not story minutes — a long gap between turns is not a reveal", () => {
    // Three story days pass between two consecutive cuts. The sleeve was in
    // view for both, so it is steady: any minute-threshold rule would call this
    // newly revealed and re-introduce an unchanged sleeve.
    let state = observed(emptyVisualCueState(), 10, [SLEEVE]);
    state = observed(state, 10 + 4_320, [SLEEVE]);
    expect(
      visualCueVisibilityStatus({ state, repeatKey: SLEEVE, familyFingerprint: `fp_${SLEEVE}` }),
    ).toBe("steady");
  });
});

describe("observeVisualCues", () => {
  it("advances the cut counter once per call, even with nothing in view", () => {
    const state = observeVisualCues(emptyVisualCueState(), { atMinutes: 5, observations: [] });
    expect(state.sequence).toBe(1);
    expect(state.cues).toEqual({});
  });

  it("keeps the first-seen stamp and moves only the last-seen one", () => {
    let state = observed(emptyVisualCueState(), 10, [SLEEVE]);
    state = observed(state, 90, [SLEEVE]);
    const record = state.cues[SLEEVE];
    expect(record?.firstVisibleAtMinutes).toBe(10);
    expect(record?.lastVisibleAtMinutes).toBe(90);
    expect(record?.lastVisibleSequence).toBe(2);
  });

  it("never deletes a family that left view — that record IS the reveal signal", () => {
    let state = observed(emptyVisualCueState(), 10, [SLEEVE]);
    state = observed(state, 20, []);
    expect(state.cues[SLEEVE]).toBeDefined();
    expect(state.cues[SLEEVE]?.lastVisibleSequence).toBe(1);
  });

  it("ignores a blank repeat key rather than minting a row for it", () => {
    const state = observeVisualCues(emptyVisualCueState(), {
      atMinutes: 1,
      observations: [{ repeatKey: "", familyFingerprint: "fp" }],
    });
    expect(state.cues).toEqual({});
  });

  it("heals a non-finite clock to zero rather than storing NaN", () => {
    const state = observeVisualCues(emptyVisualCueState(), {
      atMinutes: Number.NaN,
      observations: [{ repeatKey: SLEEVE, familyFingerprint: "fp" }],
    });
    expect(state.cues[SLEEVE]?.lastVisibleAtMinutes).toBe(0);
  });
});

describe("applyVisualCueMentions", () => {
  it("starts the cooldown only for the families that were actually said", () => {
    const seen = observed(emptyVisualCueState(), 10, [SLEEVE, POSTURE]);
    const after = applyVisualCueMentions(seen, [{ repeatKey: SLEEVE, atMinutes: 10 }]);
    expect(after.cues[SLEEVE]?.lastMentionedAtMinutes).toBe(10);
    expect(after.cues[SLEEVE]?.mentionCount).toBe(1);
    expect(after.cues[POSTURE]?.lastMentionedAtMinutes).toBeUndefined();
  });

  it("is a no-op for a family the state holds no row for", () => {
    const state = emptyVisualCueState();
    expect(applyVisualCueMentions(state, [{ repeatKey: SLEEVE, atMinutes: 10 }])).toEqual(state);
  });

  it("widens the window with each mention", () => {
    let state = observed(emptyVisualCueState(), 10, [SLEEVE]);
    state = applyVisualCueMentions(state, [{ repeatKey: SLEEVE, atMinutes: 10 }]);
    state = applyVisualCueMentions(state, [{ repeatKey: SLEEVE, atMinutes: 20 }]);
    expect(state.cues[SLEEVE]?.mentionCount).toBe(2);
    expect(state.cues[SLEEVE]?.lastMentionedAtMinutes).toBe(20);
  });

  it("leaves the cut counter alone — saying is not seeing", () => {
    const seen = observed(emptyVisualCueState(), 10, [SLEEVE]);
    expect(applyVisualCueMentions(seen, [{ repeatKey: SLEEVE, atMinutes: 10 }]).sequence).toBe(seen.sequence);
  });
});

describe("the spoken ledger", () => {
  it("marks a family spoken at the current cut and quiets it for exactly the next one", () => {
    const seen = observed(emptyVisualCueState(), 10, [SLEEVE]);
    const said = recordVisualCuesSpoken(seen, [SLEEVE]);
    expect(said.spoken[SLEEVE]).toBe(seen.sequence);
    // The cut immediately after: still quiet.
    expect(visualCueRecentlySpoken(said, SLEEVE)).toBe(true);
    // One cut later: fenced again, because a fact absent from the fence is a
    // fact the narrator is free to contradict.
    const next = observed(said, 20, [SLEEVE]);
    expect(visualCueRecentlySpoken(next, SLEEVE)).toBe(false);
  });

  it("says nothing about a family that was never spoken", () => {
    const seen = observed(emptyVisualCueState(), 10, [SLEEVE, POSTURE]);
    expect(visualCueRecentlySpoken(recordVisualCuesSpoken(seen, [SLEEVE]), POSTURE)).toBe(false);
  });

  it("records families memory owns too — the window is about the prompt, not the observer", () => {
    // The ledger takes a repeat key it holds no visibility record for, because
    // a recognizable feature's cooldown lives in observer memory while its
    // fence entry is still a thing the prompt just said.
    const said = recordVisualCuesSpoken(observed(emptyVisualCueState(), 10, []), ["recognition.appearance_mark.nose"]);
    expect(visualCueRecentlySpoken(said, "recognition.appearance_mark.nose")).toBe(true);
  });

  it("leaves the ledger alone through a visibility pass — seeing is not saying", () => {
    const said = recordVisualCuesSpoken(observed(emptyVisualCueState(), 10, [SLEEVE]), [SLEEVE]);
    expect(observed(said, 20, [SLEEVE]).spoken).toEqual(said.spoken);
  });

  it("caps the ledger, keeping the newest cuts, in key order", () => {
    let state = emptyVisualCueState();
    for (let index = 0; index < VISUAL_CUE_RECORDS_MAX + 3; index += 1) {
      state = observeVisualCues(state, { atMinutes: index, observations: [] });
      state = recordVisualCuesSpoken(state, [`family_${String(index).padStart(3, "0")}`]);
    }
    const keys = Object.keys(state.spoken);
    expect(keys).toHaveLength(VISUAL_CUE_RECORDS_MAX);
    expect(keys).not.toContain("family_000");
    expect([...keys].sort()).toEqual(keys);
  });
});

describe("retakes", () => {
  it("replays from the restored state and lands on identical counts", () => {
    // The two-generation store hands back the pre-exchange state on a retake;
    // this is the property that makes that correct — three takes of one
    // exchange all produce the same sequence and the same mention count.
    const before = observed(emptyVisualCueState(), 10, [SLEEVE]);
    const takes = [1, 2, 3].map(() =>
      JSON.stringify(
        applyVisualCueMentions(observed(before, 20, [SLEEVE]), [{ repeatKey: SLEEVE, atMinutes: 20 }]),
      ),
    );
    expect(new Set(takes).size).toBe(1);
    const replayed = JSON.parse(takes[0] ?? "{}") as VisualCueState;
    expect(replayed.sequence).toBe(2);
    expect(replayed.cues[SLEEVE]?.mentionCount).toBe(1);
  });
});

describe("the boundary", () => {
  it("heals a corrupt blob to nothing seen yet rather than throwing", () => {
    expect(parseOr(visualCueStateSchema, "not an object", emptyVisualCueState())).toEqual(emptyVisualCueState());
    expect(parseOr(visualCueStateSchema, { sequence: -4, cues: [] }, emptyVisualCueState())).toEqual({
      sequence: 0,
      cues: {},
      spoken: {},
    });
  });

  it("drops a row that cannot name itself and re-keys by the row's own value", () => {
    const parsed = parseOr(
      visualCueStateSchema,
      {
        sequence: 3,
        cues: {
          broken: { repeatKey: "" },
          mislabelled: {
            repeatKey: SLEEVE,
            visibleFingerprint: "fp",
            firstVisibleAtMinutes: 1,
            lastVisibleAtMinutes: 2,
            lastVisibleSequence: 3,
            lastMentionedAtMinutes: null,
            mentionCount: 0,
          },
        },
      },
      emptyVisualCueState(),
    );
    expect(Object.keys(parsed.cues)).toEqual([SLEEVE]);
    expect(parsed.sequence).toBe(3);
  });

  it("caps the record, evicting the coldest cuts first, in key order", () => {
    const cues: Record<string, VisualCueRecord> = {};
    for (let index = 0; index < VISUAL_CUE_RECORDS_MAX + 5; index += 1) {
      const repeatKey = `family_${String(index).padStart(3, "0")}`;
      cues[repeatKey] = {
        repeatKey,
        visibleFingerprint: "fp",
        firstVisibleAtMinutes: 0,
        lastVisibleAtMinutes: index,
        lastVisibleSequence: index,
        mentionCount: 0,
      };
    }
    const capped = capVisualCueRecords(cues);
    const keys = Object.keys(capped);
    expect(keys).toHaveLength(VISUAL_CUE_RECORDS_MAX);
    // The five coldest went, and the survivors come back sorted so a replay is
    // byte-equal.
    expect(keys).not.toContain("family_004");
    expect(keys).toContain("family_005");
    expect([...keys].sort()).toEqual(keys);
  });
});
