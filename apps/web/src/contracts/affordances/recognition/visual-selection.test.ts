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
