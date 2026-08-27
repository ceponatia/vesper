import type { DiagnosticSink } from "../../../diagnostics";
import {
  affordancePerceptionView,
  affordanceSubjectId,
  resolvedAttributeSnapshot,
  type AffordanceCueState,
  type AffordanceExposure,
  type AffordancePerceptionView,
} from "../../core";
import { deriveAffordanceRead, type AffordanceRead } from "../../derive-affordance-read";
import { garmentAffordanceDomain, GARMENT_DOMAIN_ID, type GarmentLanePayload } from "./domain";
import {
  garmentBodyContactSchema,
  garmentRegionState,
  GARMENT_FIT_CONTACT_STRENGTH,
  type GarmentBodyContactRead,
} from "./frame";
import type { GarmentRegionStateRead } from "./mechanics";
import { garmentRegionId, type GarmentFitClass } from "./profile";

/**
 * The garment spec's worked cases, as reusable builders.
 *
 * Fixtures live WITH their domain (the code-organization ruling) because they
 * are calibration evidence, not test scaffolding: the numbers in `mechanics.ts`
 * and the three phenomena were tuned against these cases, and a change that
 * breaks one is a recalibration to argue for, not a failing test to patch.
 *
 * Every case is a complete pair — lane payload plus one observer's perception
 * view — so it drives end to end through `deriveAffordanceRead` exactly as an
 * adapter would. There are no attributes: a garment's structure is the
 * wardrobe's, which is the whole point of this domain.
 */

export interface GarmentFixture {
  readonly payload: GarmentLanePayload;
  readonly perception: AffordancePerceptionView;
}

/** A sighted observer with the named exposures; anything unlisted fails closed. */
export function garmentObserver(exposure: Readonly<Record<string, AffordanceExposure>>): AffordancePerceptionView {
  return affordancePerceptionView({ exposure, channels: { sight: "available" } });
}

/**
 * Drive one garment fixture end to end through the real staged runner — the same
 * entry point a lane adapter calls, so a fixture proves the wiring and not just
 * the arithmetic. `payload` is deliberately `unknown`: passing rubbish (or
 * nothing) is how the degradation cases are expressed.
 */
export function readGarmentAffordances(input: {
  payload: unknown;
  perception: AffordancePerceptionView;
  subjectId?: string;
  storyTime?: number;
  previousCues?: AffordanceCueState;
  sink?: DiagnosticSink;
}): AffordanceRead {
  return deriveAffordanceRead({
    subjectId: affordanceSubjectId(input.subjectId ?? "garment_fixture_subject"),
    storyTime: input.storyTime ?? 0,
    attributes: resolvedAttributeSnapshot([]),
    perception: input.perception,
    domains: [garmentAffordanceDomain],
    payloads: { [GARMENT_DOMAIN_ID]: input.payload },
    ...(input.previousCues === undefined ? {} : { previousCues: input.previousCues }),
    ...(input.sink === undefined ? {} : { sink: input.sink }),
  });
}

/** One worn garment part: structure row + current reading, built together so they cannot drift. */
export function garmentFixtureRegion(input: {
  garmentId: string;
  partId?: string;
  materialClass: string;
  coveredBodyLocations: readonly string[];
  saturation: number;
  fit?: GarmentFitClass;
  sheer?: boolean;
  visibility?: "visible" | "hinted" | "hidden";
}): {
  region: GarmentLanePayload["regions"][number];
  state: GarmentRegionStateRead;
} {
  const partId = input.partId ?? "root";
  return {
    region: {
      garmentId: input.garmentId,
      partId,
      coveredBodyLocations: [...input.coveredBodyLocations],
      materialClass: input.materialClass,
      ...(input.fit === undefined ? {} : { fit: input.fit }),
      ...(input.sheer === undefined ? {} : { sheer: input.sheer }),
    },
    state: garmentRegionState({
      regionId: garmentRegionId(input.garmentId, partId),
      saturation: input.saturation,
      ...(input.visibility === undefined ? {} : { visibility: input.visibility }),
    }),
  };
}

/**
 * A fit-established contact, built through the schema so the fixture cannot
 * hand the domain a strength that a real lane could not have produced.
 */
export function garmentFixtureContact(input: {
  garmentId: string;
  partId?: string;
  bodyLocationId: string;
  mode?: GarmentBodyContactRead["mode"];
  strength?: number;
  basis?: GarmentBodyContactRead["basis"];
}): GarmentBodyContactRead {
  return garmentBodyContactSchema.parse({
    garmentId: input.garmentId,
    regionId: garmentRegionId(input.garmentId, input.partId ?? "root"),
    bodyLocationId: input.bodyLocationId,
    mode: input.mode ?? "fitted",
    strength: input.strength ?? GARMENT_FIT_CONTACT_STRENGTH,
    basis: input.basis ?? "fit",
  });
}

/** Assemble a payload from region pairs, plus whatever live inputs the case asserts. */
export function garmentFixturePayload(
  parts: readonly ReturnType<typeof garmentFixtureRegion>[],
  extra: Omit<Partial<GarmentLanePayload>, "regions" | "state"> = {},
): GarmentLanePayload {
  return {
    regions: parts.map((part) => part.region),
    state: parts.map((part) => part.state),
    ...extra,
  };
}

/**
 * Case 1 — a fitted cotton shirt in the rain.
 *
 * Saturation is high, so the shirt darkens and goes translucent by its authored
 * `wetOpacityResponse`, and its `fitted` regions establish contact from wardrobe
 * truth alone — so wet cling resolves over the back, which is not an intimate
 * location and needs no focus assertion.
 */
export function fittedCottonShirtInRain(): GarmentFixture {
  const shirt = garmentFixtureRegion({
    garmentId: "g_shirt",
    materialClass: "woven_cotton_linen",
    coveredBodyLocations: ["shoulders", "back", "waist"],
    saturation: 9_000,
    fit: "fitted",
  });
  return {
    payload: garmentFixturePayload([shirt], {
      contacts: [garmentFixtureContact({ garmentId: "g_shirt", bodyLocationId: "back" })],
      events: [{ kind: "rain_exposure", atStoryTime: 4 }],
    }),
    perception: garmentObserver({ shoulders: "visible", back: "visible", waist: "visible" }),
  };
}

/**
 * Case 2 — a leather jacket in the SAME rain.
 *
 * Identical exposure, materially different read: leather barely absorbs, so the
 * water stays on the surface (beading/runoff), its opacity does not move, and
 * nothing clings. This is the acceptance test "wet cotton and wet leather
 * produce materially different observations", as a fixture.
 */
export function leatherJacketInRain(): GarmentFixture {
  const jacket = garmentFixtureRegion({
    garmentId: "g_jacket",
    materialClass: "leather",
    coveredBodyLocations: ["shoulders", "back", "upper_arms"],
    // The same rain, integrated through leather's own absorbency: a shirt would
    // be soaked where a jacket has barely taken any water up at all.
    saturation: 2_000,
    fit: "fitted",
  });
  return {
    payload: garmentFixturePayload([jacket], {
      contacts: [garmentFixtureContact({ garmentId: "g_jacket", bodyLocationId: "back" })],
      events: [{ kind: "rain_exposure", atStoryTime: 4 }],
    }),
    perception: garmentObserver({ shoulders: "visible", back: "visible", upper_arms: "visible" }),
  };
}

/**
 * Case 3 — a soaked LOOSE skirt: the wind case minus its wind.
 *
 * The mechanics half of that case still holds and is tested: water loading has
 * raised `effectiveFlutterLoad` and dropped `effectiveDrapeStiffness`.
 * What is missing is the force — no lane owns wind or motion, so
 * `garment.wind_or_motion_response` is not registered and nothing here narrates
 * movement.
 *
 * `contacts: []` is deliberate and is the LOOSE half of the establishment law: a
 * lane that CAN answer the contact question answers "none", because a loose
 * garment establishes nothing from fit and no pose or pressure is asserted. That
 * is a different silence from a lane with no contact owner at all, which omits
 * the key entirely and is suppressed by the core instead.
 */
export function soakedLooseSkirt(): GarmentFixture {
  const skirt = garmentFixtureRegion({
    garmentId: "g_skirt",
    materialClass: "knit",
    coveredBodyLocations: ["thighs"],
    saturation: 8_500,
    fit: "loose",
  });
  return {
    payload: garmentFixturePayload([skirt], {
      contacts: [],
      events: [{ kind: "rain_exposure", atStoryTime: 2 }],
    }),
    perception: garmentObserver({ thighs: "visible" }),
  };
}

/**
 * Case 4 — a soaked sheer camisole buried under a dry opaque coat.
 *
 * Two laws in one fixture: the camisole's own reads are dropped because the
 * wardrobe says it is buried, and the captured coverage read still calls the
 * chest OPAQUE, because layers add cover and never subtract it. A see-through
 * under-layer must not undress anyone.
 */
export function soakedCamisoleUnderCoat(): GarmentFixture {
  const camisole = garmentFixtureRegion({
    garmentId: "g_camisole",
    materialClass: "silk_satin",
    coveredBodyLocations: ["chest"],
    saturation: 9_500,
    fit: "tight",
    sheer: true,
    visibility: "hidden",
  });
  const coat = garmentFixtureRegion({
    garmentId: "g_coat",
    materialClass: "wool",
    coveredBodyLocations: ["chest", "back"],
    saturation: 0,
    fit: "loose",
  });
  return {
    payload: garmentFixturePayload([camisole, coat]),
    perception: garmentObserver({ chest: "visible", back: "visible" }),
  };
}

/** The worked cases, keyed by the spec's own headings. */
export const garmentWorkedCases = {
  fittedCottonShirtInRain,
  leatherJacketInRain,
  soakedLooseSkirt,
  soakedCamisoleUnderCoat,
} as const;
