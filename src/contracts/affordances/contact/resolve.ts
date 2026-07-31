import { diag, type DiagnosticSink } from "../../diagnostics";
import {
  isAdapterSupported,
  mergeAffordanceEvidence,
  type AffordanceEvidence,
  type AffordanceSubjectId,
} from "../core";
import {
  CONTACT_ACTION_INVALID,
  CONTACT_ACTOR_CONTROL_UNAVAILABLE,
  CONTACT_ELIGIBILITY_UNAVAILABLE,
  CONTACT_GEOMETRY_UNAVAILABLE,
  CONTACT_MATERIAL_UNAVAILABLE,
  CONTACT_PERMISSION_SCOPE_MISSING,
  CONTACT_PERMISSION_UNAVAILABLE,
  CONTACT_SUPPORT_UNAVAILABLE,
  CONTACT_TARGET_AGENCY_UNAVAILABLE,
} from "./diagnostics";
import {
  CONTACT_ACTION_SCOPE,
  classifyContactAdjustment,
  contactActionRequiresAdultEligibility,
  contactActionRequiresPermission,
  type ContactActionRequirement,
  type ContactAdjustmentBlockCode,
  type ContactAdjustmentProposal,
  type ContactMinimalPoseAdjustment,
  type ContactRejectionReason,
  type ContactTargetAgencyDecision,
  type ContactUnresolvedReason,
} from "./decisions";
import {
  composeContactMaterial,
  directContactTransmission,
  type ContactMaterialLayerRead,
  type ContactMaterialTransmissionRead,
} from "./material";
import {
  contactParticipantIds,
  contactSurfacesEqual,
  isInterpersonalContact,
  isKnownContactBodyLocation,
} from "./surfaces";
import type {
  ContactAccessMode,
  ContactAccessResult,
  ContactActionContext,
  ContactActionIntent,
  ContactResolution,
} from "./types";

/**
 * The attempt gate — the single function that decides whether a contact may be
 * committed (romantic-contact-affordances.spec.contact-core.md §"Action context",
 * §"Access result", §"Implicit adjustment policy").
 *
 * Pure and total. Same intent + same context ⇒ same resolution, in any process,
 * on a retake. It reads no clock, holds no state, and throws for nothing: a
 * malformed input degrades to `unresolved` with a diagnostic, per
 * docs/resilience.md.
 *
 * ## Check order, and why it is this order
 *
 * 1. **Structure.** A surface naming a location the body tree does not know, a
 *    contact of a surface with itself, or an acting surface that belongs to
 *    somebody other than the actor, is an adapter bug — nothing further is
 *    meaningful.
 * 2. **Who may move.** Actor control, then the OWN agency of every other body
 *    the action proposes to move. This runs before permission because "the
 *    player wrote the NPC's movement" is not a question about consent; it is a
 *    question about whose story it is.
 * 3. **Who may be touched.** Adult eligibility, then interaction permission.
 *    Before geometry, deliberately: a refusal here must not depend on whether an
 *    unowned pose read happened to be available, or the same denied attempt
 *    would report differently on two lanes.
 * 4. **Whether it can physically happen.** Reach, then support, then material.
 *
 * ## Rejected, unresolved, and transition-required
 *
 * A **rejection** is an answer somebody gave: she is out of reach, the
 * permission was denied or withdrawn, the grant does not cover this, the player
 * does not control that body, she would not move. It gets no diagnostic (except
 * the scope case, which a permission UI wants to see), and the narrator seam
 * mandates that the narrator resolve it in the fiction.
 *
 * **Unresolved** means the world could not be READ — a missing pose owner, an
 * authority that never answered, an unparseable intent. It gets a diagnostic and
 * produces narrator SILENCE.
 *
 * The line between them is who spoke, not how bad the news is
 * (**corrected 2026-07-31 by the owner**). Unresolved actor control, a missing
 * or `unresolved` agency answer, unresolved-or-uncovered eligibility, and an
 * unanswered permission all used to return `rejected`, so a narrator obliged to
 * resolve a refusal invented one — a character was written declining something
 * nobody had asked her about, because an adapter was silent. All four now return
 * `unresolved` with the diagnostics they already emitted: the gap surfaces
 * through the diagnostics channel and the debug UI, which is where a missing
 * owner belongs, and never through the fiction.
 *
 * **Explicit transition required** means the attempt is legal but the scene has
 * to do something visible first. That is the plan's central anti-cheat: the
 * layer may never silently remove a garment, free a trapped limb, or cross a
 * room to make an action work.
 */

export interface ContactResolveRequest {
  readonly intent: ContactActionIntent;
  readonly context: ContactActionContext;
  readonly sink?: DiagnosticSink;
}

/** Provenance accumulator — every read the decision actually consulted. */
type EvidenceLists = (readonly AffordanceEvidence[])[];

function reject(reason: ContactRejectionReason, evidence: EvidenceLists): ContactResolution {
  return { status: "rejected", reason, evidence: mergeAffordanceEvidence(...evidence) };
}

function unresolved(
  reason: ContactUnresolvedReason,
  evidence: EvidenceLists,
  input: { sink?: DiagnosticSink; code: string; message: string; severity?: "warn" | "error" },
): ContactResolution {
  input.sink?.push(diag(input.severity ?? "warn", input.code, input.message));
  return { status: "unresolved", reason, evidence: mergeAffordanceEvidence(...evidence) };
}

function requireTransition(input: {
  requirements: readonly ContactActionRequirement[];
  mode: ContactAccessMode;
  evidence: EvidenceLists;
  adjustments?: readonly ContactMinimalPoseAdjustment[];
  /** Layers already read, when the blocker is the material itself. */
  materialBetween?: readonly ContactMaterialLayerRead[];
  transmission?: ContactMaterialTransmissionRead;
}): ContactResolution {
  const merged = mergeAffordanceEvidence(...input.evidence);
  const access: ContactAccessResult = {
    mode: input.mode,
    materialBetween: input.materialBetween ?? [],
    transmission: input.transmission ?? directContactTransmission(),
    implicitAdjustments: input.adjustments ?? [],
    explicitRequirements: input.requirements,
    evidence: merged,
  };
  return { status: "explicit_transition_required", requirements: input.requirements, access, evidence: merged };
}

/** An intent whose structure the rest of the resolver may rely on. */
function intentStructureProblem(intent: ContactActionIntent): string | undefined {
  if (intent.actionId.trim().length === 0) return "actionId is blank";
  if (!Number.isInteger(intent.storyTime) || intent.storyTime < 0) return "storyTime is not a story minute";
  // The acting surface must belong to the acting body. Without this, a control
  // decision that legitimately says "this principal may move A" authorizes an
  // attempt whose acting surface is B's — the whole gate answered about the
  // wrong body, and every check after it inherits the substitution.
  if (intent.source.subjectId !== intent.actorId) {
    return "the acting surface belongs to a subject other than the actor";
  }
  if (!isKnownContactBodyLocation(intent.source.locationId)) {
    return `source location "${intent.source.locationId}" is not in the body registry`;
  }
  if (intent.target.kind === "body" && !isKnownContactBodyLocation(intent.target.locationId)) {
    return `target location "${intent.target.locationId}" is not in the body registry`;
  }
  if (contactSurfacesEqual(intent.source, intent.target)) return "source and target are the same surface";
  return undefined;
}

/**
 * Every body other than the actor that an adjustment proposes to move, in first
 * proposal order.
 *
 * First-proposal order rather than sorted: the order is only used to make the
 * evidence trail and the chosen refusal deterministic, and the caller's own
 * order is the one a debug pass can follow back to the proposal list.
 */
function movedNonActorSubjects(
  adjustments: readonly ContactAdjustmentProposal[],
  actorId: AffordanceSubjectId,
): readonly AffordanceSubjectId[] {
  const subjects: AffordanceSubjectId[] = [];
  for (const proposal of adjustments) {
    if (proposal.subjectId === actorId || subjects.includes(proposal.subjectId)) continue;
    subjects.push(proposal.subjectId);
  }
  return subjects;
}

/**
 * The first body two agency decisions both claim to answer for, if any.
 *
 * Coverage is matched by first hit, and a first hit is only trustworthy when
 * there is exactly one: two decisions naming the same body let an earlier
 * `allowed` swallow a later `denied`, so the movement most likely to matter is
 * the one silently discarded. There is no principled tie-break either — the two
 * answers claim the same authority over the same body, and picking the harsher
 * one would still be this layer inventing which of an adapter's two statements
 * it meant.
 *
 * So a duplicate is a context built wrong, not a story fact: `action_invalid`
 * with an `error`, exactly like a decision about a different actor. Checked over
 * the WHOLE list rather than only the consulted part — a list that contradicts
 * itself about one body says nothing reliable about the others.
 */
function duplicateAgencyTarget(
  decisions: readonly ContactTargetAgencyDecision[],
): AffordanceSubjectId | undefined {
  const seen = new Set<AffordanceSubjectId>();
  for (const decision of decisions) {
    if (seen.has(decision.targetId)) return decision.targetId;
    seen.add(decision.targetId);
  }
  return undefined;
}

export function resolveContactAttempt(request: ContactResolveRequest): ContactResolution {
  const { intent, context, sink } = request;
  const evidence: EvidenceLists = [];

  // --- 1. Structure ------------------------------------------------------
  const structural = intentStructureProblem(intent);
  if (structural !== undefined) {
    return unresolved("action_invalid", evidence, {
      sink,
      code: CONTACT_ACTION_INVALID,
      message: `contact attempt is unusable: ${structural}`,
      severity: "error",
    });
  }

  // --- 2. Who may move ---------------------------------------------------
  evidence.push(context.actorControl.evidence);
  if (context.actorControl.actorId !== intent.actorId) {
    return unresolved("action_invalid", evidence, {
      sink,
      code: CONTACT_ACTION_INVALID,
      message: "actor-control decision is about a different actor than the intent",
      severity: "error",
    });
  }
  const duplicateTarget = duplicateAgencyTarget(context.targetAgencies);
  if (duplicateTarget !== undefined) {
    return unresolved("action_invalid", evidence, {
      sink,
      code: CONTACT_ACTION_INVALID,
      message: `two target-agency decisions answer for the same body "${duplicateTarget}"`,
      severity: "error",
    });
  }
  switch (context.actorControl.status) {
    case "denied":
      return reject("actor_control_denied", evidence);
    case "unresolved":
      return unresolved("actor_control_unresolved", evidence, {
        sink,
        code: CONTACT_ACTOR_CONTROL_UNAVAILABLE,
        message: "no actor-control owner answered for the initiating movement",
      });
    case "allowed":
      break;
  }

  // An adjustment may only move a body this contact actually involves. A
  // proposal naming anyone else is not a story fact to refuse — it is a context
  // built for a different action, and nothing in it can be trusted.
  const participants = contactParticipantIds(intent.source, intent.target);
  const outsider = context.adjustments.find((proposal) => !participants.includes(proposal.subjectId));
  if (outsider !== undefined) {
    return unresolved("action_invalid", evidence, {
      sink,
      code: CONTACT_ACTION_INVALID,
      message: `adjustment "${outsider.id}" moves a subject who is not part of this contact`,
      severity: "error",
    });
  }

  // A movement on anyone but the actor needs THAT body's own behaviour
  // authority — one per moved body, matched by identity. A decision about one
  // character can never be spent on a movement of another.
  const movedSubjects = movedNonActorSubjects(context.adjustments, intent.actorId);
  // The decisions actually spent on this attempt, kept so the commitment can
  // carry the proof rather than only the movement it authorized.
  const consultedAgencies: ContactTargetAgencyDecision[] = [];
  if (movedSubjects.length > 0) {
    const decisions = movedSubjects.map((subjectId) =>
      context.targetAgencies.find((decision) => decision.targetId === subjectId),
    );
    for (const decision of decisions) {
      if (decision === undefined) continue;
      evidence.push(decision.evidence);
      consultedAgencies.push(decision);
    }
    // A definite refusal outranks a missing answer: "she would not move" is a
    // beat the narrator can carry, and reporting it as unreadable would throw
    // that away because some OTHER body's owner happened to stay silent.
    if (decisions.some((decision) => decision?.status === "denied")) {
      return reject("target_agency_denied", evidence);
    }
    if (decisions.some((decision) => decision?.status !== "allowed")) {
      return unresolved("target_agency_unresolved", evidence, {
        sink,
        code: CONTACT_TARGET_AGENCY_UNAVAILABLE,
        message: "a voluntary movement has no behaviour authority for every body it moves",
      });
    }
  }

  // --- 3. Who may be touched --------------------------------------------
  const interpersonal = isInterpersonalContact(intent.source, intent.target);

  if (interpersonal && contactActionRequiresAdultEligibility(intent.actionKind)) {
    evidence.push(context.participantEligibility.evidence);
    const covered = participants.every((id) => context.participantEligibility.participantIds.includes(id));
    if (context.participantEligibility.status === "ineligible") {
      return reject("participant_ineligible", evidence);
    }
    if (context.participantEligibility.status !== "eligible" || !covered) {
      return unresolved("participant_eligibility_unresolved", evidence, {
        sink,
        code: CONTACT_ELIGIBILITY_UNAVAILABLE,
        message: covered
          ? "adult eligibility is unresolved for this contact"
          : "adult eligibility does not cover every participant",
      });
    }
  }

  if (interpersonal && contactActionRequiresPermission(intent.actionKind)) {
    evidence.push(context.policy.evidence);
    switch (context.policy.status) {
      case "denied":
        return reject("permission_denied", evidence);
      case "withdrawn":
        return reject("permission_withdrawn", evidence);
      case "unresolved":
      case "not_required":
        return unresolved("permission_unresolved", evidence, {
          sink,
          code: CONTACT_PERMISSION_UNAVAILABLE,
          message: "no permission owner answered for this interpersonal contact",
        });
      case "allowed":
        break;
    }
    if (!context.policy.scopes.includes(CONTACT_ACTION_SCOPE[intent.actionKind])) {
      sink?.push(
        diag(
          "warn",
          CONTACT_PERMISSION_SCOPE_MISSING,
          `permission does not cover ${CONTACT_ACTION_SCOPE[intent.actionKind]}`,
        ),
      );
      return reject("permission_scope_missing", evidence);
    }
  }

  // --- 4a. Reach ---------------------------------------------------------
  if (!isAdapterSupported(context.geometry)) {
    return unresolved("geometry_unavailable", evidence, {
      sink,
      code: CONTACT_GEOMETRY_UNAVAILABLE,
      message: "no pose/reach owner could place these two surfaces",
    });
  }
  evidence.push(context.geometry.value.evidence);
  if (context.geometry.value.reach === "out_of_reach") {
    return reject("out_of_reach", evidence);
  }

  // Every proposed adjustment must pass the eight-condition policy; one that
  // does not turns the whole attempt into a visible scene beat.
  const admitted: ContactMinimalPoseAdjustment[] = [];
  const blocked: ContactAdjustmentBlockCode[] = [];
  for (const proposal of context.adjustments) {
    const verdict = classifyContactAdjustment(proposal);
    if (verdict.status === "implicit") admitted.push(verdict.adjustment);
    else blocked.push(...verdict.blocks);
  }
  if (blocked.length > 0) {
    return requireTransition({
      requirements: [{ code: "reposition", subjectId: intent.actorId, detail: blocked.join(","), evidence: [] }],
      mode: "explicit_transition_required",
      evidence,
    });
  }
  if (context.geometry.value.reach === "within_reach_after_adjustment" && admitted.length === 0) {
    return requireTransition({
      requirements: [{ code: "reposition", subjectId: intent.actorId, evidence: [] }],
      mode: "blocked_by_geometry",
      evidence,
    });
  }

  // --- 4b. Support -------------------------------------------------------
  if (!isAdapterSupported(context.sourceSupport)) {
    return unresolved("support_unavailable", evidence, {
      sink,
      code: CONTACT_SUPPORT_UNAVAILABLE,
      message: "no support owner could say whether the acting surface is free to move",
    });
  }
  const sourceSupport = context.sourceSupport.value;
  evidence.push(sourceSupport.evidence);
  if (isAdapterSupported(context.targetSupport)) evidence.push(context.targetSupport.value.evidence);

  if (sourceSupport.mobility === "trapped") {
    return requireTransition({
      requirements: [{ code: "free_limb", subjectId: intent.actorId, evidence: [] }],
      mode: "blocked_by_support",
      evidence,
      adjustments: admitted,
    });
  }
  const mustMoveSource =
    intent.requestedMotion !== undefined || context.geometry.value.reach !== "in_contact";
  if (mustMoveSource && (sourceSupport.mobility === "fixed" || sourceSupport.supportRole === "weight_bearing")) {
    return requireTransition({
      requirements: [{ code: "change_support", subjectId: intent.actorId, evidence: [] }],
      mode: "blocked_by_support",
      evidence,
      adjustments: admitted,
    });
  }

  // --- 4c. Material between ---------------------------------------------
  if (!isAdapterSupported(context.material)) {
    return unresolved("material_unavailable", evidence, {
      sink,
      code: CONTACT_MATERIAL_UNAVAILABLE,
      message: "no owner could say what lies between the two surfaces",
    });
  }
  const material = context.material.value;
  evidence.push(material.evidence);
  const transmission = composeContactMaterial(material.layers);

  if (material.layers.length > 0 && intent.access === "direct_skin") {
    return requireTransition({
      requirements: transmission.layerIds.map((layerId) => ({
        code: "remove_material_layer" as const,
        detail: layerId,
        evidence: [],
      })),
      mode: "blocked_by_material",
      evidence,
      adjustments: admitted,
      materialBetween: material.layers,
      transmission,
    });
  }

  // --- Committable -------------------------------------------------------
  const merged = mergeAffordanceEvidence(...evidence);
  return {
    status: "committable",
    intent,
    access: {
      mode: transmission.directSkinContact ? "direct" : "through_material",
      materialBetween: material.layers,
      transmission,
      implicitAdjustments: admitted,
      explicitRequirements: [],
      evidence: merged,
    },
    actorControl: context.actorControl,
    targetAgencies: consultedAgencies,
    participantEligibility: context.participantEligibility,
    policy: context.policy,
    evidence: merged,
  };
}
