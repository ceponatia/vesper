import { describe, expect, it } from "vitest";
import { DiagnosticCollector } from "../../diagnostics";
import { expectCleanSink, expectDiagnostic } from "@/test/diagnostics";
import { affordancePerceptionView, toUnitInterval, AFFORDANCE_UNIT_ONE, AFFORDANCE_UNIT_ZERO } from "../core";
import {
  buildRecognitionCandidates,
  recognizableFeatureKey,
  RECOGNITION_SUPPRESSED_DETAIL_TIER,
  RECOGNITION_SUPPRESSED_DUPLICATE_KEY,
  RECOGNITION_SUPPRESSED_HIDDEN,
  RECOGNITION_SUPPRESSED_INTIMATE,
  RECOGNITION_SUPPRESSED_MALFORMED_KEY,
  RECOGNITION_SUPPRESSED_UNKNOWN_EXPOSURE,
  RECOGNITION_SUPPRESSED_UNKNOWN_LOCATION,
  RECOGNITION_VISIBILITY_HINTED,
  type RecognitionObserverContext,
  type RecognizableFeatureCandidate,
} from "./candidates";
import {
  recognitionCanNotice,
  recognitionFeatureSalience,
  recognitionFreshnessBucket,
  recognitionRepetitionCooldown,
  recognitionStrengthWithFloor,
  RECOGNITION_MENTION_FLOOR,
  RECOGNITION_NOTICE_THRESHOLD,
  RECOGNITION_STRENGTH_FLOOR,
} from "./salience";
import {
  applyRecognitionNotices,
  capVisualMemoryFeatures,
  emptyVisualMemoryState,
  visualMemoryBindingKey,
  visualMemoryStateSchema,
  VISUAL_MEMORY_FEATURES_MAX,
  type VisualFeatureMemory,
  type VisualMemoryState,
} from "./visual-memory";
import { commitRecognitionMention, selectRecognitionCue } from "./mention-policy";
import {
  recognitionBlindObserverFixture,
  recognitionMissingFingerTruthFixture,
  recognitionObserverFixture,
  recognitionProjectedTruthFixture,
  recognitionRareMarkTruthFixture,
  recognitionScarTruthFixture,
  recognitionVisualMemoryFixture,
  recognitionVisualMemoryRowFixture,
  RECOGNITION_FIXTURE_INVISIBLE_SALIENCE_INPUT,
} from "./fixtures";
import type { ProjectedFeatureTruth } from "../../appearance-features";

/**
 * The recognition layer end to end at unit level: the memory doc's acceptance
 * list, driven through the real candidate builder, the real salience formulas,
 * and the real observer memory.
 *
 * The numbers in here are the calibration evidence. A change that breaks the
 * scar-outranks-the-rare-mark case or the ordinary-visibility-stays-silent case
 * is a recalibration decision, not a failing test to be patched.
 */

const ONE_DAY = 1_440;

function build(
  projected: readonly ProjectedFeatureTruth[],
  observer: Partial<RecognitionObserverContext> = {},
  sink?: DiagnosticCollector,
): ReturnType<typeof buildRecognitionCandidates> {
  return buildRecognitionCandidates({
    projected,
    observer: recognitionObserverFixture(observer),
    ...(sink === undefined ? {} : { sink }),
  });
}

function onlyCandidate(
  projected: ProjectedFeatureTruth,
  observer: Partial<RecognitionObserverContext> = {},
): RecognizableFeatureCandidate {
  const built = build([projected], observer);
  expect(built.suppressed).toEqual([]);
  const [candidate] = built.candidates;
  if (candidate === undefined) throw new Error("expected exactly one recognition candidate");
  return candidate;
}

function suppressionCodes(projected: readonly ProjectedFeatureTruth[], observer: Partial<RecognitionObserverContext> = {}) {
  return build(projected, observer).suppressed.map((entry) => entry.code);
}

describe("recognition candidates", () => {
  it("projects a visible attribute feature with its three salience dimensions separate", () => {
    const candidate = onlyCandidate(recognitionProjectedTruthFixture());
    expect(candidate.visibility).toBe(AFFORDANCE_UNIT_ONE);
    expect(candidate.uniqueness).toBe(6_000);
    expect(candidate.importance).toBe(4_000);
    expect(candidate.detailTier).toBe(2);
    expect(candidate.repeatKey).toBe("recognition.face_geometry.nose:center");
    expect(candidate.evidence).toContainEqual({ kind: "attribute", ref: "nose.alignment" });
    expect(candidate.evidence).toContainEqual({ kind: "coverage", ref: "nose", detail: "visible" });
  });

  it("fails closed on hidden, unknown, and channel-less perception", () => {
    const nose = recognitionProjectedTruthFixture();
    expect(
      suppressionCodes([nose], {
        perception: affordancePerceptionView({ exposure: { nose: "hidden" }, channels: { sight: "available" } }),
      }),
    ).toEqual([RECOGNITION_SUPPRESSED_HIDDEN]);
    expect(
      suppressionCodes([nose], {
        perception: affordancePerceptionView({ channels: { sight: "available" } }),
      }),
    ).toEqual([RECOGNITION_SUPPRESSED_UNKNOWN_EXPOSURE]);
    // Sight never positively asserted: silence, not the benefit of the doubt.
    expect(
      buildRecognitionCandidates({ projected: [nose], observer: recognitionBlindObserverFixture() }).candidates,
    ).toEqual([]);
  });

  it("reduces but does not zero a hinted exposure", () => {
    const candidate = onlyCandidate(recognitionProjectedTruthFixture(), {
      perception: affordancePerceptionView({ exposure: { nose: "hinted" }, channels: { sight: "available" } }),
    });
    expect(candidate.visibility).toBe(RECOGNITION_VISIBILITY_HINTED);
    expect(recognitionFeatureSalience(candidate)).toBeLessThan(RECOGNITION_NOTICE_THRESHOLD);
  });

  it("gates an intimate region regardless of rarity, and opens it only on an explicit allowance", () => {
    const intimate = recognitionProjectedTruthFixture({
      locus: { bodyLocationId: "breasts" },
      priors: { baseUniqueness: 10_000, baseImportance: 10_000, minimumDetailTier: 1, repeatFamily: "skin_mark" },
    });
    const intimatePerception = affordancePerceptionView({
      exposure: { breasts: "visible" },
      channels: { sight: "available" },
    });
    expect(suppressionCodes([intimate], { perception: intimatePerception })).toEqual([
      RECOGNITION_SUPPRESSED_INTIMATE,
    ]);
    const allowed = build([intimate], { perception: intimatePerception, intimateAllowed: true });
    expect(allowed.suppressed).toEqual([]);
    expect(allowed.candidates).toHaveLength(1);
  });

  it("gates on detail tier, and deliberate inspection reaches tier 3", () => {
    const fine = recognitionProjectedTruthFixture({
      priors: { baseUniqueness: 6_000, baseImportance: 4_000, minimumDetailTier: 3, repeatFamily: "face_geometry" },
    });
    expect(suppressionCodes([fine])).toEqual([RECOGNITION_SUPPRESSED_DETAIL_TIER]);
    const inspected = onlyCandidate(fine, { inspectionFocus: new Set(["nose"]) });
    expect(inspected.detailTier).toBe(3);
  });

  it("applies observer importance at projection time without touching the base prior", () => {
    const truth = recognitionScarTruthFixture();
    const candidate = onlyCandidate(truth, { importanceBoosts: { [truth.key]: 1_500 } });
    expect(candidate.importance).toBe(9_500);
    expect(truth.priors.baseImportance).toBe(8_000);
    expect(candidate.evidence).toContainEqual({
      kind: "adapter",
      ref: "recognition.importance_boost",
      detail: "1500",
    });
  });

  it("degrades malformed, duplicated, and unplaceable features to diagnostics and silence", () => {
    const sink = new DiagnosticCollector();
    const nose = recognitionProjectedTruthFixture();
    const built = build(
      [
        recognitionProjectedTruthFixture({ key: "" }),
        nose,
        nose,
        recognitionProjectedTruthFixture({ locus: { bodyLocationId: "gizzard" }, key: "subject/gizzard/alignment" }),
      ],
      {},
      sink,
    );
    expect(built.candidates).toHaveLength(1);
    expect(built.suppressed.map((entry) => entry.code)).toEqual([
      RECOGNITION_SUPPRESSED_MALFORMED_KEY,
      RECOGNITION_SUPPRESSED_DUPLICATE_KEY,
      RECOGNITION_SUPPRESSED_UNKNOWN_LOCATION,
    ]);
    expectDiagnostic(sink, RECOGNITION_SUPPRESSED_MALFORMED_KEY);
    expectDiagnostic(sink, RECOGNITION_SUPPRESSED_DUPLICATE_KEY);
    expectDiagnostic(sink, RECOGNITION_SUPPRESSED_UNKNOWN_LOCATION);
  });

  it("records nothing in the sink on the ordinary path", () => {
    const sink = new DiagnosticCollector();
    build([recognitionProjectedTruthFixture(), recognitionScarTruthFixture()], {}, sink);
    expectCleanSink(sink);
  });
});

describe("recognition salience", () => {
  it("zero visibility produces zero salience and no notice regardless of uniqueness", () => {
    expect(recognitionFeatureSalience(RECOGNITION_FIXTURE_INVISIBLE_SALIENCE_INPUT)).toBe(AFFORDANCE_UNIT_ZERO);
    expect(
      recognitionCanNotice({
        salience: AFFORDANCE_UNIT_ONE,
        visibility: AFFORDANCE_UNIT_ZERO,
        underInspection: true,
      }),
    ).toBe(false);
  });

  it("lets a common but important scar outrank a rare irrelevant mark at equal visibility", () => {
    const scar = onlyCandidate(recognitionScarTruthFixture());
    const mark = onlyCandidate(recognitionRareMarkTruthFixture());
    expect(recognitionFeatureSalience(scar)).toBe(5_250);
    expect(recognitionFeatureSalience(mark)).toBe(5_175);
    expect(recognitionFeatureSalience(scar)).toBeGreaterThan(recognitionFeatureSalience(mark));
    expect(scar.uniqueness).toBeLessThan(mark.uniqueness);
  });

  it("buckets freshness by story day, and an unknowable stamp reads as a long absence", () => {
    expect(recognitionFreshnessBucket(0, ONE_DAY - 1)).toBe("recent");
    expect(recognitionFreshnessBucket(0, ONE_DAY)).toBe("familiar");
    expect(recognitionFreshnessBucket(0, 30 * ONE_DAY)).toBe("familiar");
    expect(recognitionFreshnessBucket(0, 30 * ONE_DAY + 1)).toBe("long_absence");
    expect(recognitionFreshnessBucket(Number.NaN, 100)).toBe("long_absence");
  });

  it("zeroes the cooldown right after a mention and recovers more slowly the more it was said", () => {
    expect(recognitionRepetitionCooldown({ mentionCount: 0, atMinutes: 10_000 })).toBe(AFFORDANCE_UNIT_ONE);
    expect(recognitionRepetitionCooldown({ lastMentionedAt: 100, mentionCount: 1, atMinutes: 100 })).toBe(0);
    const once = recognitionRepetitionCooldown({ lastMentionedAt: 0, mentionCount: 1, atMinutes: ONE_DAY / 2 });
    const thrice = recognitionRepetitionCooldown({ lastMentionedAt: 0, mentionCount: 3, atMinutes: ONE_DAY / 2 });
    expect(once).toBe(5_000);
    expect(thrice).toBeLessThan(once);
    expect(recognitionRepetitionCooldown({ lastMentionedAt: 0, mentionCount: 1, atMinutes: 10 * ONE_DAY })).toBe(
      AFFORDANCE_UNIT_ONE,
    );
  });

  it("floors a repeatedly noticed stable feature and never floors a transient one", () => {
    const faded = toUnitInterval(100);
    expect(recognitionStrengthWithFloor({ strength: faded, stability: "persistent", noticeCount: 3 })).toBe(
      RECOGNITION_STRENGTH_FLOOR,
    );
    expect(recognitionStrengthWithFloor({ strength: faded, stability: "persistent", noticeCount: 2 })).toBe(faded);
    expect(recognitionStrengthWithFloor({ strength: faded, stability: "transient", noticeCount: 9 })).toBe(faded);
  });
});

describe("visual memory", () => {
  it("keeps observers and scopes structurally separate", () => {
    const scope = { kind: "chat", memoryGroupId: "grp_1" } as const;
    const left = visualMemoryBindingKey({ scope, observer: { kind: "player_viewpoint", viewpointId: "vp_a" } });
    const right = visualMemoryBindingKey({ scope, observer: { kind: "actor", actorId: "vp_a" } });
    const otherScope = visualMemoryBindingKey({
      scope: { kind: "world_branch", branchId: "grp_1" },
      observer: { kind: "player_viewpoint", viewpointId: "vp_a" },
    });
    const standalone = visualMemoryBindingKey({
      scope: { kind: "standalone_character", characterId: "grp_1" },
      observer: { kind: "player_viewpoint", viewpointId: "vp_a" },
    });
    expect(new Set([left, right, otherScope, standalone]).size).toBe(4);
  });

  it("creates on first notice and strengthens on repeat without deleting anything", () => {
    const candidate = onlyCandidate(recognitionScarTruthFixture());
    const first = applyRecognitionNotices(emptyVisualMemoryState(), [
      { candidate, detailTier: 2, atMinutes: 0, observationId: "msg_1" },
    ]);
    const created = first.features[candidate.key];
    expect(created).toBeDefined();
    expect(created?.noticeCount).toBe(1);
    expect(created?.firstNoticedAt).toBe(0);
    expect(created?.firstObservationId).toBe("msg_1");
    expect(created?.lastMentionedAt).toBeUndefined();

    const second = applyRecognitionNotices(first, [
      { candidate, detailTier: 3, atMinutes: 90, observationId: "msg_2" },
    ]);
    const grown = second.features[candidate.key];
    expect(grown?.noticeCount).toBe(2);
    expect(grown?.lastNoticedAt).toBe(90);
    expect(grown?.firstNoticedAt).toBe(0);
    expect(grown?.strongestDetailTier).toBe(3);
    expect(grown?.firstObservationId).toBe("msg_1");
    expect(grown?.lastObservationId).toBe("msg_2");
    expect(grown?.recognitionStrength ?? 0).toBeGreaterThan(created?.recognitionStrength ?? 0);
  });

  it("never lets a plain notice overwrite the remembered fingerprint", () => {
    const candidate = onlyCandidate(recognitionMissingFingerTruthFixture());
    const before = recognitionVisualMemoryFixture([{ featureKey: candidate.key, truthFingerprint: "present" }]);
    const after = applyRecognitionNotices(before, [{ candidate, detailTier: 2, atMinutes: 500 }]);
    expect(after.features[candidate.key]?.truthFingerprint).toBe("present");
    expect(after.features[candidate.key]?.lastNoticedAt).toBe(500);
  });

  it("heals a corrupt persisted blob rather than rejecting the state", () => {
    expect(visualMemoryStateSchema.parse("not a memory")).toEqual(emptyVisualMemoryState());
    expect(visualMemoryStateSchema.parse(undefined)).toEqual(emptyVisualMemoryState());
    const healed = visualMemoryStateSchema.parse({
      features: {
        good: {
          featureKey: "good",
          subjectId: "s",
          truthFingerprint: "x",
          firstNoticedAt: 5,
          lastNoticedAt: "yesterday",
          noticeCount: "many",
          strongestDetailTier: 7,
          confidence: 99_999,
          recognitionStrength: -3,
          lastMentionedAt: "never",
          mentionCount: 2,
          firstObservationId: 12,
        },
        nameless: { subjectId: "s" },
        junk: 4,
      },
    });
    expect(Object.keys(healed.features)).toEqual(["good"]);
    const row = healed.features.good;
    expect(row?.lastNoticedAt).toBe(0);
    expect(row?.noticeCount).toBe(0);
    expect(row?.strongestDetailTier).toBe(1);
    expect(row?.confidence).toBe(0);
    expect(row?.recognitionStrength).toBe(0);
    expect(row?.mentionCount).toBe(2);
    expect(row?.lastMentionedAt).toBeUndefined();
    expect(row?.firstObservationId).toBeUndefined();
  });

  it("evicts the coldest rows deterministically and returns them in key order", () => {
    const rows: Record<string, VisualFeatureMemory> = {};
    for (let index = 99; index >= 0; index--) {
      const featureKey = `f${String(index).padStart(3, "0")}`;
      rows[featureKey] = recognitionVisualMemoryRowFixture({ featureKey, lastNoticedAt: index });
    }
    const capped = capVisualMemoryFeatures(rows);
    const keys = Object.keys(capped);
    expect(keys).toHaveLength(VISUAL_MEMORY_FEATURES_MAX);
    expect(keys[0]).toBe("f004");
    expect(keys).toEqual([...keys].sort());
    expect(capVisualMemoryFeatures(rows)).toEqual(capped);
  });
});

describe("recognition mention policy", () => {
  const scarTruth = recognitionScarTruthFixture();

  it("cues a first notice, then falls silent on ordinary repeated visibility", () => {
    const candidates = build([scarTruth]).candidates;
    const first = selectRecognitionCue({ candidates, memory: emptyVisualMemoryState(), atMinutes: 0 });
    expect(first.cue?.reason).toBe("first_notice");
    expect(first.mentionCommit).toEqual({
      featureKey: scarTruth.key,
      atMinutes: 0,
      reason: "first_notice",
      repeatKey: "recognition.scar.forearms:right",
    });

    const committed = commitRecognitionMention(first.memoryAfterNotices, first.mentionCommit);
    const second = selectRecognitionCue({ candidates, memory: committed, atMinutes: 60 });
    expect(second.cue).toBeNull();
    expect(second.mentionCommit).toBeNull();
    // Notices still happened: recognition strengthens in silence.
    expect(second.notices).toHaveLength(1);
    const row = second.memoryAfterNotices.features[scarTruth.key];
    expect(row?.noticeCount).toBe(2);
    expect(row?.lastNoticedAt).toBe(60);
  });

  it("advances lastNoticedAt without advancing lastMentionedAt", () => {
    const candidates = build([scarTruth]).candidates;
    const first = selectRecognitionCue({ candidates, memory: emptyVisualMemoryState(), atMinutes: 0 });
    const committed = commitRecognitionMention(first.memoryAfterNotices, first.mentionCommit);
    expect(committed.features[scarTruth.key]?.lastMentionedAt).toBe(0);
    expect(committed.features[scarTruth.key]?.mentionCount).toBe(1);

    const later = selectRecognitionCue({ candidates, memory: committed, atMinutes: 5 * ONE_DAY });
    const uncommitted = later.memoryAfterNotices.features[scarTruth.key];
    expect(uncommitted?.lastNoticedAt).toBe(5 * ONE_DAY);
    expect(uncommitted?.lastMentionedAt).toBe(0);
    expect(uncommitted?.mentionCount).toBe(1);
  });

  it("offers at most one cue and picks the highest priority", () => {
    const candidates = build([
      recognitionProjectedTruthFixture(),
      scarTruth,
      recognitionRareMarkTruthFixture(),
    ]).candidates;
    expect(candidates).toHaveLength(3);
    const selection = selectRecognitionCue({ candidates, memory: emptyVisualMemoryState(), atMinutes: 0 });
    expect(selection.notices).toHaveLength(3);
    expect(selection.cue?.key).toBe(scarTruth.key);
    expect(selection.cue?.priority).toBe(5_250);
  });

  it("turns a changed fingerprint into a change cue and adopts it only through the change path", () => {
    const missing = recognitionMissingFingerTruthFixture();
    const candidates = build([missing]).candidates;
    const memory = recognitionVisualMemoryFixture([
      { featureKey: missing.key, truthFingerprint: "present", lastNoticedAt: 0 },
    ]);
    const selection = selectRecognitionCue({ candidates, memory, atMinutes: 2 * ONE_DAY });
    expect(selection.cue?.reason).toBe("change");
    expect(selection.changes).toEqual([
      { featureKey: missing.key, truthFingerprint: "absent", atMinutes: 2 * ONE_DAY },
    ]);
    expect(selection.memoryAfterNotices.features[missing.key]?.truthFingerprint).toBe("absent");
    // The notice path on its own would have left the old fingerprint standing.
    expect(applyRecognitionNotices(memory, selection.notices).features[missing.key]?.truthFingerprint).toBe("present");
  });

  it("refreshes recognition after a long absence", () => {
    const candidates = build([scarTruth]).candidates;
    const memory = recognitionVisualMemoryFixture([
      { featureKey: scarTruth.key, truthFingerprint: "three_parallel", lastNoticedAt: 0 },
    ]);
    const selection = selectRecognitionCue({ candidates, memory, atMinutes: 40 * ONE_DAY });
    expect(selection.cue?.reason).toBe("recognition_refresh");
    expect(selection.cue?.priority ?? 0).toBeGreaterThanOrEqual(RECOGNITION_MENTION_FLOOR);
  });

  it("cues action relevance for a familiar feature the current action depends on", () => {
    const candidates = build([scarTruth]).candidates;
    const memory = recognitionVisualMemoryFixture([
      { featureKey: scarTruth.key, truthFingerprint: "three_parallel", lastNoticedAt: 0 },
    ]);
    const selection = selectRecognitionCue({
      candidates,
      memory,
      atMinutes: 2 * ONE_DAY,
      actionRelevantLocationIds: new Set(["forearms"]),
    });
    expect(selection.cue?.reason).toBe("action_relevance");
  });

  it("never notices, cues, or updates memory through opaque coverage", () => {
    const covered = build([scarTruth], {
      perception: affordancePerceptionView({ exposure: { forearms: "hidden" }, channels: { sight: "available" } }),
    });
    expect(covered.candidates).toEqual([]);
    const memory = recognitionVisualMemoryFixture([
      { featureKey: scarTruth.key, truthFingerprint: "three_parallel", lastNoticedAt: 10, noticeCount: 4 },
    ]);
    const selection = selectRecognitionCue({ candidates: covered.candidates, memory, atMinutes: 999 });
    expect(selection.cue).toBeNull();
    expect(selection.notices).toEqual([]);
    expect(selection.memoryAfterNotices).toEqual(memory);
  });

  it("never turns occlusion into disappearance", () => {
    const nose = recognitionProjectedTruthFixture();
    const memory = recognitionVisualMemoryFixture([
      { featureKey: scarTruth.key, truthFingerprint: "three_parallel", lastNoticedAt: 10, noticeCount: 4 },
      { featureKey: nose.key, truthFingerprint: "crooked", lastNoticedAt: 10 },
    ]);
    // Only the nose is visible this cut; the forearm is under a sleeve.
    const candidates = build([nose, scarTruth], {
      perception: affordancePerceptionView({
        exposure: { nose: "visible", forearms: "hidden" },
        channels: { sight: "available" },
      }),
    }).candidates;
    const after = selectRecognitionCue({ candidates, memory, atMinutes: 4_000 }).memoryAfterNotices;
    expect(after.features[scarTruth.key]).toEqual(memory.features[scarTruth.key]);
    expect(after.features[nose.key]?.noticeCount).toBe(2);
  });

  it("replays identically from identical inputs", () => {
    const candidates = build([recognitionProjectedTruthFixture(), scarTruth]).candidates;
    const memory: VisualMemoryState = recognitionVisualMemoryFixture([
      { featureKey: scarTruth.key, truthFingerprint: "faded", lastNoticedAt: 0, lastMentionedAt: 0, mentionCount: 1 },
    ]);
    const first = selectRecognitionCue({ candidates, memory, atMinutes: 3 * ONE_DAY, observationId: "obs_7" });
    const second = selectRecognitionCue({ candidates, memory, atMinutes: 3 * ONE_DAY, observationId: "obs_7" });
    expect(second).toEqual(first);
    expect(commitRecognitionMention(second.memoryAfterNotices, second.mentionCommit)).toEqual(
      commitRecognitionMention(first.memoryAfterNotices, first.mentionCommit),
    );
  });

  it("commits a mention once per cut, however many times the commit is replayed", () => {
    const candidates = build([scarTruth]).candidates;
    const selection = selectRecognitionCue({ candidates, memory: emptyVisualMemoryState(), atMinutes: 0 });
    const once = commitRecognitionMention(selection.memoryAfterNotices, selection.mentionCommit);
    const again = commitRecognitionMention(selection.memoryAfterNotices, selection.mentionCommit);
    expect(again).toEqual(once);
    expect(once.features[scarTruth.key]?.mentionCount).toBe(1);
    expect(commitRecognitionMention(once, null)).toBe(once);
  });

  it("cannot commit a mention for a feature this observer never noticed", () => {
    const state = emptyVisualMemoryState();
    expect(
      commitRecognitionMention(state, {
        featureKey: recognizableFeatureKey(scarTruth.key),
        atMinutes: 5,
        reason: "first_notice",
        repeatKey: "recognition.scar.forearms:right",
      }),
    ).toBe(state);
  });
});
