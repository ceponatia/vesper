import { describe, expect, it } from "vitest";
import {
  visualStateLocusKey,
  VISUAL_STATE_BODY_LANGUAGE_CONTACT_RELATION_KIND_ID,
  VISUAL_STATE_BODY_LANGUAGE_FACING_KIND_ID,
  VISUAL_STATE_BODY_LANGUAGE_HAND_OCCUPATION_KIND_ID,
  VISUAL_STATE_BODY_LANGUAGE_POSTURE_KIND_ID,
  VISUAL_STATE_BODY_SURFACE_WETNESS_KIND_ID,
  VISUAL_STATE_GARMENT_CONDITION_KIND_ID,
  VISUAL_STATE_GARMENT_DAMAGE_KIND_ID,
  VISUAL_STATE_GARMENT_PRESENTATION_KIND_ID,
  VISUAL_STATE_SPECIES_FEATURE_GROUP_KIND_ID,
  VISUAL_STATE_WARDROBE_GARMENT_KIND_ID,
  type VisualConstraint,
  type VisualNarratorCue,
  type VisualNarratorCueReason,
  type VisualNarratorDigest,
  type VisualStateLocusRef,
  toUnitInterval,
} from "@/contracts";
import {
  renderChatVisualStateCue,
  renderChatVisualStateConstraint,
  renderChatVisualStateLines,
  type ChatVisualStateSubject,
} from "./chat-visual-state-cues";

/**
 * The slice-7 narrator projection: typed visual facts → the concise factual
 * clauses the prompt carries.
 *
 * Two things are load-bearing and both are asserted here. The clause must be
 * built from the feature's own committed VALUE, so a vocabulary this adapter
 * has not learned goes quiet instead of inventing a sentence; and the two blocks
 * must not restate one another, because a fence and an offer that say the same
 * words are the repetition this whole layer exists to prevent.
 */

const SUBJECT: ChatVisualStateSubject = { characterName: "Mara", possessive: "Mara's" };
const GARMENTS = new Map([["g_coat", "grey wool coat"]]);

function constraint(overrides: Partial<VisualConstraint> & Pick<VisualConstraint, "kindId" | "value" | "locus">): VisualConstraint {
  return {
    key: "k",
    subjectId: "s",
    truthFingerprint: "fp",
    semanticTags: [],
    evidence: [],
    ...overrides,
  };
}

function cue(
  overrides: Partial<VisualNarratorCue> & Pick<VisualNarratorCue, "kindId" | "value" | "locus">,
): VisualNarratorCue {
  return {
    key: "k",
    subjectId: "s",
    layer: "current",
    reason: "newly_visible" as VisualNarratorCueReason,
    truthFingerprint: "fp",
    semanticTags: [],
    repeatKey: "r",
    priority: toUnitInterval(5_000),
    evidence: [],
    ...overrides,
  };
}

const COAT: VisualStateLocusRef = { kind: "item", itemInstanceId: "g_coat" };
const CUFF: VisualStateLocusRef = { kind: "garment_part", garmentInstanceId: "g_coat", partId: "cuff_left" };
const HAIR: VisualStateLocusRef = { kind: "body", locus: { bodyLocationId: "hair" } };
const SELF: VisualStateLocusRef = { kind: "subject", subjectId: "s" };

function line(kindId: string, value: unknown, locus: VisualStateLocusRef): string {
  return renderChatVisualStateConstraint(constraint({ kindId, value, locus }), SUBJECT, GARMENTS);
}

describe("clauses come from the committed value", () => {
  it("names a worn garment and where it is", () => {
    expect(line(VISUAL_STATE_WARDROBE_GARMENT_KIND_ID, { name: "grey wool coat", locus: { kind: "worn" } }, COAT)).toBe(
      "Mara is wearing the grey wool coat",
    );
    expect(line(VISUAL_STATE_WARDROBE_GARMENT_KIND_ID, { name: "grey wool coat", locus: { kind: "scene" } }, COAT)).toBe(
      "the grey wool coat is where it was left, not on Mara",
    );
  });

  it("joins a garment part to its garment's name", () => {
    expect(line(VISUAL_STATE_GARMENT_PRESENTATION_KIND_ID, { channel: "roll", band: "rolled" }, CUFF)).toBe(
      "the grey wool coat's cuff left is rolled up",
    );
  });

  it("falls back to the bare part when the garment has no name here", () => {
    expect(
      renderChatVisualStateConstraint(
        constraint({ kindId: VISUAL_STATE_GARMENT_PRESENTATION_KIND_ID, value: { channel: "roll", band: "rolled" }, locus: CUFF }),
        SUBJECT,
      ),
    ).toBe("the cuff left is rolled up");
  });

  it("uses each owner's own vocabulary verbatim", () => {
    expect(line(VISUAL_STATE_BODY_SURFACE_WETNESS_KIND_ID, { band: "damp" }, HAIR)).toBe("Mara's hair is damp");
    expect(line(VISUAL_STATE_GARMENT_CONDITION_KIND_ID, { channel: "wetness", band: "soaked" }, COAT)).toBe(
      "the grey wool coat is soaked",
    );
    expect(line(VISUAL_STATE_BODY_LANGUAGE_POSTURE_KIND_ID, { posture: "kneeling" }, SELF)).toBe("Mara is kneeling");
    expect(line(VISUAL_STATE_BODY_LANGUAGE_FACING_KIND_ID, { facing: "away", towardSubjectId: "p" }, SELF)).toBe(
      "Mara is turned away from you",
    );
    expect(line(VISUAL_STATE_SPECIES_FEATURE_GROUP_KIND_ID, { group: "wings" }, SELF)).toBe("Mara has wings");
  });

  it("renders damage as a noun, not as an adjective", () => {
    expect(line(VISUAL_STATE_GARMENT_DAMAGE_KIND_ID, { damage: "tear", severity: "clear" }, CUFF)).toBe(
      "the grey wool coat's cuff left has a tear",
    );
    expect(line(VISUAL_STATE_GARMENT_DAMAGE_KIND_ID, { damage: "missing_fastener", severity: "clear" }, COAT)).toBe(
      "the grey wool coat is missing a fastener",
    );
  });

  it("says a hand is occupied without claiming which, when the contact did not", () => {
    expect(line(VISUAL_STATE_BODY_LANGUAGE_HAND_OCCUPATION_KIND_ID, { side: "unspecified" }, SELF)).toBe(
      "one of Mara's hands is occupied",
    );
    expect(line(VISUAL_STATE_BODY_LANGUAGE_HAND_OCCUPATION_KIND_ID, { side: "left" }, SELF)).toBe(
      "Mara's left hand is occupied",
    );
  });

  it("goes quiet on a value shape it cannot read, rather than inventing one", () => {
    expect(line(VISUAL_STATE_BODY_SURFACE_WETNESS_KIND_ID, { band: "dripping" }, HAIR)).toBe("");
    expect(line(VISUAL_STATE_WARDROBE_GARMENT_KIND_ID, { locus: { kind: "worn" } }, COAT)).toBe("");
    expect(line(VISUAL_STATE_BODY_LANGUAGE_POSTURE_KIND_ID, "not an object", SELF)).toBe("");
  });

  it("renders a contact relation as a verbless noun phrase, naming only resolvable participants", () => {
    const named: ChatVisualStateSubject = { ...SUBJECT, subjectId: "npc", playerSubjectId: "player" };
    const relation = (source: string, target: string) => ({
      actionKind: "affectionate",
      source: { subjectId: source, locus: { bodyLocationId: "hands", side: "left" as const } },
      target: { kind: "body" as const, subjectId: target, locus: { bodyLocationId: "shoulders" } },
      materialBetween: { directSkinContact: true, layerIds: [] },
    });
    const RELATION: VisualStateLocusRef = { kind: "relation", relationId: "c1" };
    expect(
      renderChatVisualStateConstraint(
        constraint({ kindId: VISUAL_STATE_BODY_LANGUAGE_CONTACT_RELATION_KIND_ID, value: relation("npc", "player"), locus: RELATION }),
        named,
      ),
    ).toBe("Mara's left hand on your shoulders");
    // A roster member this digest cannot name, or a caller that supplied no
    // ids at all: silence, never a subject id in prose.
    expect(
      renderChatVisualStateConstraint(
        constraint({ kindId: VISUAL_STATE_BODY_LANGUAGE_CONTACT_RELATION_KIND_ID, value: relation("npc", "roster_member"), locus: RELATION }),
        named,
      ),
    ).toBe("");
    expect(
      renderChatVisualStateConstraint(
        constraint({ kindId: VISUAL_STATE_BODY_LANGUAGE_CONTACT_RELATION_KIND_ID, value: relation("npc", "player"), locus: RELATION }),
        SUBJECT,
      ),
    ).toBe("");
  });

  it("renders nothing at all for a subject with no name", () => {
    expect(
      renderChatVisualStateConstraint(
        constraint({ kindId: VISUAL_STATE_BODY_SURFACE_WETNESS_KIND_ID, value: { band: "damp" }, locus: HAIR }),
        { characterName: "  ", possessive: "" },
      ),
    ).toBe("");
  });
});

describe("cues carry the reason they are live", () => {
  it("appends the reason clause after the fact", () => {
    expect(
      renderChatVisualStateCue(
        cue({ kindId: VISUAL_STATE_BODY_SURFACE_WETNESS_KIND_ID, value: { band: "damp" }, locus: HAIR, reason: "change" }),
        SUBJECT,
      ),
    ).toBe("Mara's hair is damp — changed from what it was");
  });

  it("has a clause for the reason the cue state added", () => {
    expect(
      renderChatVisualStateCue(
        cue({ kindId: VISUAL_STATE_GARMENT_PRESENTATION_KIND_ID, value: { channel: "roll", band: "rolled" }, locus: CUFF }),
        SUBJECT,
        GARMENTS,
      ),
    ).toBe("the grey wool coat's cuff left is rolled up — just became visible");
  });
});

describe("the two blocks", () => {
  const digest = (
    constraints: readonly VisualConstraint[],
    selected: readonly VisualNarratorCue[],
  ): VisualNarratorDigest => ({ subjectId: "s", constraints, selected, suppressedCount: 0 });

  it("drops a cue that only restates a constraint", () => {
    const worn = { kindId: VISUAL_STATE_WARDROBE_GARMENT_KIND_ID, value: { name: "coat", locus: { kind: "worn" } }, locus: COAT };
    const lines = renderChatVisualStateLines({
      digest: digest([constraint(worn)], [cue({ ...worn, reason: "change" })]),
      subject: SUBJECT,
    });
    expect(lines.constraints).toEqual(["Mara is wearing the coat"]);
    expect(lines.cues).toEqual([]);
  });

  it("keeps a cue that says something the fence does not", () => {
    const lines = renderChatVisualStateLines({
      digest: digest(
        [constraint({ kindId: VISUAL_STATE_WARDROBE_GARMENT_KIND_ID, value: { name: "coat", locus: { kind: "worn" } }, locus: COAT })],
        [cue({ kindId: VISUAL_STATE_BODY_SURFACE_WETNESS_KIND_ID, value: { band: "damp" }, locus: HAIR })],
      ),
      subject: SUBJECT,
    });
    expect(lines.constraints).toHaveLength(1);
    expect(lines.cues).toEqual(["Mara's hair is damp — just became visible"]);
  });

  it("drops a duplicate constraint rather than saying it twice", () => {
    const worn = { kindId: VISUAL_STATE_WARDROBE_GARMENT_KIND_ID, value: { name: "coat", locus: { kind: "worn" } }, locus: COAT };
    const lines = renderChatVisualStateLines({
      digest: digest([constraint(worn), constraint({ ...worn, key: "k2" })], []),
      subject: SUBJECT,
    });
    expect(lines.constraints).toEqual(["Mara is wearing the coat"]);
  });

  it("says nothing at all for an empty digest", () => {
    const lines = renderChatVisualStateLines({ digest: digest([], []), subject: SUBJECT });
    expect(lines).toEqual({ constraints: [], cues: [] });
  });
});

describe("what the blocks may speak about", () => {
  it("only ever names loci the digest carries — the leakage floor", () => {
    // The digest is already visibility-filtered upstream; this asserts the
    // renderer adds no locus of its own, which is what makes the trial's
    // hidden-detail check a check on selection rather than on prose.
    const worn = constraint({
      kindId: VISUAL_STATE_WARDROBE_GARMENT_KIND_ID,
      value: { name: "coat", locus: { kind: "worn" } },
      locus: COAT,
    });
    const damp = cue({ kindId: VISUAL_STATE_BODY_SURFACE_WETNESS_KIND_ID, value: { band: "damp" }, locus: HAIR });
    const lines = renderChatVisualStateLines({
      digest: { subjectId: "s", constraints: [worn], selected: [damp], suppressedCount: 0 },
      subject: SUBJECT,
      garmentNames: GARMENTS,
    });
    expect(visualStateLocusKey(worn.locus)).toBe("item:g_coat");
    expect(lines.constraints.join(" ") + lines.cues.join(" ")).not.toContain("torso");
  });
});
