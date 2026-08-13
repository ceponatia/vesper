import { describe, expect, it } from "vitest";
import { DiagnosticCollector } from "../../diagnostics";
import { expectCleanSink, expectDiagnostic } from "@/test/diagnostics";
import {
  appearanceFeatureKey,
  birthmarkFact,
  bodyLocusKey,
  freckleClusterFact,
  missingFingerState,
  scarFact,
  APPEARANCE_BIRTHMARK_KIND_ID,
  APPEARANCE_FACT_KIND_UNKNOWN,
  APPEARANCE_FACT_VALUE_INVALID,
  APPEARANCE_FRECKLE_CLUSTER_KIND_ID,
  APPEARANCE_LOCUS_DETAIL_INVALID,
  APPEARANCE_LOCUS_UNKNOWN_LOCATION,
  APPEARANCE_SCAR_KIND_ID,
  HUMANOID_HAND_DETAIL_SCHEMA_ID,
  type ProjectedFeatureTruth,
} from "../../appearance-features";
import { affordancePerceptionView, type AffordanceExposure } from "../core";
import {
  buildRecognitionCandidates,
  RECOGNITION_SUPPRESSED_HIDDEN,
  RECOGNITION_SUPPRESSED_INTIMATE,
  RECOGNITION_SUPPRESSED_UNKNOWN_LOCATION,
} from "./candidates";
import { recognitionFeatureSalience, RECOGNITION_NOTICE_THRESHOLD } from "./salience";
import { emptyVisualMemoryState } from "./visual-memory";
import { commitRecognitionMention, selectRecognitionCue } from "./mention-policy";
import {
  candidateFor,
  look,
  noticedKeys,
  remembered,
  richBody,
  ACCEPTANCE_SUBJECT_ID,
  BREAST_LOCUS,
  BREAST_MARK_KEY,
  FINGER_KEY,
  FRECKLE_KEY,
  FRECKLE_LOCUS,
  ONE_DAY,
  SCAR_KEY,
  type BodyTruth,
} from "@/test/recognition-acceptance";

/**
 * Slice 7 ACCEPTANCE, part 2 — safety, isolation, and degradation at the seam.
 *
 * The companion to
 * [recognition-acceptance.test.ts](./recognition-acceptance.test.ts) (which
 * carries the story-time chain: first notice, repetition, change detection,
 * long absence). Both run the same real chain through
 * `@/test/recognition-acceptance`'s `look()`.
 *
 * What lives here is everything the spec's §Anti-patterns list forbids: a
 * retake advancing memory twice, one observer's memory reaching another, a
 * disappeared feature invented from an absent candidate, a rarity bypassing the
 * intimate or exposure gates, and a single malformed row blanking a read.
 */

// ---------------------------------------------------------------------------
// 8. Retake safety (memory doc §Acceptance "retake does not double-increment")
// ---------------------------------------------------------------------------

describe("acceptance 8 — a retake reuses the captured result instead of advancing memory twice", () => {
  it("is idempotent in both the selection and the commit, from one pre-state", () => {
    // Turn 1 establishes the scar. Turn 2 is the retaken cut: a committed event
    // has just cost her a finger, so this beat genuinely carries a mention —
    // which is the only interesting thing to double-count.
    const before: BodyTruth = { locatedFacts: [scarFact()] };
    const after: BodyTruth = {
      locatedFacts: [scarFact()],
      anatomy: [missingFingerState({ effectiveFrom: ONE_DAY, sourceEventId: "event_blade_fell" })],
    };
    const preState = look({ body: before, memory: emptyVisualMemoryState(), atMinutes: 0, observationId: "msg_1" })
      .committed;
    expect(remembered(preState, SCAR_KEY).mentionCount).toBe(1);

    const take = look({ body: after, memory: preState, atMinutes: ONE_DAY, observationId: "msg_2" });
    const retake = look({ body: after, memory: preState, atMinutes: ONE_DAY, observationId: "msg_2" });
    expect(take.selection.cue?.key).toBe(FINGER_KEY);
    expect(retake.selection).toEqual(take.selection);
    expect(retake.committed).toEqual(take.committed);

    const once = commitRecognitionMention(take.selection.memoryAfterNotices, take.selection.mentionCommit);
    const twice = commitRecognitionMention(take.selection.memoryAfterNotices, take.selection.mentionCommit);
    expect(twice).toEqual(once);

    // Nothing doubled: one extra notice each turn, one mention for the cut.
    expect(remembered(once, SCAR_KEY).noticeCount).toBe(2);
    expect(remembered(once, SCAR_KEY).mentionCount).toBe(1);
    expect(remembered(once, FINGER_KEY).noticeCount).toBe(1);
    expect(remembered(once, FINGER_KEY).mentionCount).toBe(1);
    expect(remembered(retake.committed, FINGER_KEY).mentionCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 9. Observer isolation (both docs; "no global visual memory shared across
//    observers")
// ---------------------------------------------------------------------------

describe("acceptance 9 — observer A's memory never appears in observer B's read", () => {
  it("keeps two viewpoints structurally disjoint across the same turns", () => {
    const body = richBody();
    // A is across the table with her sleeves up and hands on the table.
    // B is beside her: a bare shoulder, everything else out of view.
    const forA: Readonly<Record<string, AffordanceExposure>> = { shoulders: "hidden" };
    const forB: Readonly<Record<string, AffordanceExposure>> = {
      nose: "hidden",
      forearms: "hidden",
      fingers: "hidden",
      hands: "hidden",
    };
    let memoryA = emptyVisualMemoryState();
    let memoryB = emptyVisualMemoryState();

    for (const atMinutes of [0, 30, 60]) {
      memoryA = look({ body, memory: memoryA, atMinutes, exposure: forA, observationId: `a_${atMinutes}` }).committed;
      memoryB = look({
        body,
        memory: memoryB,
        atMinutes,
        exposure: forB,
        inspecting: ["shoulders"],
        observationId: `b_${atMinutes}`,
      }).committed;
    }

    const keysA = Object.keys(memoryA.features);
    const keysB = Object.keys(memoryB.features);
    expect(keysA).toEqual([FINGER_KEY, SCAR_KEY].sort());
    expect(keysB).toEqual([FRECKLE_KEY]);
    expect(keysA.filter((key) => keysB.includes(key))).toEqual([]);
    expect(memoryA).not.toEqual(memoryB);
    // Nothing A noticed can be read out of B, and vice versa.
    expect(memoryB.features[SCAR_KEY]).toBeUndefined();
    expect(memoryB.features[FINGER_KEY]).toBeUndefined();
    expect(memoryA.features[FRECKLE_KEY]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 10. Supersedence + validity (features spec §Located appearance facts;
//     "no false disappearance from cue omission")
// ---------------------------------------------------------------------------

describe("acceptance 10 — supersedence projects once, and expiry is not a disappearance", () => {
  it("collapses a wound and its healed scar into one feature, then cues the change", () => {
    const wound = scarFact({ id: "fact_wound", size: "large", validFrom: 0 });
    const healed = scarFact({ id: "fact_scar", size: "medium", validFrom: 400, supersedesFactId: "fact_wound" });

    const fresh = look({ body: { locatedFacts: [wound, healed] }, memory: emptyVisualMemoryState(), atMinutes: 100 });
    expect(fresh.projected).toHaveLength(1);
    expect(fresh.projected[0]?.sourceRef).toEqual({ kind: "located_fact", factId: "fact_wound" });
    const known = fresh.committed;
    expect(remembered(known, SCAR_KEY).truthFingerprint).toBe('{"shape":"linear","size":"large"}');

    // Two story days on, the wound has healed and its row is superseded. One
    // feature, one candidate — and the observer's remembered fingerprint is
    // contradicted, so this reads as a change rather than a second scar.
    const atMinutes = 100 + 2 * ONE_DAY;
    const later = look({ body: { locatedFacts: [wound, healed] }, memory: known, atMinutes });
    expect(later.projected).toHaveLength(1);
    expect(later.projected[0]?.sourceRef).toEqual({ kind: "located_fact", factId: "fact_scar" });
    expect(later.candidates).toHaveLength(1);
    expect(later.suppressed).toEqual([]);
    expect(later.selection.changes).toEqual([
      { featureKey: SCAR_KEY, truthFingerprint: '{"shape":"linear","size":"medium"}', atMinutes },
    ]);
    expect(later.selection.cue?.reason).toBe("change");
    expect(remembered(later.committed, SCAR_KEY).truthFingerprint).toBe('{"shape":"linear","size":"medium"}');
    // One feature the whole way through — the supersedence never forked its
    // identity, so the observer keeps their notice history.
    expect(Object.keys(later.committed.features)).toEqual([SCAR_KEY]);
    expect(remembered(later.committed, SCAR_KEY).noticeCount).toBe(2);
  });

  it("projects nothing for an expired fact without cueing a removal", () => {
    const seasonal = birthmarkFact({ id: "fact_seasonal", locus: FRECKLE_LOCUS, validFrom: 0, validUntil: 1_000 });
    const body: BodyTruth = { locatedFacts: [seasonal] };
    const markKey = appearanceFeatureKey(ACCEPTANCE_SUBJECT_ID, FRECKLE_LOCUS, APPEARANCE_BIRTHMARK_KIND_ID);

    const known = look({ body, memory: emptyVisualMemoryState(), atMinutes: 0 }).committed;
    const before = remembered(known, markKey);

    const expired = look({ body, memory: known, atMinutes: 1_000 });
    expect(expired.projected).toEqual([]);
    expect(expired.candidates).toEqual([]);
    // Absence of a candidate is NOT removal: no change, no cue, no edit.
    expect(expired.selection.changes).toEqual([]);
    expect(expired.selection.notices).toEqual([]);
    expect(expired.selection.cue).toBeNull();
    expect(remembered(expired.committed, markKey)).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// 11. Coverage fallback vs fine locus (features spec §Fine body locus)
// ---------------------------------------------------------------------------

describe("acceptance 11 — shoulder freckles use the coarse fallback; the finger keeps its fine path", () => {
  it("carries each locus through the projection into the candidate unchanged", () => {
    const read = look({ body: richBody(), memory: emptyVisualMemoryState(), atMinutes: 600 });

    const freckles = candidateFor(read, FRECKLE_KEY);
    expect(freckles.locus).toEqual({ bodyLocationId: "shoulders" });
    expect(bodyLocusKey(freckles.locus)).toBe("shoulders");
    expect(freckles.key.endsWith(`/shoulders/${APPEARANCE_FRECKLE_CLUSTER_KIND_ID}`)).toBe(true);
    expect(freckles.repeatKey).toBe("recognition.pigmentation.shoulders");

    const finger = candidateFor(read, FINGER_KEY);
    expect(bodyLocusKey(finger.locus)).toBe("fingers:left:ring_finger");
    expect(finger.key).toContain("fingers:left:ring_finger");
    expect(finger.locus.detail).toEqual({ schemaId: HUMANOID_HAND_DETAIL_SCHEMA_ID, path: ["ring_finger"] });
    // The fine path did not become a coverage node: the exposure that gated it
    // is still the coarse location's.
    expect(finger.evidence).toContainEqual({ kind: "coverage", ref: "fingers", detail: "visible" });
  });
});

// ---------------------------------------------------------------------------
// 12. Intimate gate at the seam (features spec §Resolved — "rarity never
//     overrides those gates")
// ---------------------------------------------------------------------------

describe("acceptance 12 — an intimate region is gated through the whole chain", () => {
  const body: BodyTruth = { locatedFacts: [birthmarkFact({ id: "fact_intimate", locus: BREAST_LOCUS })] };
  const exposure: Readonly<Record<string, AffordanceExposure>> = { breasts: "visible" };
  // Maxed observer attention: importance saturates, so if rarity or weight
  // could ever lift the gate, this is the read where it would.
  const importanceBoosts = { [BREAST_MARK_KEY]: 10_000 };

  it("suppresses it with no notice and no memory row when no allowance is given", () => {
    const gated = look({ body, memory: emptyVisualMemoryState(), atMinutes: 0, exposure, importanceBoosts });
    expect(gated.projected.map((record) => record.key)).toEqual([BREAST_MARK_KEY]);
    expect(gated.candidates).toEqual([]);
    expect(gated.suppressed).toEqual([{ key: BREAST_MARK_KEY, code: RECOGNITION_SUPPRESSED_INTIMATE, detail: "breasts" }]);
    expect(gated.selection.notices).toEqual([]);
    expect(gated.selection.cue).toBeNull();
    expect(gated.committed).toEqual(emptyVisualMemoryState());
  });

  it("is the gate and nothing else — an explicit allowance lets the same read through", () => {
    const allowed = look({
      body,
      memory: emptyVisualMemoryState(),
      atMinutes: 0,
      exposure,
      importanceBoosts,
      intimateAllowed: true,
    });
    expect(allowed.suppressed).toEqual([]);
    expect(recognitionFeatureSalience(candidateFor(allowed, BREAST_MARK_KEY))).toBeGreaterThan(
      RECOGNITION_NOTICE_THRESHOLD,
    );
    expect(allowed.selection.cue?.reason).toBe("first_notice");
    expect(remembered(allowed.committed, BREAST_MARK_KEY).noticeCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 13. Malformed input degrades through the chain (both docs §Acceptance)
// ---------------------------------------------------------------------------

describe("acceptance 13 — malformed kinds, loci, and values degrade to diagnostics and silence", () => {
  it("never blanks the read: one good fact survives four broken ones", () => {
    const sink = new DiagnosticCollector();
    const read = look({
      body: {
        locatedFacts: [
          { ...freckleClusterFact({ id: "fact_unknown_kind" }), kindId: "mark.glitter" },
          { ...freckleClusterFact({ id: "fact_nowhere" }), locus: { bodyLocationId: "antenna" } },
          { ...freckleClusterFact({ id: "fact_corrupt" }), value: { density: "galactic", pattern: "band" } },
          scarFact(),
        ],
        // A topology row whose detail path the registry cannot validate FAILS
        // CLOSED — never widened to "the fingers are absent".
        anatomy: [missingFingerState({ finger: "sixth_finger" })],
      },
      memory: emptyVisualMemoryState(),
      atMinutes: 0,
      sink,
    });

    expect(read.projected.map((record) => record.key)).toEqual([SCAR_KEY]);
    expect(read.candidates.map((entry) => entry.key)).toEqual([SCAR_KEY]);
    expect(read.selection.cue?.key).toBe(SCAR_KEY);
    expect(remembered(read.committed, SCAR_KEY).noticeCount).toBe(1);

    expectDiagnostic(sink, APPEARANCE_FACT_KIND_UNKNOWN);
    expectDiagnostic(sink, APPEARANCE_LOCUS_UNKNOWN_LOCATION);
    expectDiagnostic(sink, APPEARANCE_FACT_VALUE_INVALID);
    expectDiagnostic(sink, APPEARANCE_LOCUS_DETAIL_INVALID);
  });

  it("keeps a second belt at the seam for a truth record naming an unknown location", () => {
    const sink = new DiagnosticCollector();
    const offBody: ProjectedFeatureTruth = {
      key: `${ACCEPTANCE_SUBJECT_ID}/gizzard/${APPEARANCE_SCAR_KIND_ID}`,
      subjectId: ACCEPTANCE_SUBJECT_ID,
      locus: { bodyLocationId: "gizzard" },
      sourceRef: { kind: "located_fact", factId: "fact_gizzard" },
      truthFingerprint: '{"shape":"linear","size":"medium"}',
      semanticTags: ["scar"],
      stability: "persistent",
      priors: { baseUniqueness: 9_000, baseImportance: 9_000, minimumDetailTier: 2, repeatFamily: "scar" },
    };
    const built = buildRecognitionCandidates({
      projected: [offBody],
      observer: {
        perception: affordancePerceptionView({ exposure: { gizzard: "visible" }, channels: { sight: "available" } }),
        baseDetailTier: 2,
      },
      sink,
    });
    expect(built.candidates).toEqual([]);
    expect(built.suppressed.map((entry) => entry.code)).toEqual([RECOGNITION_SUPPRESSED_UNKNOWN_LOCATION]);
    expectDiagnostic(sink, RECOGNITION_SUPPRESSED_UNKNOWN_LOCATION);
    const selection = selectRecognitionCue({
      candidates: built.candidates,
      memory: emptyVisualMemoryState(),
      atMinutes: 0,
    });
    expect(selection.cue).toBeNull();
    expect(selection.memoryAfterNotices).toEqual(emptyVisualMemoryState());
  });

  it("records nothing at all on the ordinary path", () => {
    const sink = new DiagnosticCollector();
    look({ body: richBody(), memory: emptyVisualMemoryState(), atMinutes: 600, sink });
    expectCleanSink(sink);
  });
});

// ---------------------------------------------------------------------------
// 14. Zero visibility beats every rarity (both docs §Acceptance)
// ---------------------------------------------------------------------------

describe("acceptance 14 — zero visibility produces no cue regardless of uniqueness", () => {
  it("silences the rarest shipped feature under a glove while a modest visible one notices", () => {
    const read = look({
      body: { locatedFacts: [scarFact()], anatomy: [missingFingerState()] },
      memory: emptyVisualMemoryState(),
      atMinutes: 0,
      exposure: { fingers: "hidden" },
    });
    const finger = read.projected.find((record) => record.key === FINGER_KEY);
    const scarTruth = read.projected.find((record) => record.key === SCAR_KEY);
    // The gloved feature is strictly the rarer of the two, and loses anyway.
    expect(finger?.priors.baseUniqueness ?? 0).toBeGreaterThan(scarTruth?.priors.baseUniqueness ?? 0);

    expect(read.suppressed).toEqual([{ key: FINGER_KEY, code: RECOGNITION_SUPPRESSED_HIDDEN, detail: "fingers" }]);
    expect(noticedKeys(read.selection)).toEqual([SCAR_KEY]);
    expect(read.selection.cue?.key).toBe(SCAR_KEY);
    expect(read.committed.features[FINGER_KEY]).toBeUndefined();
    expect(remembered(read.committed, SCAR_KEY).noticeCount).toBe(1);
  });

  it("still says nothing at saturated uniqueness and importance", () => {
    // No shipped registry prior reaches 10_000, so this one truth record is
    // built by hand — the point is the gate, not the calibration.
    const unmissable: ProjectedFeatureTruth = {
      key: FRECKLE_KEY,
      subjectId: ACCEPTANCE_SUBJECT_ID,
      locus: FRECKLE_LOCUS,
      sourceRef: { kind: "located_fact", factId: "fact_impossible" },
      truthFingerprint: "impossible",
      semanticTags: ["impossible"],
      stability: "persistent",
      priors: { baseUniqueness: 10_000, baseImportance: 10_000, minimumDetailTier: 1, repeatFamily: "pigmentation" },
    };
    const built = buildRecognitionCandidates({
      projected: [unmissable],
      observer: {
        perception: affordancePerceptionView({ exposure: { shoulders: "hidden" }, channels: { sight: "available" } }),
        baseDetailTier: 2,
        inspectionFocus: new Set(["shoulders"]),
      },
    });
    expect(built.candidates).toEqual([]);
    expect(built.suppressed.map((entry) => entry.code)).toEqual([RECOGNITION_SUPPRESSED_HIDDEN]);
    const selection = selectRecognitionCue({
      candidates: built.candidates,
      memory: emptyVisualMemoryState(),
      atMinutes: 0,
      inspectionFocus: new Set(["shoulders"]),
    });
    expect(selection.cue).toBeNull();
    expect(selection.notices).toEqual([]);
    expect(selection.memoryAfterNotices).toEqual(emptyVisualMemoryState());
  });
});
