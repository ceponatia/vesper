import { describe, expect, it } from "vitest";
import { characterProfileObjectSchema, characterProfileSchema } from "../../world/profile";
import {
  crookedNoseAttributes,
  freckleClusterFact,
  missingFingerState,
  scarFact,
  APPEARANCE_ANATOMY_PRIORS,
  type AnatomyPartState,
} from "../../appearance-features";
import {
  recognitionFreshnessBucket,
  RECOGNITION_FRESH_FAMILIAR_MINUTES,
  RECOGNITION_STRENGTH_FLOOR,
  RECOGNITION_STRENGTH_FLOOR_MIN_NOTICES,
} from "./salience";
import { applyRecognitionNotices, emptyVisualMemoryState, type VisualMemoryState } from "./visual-memory";
import {
  RECOGNITION_SUPPRESSED_HIDDEN,
  RECOGNITION_SUPPRESSED_UNKNOWN_EXPOSURE,
} from "./candidates";
import {
  look,
  noticedKeys,
  remembered,
  richBody,
  presentRingFinger,
  FINGER_KEY,
  FRECKLE_KEY,
  NOSE_KEY,
  ONE_DAY,
  SCAR_KEY,
  type BodyTruth,
} from "@/test/recognition-acceptance";

/**
 * Slice 7 ACCEPTANCE, part 1 — the chain over story time.
 *
 * `src/contracts/appearance-features` (body truth) and
 * `src/contracts/affordances/recognition` (observer salience, visual memory,
 * mention policy) proven TOGETHER: every scenario drives the real chain through
 * `@/test/recognition-acceptance`'s `look()` and asserts what only exists at
 * the seam — first notice, repetition control, hidden-feature safety, change
 * detection, and long-absence recognition across multiple turns.
 *
 * The unit suites (`appearance-features/projection.test.ts`,
 * `recognition.test.ts`) already prove each half in isolation and are not
 * repeated here. Part 2 —
 * [recognition-acceptance-safety.test.ts](./recognition-acceptance-safety.test.ts)
 * — carries retake safety, observer isolation, the gates, and degradation.
 *
 * Describe blocks are named after the acceptance-list items in
 * `body-attribute-affordances.spec.recognizable-features.md` §Acceptance tests
 * and `body-attribute-affordances.recognizable-features.memory.md` §Acceptance
 * tests, so a failure reads as a spec violation rather than a broken assertion.
 */

// ---------------------------------------------------------------------------
// 1. No recognizability list (features spec §Acceptance; §Anti-patterns)
// ---------------------------------------------------------------------------

describe("acceptance 1 — no character profile contains a recognizability list", () => {
  it("has no recognizability key in the profile schema's key set", () => {
    const schemaKeys = Object.keys(characterProfileObjectSchema.shape);
    const parsedKeys = Object.keys(characterProfileSchema.parse({}));
    for (const keys of [schemaKeys, parsedKeys]) {
      expect(keys.filter((key) => /recogni/i.test(key))).toEqual([]);
      expect(keys).not.toContain("recognizableFeatures");
      expect(keys).not.toContain("recognizable_features");
    }
    // The one shape that could be mistaken for it is a body-CONFIG list of
    // feature-group ids (wings, horns) — ids, never authored prose marks.
    expect(schemaKeys).toContain("bodyFeatures");
  });

  it("cannot round-trip an authored recognizability blob — the ban is structural", () => {
    const smuggled = characterProfileSchema.parse({
      recognizableFeatures: ["freckles on shoulders", "crooked nose", "missing ring finger"],
    }) as Record<string, unknown>;
    expect(smuggled.recognizableFeatures).toBeUndefined();
    expect(JSON.stringify(smuggled)).not.toContain("freckles on shoulders");
  });
});

// ---------------------------------------------------------------------------
// 2. Determinism (features spec §Acceptance; memory doc §Acceptance "replay")
// ---------------------------------------------------------------------------

describe("acceptance 2 — identical body truth produces identical keys, fingerprints, and cue", () => {
  it("replays the whole chain byte-for-byte from independently built truth", () => {
    const first = look({ body: richBody(), memory: emptyVisualMemoryState(), atMinutes: 600, observationId: "obs_1" });
    const second = look({ body: richBody(), memory: emptyVisualMemoryState(), atMinutes: 600, observationId: "obs_1" });

    expect(second.projected).toEqual(first.projected);
    expect(second.candidates).toEqual(first.candidates);
    expect(second.selection).toEqual(first.selection);
    expect(second.committed).toEqual(first.committed);
  });

  it("keys and fingerprints are stable, sorted, and independent of truth arrival order", () => {
    const forward = look({ body: richBody(), memory: emptyVisualMemoryState(), atMinutes: 600 });
    const reversed = look({
      body: {
        attributes: [...crookedNoseAttributes()].reverse(),
        locatedFacts: [scarFact(), freckleClusterFact()],
        anatomy: [missingFingerState()],
      },
      memory: emptyVisualMemoryState(),
      atMinutes: 600,
    });
    const keys = forward.projected.map((record) => record.key);
    expect(keys).toEqual([...keys].sort());
    expect(keys).toEqual([FINGER_KEY, SCAR_KEY, NOSE_KEY, FRECKLE_KEY].sort());
    expect(reversed.projected).toEqual(forward.projected);
    expect(reversed.candidates.map((entry) => entry.truthFingerprint)).toEqual(
      forward.candidates.map((entry) => entry.truthFingerprint),
    );
  });
});

// ---------------------------------------------------------------------------
// 3. First notice, then repetition control (both docs §Acceptance)
// ---------------------------------------------------------------------------

describe("acceptance 3 — first notice cues; ordinary repeated visibility does not", () => {
  it("cues on turn 1 only, while lastNoticedAt advances and lastMentionedAt stays put", () => {
    const body: BodyTruth = { locatedFacts: [scarFact()] };
    const opening = look({ body, memory: emptyVisualMemoryState(), atMinutes: 0, observationId: "msg_1" });
    expect(opening.selection.cue?.reason).toBe("first_notice");
    expect(opening.selection.cue?.key).toBe(SCAR_KEY);
    expect(opening.selection.mentionCommit?.featureKey).toBe(SCAR_KEY);

    let memory: VisualMemoryState = opening.committed;
    const opened = remembered(memory, SCAR_KEY);
    expect(opened.firstNoticedAt).toBe(0);
    expect(opened.lastMentionedAt).toBe(0);
    expect(opened.mentionCount).toBe(1);
    expect(opened.noticeCount).toBe(1);

    // Turns 2–5: same body, same clear view, a few story minutes apart.
    for (const turn of [2, 3, 4, 5]) {
      const atMinutes = (turn - 1) * 5;
      const next = look({ body, memory, atMinutes, observationId: `msg_${turn}` });
      expect(next.selection.cue, `turn ${turn} must stay silent`).toBeNull();
      expect(next.selection.mentionCommit).toBeNull();
      // Silence is not blindness: the notice still happened.
      expect(noticedKeys(next.selection)).toEqual([SCAR_KEY]);
      memory = next.committed;
      const row = remembered(memory, SCAR_KEY);
      expect(row.noticeCount, `turn ${turn} notice count`).toBe(turn);
      expect(row.lastNoticedAt, `turn ${turn} lastNoticedAt`).toBe(atMinutes);
      expect(row.lastMentionedAt, `turn ${turn} lastMentionedAt`).toBe(0);
      expect(row.mentionCount, `turn ${turn} mentionCount`).toBe(1);
      expect(row.firstNoticedAt).toBe(0);
    }

    // Recognition strengthened in total silence — the whole point of the split.
    expect(remembered(memory, SCAR_KEY).recognitionStrength).toBeGreaterThan(opened.recognitionStrength);
  });
});

// ---------------------------------------------------------------------------
// 4. Hidden-feature safety / leakage (features spec §Anti-patterns; memory doc
//    "opaque coverage prevents visual-memory updates")
// ---------------------------------------------------------------------------

describe("acceptance 4 — a covered feature never leaks into memory, and never back-dates", () => {
  // The freckle field is deliberately calibrated below the conversational bar
  // ("common enough to be unremarkable on its own"), so this observer is
  // LOOKING — the ruling's deliberate-inspection branch. That never bypasses
  // visibility, which is exactly what makes it the right probe here.
  const body: BodyTruth = { locatedFacts: [freckleClusterFact()] };
  const inspecting = ["shoulders"];

  it("produces no candidate, no notice, and no memory row under a coat", () => {
    const covered = look({
      body,
      memory: emptyVisualMemoryState(),
      atMinutes: 0,
      exposure: { shoulders: "hidden" },
      inspecting,
    });
    expect(covered.projected).toHaveLength(1);
    expect(covered.candidates).toEqual([]);
    expect(covered.suppressed).toEqual([{ key: FRECKLE_KEY, code: RECOGNITION_SUPPRESSED_HIDDEN, detail: "shoulders" }]);
    expect(covered.selection.notices).toEqual([]);
    expect(covered.selection.cue).toBeNull();
    expect(covered.committed.features[FRECKLE_KEY]).toBeUndefined();
    expect(covered.committed).toEqual(emptyVisualMemoryState());
  });

  it("fails closed identically when the lane cannot answer for the location", () => {
    const unanswerable = look({
      body,
      memory: emptyVisualMemoryState(),
      atMinutes: 0,
      exposure: { shoulders: "unknown" },
      inspecting,
    });
    expect(unanswerable.candidates).toEqual([]);
    expect(unanswerable.suppressed.map((entry) => entry.code)).toEqual([RECOGNITION_SUPPRESSED_UNKNOWN_EXPOSURE]);
    expect(unanswerable.committed).toEqual(emptyVisualMemoryState());
  });

  it("first-notices only once the coat comes off, dated to the LATER look", () => {
    let memory = emptyVisualMemoryState();
    for (const atMinutes of [0, 120, 240]) {
      memory = look({ body, memory, atMinutes, exposure: { shoulders: "hidden" }, inspecting }).committed;
    }
    expect(memory).toEqual(emptyVisualMemoryState());

    const revealed = look({ body, memory, atMinutes: 600, inspecting });
    expect(revealed.selection.cue?.reason).toBe("first_notice");
    const row = remembered(revealed.committed, FRECKLE_KEY);
    // Nothing is back-dated to when the freckles were merely TRUE.
    expect(row.firstNoticedAt).toBe(600);
    expect(row.lastNoticedAt).toBe(600);
    expect(row.noticeCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 5. Occlusion is not disappearance (features spec §Anti-patterns; memory doc)
// ---------------------------------------------------------------------------

describe("acceptance 5 — occlusion never produces a false disappearance", () => {
  it("leaves a known feature's row untouched across several covered turns", () => {
    const body: BodyTruth = { locatedFacts: [scarFact()] };
    const known = look({ body, memory: emptyVisualMemoryState(), atMinutes: 0, observationId: "msg_1" }).committed;
    const before = remembered(known, SCAR_KEY);

    let memory: VisualMemoryState = known;
    for (const atMinutes of [ONE_DAY, 2 * ONE_DAY, 3 * ONE_DAY]) {
      const sleeved = look({ body, memory, atMinutes, exposure: { forearms: "hidden" } });
      expect(sleeved.candidates).toEqual([]);
      expect(sleeved.selection.notices).toEqual([]);
      expect(sleeved.selection.changes).toEqual([]);
      expect(sleeved.selection.cue).toBeNull();
      // Not decayed, not deleted, not re-fingerprinted — identical.
      expect(sleeved.selection.memoryAfterNotices).toEqual(memory);
      memory = sleeved.committed;
    }
    expect(remembered(memory, SCAR_KEY)).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// 6. Change detection — the worked missing-ring-finger flow
//    (memory doc §Acquired-feature example)
// ---------------------------------------------------------------------------

describe("acceptance 6 — the missing-ring-finger flow, truth to change cue", () => {
  it("walks committed event → anatomy delta → observed change → cooldown", () => {
    const scar = scarFact();

    // 1. Before the injury: the ring finger is PRESENT, which is not a feature,
    //    so topology projects nothing and no candidate can exist.
    const before = look({
      body: { locatedFacts: [scar], anatomy: [presentRingFinger()] },
      memory: emptyVisualMemoryState(),
      atMinutes: 0,
      observationId: "msg_1",
    });
    expect(before.projected.map((record) => record.key)).toEqual([SCAR_KEY]);
    expect(before.candidates.map((entry) => entry.key)).toEqual([SCAR_KEY]);
    const beforeMemory = before.committed;
    expect(beforeMemory.features[FINGER_KEY]).toBeUndefined();

    // 2. The committed injury event sets presence = absent from that minute on.
    const injury = missingFingerState({ effectiveFrom: 2 * ONE_DAY, sourceEventId: "event_blade_fell" });
    const acquired = look({
      body: { locatedFacts: [scar], anatomy: [presentRingFinger(), injury] },
      memory: beforeMemory,
      atMinutes: 2 * ONE_DAY,
      observationId: "msg_2",
    });
    const projectedFinger = acquired.projected.find((record) => record.key === FINGER_KEY);
    expect(projectedFinger?.truthFingerprint).toBe("absent");
    expect(projectedFinger?.sourceRef).toEqual({ kind: "anatomy", locusKey: "fingers:left:ring_finger" });
    expect(projectedFinger?.priors).toEqual(APPEARANCE_ANATOMY_PRIORS);
    // FIRST NOTICE, not change: a present finger was never a feature, so this
    // observer holds no prior fingerprint for the key to contradict. "Change"
    // is defined against remembered truth, not against the world's history.
    expect(acquired.selection.cue?.key).toBe(FINGER_KEY);
    expect(acquired.selection.cue?.reason).toBe("first_notice");
    expect(acquired.selection.changes).toEqual([]);
    const acquiredMemory = acquired.committed;
    expect(remembered(acquiredMemory, FINGER_KEY).truthFingerprint).toBe("absent");

    // 3. A later committed event fits a prosthetic — now the observer's own
    //    fingerprint is contradicted, and THAT is a change.
    const prosthetic: AnatomyPartState = {
      ...missingFingerState({ effectiveFrom: 4 * ONE_DAY, sourceEventId: "event_silver_fitting" }),
      state: "prosthetic",
      alterationKindId: "silver_ring_finger",
    };
    const altered = look({
      body: { locatedFacts: [scar], anatomy: [presentRingFinger(), injury, prosthetic] },
      memory: acquiredMemory,
      atMinutes: 4 * ONE_DAY,
      observationId: "msg_3",
    });
    expect(altered.selection.cue?.key).toBe(FINGER_KEY);
    expect(altered.selection.cue?.reason).toBe("change");
    expect(altered.selection.changes).toEqual([
      { featureKey: FINGER_KEY, truthFingerprint: "prosthetic:silver_ring_finger", atMinutes: 4 * ONE_DAY },
    ]);
    // Adopted ONLY through the change path: the notice path alone would have
    // left "absent" standing.
    expect(remembered(altered.selection.memoryAfterNotices, FINGER_KEY).truthFingerprint).toBe(
      "prosthetic:silver_ring_finger",
    );
    expect(
      remembered(applyRecognitionNotices(acquiredMemory, altered.selection.notices), FINGER_KEY).truthFingerprint,
    ).toBe("absent");

    // 4. A second look at the same hand says nothing further: the change was
    //    mentioned once (first notice + change = two beats over four days) and
    //    the cooldown now owns the feature.
    const alteredMemory = altered.committed;
    expect(remembered(alteredMemory, FINGER_KEY).mentionCount).toBe(2);
    const again = look({
      body: { locatedFacts: [scar], anatomy: [presentRingFinger(), injury, prosthetic] },
      memory: alteredMemory,
      atMinutes: 4 * ONE_DAY + 30,
      observationId: "msg_4",
    });
    expect(again.selection.changes).toEqual([]);
    expect(again.selection.cue).toBeNull();
    expect(remembered(again.committed, FINGER_KEY).mentionCount).toBe(2);
    expect(remembered(again.committed, FINGER_KEY).lastMentionedAt).toBe(4 * ONE_DAY);
    // Still watching, still silent.
    expect(noticedKeys(again.selection)).toContain(FINGER_KEY);
    expect(remembered(again.committed, FINGER_KEY).lastNoticedAt).toBe(4 * ONE_DAY + 30);
  });
});

// ---------------------------------------------------------------------------
// 7. Long-absence recognition refresh + the recognition floor
//    (memory doc §Resolved — freshness buckets, recognition floor)
// ---------------------------------------------------------------------------

describe("acceptance 7 — long absence refreshes recognition and never forgets a stable feature", () => {
  it("buckets a thirty-day gap as long_absence and cues a recognition refresh", () => {
    const body: BodyTruth = { locatedFacts: [scarFact()] };
    let memory = emptyVisualMemoryState();
    for (const atMinutes of [0, 60, 120]) {
      memory = look({ body, memory, atMinutes, observationId: `msg_${atMinutes}` }).committed;
    }
    const settled = remembered(memory, SCAR_KEY);
    expect(settled.noticeCount).toBe(RECOGNITION_STRENGTH_FLOOR_MIN_NOTICES);
    expect(settled.recognitionStrength).toBeGreaterThanOrEqual(RECOGNITION_STRENGTH_FLOOR);

    const away = 120 + RECOGNITION_FRESH_FAMILIAR_MINUTES + ONE_DAY;
    expect(recognitionFreshnessBucket(settled.lastNoticedAt, away)).toBe("long_absence");

    const reunion = look({ body, memory, atMinutes: away, observationId: "msg_reunion" });
    expect(reunion.selection.cue?.reason).toBe("recognition_refresh");
    expect(reunion.selection.changes).toEqual([]);

    const after = remembered(reunion.committed, SCAR_KEY);
    // The floor law: a repeatedly noticed STABLE feature keeps its residual
    // strength across the gap. Only freshness moved.
    expect(after.recognitionStrength).toBeGreaterThanOrEqual(RECOGNITION_STRENGTH_FLOOR);
    expect(after.recognitionStrength).toBeGreaterThanOrEqual(settled.recognitionStrength);
    expect(after.noticeCount).toBe(4);
    expect(after.firstNoticedAt).toBe(0);
    expect(recognitionFreshnessBucket(after.lastNoticedAt, away)).toBe("recent");
  });
});
