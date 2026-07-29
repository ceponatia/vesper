import { describe, expect, it } from "vitest";
import {
  affordancePerceptionView,
  applyRecognitionNotices,
  commitRecognitionMention,
  crookedNoseAttributes,
  emptyVisualMemoryState,
  missingFingerState,
  recognitionObserverFixture,
  scarFact,
  APPEARANCE_SCAR_KIND_ID,
  RECOGNITION_NOTICE_THRESHOLD,
  type AttributeValue,
  type RecognitionCue,
  type VisualMemoryState,
} from "@/contracts";
import { buildChatRecognitionRead, renderChatRecognitionCue } from "./chat-recognition-adapter";
import { visualMemoryGenerationFor } from "./visual-memory-store";

/**
 * The chat-lane recognition adapter (body-attribute-affordances slice 7).
 *
 * What this file is responsible for proving, and what it deliberately is not:
 * the contracts already own salience, the notice threshold, the cooldown law and
 * observer isolation, and they test them against their own fixtures. This suite
 * tests the ADAPTER — that the three contract calls are wired in the right order
 * with the right lane constants, that a retake of the same cut renders the same
 * sentence, and that the sentences themselves stay inside the cue register.
 *
 * The flag itself has nothing to test here: OFF means the pipeline never calls
 * this module, which is a pipeline fact, not an adapter one.
 */

const SUBJECT_ID = "subject_chat_recognition";
const NAME = "Mara";
const POSSESSIVE = "Mara's";
const SCAR_LOCATION_ID = "arms";

/** An observer at conversational distance who can see the whole fixture body. */
const SEEING = recognitionObserverFixture().perception;

/** Sighted, but every fixture location is covered — the perception gate, directly. */
const COVERED = affordancePerceptionView({
  exposure: { nose: "hidden", face: "hidden", arms: "hidden", fingers: "hidden" },
  channels: { sight: "available" },
});

/**
 * A scar at the coarse `arms` locus, matching the exposure map above.
 * `mark.scar` is the highest-salience thing this lane can currently reach at
 * conversational distance (uniqueness 0.45, importance 0.50 ⇒ salience 0.4725,
 * comfortably over the 0.35 notice bar).
 */
function scarOnArm() {
  return scarFact({ subjectId: SUBJECT_ID, locus: { bodyLocationId: SCAR_LOCATION_ID, side: "right" } });
}

function read(
  overrides: {
    attributes?: readonly AttributeValue[];
    locatedFacts?: ReturnType<typeof scarOnArm>[];
    anatomy?: ReturnType<typeof missingFingerState>[];
    perception?: typeof SEEING;
    memory?: VisualMemoryState;
    clockMinutes?: number;
  } = {},
) {
  return buildChatRecognitionRead({
    subjectId: SUBJECT_ID,
    characterName: NAME,
    possessive: POSSESSIVE,
    attributes: overrides.attributes ?? crookedNoseAttributes(),
    ...(overrides.locatedFacts === undefined ? {} : { locatedFacts: overrides.locatedFacts }),
    ...(overrides.anatomy === undefined ? {} : { anatomy: overrides.anatomy }),
    perception: overrides.perception ?? SEEING,
    memory: overrides.memory ?? emptyVisualMemoryState(),
    clockMinutes: overrides.clockMinutes ?? 0,
  });
}

/** One cue, built by hand, for the pure rendering assertions. */
function cueFixture(overrides: Partial<RecognitionCue> = {}): RecognitionCue {
  return {
    key: `${SUBJECT_ID}/nose/shape` as RecognitionCue["key"],
    subjectId: SUBJECT_ID,
    locus: { bodyLocationId: "nose" },
    reason: "first_notice",
    semanticTags: ["nose", "crooked"],
    truthFingerprint: "crooked",
    repeatKey: "recognition.facial_geometry.nose",
    priority: 5_000 as RecognitionCue["priority"],
    ...overrides,
  };
}

describe("the read, wired for the chat lane", () => {
  it("offers a first-notice cue for a perceptible, salient mark against empty memory", () => {
    const result = read({ locatedFacts: [scarOnArm()] });

    expect(result.selection.cue?.reason).toBe("first_notice");
    expect(result.cueLine).toBe("the linear scar on Mara's right arm — not remarked on before now");
    // Noticed, and the notice is the thing that gets persisted — not the cue.
    expect(result.selection.notices).toHaveLength(1);
    expect(result.selection.mentionCommit?.featureKey).toBe(result.selection.cue?.key);
    expect(Object.keys(result.selection.memoryAfterNotices.features)).toHaveLength(1);
  });

  it("is deterministic — the same committed cut renders the same sentence twice", () => {
    const first = read({ locatedFacts: [scarOnArm()], anatomy: [missingFingerState({ subjectId: SUBJECT_ID })] });
    const second = read({ locatedFacts: [scarOnArm()], anatomy: [missingFingerState({ subjectId: SUBJECT_ID })] });

    expect(second.cueLine).toBe(first.cueLine);
    expect(second.selection.memoryAfterNotices).toEqual(first.selection.memoryAfterNotices);
    expect(second.selection.mentionCommit).toEqual(first.selection.mentionCommit);
  });

  it("holds its tongue on the next exchange while notices keep accruing", () => {
    const first = read({ locatedFacts: [scarOnArm()] });
    // The cue entered the cut, so the mention commits — this is exactly what the
    // pipeline persists once the exchange settles.
    const committed = commitRecognitionMention(
      first.selection.memoryAfterNotices,
      first.selection.mentionCommit,
    );

    // A minute later, nothing about the arm has moved.
    const second = read({ locatedFacts: [scarOnArm()], memory: committed, clockMinutes: 1 });

    expect(second.cueLine).toBeNull();
    expect(second.selection.mentionCommit).toBeNull();
    // …and the observer is still looking: noticing and mentioning are separate events.
    expect(second.selection.notices).toHaveLength(1);
    const key = first.selection.cue?.key ?? "";
    expect(second.selection.memoryAfterNotices.features[key]?.noticeCount).toBe(2);
    expect(second.selection.memoryAfterNotices.features[key]?.mentionCount).toBe(1);
  });

  it("says nothing about a covered body, and does not touch memory", () => {
    const memory = emptyVisualMemoryState();
    const result = read({
      locatedFacts: [scarOnArm()],
      anatomy: [missingFingerState({ subjectId: SUBJECT_ID })],
      perception: COVERED,
      memory,
    });

    expect(result.cueLine).toBeNull();
    expect(result.selection.notices).toEqual([]);
    expect(result.selection.memoryAfterNotices).toEqual(memory);
  });

  it("says nothing when the lane cannot answer for a location (fail closed)", () => {
    // Sight is available, but no exposure is asserted anywhere — the chat
    // perception view's actual shape for bare skin today.
    const result = read({
      locatedFacts: [scarOnArm()],
      perception: affordancePerceptionView({ channels: { sight: "available" } }),
    });

    expect(result.cueLine).toBeNull();
    expect(result.selection.notices).toEqual([]);
  });

  it("adopts a perceived change instead of silently rewriting what was known", () => {
    const first = read({ locatedFacts: [scarOnArm()] });
    const known = commitRecognitionMention(first.selection.memoryAfterNotices, first.selection.mentionCommit);

    // A day later the same scar reads differently — same feature key, new truth.
    const changed = read({
      locatedFacts: [
        scarFact({
          subjectId: SUBJECT_ID,
          locus: { bodyLocationId: SCAR_LOCATION_ID, side: "right" },
          shape: "branched",
        }),
      ],
      memory: known,
      clockMinutes: 2_000,
    });

    expect(changed.selection.changes).toHaveLength(1);
    expect(changed.selection.cue?.reason).toBe("change");
    expect(changed.cueLine).toBe("the branched scar on Mara's right arm — changed from what it was");
  });

  it("speaks about acquired topology in the anatomy register", () => {
    const result = read({ anatomy: [missingFingerState({ subjectId: SUBJECT_ID })] });

    expect(result.cueLine).toBe("Mara's missing left ring finger — not remarked on before now");
  });

  /**
   * CALIBRATION FINDING, asserted so it cannot change unnoticed: the shipped
   * `nose.shape` priors (uniqueness 0.35, importance 0.30) mix to a salience of
   * 0.3275, which sits just UNDER the 0.35 notice threshold. The canonical
   * attribute example therefore produces no notice at all at conversational
   * distance — an attribute-only chat is silent, and the located-fact and anatomy
   * paths above are what the trial can actually exercise today.
   */
  it("leaves the canonical crooked nose below the notice bar at conversational distance", () => {
    const result = read();

    expect(RECOGNITION_NOTICE_THRESHOLD).toBe(3_500);
    expect(result.selection.notices).toEqual([]);
    expect(result.cueLine).toBeNull();
  });
});

describe("cue prose", () => {
  const FORBIDDEN = ["arousal", "aroused", "consent", "wants", "desire", "turned on"];

  it("renders one clause per reason, and never invents an interior life", () => {
    const lines = {
      first_notice: renderChatRecognitionCue(cueFixture({ reason: "first_notice" }), {
        characterName: NAME,
        possessive: POSSESSIVE,
      }),
      recognition_refresh: renderChatRecognitionCue(cueFixture({ reason: "recognition_refresh" }), {
        characterName: NAME,
        possessive: POSSESSIVE,
      }),
      change: renderChatRecognitionCue(cueFixture({ reason: "change" }), {
        characterName: NAME,
        possessive: POSSESSIVE,
      }),
      action_relevance: renderChatRecognitionCue(cueFixture({ reason: "action_relevance" }), {
        characterName: NAME,
        possessive: POSSESSIVE,
      }),
      emotional_callback: renderChatRecognitionCue(cueFixture({ reason: "emotional_callback" }), {
        characterName: NAME,
        possessive: POSSESSIVE,
      }),
    };

    expect(lines).toEqual({
      first_notice: "Mara's crooked nose — not remarked on before now",
      recognition_refresh: "Mara's crooked nose — familiar, after all this time",
      change: "Mara's crooked nose — changed from what it was",
      action_relevance: "Mara's crooked nose — right where this moment is happening",
      emotional_callback: "Mara's crooked nose — it carries the weight of what happened",
    });
    for (const line of Object.values(lines)) {
      for (const word of FORBIDDEN) expect(line.toLowerCase()).not.toContain(word);
      // The prompt's second person is the CHARACTER; a cue must never address an observer.
      expect(line).not.toMatch(/\byou\b/iu);
    }
  });

  it("singularizes a paired part when the locus names one side", () => {
    const line = renderChatRecognitionCue(
      cueFixture({
        locus: { bodyLocationId: SCAR_LOCATION_ID, side: "right" },
        semanticTags: ["mark", APPEARANCE_SCAR_KIND_ID, SCAR_LOCATION_ID, "right", "linear", "medium"],
      }),
      { characterName: NAME, possessive: POSSESSIVE },
    );

    expect(line).toBe("the linear scar on Mara's right arm — not remarked on before now");
  });

  it("names a facet attribute at its location rather than pinning the value on the part", () => {
    const line = renderChatRecognitionCue(
      cueFixture({ locus: { bodyLocationId: "face" }, semanticTags: ["face", "freckles", "heavy"] }),
      { characterName: NAME, possessive: POSSESSIVE },
    );

    expect(line).toBe("the heavy freckles on Mara's face — not remarked on before now");
  });

  it("falls back to the character's name when the possessive is blank, and to nothing when both are", () => {
    expect(renderChatRecognitionCue(cueFixture(), { characterName: NAME, possessive: "  " })).toBe(
      "Mara's crooked nose — not remarked on before now",
    );
    expect(renderChatRecognitionCue(cueFixture(), { characterName: " ", possessive: "" })).toBe("");
  });

  it("degrades an unknown tag shape to the bare part instead of inventing prose", () => {
    const line = renderChatRecognitionCue(cueFixture({ semanticTags: [] }), {
      characterName: NAME,
      possessive: POSSESSIVE,
    });

    expect(line).toBe("Mara's nose — not remarked on before now");
  });
});

describe("the retake generation decision", () => {
  const PROMPT_ID = "msg_prompt";

  it("reads the live generation for a missing row, a virgin row, and another exchange", () => {
    expect(visualMemoryGenerationFor(null, PROMPT_ID)).toBe("features");
    expect(visualMemoryGenerationFor({ appliedMessageId: null }, PROMPT_ID)).toBe("features");
    expect(visualMemoryGenerationFor({ appliedMessageId: "msg_earlier" }, PROMPT_ID)).toBe("features");
  });

  it("reads the PRIOR generation when this exchange has already applied once", () => {
    expect(visualMemoryGenerationFor({ appliedMessageId: PROMPT_ID }, PROMPT_ID)).toBe("features_before");
  });

  it("makes a retake recompute the identical memory rather than double-counting", () => {
    const first = read({ locatedFacts: [scarOnArm()] });
    const committed = commitRecognitionMention(first.selection.memoryAfterNotices, first.selection.mentionCommit);
    // The store hands back `features_before` on a retake — for the first exchange
    // of a chat that is an empty memory, which is exactly what the take saw.
    const retake = read({ locatedFacts: [scarOnArm()], memory: emptyVisualMemoryState() });

    expect(retake.selection.memoryAfterNotices).toEqual(first.selection.memoryAfterNotices);
    expect(retake.cueLine).toBe(first.cueLine);
    // Had it recomputed from the COMMITTED memory instead, the counts would climb.
    const doubled = applyRecognitionNotices(committed, retake.selection.notices);
    const key = first.selection.cue?.key ?? "";
    expect(doubled.features[key]?.noticeCount).toBe(2);
    expect(retake.selection.memoryAfterNotices.features[key]?.noticeCount).toBe(1);
  });
});
