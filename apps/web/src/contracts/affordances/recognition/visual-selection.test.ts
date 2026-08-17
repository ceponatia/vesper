import { describe, expect, it } from "vitest";
import { expectDiagnostic } from "@/test/diagnostics";
import { DiagnosticCollector } from "../../diagnostics";
import {
  projectSpeciesFeatureGroups,
  visualStateFeatureFixture,
  visualStateNonHumanBody,
  VISUAL_STATE_BODY_LANGUAGE_POSTURE_KIND_ID,
  VISUAL_STATE_INTIMATE_GATED,
  type VisualStateFeature,
  type VisualStateSnapshot,
} from "../../visual-state";
import { affordancePerceptionView, toUnitInterval, AFFORDANCE_UNIT_ONE } from "../core";
import {
  recognitionVisualMemoryFixture,
  visualAttentionContextFixture,
  visualAttentionMemoryRowFixture,
  visualAttentionSnapshotFixture,
  VISUAL_ATTENTION_FIXTURE_SCOPE,
} from "./fixtures";
import type { VisualFeatureMemory, VisualMemoryBinding, VisualMemoryState } from "./visual-memory";
import {
  commitVisualNarratorCueMentions,
  commitVisualNarratorMentions,
  selectVisualImageFacts,
  selectVisualNarratorCues,
  VISUAL_NARRATOR_CUE_BUDGET_DEFAULT,
  VISUAL_SELECTION_BUDGET_INVALID,
  VISUAL_SELECTION_CONTEXT_MISMATCH,
  VISUAL_SELECTION_KEY_UNBRANDABLE,
  VISUAL_SELECTION_SCOPE_MISMATCH,
  type VisualNarratorSelectionInput,
} from "./visual-selection";

/**
 * Slice 5's consumer selections: the narrator's observer-relative, memory-aware
 * budgeted cues, and the camera's memoryless mandatory-plus-optional facts.
 * Observer isolation, the strict budgets, and every fail-closed gate are
 * asserted here with their diagnostic codes.
 */

const BINDING: VisualMemoryBinding = {
  scope: VISUAL_ATTENTION_FIXTURE_SCOPE,
  observer: { kind: "player_viewpoint", viewpointId: "vp_fixture" },
};
const SUBJECT = visualStateFeatureFixture().subjectId;
const snapshotOf = visualAttentionSnapshotFixture;
const contextOf = visualAttentionContextFixture;
const memoryRowOf = visualAttentionMemoryRowFixture;

function memoryOf(...rows: readonly VisualFeatureMemory[]): VisualMemoryState {
  return recognitionVisualMemoryFixture(rows);
}

function narratorInput(
  snapshot: VisualStateSnapshot,
  memory: VisualMemoryState,
  overrides: Partial<VisualNarratorSelectionInput> = {},
): VisualNarratorSelectionInput {
  return { snapshot, context: contextOf("narrator"), binding: BINDING, memory, ...overrides };
}

function wingsFeatures(): readonly VisualStateFeature[] {
  return projectSpeciesFeatureGroups({
    subjectId: SUBJECT,
    realizedBody: visualStateNonHumanBody(["wings"]),
  });
}

/** A mandatory anatomy fact at an intimate locus — the consent-gate cases. */
function intimateMandatoryFixture(): VisualStateFeature {
  return visualStateFeatureFixture({
    kindId: "appearance.anatomy",
    stability: "persistent",
    aspect: "presence",
    locus: { kind: "body", locus: { bodyLocationId: "vulva" } },
    sourceRef: { kind: "appearance", ref: { kind: "anatomy", locusKey: "vulva" } },
    priors: {
      baseUniqueness: toUnitInterval(6_000),
      baseImportance: toUnitInterval(6_000),
      minimumDetailTier: 2,
      mandatoryForIdentity: true,
    },
  });
}

describe("selectVisualNarratorCues", () => {
  it("offers a first-notice cue for an unseen distinctive feature and stages its mention", () => {
    const feature = visualStateFeatureFixture();
    const selection = selectVisualNarratorCues(narratorInput(snapshotOf([feature]), memoryOf()));
    expect(selection.digests).toHaveLength(1);
    const digest = selection.digests[0];
    expect(digest?.selected).toHaveLength(1);
    expect(digest?.selected[0]?.reason).toBe("first_notice");
    expect(digest?.selected[0]?.priority).toBe(4_550);
    expect(digest?.selected[0]?.repeatKey).toBe("recognition.fixture.nose");
    expect(selection.notices).toHaveLength(1);
    expect(selection.memoryAfterNotices.features[feature.key]?.noticeCount).toBe(1);
    expect(selection.mentionCommits).toEqual([
      { featureKey: feature.key, atMinutes: 120, reason: "first_notice", repeatKey: "recognition.fixture.nose" },
    ]);
  });

  it("notices a familiar unchanged feature silently — memory strengthens, nothing is said", () => {
    const feature = visualStateFeatureFixture();
    const memory = memoryOf(memoryRowOf(feature));
    const selection = selectVisualNarratorCues(narratorInput(snapshotOf([feature]), memory));
    expect(selection.digests[0]?.selected).toEqual([]);
    // Noticed, but never cue-ELIGIBLE: a familiar steady-state fact earns no cue
    // reason at all, so there was nothing for restraint to hold back. Counting it
    // as suppressed would report restraint the selection never exercised.
    expect(selection.digests[0]?.suppressedCount).toBe(0);
    expect(selection.notices).toHaveLength(1);
    expect(selection.memoryAfterNotices.features[feature.key]?.noticeCount).toBe(4);
    expect(selection.mentionCommits).toEqual([]);
  });

  it("cues a contradicted fingerprint as a change and adopts it through the change path", () => {
    const feature = visualStateFeatureFixture();
    const memory = memoryOf(memoryRowOf(feature, { truthFingerprint: '"straight"' }));
    const selection = selectVisualNarratorCues(narratorInput(snapshotOf([feature]), memory));
    expect(selection.digests[0]?.selected[0]?.reason).toBe("change");
    expect(selection.changes).toEqual([
      { featureKey: feature.key, truthFingerprint: feature.truthFingerprint, atMinutes: 120 },
    ]);
    expect(selection.memoryAfterNotices.features[feature.key]?.truthFingerprint).toBe(feature.truthFingerprint);
  });

  it("change-gates a stamped current fact that observer memory can never hold", () => {
    const posture: VisualStateFeature = {
      ...visualStateFeatureFixture({
        kindId: VISUAL_STATE_BODY_LANGUAGE_POSTURE_KIND_ID,
        layer: "body_language",
        stability: "instantaneous",
        aspect: "body_language.posture",
        locus: { kind: "subject", subjectId: SUBJECT },
        sourceRef: { kind: "scene_relation", relationId: "rel_fixture" },
        value: { posture: "kneeling" },
      }),
      changedAtMinutes: 110,
    };
    const memory = memoryOf();
    const selection = selectVisualNarratorCues(narratorInput(snapshotOf([posture]), memory));
    expect(selection.digests[0]?.selected[0]?.reason).toBe("change");
    // Instantaneous facts never reach observer memory: no notice, no row.
    expect(selection.notices).toEqual([]);
    expect(selection.memoryAfterNotices).toBe(memory);
  });

  it("cues a familiar feature the current action puts in play", () => {
    const feature = visualStateFeatureFixture();
    const memory = memoryOf(memoryRowOf(feature));
    const selection = selectVisualNarratorCues(
      narratorInput(snapshotOf([feature]), memory, {
        context: contextOf("narrator", { actionLoci: new Set(["nose"]) }),
      }),
    );
    expect(selection.digests[0]?.selected[0]?.reason).toBe("action_relevance");
    expect(selection.digests[0]?.selected[0]?.priority).toBe(3_640);
  });

  it("lets the repetition cooldown silence an otherwise perfect cue", () => {
    const feature = visualStateFeatureFixture();
    const memory = memoryOf(memoryRowOf(feature, { lastMentionedAt: 120, mentionCount: 1 }));
    const selection = selectVisualNarratorCues(
      narratorInput(snapshotOf([feature]), memory, {
        context: contextOf("narrator", { actionLoci: new Set(["nose"]) }),
      }),
    );
    expect(selection.digests[0]?.selected).toEqual([]);
    expect(selection.notices).toHaveLength(1);
  });

  it("commits mentions only when the caller says the cut landed", () => {
    const feature = visualStateFeatureFixture();
    const selection = selectVisualNarratorCues(narratorInput(snapshotOf([feature]), memoryOf()));
    // Selection itself never spends mention state.
    expect(selection.memoryAfterNotices.features[feature.key]?.mentionCount).toBe(0);
    const committed = commitVisualNarratorMentions(selection.memoryAfterNotices, selection.mentionCommits);
    expect(committed.features[feature.key]?.mentionCount).toBe(1);
    expect(committed.features[feature.key]?.lastMentionedAt).toBe(120);
    expect(commitVisualNarratorMentions(committed, [])).toBe(committed);
  });

  it("keeps the strict budget with deterministic priority-then-key order", () => {
    const features = [
      visualStateFeatureFixture({
        aspect: "shape",
        priors: { baseUniqueness: toUnitInterval(5_000), baseImportance: toUnitInterval(4_000), minimumDetailTier: 2, repeatFamily: "fam_nose" },
      }),
      visualStateFeatureFixture({
        aspect: "sheen",
        locus: { kind: "body", locus: { bodyLocationId: "hair" } },
        priors: { baseUniqueness: toUnitInterval(5_000), baseImportance: toUnitInterval(4_000), minimumDetailTier: 2, repeatFamily: "fam_hair" },
      }),
      visualStateFeatureFixture({
        aspect: "scar",
        locus: { kind: "body", locus: { bodyLocationId: "fingers" } },
        priors: { baseUniqueness: toUnitInterval(5_000), baseImportance: toUnitInterval(4_000), minimumDetailTier: 2, repeatFamily: "fam_fingers" },
      }),
    ];
    const selection = selectVisualNarratorCues(narratorInput(snapshotOf(features), memoryOf()));
    expect(selection.digests[0]?.selected.map((cue) => cue.key)).toEqual([
      `${SUBJECT}/fingers/scar`,
      `${SUBJECT}/hair/sheen`,
    ]);
    expect(selection.digests[0]?.selected).toHaveLength(VISUAL_NARRATOR_CUE_BUDGET_DEFAULT);
    expect(selection.digests[0]?.suppressedCount).toBe(1);
  });

  it("offers one cue per repeat family, not one per feature", () => {
    const shape = visualStateFeatureFixture({ aspect: "shape" });
    const tone = visualStateFeatureFixture({ aspect: "tone" });
    const selection = selectVisualNarratorCues(narratorInput(snapshotOf([shape, tone]), memoryOf()));
    expect(selection.digests[0]?.selected).toHaveLength(1);
    expect(selection.digests[0]?.selected[0]?.repeatKey).toBe("recognition.fixture.nose");
  });

  it("degrades an unusable cue budget to the default with a diagnostic", () => {
    const sink = new DiagnosticCollector();
    const feature = visualStateFeatureFixture();
    const selection = selectVisualNarratorCues(
      narratorInput(snapshotOf([feature]), memoryOf(), { cueBudget: Number.NaN, sink }),
    );
    expect(selection.digests[0]?.selected).toHaveLength(1);
    expectDiagnostic(sink, VISUAL_SELECTION_BUDGET_INVALID, { times: 1 });
  });

  it("lowers the notice threshold under deliberate inspection focus", () => {
    const subtle = visualStateFeatureFixture({
      priors: { baseUniqueness: toUnitInterval(3_000), baseImportance: toUnitInterval(2_500), minimumDetailTier: 2, repeatFamily: "subtle" },
    });
    const unfocused = selectVisualNarratorCues(narratorInput(snapshotOf([subtle]), memoryOf()));
    expect(unfocused.notices).toEqual([]);
    expect(unfocused.digests[0]?.selected).toEqual([]);
    const focused = selectVisualNarratorCues(
      narratorInput(snapshotOf([subtle]), memoryOf(), {
        context: contextOf("narrator", { focusLoci: new Set(["nose"]) }),
      }),
    );
    expect(focused.notices).toHaveLength(1);
    expect(focused.digests[0]?.selected).toHaveLength(1);
  });

  it("never leaks a hidden or intimate feature into cues, notices, or constraints", () => {
    const hidden = visualStateFeatureFixture();
    const hiddenRun = selectVisualNarratorCues(
      narratorInput(snapshotOf([hidden]), memoryOf(), {
        context: contextOf("narrator", {
          perception: affordancePerceptionView({ exposure: { nose: "hidden" }, channels: { sight: "available" } }),
        }),
      }),
    );
    expect(hiddenRun.candidates).toEqual([]);
    expect(hiddenRun.notices).toEqual([]);
    expect(hiddenRun.digests[0]?.selected).toEqual([]);
    expect(hiddenRun.digests[0]?.constraints).toEqual([]);

    const gated = selectVisualNarratorCues(narratorInput(snapshotOf([intimateMandatoryFixture()]), memoryOf()));
    expect(gated.digests[0]?.selected).toEqual([]);
    expect(gated.digests[0]?.constraints).toEqual([]);
    expect(gated.notices).toEqual([]);
    expect(gated.suppressions.map((suppression) => suppression.code)).toContain(VISUAL_STATE_INTIMATE_GATED);
  });

  it("lists visible mandatory facts as constraints and hidden ones never", () => {
    const wings = wingsFeatures();
    const visible = selectVisualNarratorCues(narratorInput(snapshotOf(wings), memoryOf()));
    expect(visible.digests[0]?.constraints.map((constraint) => constraint.key)).toEqual([
      `${SUBJECT}/wings/species.feature_group`,
    ]);
    const coat = visualStateFeatureFixture({
      aspect: "coat",
      relationships: [
        { kind: "covers", targetKey: `${SUBJECT}/wings/species.feature_group`, degree: AFFORDANCE_UNIT_ONE },
      ],
    });
    const covered = selectVisualNarratorCues(narratorInput(snapshotOf([...wings, coat]), memoryOf()));
    expect(covered.digests[0]?.constraints).toEqual([]);
  });

  it("fails closed to silence when the snapshot and binding name different continuities", () => {
    const sink = new DiagnosticCollector();
    const feature = visualStateFeatureFixture();
    const memory = memoryOf(memoryRowOf(feature));
    const selection = selectVisualNarratorCues(
      narratorInput(snapshotOf([feature]), memory, {
        binding: { scope: { kind: "chat", memoryGroupId: "another_group" }, observer: BINDING.observer },
        sink,
      }),
    );
    expect(selection.digests[0]?.selected).toEqual([]);
    expect(selection.notices).toEqual([]);
    expect(selection.memoryAfterNotices).toBe(memory);
    expect(selection.suppressions.every((suppression) => suppression.code === VISUAL_SELECTION_SCOPE_MISMATCH)).toBe(true);
    expect(selection.suppressions).toHaveLength(1);
    expectDiagnostic(sink, VISUAL_SELECTION_SCOPE_MISMATCH, { times: 1 });
  });

  it("fails closed when called for the wrong consumer or viewpoint", () => {
    const sink = new DiagnosticCollector();
    const feature = visualStateFeatureFixture();
    const selection = selectVisualNarratorCues(
      narratorInput(snapshotOf([feature]), memoryOf(), { context: contextOf("image"), sink }),
    );
    expect(selection.digests[0]?.selected).toEqual([]);
    expect(selection.suppressions[0]?.code).toBe(VISUAL_SELECTION_CONTEXT_MISMATCH);
    expectDiagnostic(sink, VISUAL_SELECTION_CONTEXT_MISMATCH, { times: 1 });
  });

  it("fails a key observer memory cannot index closed, with a diagnostic", () => {
    const sink = new DiagnosticCollector();
    const unbrandable = visualStateFeatureFixture({ aspect: "x".repeat(300) });
    const memory = memoryOf();
    const selection = selectVisualNarratorCues(narratorInput(snapshotOf([unbrandable]), memory, { sink }));
    expect(selection.digests[0]?.selected).toEqual([]);
    expect(selection.notices).toEqual([]);
    expect(selection.memoryAfterNotices).toBe(memory);
    expect(selection.suppressions).toEqual([{ key: unbrandable.key, code: VISUAL_SELECTION_KEY_UNBRANDABLE }]);
    expectDiagnostic(sink, VISUAL_SELECTION_KEY_UNBRANDABLE, { times: 1 });
  });

  it("never mutates the memory it was handed", () => {
    const feature = visualStateFeatureFixture();
    const memory = memoryOf(memoryRowOf(feature, { truthFingerprint: '"straight"' }));
    const before = JSON.stringify(memory);
    const selection = selectVisualNarratorCues(narratorInput(snapshotOf([feature]), memory));
    expect(JSON.stringify(memory)).toBe(before);
    expect(selection.memoryAfterNotices).not.toBe(memory);
  });

  it("produces byte-equal selections from the same inputs", () => {
    const feature = visualStateFeatureFixture();
    const snapshot = snapshotOf([feature]);
    const memory = memoryOf(memoryRowOf(feature));
    const run = () => JSON.stringify(selectVisualNarratorCues(narratorInput(snapshot, memory)));
    expect(run()).toBe(run());
  });
});

/**
 * The narrator cue state doing the job observer memory refuses (slice 7's first
 * blocker): repetition and first visibility for current-state and body-language
 * facts, which are deliberately `recognitionEligible: false`.
 */
describe("selectVisualNarratorCues — the cue state", () => {
  /** An unstamped posture: the case only the cue state can say anything about. */
  function postureFixture(): VisualStateFeature {
    return visualStateFeatureFixture({
      kindId: VISUAL_STATE_BODY_LANGUAGE_POSTURE_KIND_ID,
      layer: "body_language",
      stability: "instantaneous",
      aspect: "body_language.posture",
      locus: { kind: "subject", subjectId: SUBJECT },
      sourceRef: { kind: "scene_relation", relationId: "rel_fixture" },
      value: { posture: "kneeling" },
    });
  }

  const POSTURE_REPEAT_KEY = `recognition.fixture.subject:${SUBJECT}`;

  it("cues an unstamped current fact as newly visible the first time it is in view", () => {
    const selection = selectVisualNarratorCues(narratorInput(snapshotOf([postureFixture()]), memoryOf()));
    expect(selection.digests[0]?.selected[0]?.reason).toBe("newly_visible");
    // The observation is returned so the caller can record it, and the mention
    // is staged separately — the same notice/mention split memory uses.
    expect(selection.cueObservations.map((entry) => entry.repeatKey)).toEqual([POSTURE_REPEAT_KEY]);
    expect(selection.cueMentionCommits).toEqual([{ repeatKey: POSTURE_REPEAT_KEY, atMinutes: 120 }]);
    // …and observer recognition memory is untouched by all of it.
    expect(selection.notices).toEqual([]);
  });

  it("goes quiet once the same fact has been seen and said — the repetition blocker", () => {
    // Before this record existed, a feature memory could not hold produced a
    // full cooldown every cut, so a rolled sleeve stayed cue-eligible forever.
    const posture = postureFixture();
    const first = selectVisualNarratorCues(narratorInput(snapshotOf([posture]), memoryOf()));
    const spent = commitVisualNarratorCueMentions(first.cueStateAfterVisibility, first.cueMentionCommits);
    const second = selectVisualNarratorCues(
      narratorInput(snapshotOf([posture]), memoryOf(), { cues: spent }),
    );
    expect(second.digests[0]?.selected).toEqual([]);
    expect(second.candidates[0]?.repetitionCooldown).toBe(0);
    expect(second.candidates[0]?.noveltySource).toBe("cue");
    expect(second.candidates[0]?.cueStatus).toBe("steady");
  });

  it("speaks again when the fact leaves view and comes back", () => {
    const posture = postureFixture();
    const first = selectVisualNarratorCues(narratorInput(snapshotOf([posture]), memoryOf()));
    // A cut in which the posture was not resolvable at all.
    const away = selectVisualNarratorCues(
      narratorInput(snapshotOf([]), memoryOf(), { cues: first.cueStateAfterVisibility }),
    );
    const back = selectVisualNarratorCues(
      narratorInput(snapshotOf([posture]), memoryOf(), { cues: away.cueStateAfterVisibility }),
    );
    expect(back.candidates[0]?.cueStatus).toBe("revealed");
    expect(back.digests[0]?.selected[0]?.reason).toBe("newly_visible");
  });

  it("fences visible facts the image-mandatory flags would have left open", () => {
    // The flags are IMAGE requirements (priors.ts). A posture is not one, and
    // it is exactly the kind of fact prose contradicts, so the narrator fence
    // must carry it.
    const selection = selectVisualNarratorCues(narratorInput(snapshotOf([postureFixture()]), memoryOf()));
    const digest = selection.digests[0];
    // It rode the cue lane this turn (first sighting), so the fence defers to
    // the block that says more — but a second, already-said turn fences it.
    expect(digest?.selected[0]?.kindId).toBe(VISUAL_STATE_BODY_LANGUAGE_POSTURE_KIND_ID);
    const spent = commitVisualNarratorCueMentions(
      selection.cueStateAfterVisibility,
      selection.cueMentionCommits,
    );
    const second = selectVisualNarratorCues(
      narratorInput(snapshotOf([postureFixture()]), memoryOf(), { cues: spent }),
    );
    expect(second.digests[0]?.selected).toEqual([]);
    expect(second.digests[0]?.constraints.map((entry) => entry.kindId)).toContain(
      VISUAL_STATE_BODY_LANGUAGE_POSTURE_KIND_ID,
    );
  });

  it("keeps a just-said fact out of the fence for one cut, then fences it again", () => {
    // The round-1 repetition finding: a fact cued on one cut and said, then
    // re-presented by the fence on the very next one, which the narrator reads
    // as licence to say it twice.
    const posture = postureFixture();
    const first = selectVisualNarratorCues(narratorInput(snapshotOf([posture]), memoryOf()));
    expect(first.digests[0]?.selected).toHaveLength(1);
    expect(first.spokenRepeatKeys).toEqual([POSTURE_REPEAT_KEY]);

    const afterSaying = commitVisualNarratorCueMentions(
      first.cueStateAfterVisibility,
      first.cueMentionCommits,
      first.spokenRepeatKeys,
    );
    const second = selectVisualNarratorCues(
      narratorInput(snapshotOf([posture]), memoryOf(), { cues: afterSaying }),
    );
    expect(second.digests[0]?.selected).toEqual([]);
    expect(second.digests[0]?.constraints.map((entry) => entry.kindId)).not.toContain(
      VISUAL_STATE_BODY_LANGUAGE_POSTURE_KIND_ID,
    );

    // …and it comes back, because a fact absent from the fence is a fact the
    // narrator is free to contradict.
    const third = selectVisualNarratorCues(
      narratorInput(snapshotOf([posture]), memoryOf(), { cues: second.cueStateAfterVisibility }),
    );
    expect(third.digests[0]?.constraints.map((entry) => entry.kindId)).toContain(
      VISUAL_STATE_BODY_LANGUAGE_POSTURE_KIND_ID,
    );
  });

  it("records every offered family as spoken, whichever record cooled it down", () => {
    // A recognizable feature's cooldown comes from observer memory, not the cue
    // state — but the fence's quiet window is about what the PROMPT just said.
    const feature = visualStateFeatureFixture();
    const selection = selectVisualNarratorCues(narratorInput(snapshotOf([feature]), memoryOf()));
    expect(selection.candidates[0]?.noveltySource).toBe("memory");
    expect(selection.cueMentionCommits).toEqual([]);
    expect(selection.spokenRepeatKeys).toEqual(["recognition.fixture.nose"]);
  });

  it("never states one fact in both blocks", () => {
    const posture = postureFixture();
    const selection = selectVisualNarratorCues(narratorInput(snapshotOf([posture]), memoryOf()));
    const digest = selection.digests[0];
    const cued = new Set(digest?.selected.map((cue) => cue.key));
    expect(digest?.constraints.every((entry) => !cued.has(entry.key))).toBe(true);
  });

  it("caps the fence and never drops a mandatory fact to fit an optional one", () => {
    const selection = selectVisualNarratorCues(
      narratorInput(snapshotOf([...wingsFeatures(), postureFixture()]), memoryOf(), { constraintBudget: 1 }),
    );
    const digest = selection.digests[0];
    expect(digest?.constraints).toHaveLength(1);
    expect(digest?.constraints[0]?.kindId).toBe("species.feature_group");
  });

  it("never spends a cue slot on a fact the constraint block already fences", () => {
    // Wings are mandatory-for-identity, so they ride the constraints list. A
    // first sighting of them would otherwise take one of the two optional
    // slots and restate what the must-preserve block says on the same turn.
    const posture = postureFixture();
    const selection = selectVisualNarratorCues(
      narratorInput(snapshotOf([...wingsFeatures(), posture]), memoryOf()),
    );
    const digest = selection.digests[0];
    expect(digest?.constraints.some((entry) => entry.kindId === "species.feature_group")).toBe(true);
    expect(digest?.selected.every((cue) => cue.kindId !== "species.feature_group")).toBe(true);
    expect(digest?.selected[0]?.kindId).toBe(VISUAL_STATE_BODY_LANGUAGE_POSTURE_KIND_ID);
  });

  it("keeps the two records disjoint — a recognizable feature never enters the cue state", () => {
    const feature = visualStateFeatureFixture();
    const selection = selectVisualNarratorCues(narratorInput(snapshotOf([feature]), memoryOf()));
    expect(selection.cueObservations).toEqual([]);
    expect(selection.cueMentionCommits).toEqual([]);
    expect(selection.candidates[0]?.noveltySource).toBe("memory");
    expect(selection.candidates[0]?.cueStatus).toBeUndefined();
  });

  it("advances the cut counter on every narrated cut, said or not", () => {
    const posture = postureFixture();
    const first = selectVisualNarratorCues(narratorInput(snapshotOf([posture]), memoryOf()));
    expect(first.cueStateAfterVisibility.sequence).toBe(1);
    const second = selectVisualNarratorCues(
      narratorInput(snapshotOf([]), memoryOf(), { cues: first.cueStateAfterVisibility }),
    );
    expect(second.cueStateAfterVisibility.sequence).toBe(2);
  });

  it("does not advance the cut counter when the selection fails closed", () => {
    // A scope mismatch selects nothing and sees nothing; advancing anyway would
    // make every family read as revealed on the next real cut.
    const posture = postureFixture();
    const seen = selectVisualNarratorCues(narratorInput(snapshotOf([posture]), memoryOf()));
    const mismatched = selectVisualNarratorCues(
      narratorInput(snapshotOf([posture]), memoryOf(), {
        cues: seen.cueStateAfterVisibility,
        binding: { ...BINDING, scope: { kind: "chat", memoryGroupId: "mg_other" } },
      }),
    );
    expect(mismatched.cueStateAfterVisibility).toBe(seen.cueStateAfterVisibility);
    expect(mismatched.cueObservations).toEqual([]);
  });

  it("keeps the cue state out of the camera's read entirely", () => {
    const posture = postureFixture();
    const first = selectVisualNarratorCues(narratorInput(snapshotOf([posture]), memoryOf()));
    const spent = commitVisualNarratorCueMentions(first.cueStateAfterVisibility, first.cueMentionCommits);
    // Same snapshot, same spent state — the camera cannot see it, so its
    // cooldown stays one and the fact still ranks (invariant 6).
    const image = selectVisualImageFacts({ snapshot: snapshotOf([posture]), context: contextOf("image") });
    expect(spent.cues[POSTURE_REPEAT_KEY]?.mentionCount).toBe(1);
    expect(image.optional[0]?.repetitionCooldown).toBe(AFFORDANCE_UNIT_ONE);
    expect(image.optional[0]?.noveltySource).toBe("none");
  });
});

describe("selectVisualImageFacts", () => {
  it("hands every mandatory fact to the camera regardless of coverage or salience", () => {
    const wings = wingsFeatures();
    const coat = visualStateFeatureFixture({
      aspect: "coat",
      relationships: [
        { kind: "covers", targetKey: `${SUBJECT}/wings/species.feature_group`, degree: AFFORDANCE_UNIT_ONE },
      ],
    });
    const selection = selectVisualImageFacts({
      snapshot: snapshotOf([...wings, coat]),
      context: contextOf("image"),
    });
    // The wing is composed away for the camera's OPTIONAL lane, yet the render
    // still receives it — the hidden identity anchor the plan promises.
    expect(selection.mandatory.map((feature) => feature.key)).toEqual([`${SUBJECT}/wings/species.feature_group`]);
    expect(selection.optional.map((candidate) => candidate.feature.key)).toEqual([coat.key]);
    expect(selection.subjects).toEqual([SUBJECT]);
    expect(selection.subjectCount).toBe(1);
  });

  it("keeps mandatory facts through a zero optional budget", () => {
    const selection = selectVisualImageFacts({
      snapshot: snapshotOf([...wingsFeatures(), visualStateFeatureFixture()]),
      context: contextOf("image"),
      optionalBudget: 0,
    });
    expect(selection.mandatory).toHaveLength(1);
    expect(selection.optional).toEqual([]);
    expect(selection.suppressedOptionalCount).toBe(1);
  });

  it("never lists a mandatory fact in the optional lane", () => {
    const selection = selectVisualImageFacts({
      snapshot: snapshotOf([...wingsFeatures(), visualStateFeatureFixture()]),
      context: contextOf("image"),
    });
    expect(selection.mandatory.map((feature) => feature.key)).toEqual([`${SUBJECT}/wings/species.feature_group`]);
    expect(selection.optional.map((candidate) => candidate.feature.key)).toEqual([`${SUBJECT}/nose/shape`]);
  });

  it("never consults mention cooldowns and returns no memory at all", () => {
    const feature = visualStateFeatureFixture();
    const snapshot = snapshotOf([feature]);
    // The narrator's cooldown silences this feature outright…
    const narrated = selectVisualNarratorCues(
      narratorInput(snapshot, memoryOf(memoryRowOf(feature, { lastMentionedAt: 120, mentionCount: 2 })), {
        context: contextOf("narrator", { actionLoci: new Set(["nose"]) }),
      }),
    );
    expect(narrated.digests[0]?.selected).toEqual([]);
    // …while the camera still receives it: there is no memory in the image
    // path's signature, so nothing an observer noticed can dim a render.
    const rendered = selectVisualImageFacts({ snapshot, context: contextOf("image") });
    expect(rendered.optional.map((candidate) => candidate.feature.key)).toEqual([feature.key]);
    expect(rendered.optional[0]?.repetitionCooldown).toBe(AFFORDANCE_UNIT_ONE);
    expect("memoryAfterNotices" in rendered).toBe(false);
    expect("mentionCommits" in rendered).toBe(false);
  });

  it("gates an intimate mandatory fact on consent — the one thing mandatory never outranks", () => {
    const intimate = intimateMandatoryFixture();
    const snapshot = snapshotOf([intimate]);
    const gated = selectVisualImageFacts({ snapshot, context: contextOf("image") });
    expect(gated.mandatory).toEqual([]);
    expect(gated.suppressions).toContainEqual({
      key: intimate.key,
      code: VISUAL_STATE_INTIMATE_GATED,
      detail: "mandatory:vulva",
    });
    const allowed = selectVisualImageFacts({
      snapshot,
      context: contextOf("image", {
        intimateAllowed: true,
        perception: affordancePerceptionView({ exposure: { vulva: "visible" }, channels: {} }),
      }),
    });
    expect(allowed.mandatory.map((feature) => feature.key)).toEqual([intimate.key]);
  });

  it("fails closed when handed an observer viewpoint", () => {
    const sink = new DiagnosticCollector();
    const selection = selectVisualImageFacts({
      snapshot: snapshotOf([...wingsFeatures()]),
      context: contextOf("image", { viewpoint: { kind: "observer", observerId: "obs_fixture" } }),
      sink,
    });
    expect(selection.mandatory).toEqual([]);
    expect(selection.optional).toEqual([]);
    expect(selection.suppressions.every((suppression) => suppression.code === VISUAL_SELECTION_CONTEXT_MISMATCH)).toBe(true);
    expectDiagnostic(sink, VISUAL_SELECTION_CONTEXT_MISMATCH, { times: 1 });
  });

  it("produces byte-equal selections from the same snapshot and context", () => {
    const snapshot = snapshotOf([...wingsFeatures(), visualStateFeatureFixture()]);
    const run = () => JSON.stringify(selectVisualImageFacts({ snapshot, context: contextOf("image") }));
    expect(run()).toBe(run());
  });
});
