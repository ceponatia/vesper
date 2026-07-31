import type { DiagnosticSink } from "../../../diagnostics";
import type { AttributeValue } from "../../../attributes";
import {
  commitContactResolution,
  contactEventRef,
  emptyContactLifecycleState,
  resolveContactAttempt,
  type CommittedContactRead,
  type ContactActionKind,
  type ContactAreaBand,
  type ContactMaterialLayerRead,
  type ContactMotionBand,
  type ContactPressureBand,
  type ContactSurfaceSide,
} from "../../contact";
import {
  adapterSupported,
  affordancePerceptionView,
  affordanceSubjectId,
  resolvedAttributeSnapshot,
  toUnitInterval,
  type AffordanceCueState,
  type AffordanceExposure,
  type AffordancePerceptionView,
  type AffordanceSubjectId,
} from "../../core";
import { deriveAffordanceRead, type AffordanceRead } from "../../derive-affordance-read";
import type { FootArchValue, FootNailValue, FootToeValue } from "./attribute-maps";
import type { FootCoarseConditionRead } from "./condition";
import { footAffordanceDomain, FOOT_DOMAIN_ID, type FootLanePayload } from "./domain";
import type { FootwearItemRead } from "./footwear";
import type { FootSurfaceId } from "./topology";

/**
 * The foot spec's calibration fixture and the slice-2 half of its fixture matrix,
 * as reusable builders.
 *
 * Fixtures live WITH their domain because they are calibration evidence, not test
 * scaffolding: the numbers in `attribute-maps.ts`, `profile.ts`, and `friction.ts`
 * were tuned against these cases, and a change that breaks one is a
 * recalibration, not a failing test to be patched.
 *
 * Every case supplies its geometry EXPLICITLY. That is not convenience — the
 * truth-source audit records that no lane owns reach, so a fixture that let the
 * resolver infer a position would be testing a capability the product does not
 * have.
 *
 * Every committed contact is built by running the real slice-1 gate
 * (`resolveContactAttempt` → `commitContactResolution`), so a fixture proves the
 * wiring and not just the arithmetic — and a contact that the gate would refuse
 * cannot be smuggled into a foot read by hand.
 */

export const FOOT_FIXTURE_SUBJECT = affordanceSubjectId("foot_fixture_subject");
export const FOOT_FIXTURE_ACTOR = affordanceSubjectId("foot_fixture_actor");

export interface FootFixture {
  readonly attributes: readonly AttributeValue[];
  readonly payload: FootLanePayload;
  readonly perception: AffordancePerceptionView;
}

export interface FootAttributeFixtureInput {
  readonly arch: FootArchValue;
  readonly nails: FootNailValue;
  readonly toes: FootToeValue;
  readonly size?: string;
}

/** The three authored attributes a complete foot read needs, plus one it must ignore. */
export function footAttributeFixture(input: FootAttributeFixtureInput): AttributeValue[] {
  return [
    { id: "feet.arch", value: input.arch, source: "creation" },
    { id: "feet.nails", value: input.nails, source: "creation" },
    { id: "feet.toes", value: input.toes, source: "creation" },
    // Present to prove it never reaches mechanics: no axis maps it.
    { id: "feet.size", value: input.size ?? "average", source: "creation" },
  ];
}

/** Every foot locus visible to a sighted observer; anything unlisted fails closed. */
export function footObserver(
  overrides: Readonly<Record<string, AffordanceExposure>> = {},
): AffordancePerceptionView {
  return affordancePerceptionView({
    exposure: {
      feet: "visible",
      sole: "visible",
      heel: "visible",
      toes: "visible",
      top_of_foot: "visible",
      ankles: "visible",
      ...overrides,
    },
    channels: { sight: "available", touch: "available" },
  });
}

// ---------------------------------------------------------------------------
// Committed contact
// ---------------------------------------------------------------------------

export interface FootContactFixtureInput {
  readonly detail: FootSurfaceId;
  readonly locationId: string;
  readonly side?: ContactSurfaceSide;
  readonly actionKind?: ContactActionKind;
  readonly pressure?: ContactPressureBand;
  readonly area?: ContactAreaBand;
  readonly motion?: ContactMotionBand;
  readonly path?: readonly FootSurfaceId[];
  readonly layers?: readonly ContactMaterialLayerRead[];
  readonly eventId?: string;
  readonly storyTime?: number;
}

/**
 * A palm on a foot, resolved and committed through the real contact gate.
 *
 * The action kind is `affectionate` by default: it needs no adult-eligibility
 * proof and no permission owner, both of which legacy chat cannot produce. That
 * is the ruled starting point, not a stand-in — the owner ruled 2026-07-30
 * (romantic-contact-affordances.audit.md §"Owner decisions needed" 1) that
 * romantic contact is NEVER relabeled to make a trial commit, and that a
 * genuinely affectionate case is the right first integration. A fixture asking
 * for `romantic` is refused by the gate — correctly, and that refusal is itself
 * worth a test.
 *
 * Throws on a non-committable resolution: a fixture that cannot produce the
 * contact it claims is a bug in the fixture, not degraded runtime data.
 */
export function committedFootContact(input: FootContactFixtureInput): CommittedContactRead {
  const resolution = resolveContactAttempt({
    intent: {
      actionId: `foot_fixture_${input.detail}`,
      actorId: FOOT_FIXTURE_ACTOR,
      source: { kind: "body", subjectId: FOOT_FIXTURE_ACTOR, locationId: "hands" },
      target: {
        kind: "body",
        subjectId: FOOT_FIXTURE_SUBJECT,
        locationId: input.locationId,
        ...(input.side === undefined ? {} : { side: input.side }),
        detail: input.detail,
      },
      actionKind: input.actionKind ?? "affectionate",
      access: "any_material",
      ...(input.pressure === undefined ? {} : { requestedPressure: input.pressure }),
      ...(input.area === undefined ? {} : { requestedArea: input.area }),
      ...(input.motion === undefined
        ? {}
        : { requestedMotion: { band: input.motion, ...(input.path === undefined ? {} : { pathDetailIds: input.path }) } }),
      storyTime: input.storyTime ?? 100,
    },
    context: {
      actorControl: { status: "allowed", actorId: FOOT_FIXTURE_ACTOR, evidence: [] },
      targetAgencies: [],
      participantEligibility: {
        status: "eligible",
        participantIds: [FOOT_FIXTURE_ACTOR, FOOT_FIXTURE_SUBJECT],
        evidence: [],
      },
      policy: { status: "allowed", scopes: ["affectionate_touch"], evidence: [] },
      geometry: adapterSupported({ reach: "in_contact", evidence: [] }),
      sourceSupport: adapterSupported({ mobility: "free", supportRole: "free", evidence: [] }),
      targetSupport: adapterSupported({ mobility: "free", supportRole: "free", evidence: [] }),
      material: adapterSupported({ layers: input.layers ?? [], evidence: [] }),
      adjustments: [],
    },
  });
  if (resolution.status !== "committable") {
    throw new Error(`foot fixture contact did not commit: ${resolution.status}`);
  }
  const committed = commitContactResolution({
    state: emptyContactLifecycleState(),
    resolution,
    eventRef: contactEventRef(input.eventId ?? "foot_fixture_event"),
  });
  return committed.contact;
}

/** A layer that filters touch without blocking it — a sock, in numbers. */
export function footFabricLayer(layerId: string, order = 0): ContactMaterialLayerRead {
  return {
    layerId,
    order,
    tactileTransmission: toUnitInterval(6_000),
    shapeTransmission: toUnitInterval(7_000),
    thermalTransmission: toUnitInterval(5_000),
    moistureTransmission: toUnitInterval(4_000),
    scentTransmission: toUnitInterval(5_000),
    visibleThrough: false,
    evidence: [],
  };
}

/** One worn item, with the restrictive terms a caller usually wants to vary. */
export function footwearFixture(overrides: Partial<FootwearItemRead> = {}): FootwearItemRead {
  return {
    layerId: "fixture_sock",
    kind: "sock",
    order: 0,
    parts: ["cuff", "heel_section", "sole_section", "toe_section"],
    filterTag: "ribbed_sock",
    compression: toUnitInterval(3_000),
    rigidity: toUnitInterval(500),
    toeBoxVolume: toUnitInterval(7_000),
    ankleRestriction: toUnitInterval(1_000),
    effectiveFriction: toUnitInterval(5_000),
    permeability: toUnitInterval(6_000),
    closureState: "secured",
    tactileTransmission: toUnitInterval(6_000),
    shapeTransmission: toUnitInterval(7_000),
    visibleThrough: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Driving a fixture
// ---------------------------------------------------------------------------

/**
 * Drive one foot fixture end to end through the real staged runner — the same
 * entry point a lane adapter would call. `payload` is deliberately `unknown`:
 * passing rubbish (or nothing) is how the degradation cases are expressed.
 */
export function readFootAffordances(input: {
  attributes: readonly AttributeValue[];
  payload: unknown;
  perception: AffordancePerceptionView;
  subjectId?: AffordanceSubjectId;
  storyTime?: number;
  previousCues?: AffordanceCueState;
  sink?: DiagnosticSink;
}): AffordanceRead {
  return deriveAffordanceRead({
    subjectId: input.subjectId ?? FOOT_FIXTURE_SUBJECT,
    storyTime: input.storyTime ?? 100,
    attributes: resolvedAttributeSnapshot([...input.attributes]),
    perception: input.perception,
    domains: [footAffordanceDomain],
    payloads: { [FOOT_DOMAIN_ID]: input.payload },
    ...(input.previousCues === undefined ? {} : { previousCues: input.previousCues }),
    ...(input.sink === undefined ? {} : { sink: input.sink }),
  });
}

// ---------------------------------------------------------------------------
// The calibration fixture
// ---------------------------------------------------------------------------

/**
 * A foot the owner read as dry. No `side`, which is the ordinary case: one
 * answer for a character whose two feet the lane cannot tell apart.
 */
const DRY_FOOT: FootCoarseConditionRead = {
  moisture: toUnitInterval(0),
  contributors: [],
  placedSubstances: [],
  placedResidues: [],
};

/** A dry foot with a worked-in film of lotion on the arch and the ball. */
const LOTION_ON_ARCH_AND_BALL: FootCoarseConditionRead = {
  moisture: toUnitInterval(0),
  contributors: [],
  cleanlinessBand: "clean",
  placedSubstances: [
    { surfaceId: "arch", kind: "lotion", amount: toUnitInterval(5_000) },
    { surfaceId: "ball", kind: "lotion", amount: toUnitInterval(5_000) },
  ],
  placedResidues: [],
};

/**
 * **The spec's first calibration fixture.** Seated; one bare, free foot resting
 * in the player's lap; lotion on the arch and the ball and none on the heel; the
 * player's palm slides arch → heel at light-to-moderate broad pressure.
 *
 * What it must produce: a committed direct-skin contact with no reposition, a
 * soft arch texture read, an easy glide where the path crosses the lotion, and a
 * localized catch at the dry callused heel — and nothing about toe curl, sweat,
 * scent, scratches, residue transfer, or pleasure.
 */
export function lotionArchToHeelSlide(): FootFixture {
  return {
    attributes: footAttributeFixture({ arch: "average", nails: "neat", toes: "average" }),
    payload: {
      condition: [LOTION_ON_ARCH_AND_BALL],
      contact: committedFootContact({
        detail: "arch",
        locationId: "foot_arch",
        side: "left",
        pressure: "moderate",
        area: "broad",
        motion: "sliding",
        path: ["arch", "heel_pad"],
      }),
      // Bare foot: the lane can answer, and the answer is "nothing is worn".
      footwear: [],
      support: [{ side: "left", supportRole: "free", mobility: "free" }],
      tactile: { available: true },
    },
    perception: footObserver(),
  };
}

/** The same touch, still. Glide has nothing to say; pressure and texture do. */
export function restingPalmOnArch(): FootFixture {
  return {
    attributes: footAttributeFixture({ arch: "average", nails: "neat", toes: "average" }),
    payload: {
      condition: [LOTION_ON_ARCH_AND_BALL],
      contact: committedFootContact({
        detail: "arch",
        locationId: "foot_arch",
        pressure: "light",
        area: "broad",
        motion: "still",
      }),
      footwear: [],
      tactile: { available: true },
    },
    perception: footObserver(),
  };
}

/** The same foot inside a ribbed sock: filtered texture, no direct skin. */
export function sockFilteredTouch(): FootFixture {
  return {
    attributes: footAttributeFixture({ arch: "average", nails: "neat", toes: "average" }),
    payload: {
      condition: [DRY_FOOT],
      contact: committedFootContact({
        detail: "arch",
        locationId: "foot_arch",
        pressure: "moderate",
        area: "broad",
        layers: [footFabricLayer("fixture_sock")],
      }),
      footwear: [footwearFixture()],
      tactile: { available: true },
    },
    perception: footObserver(),
  };
}

/** An open-toed sandal: toes bare, sole and heel contained. */
export function openToedSandal(): FootFixture {
  return {
    attributes: footAttributeFixture({ arch: "high", nails: "pedicured", toes: "long" }),
    payload: {
      condition: [DRY_FOOT],
      contact: committedFootContact({ detail: "toe_pads", locationId: "toes", pressure: "light", area: "narrow" }),
      footwear: [
        footwearFixture({
          layerId: "fixture_sandal",
          kind: "shoe",
          parts: ["upper", "insole", "heel_counter"],
          filterTag: "leather",
          rigidity: toUnitInterval(4_000),
          closureState: "secured",
        }),
      ],
      tactile: { available: true },
      articulation: [{ side: "left", toes: "relaxed", arch: "neutral" }],
    },
    perception: footObserver(),
  };
}

/** A rigid boot: the toes can move and nobody outside can tell. */
export function rigidBootHiddenToes(): FootFixture {
  return {
    attributes: footAttributeFixture({ arch: "average", nails: "trimmed", toes: "average" }),
    payload: {
      condition: [DRY_FOOT],
      footwear: [
        footwearFixture({
          layerId: "fixture_boot",
          kind: "shoe",
          parts: ["upper", "toe_box", "tongue", "closure", "heel_counter", "insole", "outsole"],
          filterTag: "leather",
          rigidity: toUnitInterval(8_500),
          compression: toUnitInterval(6_000),
          toeBoxVolume: toUnitInterval(2_500),
          tactileTransmission: toUnitInterval(1_000),
          shapeTransmission: toUnitInterval(800),
          closureState: "secured",
        }),
      ],
      articulation: [{ side: "left", toes: "curled", arch: "neutral" }],
      tactile: { available: true },
    },
    perception: footObserver(),
  };
}

/**
 * The other half of the rigid-boot row: the same committed toe curl inside
 * FLEXIBLE fabric, being touched. The sock transmits deformation, so the pose
 * detail is an externally available fact and the observation carries it.
 */
export function sockTransmittedToeCurl(): FootFixture {
  return {
    attributes: footAttributeFixture({ arch: "average", nails: "neat", toes: "average" }),
    payload: {
      condition: [DRY_FOOT],
      contact: committedFootContact({
        detail: "toe_pads",
        locationId: "toes",
        side: "left",
        pressure: "light",
        area: "narrow",
        layers: [footFabricLayer("fixture_sock")],
      }),
      footwear: [footwearFixture()],
      articulation: [{ side: "left", toes: "curled", arch: "neutral" }],
      tactile: { available: true },
    },
    perception: footObserver(),
  };
}

/**
 * One foot in a puddle and one out of it. The condition owner answered PER FOOT,
 * so the damp left sole and the dry right one are two different reads of the
 * same character rather than one average nobody has.
 */
export function dampLeftFootDryRight(): FootFixture {
  return {
    attributes: footAttributeFixture({ arch: "average", nails: "neat", toes: "average" }),
    payload: {
      condition: [
        {
          side: "left",
          moisture: toUnitInterval(8_000),
          contributors: [{ kind: "water", amount: toUnitInterval(8_000) }],
          placedSubstances: [],
          placedResidues: [],
        },
        { side: "right", ...DRY_FOOT },
      ],
      contact: committedFootContact({
        detail: "plantar_surface",
        locationId: "sole",
        side: "left",
        pressure: "light",
        area: "broad",
      }),
      footwear: [],
      tactile: { available: true },
    },
    perception: footObserver(),
  };
}

/**
 * A foot that has been out of the bath a while: the sole is still damp, the
 * exposed dorsal skin has dried, and the interdigital spaces are holding the
 * most of all.
 */
export function dampSoleDryDorsal(): FootFixture {
  return {
    attributes: footAttributeFixture({ arch: "average", nails: "neat", toes: "long" }),
    payload: {
      condition: [
        {
          moisture: toUnitInterval(6_000),
          contributors: [{ kind: "water", amount: toUnitInterval(6_000) }],
          placedSubstances: [],
          placedResidues: [],
        },
      ],
      contact: committedFootContact({ detail: "plantar_surface", locationId: "sole", pressure: "light", area: "broad" }),
      footwear: [],
      tactile: { available: true },
    },
    perception: footObserver(),
  };
}

/**
 * The surface-state owner answered, and its answer was *"I do not know how wet
 * this foot is"* — the case the whole unknown-is-not-dry rule exists for. The
 * condition input is SUPPORTED (so the core's dependency gate is satisfied) and
 * the moisture inside it is absent, so the suppression has to come from the
 * domain rather than from a missing key.
 */
export function unknownSurfaceState(): FootFixture {
  return {
    attributes: footAttributeFixture({ arch: "average", nails: "neat", toes: "average" }),
    payload: {
      condition: [{ contributors: [], placedSubstances: [], placedResidues: [] }],
      contact: committedFootContact({
        detail: "arch",
        locationId: "foot_arch",
        pressure: "light",
        area: "broad",
        motion: "sliding",
        path: ["arch", "heel_pad"],
      }),
      tactile: { available: true },
    },
    perception: footObserver(),
  };
}

/**
 * Production, today: a lane that can read a foot and has no contact owner. Every
 * phenomenon must be silent.
 */
export function noCommittedContact(): FootFixture {
  return {
    attributes: footAttributeFixture({ arch: "average", nails: "neat", toes: "average" }),
    payload: {
      condition: [DRY_FOOT],
      footwear: [],
    },
    perception: footObserver(),
  };
}

/** The worked cases, keyed by the spec's own headings. */
export const footWorkedCases = {
  lotionArchToHeelSlide,
  restingPalmOnArch,
  sockFilteredTouch,
  openToedSandal,
  rigidBootHiddenToes,
  sockTransmittedToeCurl,
  dampLeftFootDryRight,
  dampSoleDryDorsal,
  unknownSurfaceState,
  noCommittedContact,
} as const;
