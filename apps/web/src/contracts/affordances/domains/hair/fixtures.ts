import type { DiagnosticSink } from "../../../diagnostics";
import type { AttributeValue } from "../../../attributes";
import {
  affordancePerceptionView,
  affordanceSubjectId,
  resolvedAttributeSnapshot,
  type AffordanceCueState,
  type AffordanceExposure,
  type AffordancePerceptionView,
} from "../../core";
import { deriveAffordanceRead, type AffordanceRead } from "../../derive-affordance-read";
import type {
  HairConditionValue,
  HairDensityValue,
  HairLengthValue,
  HairStrandThicknessValue,
  HairTextureValue,
} from "./attribute-maps";
import type { HairArrangement } from "./mechanics";
import { hairAffordanceDomain, HAIR_DOMAIN_ID, type HairLanePayload } from "./domain";

/**
 * The hair spec's four worked cases, as reusable builders.
 *
 * Fixtures live WITH their domain (the code-organization ruling) because they
 * are calibration evidence, not test scaffolding: these four cases are what the
 * numbers in `attribute-maps/`, `mechanics.ts`, and the phenomena were tuned
 * against, and a change that breaks one of them is a recalibration, not a
 * failing test to be patched.
 *
 * Every case is a complete triple — canonical attributes, lane payload, and one
 * observer's perception view — so it can be driven end to end through
 * `deriveAffordanceRead` exactly as a lane adapter would.
 */

export interface HairFixture {
  readonly attributes: readonly AttributeValue[];
  readonly payload: HairLanePayload;
  readonly perception: AffordancePerceptionView;
}

export interface HairAttributeFixtureInput {
  readonly length: HairLengthValue;
  readonly density: HairDensityValue;
  readonly strandThickness: HairStrandThicknessValue;
  readonly texture: HairTextureValue;
  readonly condition: HairConditionValue;
  readonly arrangement: HairArrangement;
  readonly color?: string;
}

/** The six authored hair attributes a complete hair read needs. */
export function hairAttributeFixture(input: HairAttributeFixtureInput): AttributeValue[] {
  return [
    { id: "hair.length", value: input.length, source: "creation" },
    { id: "hair.density", value: input.density, source: "creation" },
    { id: "hair.strand_thickness", value: input.strandThickness, source: "creation" },
    { id: "hair.texture", value: input.texture, source: "creation" },
    { id: "hair.condition", value: input.condition, source: "creation" },
    { id: "hair.arrangement", value: input.arrangement, source: "creation" },
    // Cue-realization metadata only — present to prove it never reaches mechanics.
    { id: "hair.color", value: input.color ?? "blonde", source: "creation" },
  ];
}

/** A sighted observer with the named exposures; anything unlisted fails closed. */
export function hairObserver(exposure: Readonly<Record<string, AffordanceExposure>>): AffordancePerceptionView {
  return affordancePerceptionView({ exposure, channels: { sight: "available" } });
}

/**
 * Drive one hair fixture end to end through the real staged runner — the same
 * entry point a lane adapter calls, so a fixture proves the wiring and not just
 * the arithmetic. `payload` is deliberately `unknown`: passing rubbish (or
 * nothing) is how the degradation cases are expressed.
 */
export function readHairAffordances(input: {
  attributes: readonly AttributeValue[];
  payload: unknown;
  perception: AffordancePerceptionView;
  subjectId?: string;
  storyTime?: number;
  previousCues?: AffordanceCueState;
  sink?: DiagnosticSink;
}): AffordanceRead {
  return deriveAffordanceRead({
    subjectId: affordanceSubjectId(input.subjectId ?? "hair_fixture_subject"),
    storyTime: input.storyTime ?? 0,
    attributes: resolvedAttributeSnapshot([...input.attributes]),
    perception: input.perception,
    domains: [hairAffordanceDomain],
    payloads: { [HAIR_DOMAIN_ID]: input.payload },
    ...(input.previousCues === undefined ? {} : { previousCues: input.previousCues }),
    ...(input.sink === undefined ? {} : { sink: input.sink }),
  });
}

/**
 * Case 1 — dry, fine, shoulder-length, loose; moderate breeze.
 *
 * Low effective load and a free-moving head of hair support a clear motion
 * read; nothing is wet, and no contact is asserted.
 */
export function dryFineLooseInBreeze(): HairFixture {
  return {
    attributes: hairAttributeFixture({
      length: "shoulder_length",
      density: "sparse",
      strandThickness: "fine",
      texture: "straight",
      condition: "silky",
      arrangement: "loose",
    }),
    payload: {
      wetness: 0,
      coveredFraction: 0,
      wind: { force: 5_000 },
      // Both lanes CAN answer here; the answer is "nothing".
      contacts: [],
      events: [],
    },
    perception: hairObserver({ hair: "visible", neck: "visible" }),
  };
}

/**
 * Case 2 — saturated, dense/coarse, shoulder-length; light breeze; exposed neck
 * contact after rain.
 *
 * Water load suppresses whole-hair wind motion, clumping resolves, the asserted
 * neck contact licenses adhesion, and the rain provenance appears only because
 * the exposure event is in the frame.
 */
export function saturatedDenseNeckContact(): HairFixture {
  return {
    attributes: hairAttributeFixture({
      length: "shoulder_length",
      density: "dense",
      strandThickness: "thick",
      texture: "wavy",
      condition: "healthy",
      arrangement: "loose",
    }),
    payload: {
      wetness: 9_500,
      coveredFraction: 0,
      wind: { force: 1_500 },
      contacts: [{ sourceLocationId: "hair", targetLocationId: "neck" }],
      events: [{ kind: "rain_exposure", atStoryTime: 4 }],
    },
    perception: hairObserver({ hair: "visible", neck: "visible" }),
  };
}

/**
 * Case 3 — the same saturated hair braided under a hood.
 *
 * Binding and coverage collapse the free-moving fraction, so visible motion is
 * suppressed and the asserted neck contact produces no cue — neither because
 * reach made it possible nor because the hair is wet.
 */
export function braidedUnderHood(): HairFixture {
  return {
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
      coveredFraction: 9_000,
      wind: { force: 1_500 },
      contacts: [{ sourceLocationId: "hair", targetLocationId: "neck" }],
      events: [{ kind: "rain_exposure", atStoryTime: 4 }],
    },
    perception: hairObserver({ hair: "hidden", neck: "hidden" }),
  };
}

/**
 * Case 4 — damp thick hair, strong gust, loose ends below a hood.
 *
 * The covered bulk stays constrained while the exposed ends stir. The read is
 * ends-only and carries its own tags and repeat key, so it cannot be narrated as
 * the whole style flying free.
 */
export function dampThickGustLooseEnds(): HairFixture {
  return {
    attributes: hairAttributeFixture({
      length: "mid_back",
      density: "dense",
      strandThickness: "thick",
      texture: "wavy",
      condition: "dry",
      arrangement: "loose",
    }),
    payload: {
      wetness: 5_000,
      coveredFraction: 6_000,
      looseEndLengthBand: "long",
      wind: { force: 8_500 },
      contacts: [],
      events: [{ kind: "gust", atStoryTime: 9 }],
    },
    // The hood covers the bulk (mechanics); what this observer sees is the ends.
    perception: hairObserver({ hair: "visible", neck: "visible" }),
  };
}

/** The four worked cases, keyed by the spec's own headings. */
export const hairWorkedCases = {
  dryFineLooseInBreeze,
  saturatedDenseNeckContact,
  braidedUnderHood,
  dampThickGustLooseEnds,
} as const;
