import { describe, expect, it } from "vitest";
import {
  DiagnosticCollector,
  GUIDANCE_MAX_CORRECTIONS,
  hairAttributeFixture,
  hairObserver,
  readHairAffordances,
  HAIR_CLAIM_ARRANGEMENT_BRAID,
  HAIR_CLAIM_ARRANGEMENT_LOOSE,
  HAIR_CLAIM_CAUSE_IMMERSION,
  HAIR_CLAIM_CAUSE_RAIN,
  HAIR_CLAIM_COVERAGE_UNCOVERED,
  HAIR_CLAIM_MOTION_FREE_FLOW,
  HAIR_CLAIM_WETNESS_DRY,
  HAIR_CLAIM_WETNESS_SOAKED,
  type AffordanceRead,
} from "@/contracts";
import { buildChatPhysicalGuidance, detectHairPremises } from "./chat-physical-guidance";
import type { ChatCommittedHairState } from "./chat-affordances";

/**
 * The chat lane's premise detector and compile adapter
 * (narrator-physical-guidance.plan.md slice 2).
 *
 * The tests are organised the way the risk is: the GUARDS come first, because every
 * one of them exists to stop a false correction, and a false correction is the failure
 * that makes the whole feature untrustworthy — the narrator fences off something that
 * is actually true and the player watches their own scene get contradicted. The
 * verdicts come second, and the shape of the compile last.
 */

const CHARACTER = "Wren";
const PLAYER = "Brian";

/** Soaked from a bath, braided, uncovered — the plan's worked example, as state. */
function committed(overrides: Partial<ChatCommittedHairState> = {}): ChatCommittedHairState {
  return {
    wetnessBand: "soaked",
    wetnessCause: "immersion",
    arrangement: "braid",
    coveredFraction: 0,
    available: { wetness: true, arrangement: true, coverage: true },
    ...overrides,
  };
}

function detect(message: string, state = committed(), narratorInput = false) {
  return detectHairPremises({
    message,
    playerName: PLAYER,
    characterName: CHARACTER,
    narratorInput,
    committed: state,
  });
}

const claims = (message: string, state = committed()): string[] =>
  detect(message, state).map((correction) => correction.claimCode);

const verdicts = (message: string, state = committed()): string[] =>
  detect(message, state).map((correction) => `${correction.claimCode}:${correction.verdict}`);

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

describe("input authority", () => {
  it("never corrects storyteller narration, however wrong it looks", () => {
    // The narrator-mode line is a PROPOSED authoritative state change (plan
    // §Architecture 3); until it has a pre-narrator commit seam it is excluded, so a
    // player writing the world cannot be told they are contradicting it.
    expect(detect("Her loose hair was drenched by the storm.", committed(), true)).toEqual([]);
    // …and the identical text in ordinary mode is checked.
    expect(claims("Her loose hair was drenched by the storm.").length).toBeGreaterThan(0);
  });

  it("ignores every span kind that is not speech or unmarked narration", () => {
    for (const message of [
      "*Her hair is loose today*",
      "((her hair should be loose here))",
      "_her loose hair_",
      "*Wren: your loose hair is a mess*",
    ]) {
      expect(detect(message), message).toEqual([]);
    }
  });

  it("checks a quoted line as dialogue and an unmarked line as narration", () => {
    const [dialogue] = detect('"Your loose hair is soaked."');
    expect(dialogue?.source).toBe("player_dialogue");
    const [narration] = detect("Your loose hair is soaked.");
    expect(narration?.source).toBe("ordinary_player_narration");
  });

  it("says nothing about an empty or beat-only turn", () => {
    expect(detect("")).toEqual([]);
    expect(detect("   ")).toEqual([]);
  });
});

describe("sentence guards", () => {
  it("a question asserts nothing", () => {
    expect(detect("Is your hair loose?")).toEqual([]);
    // …and a question in one sentence does not silence a statement in the next.
    expect(claims("Is it late? Your hair is loose.")).toEqual([HAIR_CLAIM_ARRANGEMENT_LOOSE]);
  });

  it("a hypothetical, a wish, or a simile asserts nothing", () => {
    for (const message of [
      "If your hair were loose I would notice.",
      "Your hair would be loose by now.",
      "I imagine your hair loose.",
      "I wish your hair were loose.",
      "Your hair falls like a loose curtain.",
    ]) {
      expect(detect(message), message).toEqual([]);
    }
  });

  it("a negation before the phrase denies the claim; one after it does not", () => {
    expect(detect("Your hair is not loose.")).toEqual([]);
    expect(detect("Your hair isn't loose anymore.")).toEqual([]);
    expect(detect("Your hair is no longer loose.")).toEqual([]);
    // The marker has to PRECEDE the claim — otherwise "not" anywhere in a sentence
        // would silence an assertion it has nothing to do with.
    expect(claims("Your hair is loose, not that you mind.")).toEqual([HAIR_CLAIM_ARRANGEMENT_LOOSE]);
  });

  it("needs the subject's hair, not just the word", () => {
    // No possessive at all, the player's own hair, and a foreign determiner.
    for (const message of ["Loose hair everywhere.", "I pushed my loose hair back.", "The loose hair on the pillow."]) {
      expect(detect(message), message).toEqual([]);
    }
    // A modifier between the possessive and the noun must not hide the reference —
    // "your loose hair" is the plan's own example phrasing.
    expect(claims("The storm drenched your loose hair.")).toContain(HAIR_CLAIM_ARRANGEMENT_LOOSE);
    expect(claims("Wren's loose hair is soaked.")).toContain(HAIR_CLAIM_ARRANGEMENT_LOOSE);
  });

  it("accepts a third-person pronoun only when nobody else could own it", () => {
    expect(claims("Her loose hair falls forward.")).toEqual([HAIR_CLAIM_ARRANGEMENT_LOOSE]);
    // Another name in the same sentence makes the referent ambiguous, and ambiguity is
    // silence — never a guess about which body the claim was about.
    expect(detect("Mira brushes her loose hair.")).toEqual([]);
  });

  it("says nothing about a sentence that mentions hair without a lexicon claim", () => {
    // Domain reference without a safely parsed claim may raise a constraint's priority
    // (plan §Architecture 4); it may never invent a correction.
    expect(detect("You tuck your hair behind one ear.")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Verdicts
// ---------------------------------------------------------------------------

describe("wetness degree", () => {
  it("contradicts a claim two or more bands above the committed one", () => {
    expect(verdicts("Your hair is soaked.", committed({ wetnessBand: "damp" }))).toEqual([
      `${HAIR_CLAIM_WETNESS_SOAKED}:contradicted`,
    ]);
  });

  it("stays silent on an understatement — less specific is not wrong", () => {
    // The asymmetry: claiming "wet" against soaked hair is one band down and merely
    // less specific, so it is not worth a fence.
    expect(detect("Your hair is wet.", committed({ wetnessBand: "soaked" }))).toEqual([]);
  });

  it("stays silent one band either way — the bands are a coarse cut of a live level", () => {
    expect(detect("Your hair is soaked.", committed({ wetnessBand: "wet" }))).toEqual([]);
    expect(detect("Your hair is damp.", committed({ wetnessBand: "wet" }))).toEqual([]);
  });

  it("contradicts a dryness claim against genuinely wet hair", () => {
    // Two bands DOWN, which is where the understatement rule runs out: "dry" against a
    // committed soaking is a negation, not a vaguer description of the same thing.
    expect(verdicts("Your hair is dry.", committed({ wetnessBand: "soaked" }))).toEqual([
      `${HAIR_CLAIM_WETNESS_DRY}:contradicted`,
    ]);
    expect(detect("Your hair is dry.", committed({ wetnessBand: "damp" }))).toEqual([]);
  });

  it("carries the committed band as the truth it does not voice", () => {
    const [correction] = detect("Your hair is soaked.", committed({ wetnessBand: "damp" }));
    expect(correction?.truthCodes).toEqual(["hair.wetness.damp"]);
  });
});

describe("wetness provenance", () => {
  it("contradicts a rain claim over a committed bath — a bath is not weather", () => {
    const [correction] = detect("The storm soaked your hair.");
    expect(correction?.claimCode).toBe(HAIR_CLAIM_CAUSE_RAIN);
    expect(correction?.verdict).toBe("contradicted");
    expect(correction?.truthCodes).toEqual([HAIR_CLAIM_CAUSE_IMMERSION]);
  });

  it("stays silent when the claim names the committed cause", () => {
    expect(detect("The bath left your hair wet.")).toEqual([]);
  });

  it("stays silent when nothing recorded WHY the hair is wet", () => {
    // "We did not record a cause" is not evidence that the player is wrong. Two live
    // causes are the same story, and the adapter reports both as `null`.
    expect(detect("The storm soaked your hair.", committed({ wetnessCause: null }))).toEqual([]);
  });
});

describe("arrangement", () => {
  it("contradicts a loose claim over a committed braid", () => {
    const [correction] = detect("Your loose hair spills over the pillow.");
    expect(correction?.claimCode).toBe(HAIR_CLAIM_ARRANGEMENT_LOOSE);
    expect(correction?.truthCodes).toEqual([HAIR_CLAIM_ARRANGEMENT_BRAID]);
  });

  it("stays silent when the claim matches, and when the style is unidentified", () => {
    expect(detect("Your braided hair is soaked.")).toEqual([]);
    expect(detect("Your loose hair spills forward.", committed({ arrangement: "other" }))).toEqual([]);
  });
});

describe("motion", () => {
  it("contradicts free-flowing hair whenever something holds the bulk still", () => {
    const [correction] = detect("Your hair goes streaming in the wind.");
    expect(correction?.claimCode).toBe(HAIR_CLAIM_MOTION_FREE_FLOW);
    expect(correction?.verdict).toBe("contradicted");
  });

  it("stays silent on loose, uncovered hair — then the claim is simply true", () => {
    expect(detect("Your hair goes streaming in the wind.", committed({ arrangement: "loose" }))).toEqual([]);
  });
});

describe("coverage", () => {
  it("contradicts an uncovered claim under real coverage", () => {
    const [correction] = detect(
      "Your hair is bare-headed in this weather.",
      committed({ coveredFraction: 9_000 }),
    );
    expect(correction?.claimCode).toBe(HAIR_CLAIM_COVERAGE_UNCOVERED);
    // Coverage licenses no positive hair claim: the fence carries the whole instruction.
    expect(correction?.truthCodes).toEqual([]);
  });

  it("stays silent below the coverage gate", () => {
    expect(detect("Your hair is uncovered.", committed({ coveredFraction: 0 }))).toEqual([]);
  });
});

describe("unsupported claims", () => {
  it("fences a claim whose owner this lane could not read, and supplies no alternative", () => {
    const unreadable = committed({
      wetnessBand: null,
      wetnessCause: null,
      available: { wetness: false, arrangement: true, coverage: true },
    });
    const [correction] = detect("Your hair is soaked.", unreadable);
    expect(correction?.verdict).toBe("unsupported");
    expect(correction?.truthCodes).toEqual([]);
    expect(correction?.evidence).toEqual([{ kind: "state", ref: "body_surface.hair", detail: "unavailable" }]);
  });

  it("does the same for an unreadable arrangement and an unmodelled wardrobe", () => {
    const noStyle = committed({
      arrangement: null,
      available: { wetness: true, arrangement: false, coverage: true },
    });
    expect(verdicts("Your loose hair spills forward.", noStyle)).toEqual([
      `${HAIR_CLAIM_ARRANGEMENT_LOOSE}:unsupported`,
    ]);
    const noWardrobe = committed({
      coveredFraction: null,
      available: { wetness: true, arrangement: true, coverage: false },
    });
    expect(verdicts("Your hair is uncovered.", noWardrobe)).toEqual([
      `${HAIR_CLAIM_COVERAGE_UNCOVERED}:unsupported`,
    ]);
  });
});

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

describe("shape and determinism", () => {
  it("at most one correction per claim area, first eligible sentence wins", () => {
    const message = "Your loose hair is streaming. Your unbound hair is whipping about.";
    const areas = detect(message).map((correction) => correction.claimCode);
    expect(areas).toEqual([HAIR_CLAIM_ARRANGEMENT_LOOSE, HAIR_CLAIM_MOTION_FREE_FLOW]);
  });

  it("reproduces identical ids and fingerprints from the same message and cut", () => {
    const message = "The storm drenched your loose hair.";
    const first = detect(message);
    const second = detect(message);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(first.every((correction) => correction.fingerprint.length === 16)).toBe(true);
  });

  it("never marks a correction resolver-only — a hidden correction is a contradiction in terms", () => {
    for (const correction of detect("The storm drenched your loose hair.")) {
      expect(correction.disclosure).toBe("consistency_only");
    }
  });
});

// ---------------------------------------------------------------------------
// Compilation
// ---------------------------------------------------------------------------

/** The plan's worked cut: soaked from a bath, braided, uncovered, still air. */
function braidedRead(): AffordanceRead {
  return readHairAffordances({
    attributes: hairAttributeFixture({
      length: "shoulder_length",
      density: "dense",
      strandThickness: "thick",
      texture: "wavy",
      condition: "healthy",
      arrangement: "braid",
    }),
    payload: {
      wetness: 9_500,
      coveredFraction: 0,
      wind: { force: 0 },
      events: [{ kind: "immersion", atStoryTime: 5 }],
    },
    perception: hairObserver({ hair: "visible" }),
  });
}

function compile(input: {
  message: string;
  read?: AffordanceRead | null;
  visible?: boolean;
  state?: ChatCommittedHairState;
  sink?: DiagnosticCollector;
}) {
  const read = input.read === undefined ? braidedRead() : input.read;
  return buildChatPhysicalGuidance({
    read,
    perception: read === null ? null : hairObserver({ hair: input.visible === false ? "hidden" : "visible" }),
    subjectId: "character_wren",
    characterName: CHARACTER,
    playerName: PLAYER,
    message: input.message,
    narratorInput: false,
    committed: input.state ?? committed(),
    ...(input.sink === undefined ? {} : { sink: input.sink }),
  });
}

describe("compile", () => {
  it("compiles the plan's worked example: one fence and two premise checks", () => {
    const guidance = compile({ message: "The storm drenched your loose hair." });
    expect(guidance.constraints.map((constraint) => constraint.prohibitedClaimCodes)).toEqual([
      [HAIR_CLAIM_ARRANGEMENT_LOOSE, HAIR_CLAIM_MOTION_FREE_FLOW],
    ]);
    expect(guidance.corrections.map((correction) => correction.claimCode).sort()).toEqual(
      [HAIR_CLAIM_ARRANGEMENT_LOOSE, HAIR_CLAIM_CAUSE_RAIN].sort(),
    );
    // Slice 2 produces neither of the later tiers.
    expect(guidance.actionOutcomes).toEqual([]);
    expect(guidance.transitions).toEqual([]);
  });

  it("licenses the committed truth only when the locus is visible", () => {
    expect(compile({ message: "hello" }).constraints[0]?.allowedClaimCodes).toEqual([HAIR_CLAIM_ARRANGEMENT_BRAID]);
    // Hidden hair keeps the prohibition and drops the cause — a fence that does not
    // explain itself (plan §Architecture 5).
    const hidden = compile({ message: "hello", visible: false });
    expect(hidden.constraints[0]?.prohibitedClaimCodes.length).toBeGreaterThan(0);
    expect(hidden.constraints[0]?.allowedClaimCodes).toEqual([]);
  });

  it("keeps the fences standing on a turn that asserts nothing", () => {
    const guidance = compile({ message: "You look well today." });
    expect(guidance.corrections).toEqual([]);
    expect(guidance.constraints).toHaveLength(1);
  });

  it("still premise-checks with no read at all — a suppressed domain knows the style", () => {
    const guidance = compile({ message: "Your loose hair spills forward.", read: null });
    expect(guidance.constraints).toEqual([]);
    expect(guidance.corrections.map((correction) => correction.claimCode)).toEqual([HAIR_CLAIM_ARRANGEMENT_LOOSE]);
  });

  it("is the empty value, with no diagnostics, when nothing is at stake", () => {
    const sink = new DiagnosticCollector();
    const loose = readHairAffordances({
      attributes: hairAttributeFixture({
        length: "shoulder_length",
        density: "sparse",
        strandThickness: "fine",
        texture: "straight",
        condition: "silky",
        arrangement: "loose",
      }),
      payload: { wetness: 0, coveredFraction: 0, wind: { force: 0 }, events: [] },
      perception: hairObserver({ hair: "visible" }),
    });
    const guidance = buildChatPhysicalGuidance({
      read: loose,
      perception: hairObserver({ hair: "visible" }),
      subjectId: "character_wren",
      characterName: CHARACTER,
      playerName: PLAYER,
      message: "You look well today.",
      narratorInput: false,
      committed: committed({ wetnessBand: "dry", wetnessCause: null, arrangement: "loose" }),
      sink,
    });
    expect(guidance.constraints).toEqual([]);
    expect(guidance.corrections).toEqual([]);
    // A nothing-to-say turn must not be distinguishable from a feature-off one, right
    // down to the diagnostics it did not file.
    expect(guidance.diagnostics).toEqual([]);
    expect(sink.items.filter((item) => item.code.startsWith("guidance."))).toEqual([]);
  });

  it("cannot exceed the shared correction budget", () => {
    const guidance = compile({
      message: "Your loose hair is streaming, bare-headed and dry in the storm.",
      state: committed({ coveredFraction: 9_000, wetnessBand: "soaked" }),
    });
    expect(guidance.corrections.length).toBeLessThanOrEqual(GUIDANCE_MAX_CORRECTIONS);
  });
});
