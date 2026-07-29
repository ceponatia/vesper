import { describe, expect, it } from "vitest";
import { bodyLocationRegistry } from "../../../body/locations";
import {
  affordancePerceptionView,
  AFFORDANCE_INPUT_UNAVAILABLE,
  AFFORDANCE_INTENSITY_WEIGHT,
  AFFORDANCE_PERCEPTION_HIDDEN,
  type AffordanceExposure,
  type AffordanceObservation,
  type AffordancePerceptionView,
} from "../../core";
import type { AffordanceRead } from "../../derive-affordance-read";
import {
  hairConditionValues,
  hairStrandThicknessValues,
  hairTextureValues,
  type HairConditionValue,
  type HairDensityValue,
  type HairLengthValue,
  type HairStrandThicknessValue,
  type HairTextureValue,
} from "./attribute-maps";
import type { HairArrangement } from "./mechanics";
import type { HairLanePayload } from "./domain";
import { hairRainEventKinds, isHairRainEvent } from "./frame";
import {
  hairAttributeFixture,
  readHairAffordances,
  saturatedDenseNeckContact,
  type HairFixture,
} from "./fixtures";
import { HAIR_SHEDS_DROPLETS_ID } from "./phenomena/droplet-shedding";
import { HAIR_SKIN_ADHESION_ID } from "./phenomena/skin-adhesion";
import { HAIR_WET_CLUMPING_ID } from "./phenomena/wet-clumping";
import { HAIR_WIND_OR_MOTION_ID } from "./phenomena/wind-motion";

/**
 * Stage 4: the four phenomena, driven through the real staged runner.
 *
 * Every case here is about CAUSE. A phenomenon that has capacity but no current
 * force, no asserted contact, or no committed impulse must fall silent with a
 * reason — the plan's whole premise is that a missing cause never produces an
 * effect, and an attractive-sounding read is exactly the one worth suppressing.
 */

/** A fully sighted observer: perception is not the subject of these tests. */
const SEEN_EVERYWHERE: AffordancePerceptionView = affordancePerceptionView({
  exposure: Object.fromEntries(
    bodyLocationRegistry.all.map((location) => [location.id, "visible" as AffordanceExposure]),
  ),
  channels: { sight: "available" },
});

interface HairStructureInput {
  readonly length?: HairLengthValue;
  readonly density?: HairDensityValue;
  readonly strandThickness?: HairStrandThicknessValue;
  readonly texture?: HairTextureValue;
  readonly condition?: HairConditionValue;
  readonly arrangement?: HairArrangement;
}

/** Saturated, dense, coarse — the flagship "resists the breeze" material. */
function attributesFor(structure: HairStructureInput = {}) {
  return hairAttributeFixture({
    length: structure.length ?? "shoulder_length",
    density: structure.density ?? "dense",
    strandThickness: structure.strandThickness ?? "thick",
    texture: structure.texture ?? "wavy",
    condition: structure.condition ?? "healthy",
    arrangement: structure.arrangement ?? "loose",
  });
}

function payloadFor(overrides: Partial<HairLanePayload> = {}): HairLanePayload {
  return { wetness: 9_500, coveredFraction: 0, contacts: [], events: [], ...overrides };
}

function read(input: { structure?: HairStructureInput; payload?: unknown } = {}): AffordanceRead {
  return readHairAffordances({
    attributes: attributesFor(input.structure),
    payload: input.payload ?? payloadFor(),
    perception: SEEN_EVERYWHERE,
  });
}

function readFixture(fixture: HairFixture): AffordanceRead {
  return readHairAffordances({
    attributes: fixture.attributes,
    payload: fixture.payload,
    perception: fixture.perception,
  });
}

const observed = (result: AffordanceRead, id: string): AffordanceObservation | undefined =>
  result.observations.find((observation) => observation.id === id);

const suppressedCode = (result: AffordanceRead, id: string): string | undefined =>
  result.suppressed.find((entry) => entry.phenomenonId === id)?.code;

/** Band weight, with silence as zero — lets a law be stated as "never rises". */
const weight = (observation: AffordanceObservation | undefined): number =>
  observation === undefined ? 0 : AFFORDANCE_INTENSITY_WEIGHT[observation.intensityBand];

// ---------------------------------------------------------------------------
// hair.wet_clumping
// ---------------------------------------------------------------------------

describe("hair.wet_clumping", () => {
  it("stays silent on dry hair", () => {
    const result = read({ payload: payloadFor({ wetness: 0 }) });
    expect(suppressedCode(result, HAIR_WET_CLUMPING_ID)).toBe("insufficient_wetness");
  });

  it("stays silent when barely damp hair cannot gather", () => {
    const result = read({
      structure: { density: "sparse", strandThickness: "fine", texture: "straight", condition: "silky" },
      payload: payloadFor({ wetness: 2_500 }),
    });
    expect(suppressedCode(result, HAIR_WET_CLUMPING_ID)).toBe("below_response_threshold");
  });

  it("resolves distinct strands on saturated dense hair, with the spec's descriptors", () => {
    const observation = observed(read(), HAIR_WET_CLUMPING_ID);
    expect(observation?.intensityBand).toBe("clear");
    expect(observation?.sourceLocationId).toBe("hair");
    expect(observation?.repeatKey).toBe("hair:clumping");
    expect(observation?.semanticTags).toEqual([
      "distinct_strands",
      "wet_darkened_relative_to_base",
      "retains_droplets",
      "loose_strands",
    ]);
  });

  it("attaches a rain cause ONLY when a committed rain event supports it", () => {
    const withRain = observed(read({ payload: payloadFor({ events: [{ kind: "rain_exposure", atStoryTime: 3 }] }) }), HAIR_WET_CLUMPING_ID);
    expect(withRain?.semanticTags).toContain("recent_rain");

    // Equally wet, but nothing in the frame says weather.
    const withSplash = observed(read({ payload: payloadFor({ events: [{ kind: "splash", atStoryTime: 3 }] }) }), HAIR_WET_CLUMPING_ID);
    expect(withSplash?.semanticTags).not.toContain("recent_rain");
    expect(observed(read(), HAIR_WET_CLUMPING_ID)?.semanticTags).not.toContain("recent_rain");
  });

  it("wets the hair on immersion WITHOUT calling it rain — a bath is not weather", () => {
    const bathed = observed(
      read({ payload: payloadFor({ events: [{ kind: "immersion", atStoryTime: 3 }] }) }),
      HAIR_WET_CLUMPING_ID,
    );
    // The wet read itself is unaffected: immersion is a real wetting event.
    expect(bathed?.intensityBand).toBe("clear");
    expect(bathed?.semanticTags).toContain("wet_darkened_relative_to_base");
    // ...but it licenses no cause, so the narrator cannot say "wet from the rain".
    expect(bathed?.semanticTags).not.toContain("recent_rain");
    // The ONLY difference from the causeless case is that there is no difference.
    expect(bathed?.semanticTags).toEqual(observed(read(), HAIR_WET_CLUMPING_ID)?.semanticTags);
  });

  it("names rain_exposure as the only rain-licensing event kind", () => {
    expect(hairRainEventKinds).toEqual(["rain_exposure"]);
    expect(isHairRainEvent({ kind: "immersion", atStoryTime: 3 })).toBe(false);
    expect(isHairRainEvent({ kind: "splash", atStoryTime: 3 })).toBe(false);
    expect(isHairRainEvent({ kind: "rain_exposure", atStoryTime: 3 })).toBe(true);
  });

  it("reads a braid as one bound mass and loose hair as strands", () => {
    expect(observed(read({ structure: { arrangement: "braid" } }), HAIR_WET_CLUMPING_ID)?.semanticTags).toContain("bound_mass");
    expect(observed(read(), HAIR_WET_CLUMPING_ID)?.semanticTags).toContain("loose_strands");
  });

  it("notes defined curls only where the texture holds them", () => {
    expect(observed(read({ structure: { texture: "coily" } }), HAIR_WET_CLUMPING_ID)?.semanticTags).toContain("defined_curls");
    expect(observed(read({ structure: { texture: "straight" } }), HAIR_WET_CLUMPING_ID)?.semanticTags).not.toContain("defined_curls");
  });

  it("notes contamination when the lane reports it, and never invents it", () => {
    const dirty = read({ payload: payloadFor({ contamination: { level: 5_000, kind: "mud" } }) });
    expect(observed(dirty, HAIR_WET_CLUMPING_ID)?.semanticTags).toContain("contaminated");
    expect(observed(read(), HAIR_WET_CLUMPING_ID)?.semanticTags).not.toContain("contaminated");
  });
});

// ---------------------------------------------------------------------------
// hair.wind_or_motion_response
// ---------------------------------------------------------------------------

describe("hair.wind_or_motion_response", () => {
  const DRY_FINE = { density: "sparse", strandThickness: "fine", texture: "straight", condition: "silky" } as const;

  it("no force input at all produces no motion observation", () => {
    const result = read({ structure: DRY_FINE, payload: payloadFor({ wetness: 0 }) });
    expect(suppressedCode(result, HAIR_WIND_OR_MOTION_ID)).toBe("no_current_force");
    expect(observed(result, HAIR_WIND_OR_MOTION_ID)).toBeUndefined();
  });

  it("a present-but-zero force is still no force", () => {
    const result = read({ structure: DRY_FINE, payload: payloadFor({ wetness: 0, wind: { force: 0 } }) });
    expect(suppressedCode(result, HAIR_WIND_OR_MOTION_ID)).toBe("no_current_force");
  });

  it("dry, fine, loose hair in a moderate breeze reads clear whole-hair motion", () => {
    const observation = observed(
      read({ structure: DRY_FINE, payload: payloadFor({ wetness: 0, wind: { force: 5_000 } }) }),
      HAIR_WIND_OR_MOTION_ID,
    );
    expect(observation?.intensityBand).toBe("clear");
    expect(observation?.repeatKey).toBe("hair:motion");
    expect(observation?.semanticTags).toContain("whole_hair");
  });

  it("body motion alone is a cause, with no wind read at all", () => {
    const observation = observed(
      read({ structure: DRY_FINE, payload: payloadFor({ wetness: 0, motion: { force: 5_000 } }) }),
      HAIR_WIND_OR_MOTION_ID,
    );
    expect(observation?.intensityBand).toBe("clear");
  });

  it("saturated hair in a light breeze is suppressed as water-loaded", () => {
    const result = read({ payload: payloadFor({ wind: { force: 1_500 } }) });
    expect(suppressedCode(result, HAIR_WIND_OR_MOTION_ID)).toBe("water_loaded");
  });

  it("names the constraint that actually holds the bulk still", () => {
    const dryBreeze = (arrangement: HairArrangement, coveredFraction = 0) =>
      suppressedCode(
        read({
          structure: { ...DRY_FINE, arrangement },
          payload: payloadFor({ wetness: 0, coveredFraction, wind: { force: 5_000 } }),
        }),
        HAIR_WIND_OR_MOTION_ID,
      );
    expect(dryBreeze("braid")).toBe("bound");
    expect(dryBreeze("ponytail")).toBe("bound");
    // A bun is both; "pinned against the head" is the more specific reason.
    expect(dryBreeze("bun")).toBe("pinned");
    expect(dryBreeze("loose", 6_000)).toBe("covered");
  });

  it("wet dense hair in light wind NEVER produces whole-hair flight", () => {
    for (const condition of hairConditionValues) {
      for (const strandThickness of hairStrandThicknessValues) {
        for (const texture of hairTextureValues) {
          const result = read({
            structure: { density: "dense", condition, strandThickness, texture },
            payload: payloadFor({ wetness: 8_000, wind: { force: 2_000 } }),
          });
          expect(
            observed(result, HAIR_WIND_OR_MOTION_ID),
            `${condition}/${strandThickness}/${texture} flew while soaked`,
          ).toBeUndefined();
          expect(suppressedCode(result, HAIR_WIND_OR_MOTION_ID)).toBe("water_loaded");
        }
      }
    }
  });

  it("wetness never strengthens the response — swept up the wetness ladder", () => {
    let previous = Number.POSITIVE_INFINITY;
    for (const wetness of [0, 2_000, 4_000, 6_000, 8_000, 10_000]) {
      const result = read({ structure: DRY_FINE, payload: payloadFor({ wetness, wind: { force: 5_000 } }) });
      const current = weight(observed(result, HAIR_WIND_OR_MOTION_ID));
      expect(current, `wetness ${wetness} strengthened the read`).toBeLessThanOrEqual(previous);
      previous = current;
    }
  });

  it("a strong gust stirs exposed ends while the constrained bulk stays put", () => {
    const result = read({
      structure: { length: "mid_back", condition: "dry" },
      payload: payloadFor({ wetness: 5_000, coveredFraction: 6_000, looseEndLengthBand: "long", wind: { force: 8_500 } }),
    });
    const observation = observed(result, HAIR_WIND_OR_MOTION_ID);
    expect(observation?.intensityBand).toBe("subtle");
    expect(observation?.repeatKey).toBe("hair:motion:ends");
    expect(observation?.semanticTags).toEqual(["exposed_ends", "stirs", "ends_long"]);
    // Distinct from the whole-hair read in both tags and anti-repeat identity.
    expect(observation?.semanticTags).not.toContain("whole_hair");
  });

  it("a light breeze on the same constrained hair says nothing at all", () => {
    const result = read({
      structure: { length: "mid_back", condition: "dry" },
      payload: payloadFor({ wetness: 5_000, coveredFraction: 6_000, looseEndLengthBand: "long", wind: { force: 2_000 } }),
    });
    expect(observed(result, HAIR_WIND_OR_MOTION_ID)).toBeUndefined();
    expect(suppressedCode(result, HAIR_WIND_OR_MOTION_ID)).toBe("covered");
  });
});

// ---------------------------------------------------------------------------
// hair.strands_adhere_to_skin
// ---------------------------------------------------------------------------

describe("hair.strands_adhere_to_skin", () => {
  it("a lane with no contact owner suppresses it in the core — reach never invents contact", () => {
    const result = read({ payload: { wetness: 9_500, coveredFraction: 0, events: [] } });
    expect(suppressedCode(result, HAIR_SKIN_ADHESION_ID)).toBe(AFFORDANCE_INPUT_UNAVAILABLE);
    expect(observed(result, HAIR_SKIN_ADHESION_ID)).toBeUndefined();
  });

  it("an answered 'nothing is touching' is its own, different silence", () => {
    expect(suppressedCode(read(), HAIR_SKIN_ADHESION_ID)).toBe("no_asserted_contact");
  });

  it("a contact beyond nominal reach is out of reach, not adhesion", () => {
    const result = read({ payload: payloadFor({ contacts: [{ sourceLocationId: "hair", targetLocationId: "thighs" }] }) });
    expect(suppressedCode(result, HAIR_SKIN_ADHESION_ID)).toBe("target_out_of_reach");
    // The same contact IS in reach for hair long enough to arrive there.
    const longer = read({
      structure: { length: "feet_length" },
      payload: payloadFor({ contacts: [{ sourceLocationId: "hair", targetLocationId: "thighs" }] }),
    });
    expect(observed(longer, HAIR_SKIN_ADHESION_ID)?.targetLocationId).toBe("thighs");
  });

  it("dry hair in contact does not cling", () => {
    const result = read({
      payload: payloadFor({ wetness: 0, contacts: [{ sourceLocationId: "hair", targetLocationId: "neck" }] }),
    });
    expect(suppressedCode(result, HAIR_SKIN_ADHESION_ID)).toBe("insufficient_wetness");
  });

  it("a braid has no loose strands to cling with", () => {
    const result = read({
      structure: { arrangement: "braid" },
      payload: payloadFor({ contacts: [{ sourceLocationId: "hair", targetLocationId: "neck" }] }),
    });
    expect(suppressedCode(result, HAIR_SKIN_ADHESION_ID)).toBe("bound");
  });

  it("saturated loose hair against an exposed neck resolves the spec's read", () => {
    const observation = observed(readFixture(saturatedDenseNeckContact()), HAIR_SKIN_ADHESION_ID);
    expect(observation).toEqual({
      kind: "observation",
      id: "hair.strands_adhere_to_skin",
      sourceLocationId: "hair",
      targetLocationId: "neck",
      intensityBand: "clear",
      semanticTags: ["damp", "clumped", "several_strands"],
      repeatKey: "hair:adhesion:neck",
    });
  });

  it("picks the same target however the lane ordered the contacts", () => {
    const contacts = [
      { sourceLocationId: "hair", targetLocationId: "shoulders" },
      { sourceLocationId: "hair", targetLocationId: "neck" },
    ];
    const forward = observed(read({ payload: payloadFor({ contacts }) }), HAIR_SKIN_ADHESION_ID);
    const reversed = observed(read({ payload: payloadFor({ contacts: [...contacts].reverse() }) }), HAIR_SKIN_ADHESION_ID);
    expect(forward?.targetLocationId).toBe("neck");
    expect(reversed).toEqual(forward);
  });

  it("ignores contacts that do not start at the hair", () => {
    const result = read({ payload: payloadFor({ contacts: [{ sourceLocationId: "hands", targetLocationId: "neck" }] }) });
    expect(suppressedCode(result, HAIR_SKIN_ADHESION_ID)).toBe("no_asserted_contact");
  });

  it("stays physically true behind opaque coverage — perception hides it, physics does not erase it", () => {
    const fixture = saturatedDenseNeckContact();
    const hidden = readHairAffordances({
      attributes: fixture.attributes,
      payload: fixture.payload,
      perception: affordancePerceptionView({
        exposure: { hair: "visible", neck: "hidden" },
        channels: { sight: "available" },
      }),
    });
    expect(observed(hidden, HAIR_SKIN_ADHESION_ID)).toBeUndefined();
    expect(hidden.suppressed).toContainEqual({
      kind: "suppressed",
      phenomenonId: HAIR_SKIN_ADHESION_ID,
      code: AFFORDANCE_PERCEPTION_HIDDEN,
      detail: "neck",
    });
    expect(hidden.cues.map((cue) => cue.repeatKey)).not.toContain("hair:adhesion:neck");
  });
});

// ---------------------------------------------------------------------------
// hair.sheds_droplets
// ---------------------------------------------------------------------------

describe("hair.sheds_droplets", () => {
  it("a lane with no impulse owner suppresses it in the core", () => {
    const result = read({ payload: { wetness: 9_500, coveredFraction: 0, contacts: [] } });
    expect(suppressedCode(result, HAIR_SHEDS_DROPLETS_ID)).toBe(AFFORDANCE_INPUT_UNAVAILABLE);
  });

  it("retained water without an impulse produces no shedding observation", () => {
    expect(suppressedCode(read(), HAIR_SHEDS_DROPLETS_ID)).toBe("no_current_impulse");
    const rained = read({ payload: payloadFor({ events: [{ kind: "rain_exposure", atStoryTime: 2 }] }) });
    expect(suppressedCode(rained, HAIR_SHEDS_DROPLETS_ID)).toBe("no_current_impulse");
  });

  it("an impulse with nothing to shed stays silent", () => {
    const result = read({ payload: payloadFor({ wetness: 0, events: [{ kind: "shake", atStoryTime: 2 }] }) });
    expect(suppressedCode(result, HAIR_SHEDS_DROPLETS_ID)).toBe("insufficient_wetness");
  });

  it("bound hair cannot whip water loose", () => {
    const result = read({
      structure: { arrangement: "braid" },
      payload: payloadFor({ events: [{ kind: "shake", atStoryTime: 2 }] }),
    });
    expect(suppressedCode(result, HAIR_SHEDS_DROPLETS_ID)).toBe("bound");
  });

  it("a committed impulse on soaked loose hair sheds, and cites its cause", () => {
    const observation = observed(
      read({ payload: payloadFor({ events: [{ kind: "shake", atStoryTime: 2 }] }) }),
      HAIR_SHEDS_DROPLETS_ID,
    );
    expect(observation?.intensityBand).toBe("clear");
    expect(observation?.repeatKey).toBe("hair:droplets");
    expect(observation?.semanticTags).toEqual(["droplets", "scatters", "caused_by_shake"]);
  });

  it("cites the most recent impulse regardless of the order events arrived in", () => {
    const events = [
      { kind: "run", atStoryTime: 1 },
      { kind: "impact", atStoryTime: 7 },
    ] as const;
    const forward = observed(read({ payload: payloadFor({ events: [...events] }) }), HAIR_SHEDS_DROPLETS_ID);
    const reversed = observed(read({ payload: payloadFor({ events: [...events].reverse() }) }), HAIR_SHEDS_DROPLETS_ID);
    expect(forward?.semanticTags).toContain("caused_by_impact");
    expect(reversed).toEqual(forward);
  });

  it("describes shedding without touching authoritative wetness", () => {
    const payload = payloadFor({ events: [{ kind: "shake", atStoryTime: 2 }] });
    const snapshot = JSON.stringify(payload);
    const first = read({ payload });
    const second = read({ payload });
    expect(JSON.stringify(payload)).toBe(snapshot);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });
});
