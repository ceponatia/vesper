import { describe, expect, it } from "vitest";
import type { AffordanceObservation, AffordanceResolution, AffordanceSuppression } from "../../core";
import { resolvedAttributeSnapshot, toUnitInterval } from "../../core";
import { compileFootwearContact, type FootwearContactRead } from "./footwear";
import {
  committedFootContact,
  footAttributeFixture,
  footFabricLayer,
  footwearFixture,
  type FootAttributeFixtureInput,
  type FootContactFixtureInput,
} from "./fixtures";
import { buildFootFrame, footContactFromCommitted, type FootAffordanceFrame } from "./frame";
import { FOOT_FIXTURE_ACTOR, FOOT_FIXTURE_SUBJECT } from "./fixtures";
import { deriveFootMechanics } from "./mechanics";
import {
  footArticulationObservation,
  footContactPressure,
  footGlideResponse,
  footNailContact,
  footPhenomena,
  footSurfaceTextureContact,
  FOOT_ARTICULATION_ID,
  FOOT_CONTACT_PRESSURE_ID,
  FOOT_FIRM_NAIL_EDGE,
  FOOT_GLIDE_RESPONSE_ID,
  FOOT_INTERDIGITAL_CLOSED,
  FOOT_LIGHT_NAIL_TRACE,
  FOOT_MATERIAL_BLOCKS_TOUCH,
  FOOT_NAIL_CONTACT_ID,
  FOOT_NO_COMMITTED_CONTACT,
  FOOT_NO_COMMITTED_POSE,
  FOOT_NO_NAIL_CONTACT,
  FOOT_NO_SLIDING_MOTION,
  FOOT_NO_TACTILE_CHANNEL,
  FOOT_PRESSURE_UNKNOWN,
  FOOT_SURFACE_TEXTURE_ID,
  FOOT_UNKNOWN_SURFACE_STATE,
} from "./phenomena";
import { compileFootProfile } from "./profile";
import type { FootCoarseConditionRead } from "./condition";
import type { FootArticulationRead, FootSupportRead } from "./support";
import type { FootSurfaceId } from "./topology";

/**
 * Per-phenomenon gates, driven through hand-built frames.
 *
 * The frames are built with the domain's own `buildFootFrame`, so a resolver
 * cannot be handed a shape the pipeline would never produce; the CORE's
 * dependency gate (required key not `supported` ⇒ suppressed) is exercised
 * separately in `foot.test.ts`, end to end.
 */

interface FrameInput {
  readonly attributes?: FootAttributeFixtureInput;
  readonly coarse?: FootCoarseConditionRead;
  readonly contact?: FootContactFixtureInput;
  readonly footwear?: FootwearContactRead;
  readonly supports?: readonly FootSupportRead[];
  readonly articulations?: readonly FootArticulationRead[];
  readonly tactile?: boolean;
}

const DRY: FootCoarseConditionRead = {
  moisture: toUnitInterval(0),
  contributors: [],
  placedSubstances: [],
  placedResidues: [],
};

function frameOf(input: FrameInput): FootAffordanceFrame {
  const attributes = input.attributes ?? { arch: "average", nails: "neat", toes: "average" };
  const profile = compileFootProfile(resolvedAttributeSnapshot(footAttributeFixture(attributes))).profile;
  if (profile === undefined) throw new Error("fixture attributes failed to compile");
  const contact =
    input.contact === undefined
      ? undefined
      : (footContactFromCommitted({
          contact: committedFootContact(input.contact),
          subjectId: FOOT_FIXTURE_SUBJECT,
        }) ?? undefined);
  return buildFootFrame(
    profile,
    deriveFootMechanics({
      profile,
      ...(input.coarse === undefined ? {} : { coarse: input.coarse }),
      ...(input.footwear === undefined ? {} : { footwear: input.footwear }),
      articulations: input.articulations ?? [],
    }),
    {
      subjectId: FOOT_FIXTURE_SUBJECT,
      storyTime: 100,
      ...(input.footwear === undefined ? {} : { footwear: input.footwear }),
      ...(contact === undefined ? {} : { contact }),
      supports: input.supports ?? [],
      articulations: input.articulations ?? [],
      tactile: input.tactile ?? true,
      evidence: [],
    },
  );
}

function observation(resolution: AffordanceResolution): AffordanceObservation {
  if (resolution.kind !== "observation") throw new Error(`expected an observation, got ${resolution.kind}`);
  return resolution;
}

function suppression(resolution: AffordanceResolution): AffordanceSuppression {
  if (resolution.kind !== "suppressed") throw new Error(`expected a suppression, got ${resolution.kind}`);
  return resolution;
}

const ARCH_TOUCH: FootContactFixtureInput = {
  detail: "arch",
  locationId: "foot_arch",
  pressure: "moderate",
  area: "broad",
};

describe("no committed contact yields no observation", () => {
  it.each([
    [FOOT_CONTACT_PRESSURE_ID, footContactPressure],
    [FOOT_SURFACE_TEXTURE_ID, footSurfaceTextureContact],
    [FOOT_GLIDE_RESPONSE_ID, footGlideResponse],
    [FOOT_NAIL_CONTACT_ID, footNailContact],
  ])("%s falls silent", (id, phenomenon) => {
    const resolved = suppression(phenomenon.resolveFrame(frameOf({ coarse: DRY })));
    expect(resolved.phenomenonId).toBe(id);
    expect(resolved.code).toBe(FOOT_NO_COMMITTED_CONTACT);
  });

  it("ignores a committed contact on somebody else's body", () => {
    const elsewhere = committedFootContact({ detail: "arch", locationId: "foot_arch" });
    expect(footContactFromCommitted({ contact: elsewhere, subjectId: FOOT_FIXTURE_ACTOR })).toBeNull();
  });

  it("refuses to place a contact that names the foot but no region", () => {
    const whole = committedFootContact({ detail: "arch", locationId: "feet" });
    const placed = footContactFromCommitted({ contact: whole, subjectId: FOOT_FIXTURE_SUBJECT });
    // The detail token still places it; a contact with NO detail on `feet` does not.
    expect(placed?.primary.surfaceId).toBe("arch");
  });

  it("degrades a path of unresolvable tokens to the contact's own locus, not to a phantom slide", () => {
    const contact = committedFootContact({
      detail: "arch",
      locationId: "foot_arch",
      pressure: "light",
      area: "broad",
      motion: "sliding",
      // Tokens this domain has no surface for. They are DROPPED — the core stores
      // details verbatim and only this domain gives them meaning — and the path
      // collapses to the one locus the contact is actually placed on.
      path: ["instep", "outstep"] as unknown as readonly FootSurfaceId[],
    });
    const placed = footContactFromCommitted({ contact, subjectId: FOOT_FIXTURE_SUBJECT });
    expect(placed?.path.map((locus) => locus.surfaceId)).toEqual(["arch"]);

    // The observable consequence: the read is a single-locus slide over the
    // primary surface, and the crossed-region tags a real path would carry are
    // absent — so nothing claims the movement went anywhere it did not.
    const resolved = observation(
      footContactPressure.resolveFrame(
        frameOf({ coarse: DRY, contact: { ...ARCH_TOUCH, motion: "sliding", path: ["instep"] as unknown as readonly FootSurfaceId[] } }),
      ),
    );
    expect(resolved.semanticTags.some((tag) => tag.startsWith("crosses_"))).toBe(false);
  });
});

describe("foot.contact_pressure", () => {
  it("reports the band, the area, and the regions a path crossed", () => {
    const resolved = observation(
      footContactPressure.resolveFrame(
        frameOf({ coarse: DRY, contact: { ...ARCH_TOUCH, motion: "sliding", path: ["arch", "heel_pad"] } }),
      ),
    );
    expect(resolved.intensityBand).toBe("clear");
    expect(resolved.sourceLocationId).toBe("sole");
    expect(resolved.semanticTags).toEqual([
      "pressure_moderate",
      "area_broad",
      "arch",
      "crosses_arch",
      "crosses_heel_pad",
    ]);
  });

  it("falls silent when the committed contact states no pressure", () => {
    const resolved = suppression(
      footContactPressure.resolveFrame(frameOf({ coarse: DRY, contact: { detail: "arch", locationId: "foot_arch" } })),
    );
    expect(resolved.code).toBe(FOOT_PRESSURE_UNKNOWN);
  });

  it("keeps reading pressure when only the area is unstated", () => {
    const resolved = observation(
      footContactPressure.resolveFrame(
        frameOf({ coarse: DRY, contact: { detail: "arch", locationId: "foot_arch", pressure: "firm" } }),
      ),
    );
    expect(resolved.intensityBand).toBe("strong");
    expect(resolved.semanticTags).toEqual(["pressure_firm", "arch"]);
  });

  it("never names redness, a mark, or an impression", () => {
    const resolved = observation(
      footContactPressure.resolveFrame(
        frameOf({ coarse: DRY, contact: { ...ARCH_TOUCH, pressure: "firm", area: "point" } }),
      ),
    );
    for (const forbidden of ["red", "mark", "impression", "bruise", "print", "ache"]) {
      expect(resolved.semanticTags.join(" "), forbidden).not.toContain(forbidden);
    }
  });
});

describe("foot.surface_texture_contact", () => {
  it("needs a tactile channel the lane positively asserted", () => {
    const resolved = suppression(
      footSurfaceTextureContact.resolveFrame(frameOf({ coarse: DRY, contact: ARCH_TOUCH, tactile: false })),
    );
    expect(resolved.code).toBe(FOOT_NO_TACTILE_CHANNEL);
  });

  it("reads the arch soft and the heel rougher on the same foot", () => {
    const arch = observation(footSurfaceTextureContact.resolveFrame(frameOf({ coarse: DRY, contact: ARCH_TOUCH })));
    const heel = observation(
      footSurfaceTextureContact.resolveFrame(
        frameOf({ coarse: DRY, contact: { detail: "heel_pad", locationId: "heel", pressure: "moderate" } }),
      ),
    );
    expect(arch.semanticTags).toContain("soft_arch");
    expect(heel.semanticTags).toContain("rougher_heel_pad");
    expect(heel.sourceLocationId).toBe("heel");
  });

  it("reads the ball firmer than the arch", () => {
    const ball = observation(
      footSurfaceTextureContact.resolveFrame(
        frameOf({ coarse: DRY, contact: { detail: "ball", locationId: "ball_of_foot", pressure: "light" } }),
      ),
    );
    expect(ball.semanticTags).toContain("firmer_ball");
  });

  it("reads the dorsal surface smooth", () => {
    const dorsal = observation(
      footSurfaceTextureContact.resolveFrame(
        frameOf({ coarse: DRY, contact: { detail: "dorsal_surface", locationId: "top_of_foot", pressure: "light" } }),
      ),
    );
    expect(dorsal.semanticTags).toContain("smooth_dorsal_surface");
  });

  it("names the register a covered touch arrives through, and damps its band", () => {
    const bare = observation(
      footSurfaceTextureContact.resolveFrame(
        frameOf({ coarse: DRY, contact: { detail: "heel_pad", locationId: "heel", pressure: "moderate" } }),
      ),
    );
    const socked = observation(
      footSurfaceTextureContact.resolveFrame(
        frameOf({
          coarse: DRY,
          footwear: compileFootwearContact([footwearFixture({ filterTag: "stocking" })]),
          contact: {
            detail: "heel_pad",
            locationId: "heel",
            pressure: "moderate",
            layers: [footFabricLayer("fixture_sock")],
          },
        }),
      ),
    );
    expect(socked.semanticTags).toContain("stocking_filtered");
    expect(bare.intensityBand).toBe("strong");
    expect(socked.intensityBand).toBe("clear");
  });

  it("adds a softened tag only when there is moisture to soften it", () => {
    const damp = observation(
      footSurfaceTextureContact.resolveFrame(
        frameOf({
          coarse: { ...DRY, moisture: toUnitInterval(9_000), contributors: [{ kind: "water", amount: toUnitInterval(9_000) }] },
          contact: ARCH_TOUCH,
        }),
      ),
    );
    const dry = observation(footSurfaceTextureContact.resolveFrame(frameOf({ coarse: DRY, contact: ARCH_TOUCH })));
    expect(damp.semanticTags).toContain("moisture_softened");
    expect(dry.semanticTags).not.toContain("moisture_softened");
  });

  it("says nothing about dryness when the moisture is unknown", () => {
    const unknown = observation(footSurfaceTextureContact.resolveFrame(frameOf({ contact: ARCH_TOUCH })));
    expect(unknown.semanticTags).not.toContain("moisture_softened");
    expect(unknown.semanticTags.join(" ")).not.toContain("dry");
  });

  it("emits no number, anywhere", () => {
    const resolved = observation(footSurfaceTextureContact.resolveFrame(frameOf({ coarse: DRY, contact: ARCH_TOUCH })));
    for (const tag of resolved.semanticTags) expect(tag, tag).not.toMatch(/\d/u);
  });

  it("refuses a bare-skin claim at a locus the wardrobe says is covered", () => {
    // The adversarial case: the lane's material list says direct skin while the
    // wardrobe says the surface is inside a sock. The conservative half wins, so
    // footwear can actually stop a bare-skin read.
    const resolved = observation(
      footSurfaceTextureContact.resolveFrame(
        frameOf({
          coarse: DRY,
          footwear: compileFootwearContact([footwearFixture({ filterTag: "stocking" })]),
          // No layers on the contact ⇒ `directSkinContact: true`.
          contact: { detail: "heel_pad", locationId: "heel", pressure: "moderate" },
        }),
      ),
    );
    expect(resolved.semanticTags).toContain("stocking_filtered");
    expect(resolved.intensityBand).toBe("clear");
    const bare = observation(
      footSurfaceTextureContact.resolveFrame(
        frameOf({ coarse: DRY, contact: { detail: "heel_pad", locationId: "heel", pressure: "moderate" } }),
      ),
    );
    expect(bare.intensityBand).toBe("strong");
  });

  it("still reads bare at a locus the same footwear leaves uncovered", () => {
    const resolved = observation(
      footSurfaceTextureContact.resolveFrame(
        frameOf({
          coarse: DRY,
          // A sock: no upper, so the dorsal surface is outside it.
          footwear: compileFootwearContact([footwearFixture()]),
          contact: { detail: "dorsal_surface", locationId: "top_of_foot", pressure: "light" },
        }),
      ),
    );
    expect(resolved.semanticTags).toEqual(["smooth_dorsal_surface"]);
  });

  it("falls silent between toes the committed pose has pressed together", () => {
    const closed = suppression(
      footSurfaceTextureContact.resolveFrame(
        frameOf({
          coarse: DRY,
          contact: { detail: "interdigital_spaces", locationId: "toes", pressure: "light" },
          articulations: [{ side: "left", toes: "curled", arch: "neutral", evidence: [] }],
        }),
      ),
    );
    expect(closed.code).toBe(FOOT_INTERDIGITAL_CLOSED);

    const spread = observation(
      footSurfaceTextureContact.resolveFrame(
        frameOf({
          coarse: DRY,
          contact: { detail: "interdigital_spaces", locationId: "toes", pressure: "light" },
          articulations: [{ side: "left", toes: "spread", arch: "neutral", evidence: [] }],
        }),
      ),
    );
    expect(spread.semanticTags[0]).toBe("soft_interdigital_spaces");
  });

  it("falls silent when nothing reaches the skin at all", () => {
    const opaque = footFabricLayer("fixture_cast");
    const resolved = suppression(
      footSurfaceTextureContact.resolveFrame(
        frameOf({
          coarse: DRY,
          contact: { ...ARCH_TOUCH, layers: [{ ...opaque, tactileTransmission: toUnitInterval(0) }] },
        }),
      ),
    );
    expect(resolved.code).toBe(FOOT_MATERIAL_BLOCKS_TOUCH);
  });
});

describe("foot.glide_response", () => {
  const LOTIONED: FootCoarseConditionRead = {
    ...DRY,
    placedSubstances: [{ surfaceId: "arch", kind: "lotion", amount: toUnitInterval(5_000) }],
  };

  it("needs committed sliding motion", () => {
    const resolved = suppression(footGlideResponse.resolveFrame(frameOf({ coarse: DRY, contact: ARCH_TOUCH })));
    expect(resolved.code).toBe(FOOT_NO_SLIDING_MOTION);
  });

  it("suppresses on an unknown surface state rather than reading it dry", () => {
    const resolved = suppression(
      footGlideResponse.resolveFrame(frameOf({ contact: { ...ARCH_TOUCH, motion: "sliding" } })),
    );
    expect(resolved.code).toBe(FOOT_UNKNOWN_SURFACE_STATE);
  });

  it("cannot report slippery without a moisture or product source", () => {
    const resolved = observation(
      footGlideResponse.resolveFrame(
        frameOf({
          coarse: DRY,
          contact: { detail: "dorsal_surface", locationId: "top_of_foot", pressure: "light", motion: "sliding" },
        }),
      ),
    );
    expect(resolved.semanticTags[0]).toBe("smooth_glide");
    expect(resolved.semanticTags.some((tag) => tag.startsWith("via_"))).toBe(false);
  });

  it("reports a slippery lotioned arch, naming the substance", () => {
    const resolved = observation(
      footGlideResponse.resolveFrame(
        frameOf({ coarse: LOTIONED, contact: { ...ARCH_TOUCH, motion: "sliding" } }),
      ),
    );
    expect(resolved.semanticTags[0]).toBe("slippery");
    expect(resolved.semanticTags).toContain("via_lotion");
  });

  it("picks the localized heel catch out of an arch → heel slide", () => {
    const resolved = observation(
      footGlideResponse.resolveFrame(
        frameOf({ coarse: LOTIONED, contact: { ...ARCH_TOUCH, motion: "sliding", path: ["arch", "heel_pad"] } }),
      ),
    );
    expect(resolved.semanticTags[0]).toBe("rough_surface_catch");
    expect(resolved.sourceLocationId).toBe("heel");
    expect(resolved.semanticTags).toContain("crosses_arch");
    // The lotion was on the arch, not on the heel that caught.
    expect(resolved.semanticTags).not.toContain("via_lotion");
  });

  it("surfaces a heel catch even when another locus out-frictions it", () => {
    // Sand on the arch drives its friction (4_500 + grit) past the callused
    // heel's 7_000. Picking the grippiest locus and only THEN asking whether it
    // catches lost the snag entirely and reported `dragging` on the arch.
    const gritty = observation(
      footGlideResponse.resolveFrame(
        frameOf({
          coarse: {
            ...DRY,
            placedResidues: [{ surfaceId: "arch", kind: "sand", amount: toUnitInterval(10_000) }],
          },
          contact: { ...ARCH_TOUCH, motion: "sliding", path: ["arch", "heel_pad"] },
        }),
      ),
    );
    expect(gritty.semanticTags[0]).toBe("rough_surface_catch");
    expect(gritty.sourceLocationId).toBe("heel");
  });

  it("does not catch on a smooth surface however much it drags", () => {
    const resolved = observation(
      footGlideResponse.resolveFrame(
        frameOf({
          coarse: DRY,
          attributes: { arch: "high", nails: "neat", toes: "average" },
          contact: { detail: "arch", locationId: "foot_arch", pressure: "light", motion: "sliding" },
        }),
      ),
    );
    expect(resolved.semanticTags[0]).not.toBe("rough_surface_catch");
  });
});

describe("foot.articulation_observation", () => {
  it("is silent without a committed pose — which is production, today", () => {
    const resolved = suppression(footArticulationObservation.resolveFrame(frameOf({ coarse: DRY, contact: ARCH_TOUCH })));
    expect(resolved.code).toBe(FOOT_NO_COMMITTED_POSE);
  });

  it("reports the committed pose and what is limiting it", () => {
    const resolved = observation(
      footArticulationObservation.resolveFrame(
        frameOf({ coarse: DRY, articulations: [{ side: "left", toes: "curled", arch: "extended", evidence: [] }] }),
      ),
    );
    expect(resolved.semanticTags).toEqual(["foot_left", "toes_curled", "arch_extended", "restricted_by_unrestricted"]);
  });

  it("blames rigid footwear over an ordinary support", () => {
    const boot = compileFootwearContact([
      footwearFixture({ kind: "shoe", parts: ["upper", "toe_box"], rigidity: toUnitInterval(9_000) }),
    ]);
    const resolved = observation(
      footArticulationObservation.resolveFrame(
        frameOf({
          coarse: DRY,
          footwear: boot,
          supports: [{ side: "left", supportRole: "weight_bearing", mobility: "limited", evidence: [] }],
          articulations: [{ side: "left", toes: "relaxed", arch: "neutral", evidence: [] }],
        }),
      ),
    );
    expect(resolved.semanticTags).toContain("restricted_by_footwear");
    expect(resolved.intensityBand).toBe("clear");
  });

  it("never assigns an emotional meaning", () => {
    const resolved = observation(
      footArticulationObservation.resolveFrame(
        frameOf({ coarse: DRY, contact: ARCH_TOUCH, articulations: [{ side: "left", toes: "curled", arch: "neutral", evidence: [] }] }),
      ),
    );
    for (const forbidden of ["pleasure", "tense", "arous", "enjoy", "shy", "eager", "flinch"]) {
      expect(resolved.semanticTags.join(" "), forbidden).not.toContain(forbidden);
    }
  });
});

describe("foot.nail_contact", () => {
  const NAIL_TOUCH: FootContactFixtureInput = { detail: "toenails", locationId: "toenails", pressure: "firm" };

  it("needs the contact to actually name the nail plate", () => {
    const resolved = suppression(
      footNailContact.resolveFrame(
        frameOf({ coarse: DRY, contact: { detail: "toe_pads", locationId: "toes", pressure: "firm" } }),
      ),
    );
    expect(resolved.code).toBe(FOOT_NO_NAIL_CONTACT);
  });

  it("reads a firm edge on a neglected nail and a trace on a pedicured one", () => {
    const neglected = observation(
      footNailContact.resolveFrame(
        frameOf({ coarse: DRY, attributes: { arch: "average", nails: "neglected", toes: "average" }, contact: NAIL_TOUCH }),
      ),
    );
    const pedicured = observation(
      footNailContact.resolveFrame(
        frameOf({ coarse: DRY, attributes: { arch: "average", nails: "pedicured", toes: "average" }, contact: NAIL_TOUCH }),
      ),
    );
    expect(neglected.semanticTags).toEqual([FOOT_FIRM_NAIL_EDGE]);
    expect(pedicured.semanticTags).toEqual([FOOT_LIGHT_NAIL_TRACE]);
  });

  it("reads a trace whenever the press is light, however prominent the edge", () => {
    const resolved = observation(
      footNailContact.resolveFrame(
        frameOf({
          coarse: DRY,
          attributes: { arch: "average", nails: "neglected", toes: "average" },
          contact: { ...NAIL_TOUCH, pressure: "trace" },
        }),
      ),
    );
    expect(resolved.semanticTags).toEqual([FOOT_LIGHT_NAIL_TRACE]);
  });

  it("falls silent when the committed contact states no pressure", () => {
    const resolved = suppression(
      footNailContact.resolveFrame(
        frameOf({ coarse: DRY, contact: { detail: "toenails", locationId: "toenails" } }),
      ),
    );
    expect(resolved.code).toBe(FOOT_PRESSURE_UNKNOWN);
  });

  it("has no vocabulary for a scratch", () => {
    for (const attributes of [{ arch: "flat" }, { arch: "high" }] as const) {
      const resolved = observation(
        footNailContact.resolveFrame(
          frameOf({
            coarse: DRY,
            attributes: { ...attributes, nails: "neglected", toes: "long" },
            contact: NAIL_TOUCH,
          }),
        ),
      );
      expect(resolved.semanticTags.join(" ")).not.toMatch(/scratch|cut|graze|welt/u);
    }
  });
});

describe("the corpus", () => {
  it("registers five phenomena, each under the foot domain", () => {
    expect(footPhenomena.map((phenomenon) => phenomenon.id)).toEqual([
      FOOT_CONTACT_PRESSURE_ID,
      FOOT_SURFACE_TEXTURE_ID,
      FOOT_GLIDE_RESPONSE_ID,
      FOOT_NAIL_CONTACT_ID,
      FOOT_ARTICULATION_ID,
    ]);
  });

  it("declares no phenomenon the slice deferred", () => {
    const ids = footPhenomena.map((phenomenon) => phenomenon.id);
    expect(ids).not.toContain("foot.contact_temperature");
    expect(ids).not.toContain("foot.scent_proximity");
    expect(ids).not.toContain("foot.pressure_mark_surface_state");
    expect(ids).not.toContain("foot.surface_transfer");
  });
});
