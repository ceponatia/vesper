import {
  adapterSupported,
  affordanceEvidence,
  affordanceSubjectId,
  AFFORDANCE_UNIT_ONE,
  toUnitInterval,
  type AffordanceSubjectId,
} from "../core";
import type {
  ContactActionKind,
  ContactAdjustmentProposal,
  ContactInteractionPolicyRead,
  ContactParticipantEligibilityRead,
  ContactActorControlDecision,
  ContactTargetAgencyDecision,
} from "./decisions";
import { CONTACT_ACTION_SCOPE } from "./decisions";
import { contactEventRef } from "./identity";
import type { ContactMaterialLayerRead } from "./material";
import type { ContactBodySurfaceRef } from "./surfaces";
import type {
  ContactActionContext,
  ContactActionIntent,
  ContactGeometryRead,
  ContactReach,
  ContactSupportMobility,
  ContactSupportRead,
  ContactSupportRole,
} from "./types";

/**
 * Fixture builders for the contact core's own tests.
 *
 * Deliberately **not** in the barrel — the guidance layer's `test-support.ts`
 * set the precedent, and a probe builder that reaches production is a way for a
 * default nobody chose to become a physical claim.
 *
 * Every builder's default is the PERMISSIVE-but-explicit case: control allowed,
 * eligibility eligible, permission granted for the action's own scope, in
 * contact, free support, nothing in between. A test that wants a refusal states
 * the one field it is testing, so each case reads as exactly its own hypothesis.
 */

export const PROBE_ACTOR = affordanceSubjectId("probe_actor");
export const PROBE_TARGET = affordanceSubjectId("probe_target");
export const PROBE_EVENT = contactEventRef("probe_event_1");

export function probeBodySurface(
  subjectId: AffordanceSubjectId,
  locationId: string,
  detail?: string,
): ContactBodySurfaceRef {
  return { kind: "body", subjectId, locationId, ...(detail === undefined ? {} : { detail }) };
}

export function probeIntent(overrides: Partial<ContactActionIntent> = {}): ContactActionIntent {
  return {
    actionId: "probe_action",
    actorId: PROBE_ACTOR,
    source: probeBodySurface(PROBE_ACTOR, "hands"),
    target: probeBodySurface(PROBE_TARGET, "feet", "arch"),
    actionKind: "affectionate",
    access: "any_material",
    storyTime: 100,
    ...overrides,
  };
}

export function probeControl(
  status: ContactActorControlDecision["status"] = "allowed",
  actorId: AffordanceSubjectId = PROBE_ACTOR,
): ContactActorControlDecision {
  return { status, actorId, evidence: [affordanceEvidence("adapter", "probe.control", status)] };
}

export function probeAgency(
  status: ContactTargetAgencyDecision["status"] = "not_required",
): ContactTargetAgencyDecision {
  return { status, targetId: PROBE_TARGET, evidence: [] };
}

export function probeEligibility(
  status: ContactParticipantEligibilityRead["status"] = "eligible",
  participantIds: readonly AffordanceSubjectId[] = [PROBE_ACTOR, PROBE_TARGET],
): ContactParticipantEligibilityRead {
  return { status, participantIds, evidence: [] };
}

export function probePolicy(
  status: ContactInteractionPolicyRead["status"] = "allowed",
  kind: ContactActionKind = "romantic",
): ContactInteractionPolicyRead {
  return { status, scopes: [CONTACT_ACTION_SCOPE[kind]], evidence: [] };
}

export function probeGeometry(reach: ContactReach = "in_contact"): ContactGeometryRead {
  return { reach, evidence: [affordanceEvidence("state", "probe.reach", reach)] };
}

export function probeSupport(
  mobility: ContactSupportMobility = "free",
  supportRole: ContactSupportRole = "free",
): ContactSupportRead {
  return { mobility, supportRole, evidence: [] };
}

/** A layer that transmits most of everything — a thin sock, in numbers. */
export function probeLayer(layerId: string, order = 0): ContactMaterialLayerRead {
  return {
    layerId,
    order,
    tactileTransmission: toUnitInterval(7_000),
    shapeTransmission: toUnitInterval(8_000),
    thermalTransmission: toUnitInterval(6_000),
    moistureTransmission: toUnitInterval(4_000),
    scentTransmission: toUnitInterval(5_000),
    visibleThrough: false,
    evidence: [affordanceEvidence("coverage", `probe.layer.${layerId}`)],
  };
}

/** A layer that hides nothing and blocks nothing but still is not skin. */
export function probeSheerLayer(layerId: string, order = 0): ContactMaterialLayerRead {
  return {
    layerId,
    order,
    tactileTransmission: AFFORDANCE_UNIT_ONE,
    shapeTransmission: AFFORDANCE_UNIT_ONE,
    thermalTransmission: AFFORDANCE_UNIT_ONE,
    moistureTransmission: AFFORDANCE_UNIT_ONE,
    scentTransmission: AFFORDANCE_UNIT_ONE,
    visibleThrough: true,
    evidence: [],
  };
}

export function probeAdjustment(
  overrides: Partial<ContactAdjustmentProposal> = {},
): ContactAdjustmentProposal {
  return {
    id: "probe_adjustment",
    subjectId: PROBE_ACTOR,
    kind: "joint_rotation",
    withinCurrentProximity: true,
    movesMaterialLayer: false,
    newlyExposesIntimateSurface: false,
    changesPostureOrPlace: false,
    requiresSupportTransfer: false,
    overcomesResistanceOrConstraint: false,
    expressesChoiceOrReaction: false,
    evidence: [],
    ...overrides,
  };
}

export function probeContext(overrides: Partial<ContactActionContext> = {}): ContactActionContext {
  return {
    actorControl: probeControl(),
    targetAgency: probeAgency(),
    participantEligibility: probeEligibility(),
    policy: probePolicy(),
    geometry: adapterSupported(probeGeometry()),
    sourceSupport: adapterSupported(probeSupport()),
    targetSupport: adapterSupported(probeSupport()),
    material: adapterSupported({ layers: [], evidence: [] }),
    adjustments: [],
    ...overrides,
  };
}

/** The three knobs most tests turn, as one call. */
export function probeAttempt(input: {
  intent?: Partial<ContactActionIntent>;
  context?: Partial<ContactActionContext>;
}): { intent: ContactActionIntent; context: ContactActionContext } {
  return { intent: probeIntent(input.intent ?? {}), context: probeContext(input.context ?? {}) };
}
