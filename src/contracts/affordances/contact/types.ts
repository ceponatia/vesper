import { z } from "zod";
import type { AdapterRead, AffordanceEvidence, AffordanceStoryTime, AffordanceSubjectId } from "../core";
import type {
  ContactActionKind,
  ContactActionRequirement,
  ContactActorControlDecision,
  ContactInteractionPolicyRead,
  ContactMinimalPoseAdjustment,
  ContactParticipantEligibilityRead,
  ContactRejectionReason,
  ContactTargetAgencyDecision,
  ContactUnresolvedReason,
  ContactAdjustmentProposal,
} from "./decisions";
import type { ContactId, ContactEventRef } from "./identity";
import type { ContactMaterialLayerRead, ContactMaterialTransmissionRead } from "./material";
import type { ContactBodySurfaceRef, ContactSurfaceRef } from "./surfaces";

/**
 * The attempt / resolution / commitment boundary
 * (romantic-contact-affordances.spec.contact-core.md §"Boundary").
 *
 * Three types instead of one, because collapsing them is exactly how a
 * possibility reaches a narrator as a fact. The type system carries the
 * separation rather than a convention:
 *
 * - a non-committable `ContactResolution` has no `intent` and no `access`, so it
 *   cannot be passed to the function that commits a contact;
 * - `CommittedContactRead` is only ever constructed from a
 *   `CommittableContactResolution`, and carries `phase: "active"`;
 * - an ended contact becomes `EndedContactRecord` with `phase: "ended"`, which is
 *   not assignable where an active read is required.
 *
 * Nothing in this file reads a clock. Story time arrives on the intent and is
 * carried; the core does no time arithmetic at all, exactly as
 * `AffordanceStoryTime` requires ("provenance only").
 */

// ---------------------------------------------------------------------------
// Bands
// ---------------------------------------------------------------------------

export const contactPressureBands = ["trace", "light", "moderate", "firm"] as const;
export const contactPressureBandSchema = z.enum(contactPressureBands);
export type ContactPressureBand = z.infer<typeof contactPressureBandSchema>;

export const contactAreaBands = ["point", "narrow", "broad"] as const;
export const contactAreaBandSchema = z.enum(contactAreaBands);
export type ContactAreaBand = z.infer<typeof contactAreaBandSchema>;

export const contactMotionBands = ["still", "pressing", "sliding", "rolling", "tapping"] as const;
export const contactMotionBandSchema = z.enum(contactMotionBands);
export type ContactMotionBand = z.infer<typeof contactMotionBandSchema>;

/**
 * Motion as committed: a band plus the domain's own path tokens.
 *
 * `pathDetailIds` are the same opaque sub-surface tokens `ContactSurfaceRef.detail`
 * carries — a foot domain writes `["arch","heel_pad"]` and the core stores the
 * sequence without knowing what either one is. Order is identity: a slide from
 * arch to heel and one from heel to arch are different motions.
 */
export interface CommittedContactMotionRead {
  readonly band: ContactMotionBand;
  readonly pathDetailIds?: readonly string[];
  readonly evidence: readonly AffordanceEvidence[];
}

// ---------------------------------------------------------------------------
// The attempt
// ---------------------------------------------------------------------------

/** Whether the action needs bare surfaces or will settle for contact through material. */
export const contactAccessRequirements = ["direct_skin", "any_material"] as const;
export const contactAccessRequirementSchema = z.enum(contactAccessRequirements);
export type ContactAccessRequirement = z.infer<typeof contactAccessRequirementSchema>;

export interface ContactMotionIntent {
  readonly band: ContactMotionBand;
  readonly pathDetailIds?: readonly string[];
}

/**
 * One attempted contact. Nothing here is true yet.
 *
 * `actionId` is the lane's identity for the attempt, and it is the same id the
 * narrator-guidance seam's `buildActionOutcome` stamps — so a rejected attempt
 * and the outcome the narrator must resolve are provably the same event.
 */
export interface ContactActionIntent {
  readonly actionId: string;
  readonly actorId: AffordanceSubjectId;
  /** The acting surface. Always a body: an object cannot initiate. */
  readonly source: ContactBodySurfaceRef;
  readonly target: ContactSurfaceRef;
  readonly actionKind: ContactActionKind;
  readonly access: ContactAccessRequirement;
  readonly requestedPressure?: ContactPressureBand;
  readonly requestedArea?: ContactAreaBand;
  readonly requestedMotion?: ContactMotionIntent;
  readonly storyTime: AffordanceStoryTime;
}

// ---------------------------------------------------------------------------
// Authoritative reads the resolver consumes
// ---------------------------------------------------------------------------

/**
 * How far apart the two surfaces are, in the only terms a contact decision needs.
 *
 * The audit records that NEITHER lane owns this today, which is why it arrives as
 * an `AdapterRead`: a lane with no pose or proximity model reports `unavailable`
 * and the attempt resolves `unresolved`, rather than a distance being guessed
 * from co-location or from the fact that the player asked.
 */
export const contactReaches = ["in_contact", "within_reach", "within_reach_after_adjustment", "out_of_reach"] as const;
export const contactReachSchema = z.enum(contactReaches);
export type ContactReach = z.infer<typeof contactReachSchema>;

export interface ContactGeometryRead {
  readonly reach: ContactReach;
  readonly evidence: readonly AffordanceEvidence[];
}

/**
 * What a surface is doing structurally right now. The vocabulary is lifted from
 * the foot spec's `FootSupportRead` on purpose: it was already the general
 * answer, and a second one would have to be reconciled with it later.
 */
export const contactSupportMobilities = ["free", "limited", "fixed", "trapped"] as const;
export const contactSupportMobilitySchema = z.enum(contactSupportMobilities);
export type ContactSupportMobility = z.infer<typeof contactSupportMobilitySchema>;

export const contactSupportRoles = ["weight_bearing", "partial", "free"] as const;
export const contactSupportRoleSchema = z.enum(contactSupportRoles);
export type ContactSupportRole = z.infer<typeof contactSupportRoleSchema>;

export interface ContactSupportRead {
  readonly mobility: ContactSupportMobility;
  readonly supportRole: ContactSupportRole;
  readonly evidence: readonly AffordanceEvidence[];
}

/** Everything currently interposed between the two surfaces, source-first. */
export interface ContactMaterialRead {
  readonly layers: readonly ContactMaterialLayerRead[];
  readonly evidence: readonly AffordanceEvidence[];
}

/**
 * Everything the resolver consults, owned by somebody else.
 *
 * The spec's context also listed `pose`, `environment`, and `bodyStateCut`. Pose
 * is folded into `geometry` (one unowned read is honest; two are ceremony), and
 * the other two are FRAME inputs for the observation stage rather than
 * resolution inputs — nothing about whether a contact may happen depends on them.
 */
export interface ContactActionContext {
  readonly actorControl: ContactActorControlDecision;
  readonly targetAgency: ContactTargetAgencyDecision;
  readonly participantEligibility: ContactParticipantEligibilityRead;
  readonly policy: ContactInteractionPolicyRead;
  readonly geometry: AdapterRead<ContactGeometryRead>;
  readonly sourceSupport: AdapterRead<ContactSupportRead>;
  readonly targetSupport: AdapterRead<ContactSupportRead>;
  readonly material: AdapterRead<ContactMaterialRead>;
  /** Movements the lane proposes to fold into this action. Empty is the ordinary case. */
  readonly adjustments: readonly ContactAdjustmentProposal[];
}

// ---------------------------------------------------------------------------
// Access
// ---------------------------------------------------------------------------

/**
 * Why the two surfaces can or cannot meet.
 *
 * The spec's `implicit_adjustment` mode is deliberately absent: whether an
 * adjustment was folded in is orthogonal to what lies between the surfaces, and
 * one enum cannot carry both without a hand-through-fabric contact reporting
 * itself as bare. The adjustments ride their own list; the mode answers only
 * "what is between, or what is in the way".
 */
export const contactAccessModes = [
  "direct",
  "through_material",
  "explicit_transition_required",
  "blocked_by_material",
  "blocked_by_geometry",
  "blocked_by_support",
  "blocked_by_policy",
  "out_of_reach",
  "unresolved",
] as const;
export const contactAccessModeSchema = z.enum(contactAccessModes);
export type ContactAccessMode = z.infer<typeof contactAccessModeSchema>;

export interface ContactAccessResult {
  readonly mode: ContactAccessMode;
  readonly materialBetween: readonly ContactMaterialLayerRead[];
  readonly transmission: ContactMaterialTransmissionRead;
  readonly implicitAdjustments: readonly ContactMinimalPoseAdjustment[];
  readonly explicitRequirements: readonly ContactActionRequirement[];
  readonly evidence: readonly AffordanceEvidence[];
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/**
 * Four statuses, aligned 1:1 with the narrator seam's `PhysicalActionStatus`
 * (`guidance/types.ts`) so slice 3 projects a resolution without translating it.
 * The alignment is pinned by a test rather than by this comment.
 *
 * `committable` keeps the spec's name over the seam's `committed`: a resolution
 * is a decision, and the commitment is a separate act by the lifecycle. Losing
 * that distinction is the exact failure the three-type boundary exists to
 * prevent. `partially_committed` has no producer here and is not modelled —
 * a path that commits at some loci and not others is slice 2's problem, and
 * inventing the shape now would be an untested guess at its semantics.
 */
export const contactResolutionStatuses = [
  "committable",
  "explicit_transition_required",
  "rejected",
  "unresolved",
] as const;
export type ContactResolutionStatus = (typeof contactResolutionStatuses)[number];

/** Resolution status → the guidance seam's `PhysicalActionStatus` string. */
export const CONTACT_RESOLUTION_ACTION_STATUS: Readonly<Record<ContactResolutionStatus, string>> = {
  committable: "committed",
  explicit_transition_required: "explicit_transition_required",
  rejected: "rejected",
  unresolved: "unresolved",
};

export type ContactResolution =
  | {
      readonly status: "committable";
      readonly intent: ContactActionIntent;
      readonly access: ContactAccessResult;
      readonly actorControl: ContactActorControlDecision;
      readonly participantEligibility: ContactParticipantEligibilityRead;
      readonly policy: ContactInteractionPolicyRead;
      readonly evidence: readonly AffordanceEvidence[];
    }
  | {
      readonly status: "explicit_transition_required";
      readonly requirements: readonly ContactActionRequirement[];
      readonly access: ContactAccessResult;
      readonly evidence: readonly AffordanceEvidence[];
    }
  | {
      readonly status: "rejected";
      readonly reason: ContactRejectionReason;
      readonly evidence: readonly AffordanceEvidence[];
    }
  | {
      readonly status: "unresolved";
      readonly reason: ContactUnresolvedReason;
      readonly evidence: readonly AffordanceEvidence[];
    };

export type CommittableContactResolution = Extract<ContactResolution, { status: "committable" }>;

export function isCommittableContactResolution(
  resolution: ContactResolution,
): resolution is CommittableContactResolution {
  return resolution.status === "committable";
}

// ---------------------------------------------------------------------------
// Commitment
// ---------------------------------------------------------------------------

/**
 * A contact that is happening now — the ONLY value a physical observation may be
 * derived from.
 *
 * `pressure` and `contactArea` are optional, against the spec's draft, and the
 * reason is the repo's oldest law about degraded reads: unknown is not a
 * convenient default. A contact whose pressure nobody stated is not a `trace`
 * press — it is a contact whose pressure is unknown, and a pressure-dependent
 * observation must fall silent rather than describe the lightest thing that
 * could be true.
 *
 * The three decisions are carried rather than dropped so the committed record can
 * prove, later and out of context, WHY it was allowed to exist.
 */
export interface CommittedContactRead {
  readonly phase: "active";
  readonly contactId: ContactId;
  /** The order-independent surface-pair key this contact occupies. */
  readonly pairKey: string;
  readonly startedByEventRef: ContactEventRef;
  readonly lastUpdatedByEventRef: ContactEventRef;
  readonly startedAt: AffordanceStoryTime;
  readonly lastUpdatedAt: AffordanceStoryTime;
  readonly actorId: AffordanceSubjectId;
  readonly actionKind: ContactActionKind;
  /** Orientation, fixed at start: which side acted. Never patched. */
  readonly source: ContactBodySurfaceRef;
  readonly target: ContactSurfaceRef;
  readonly pressure?: ContactPressureBand;
  readonly contactArea?: ContactAreaBand;
  readonly motion?: CommittedContactMotionRead;
  readonly materialBetween: readonly ContactMaterialLayerRead[];
  readonly transmission: ContactMaterialTransmissionRead;
  readonly implicitAdjustments: readonly ContactMinimalPoseAdjustment[];
  readonly actorControl: ContactActorControlDecision;
  readonly participantEligibility: ContactParticipantEligibilityRead;
  readonly policy: ContactInteractionPolicyRead;
  readonly evidence: readonly AffordanceEvidence[];
}

export const contactEndReasons = [
  "withdrawn",
  "separated",
  "scene_changed",
  "policy_withdrawn",
  "state_invalidated",
] as const;
export const contactEndReasonSchema = z.enum(contactEndReasons);
export type ContactEndReason = z.infer<typeof contactEndReasonSchema>;

/**
 * A contact that has ended. `phase: "ended"` is not assignable where
 * `CommittedContactRead` is expected, so an ended contact cannot be handed to a
 * frame by mistake — which is the spec's "an ended contact cannot enter a current
 * frame" expressed as a type rather than a rule.
 */
export interface EndedContactRecord extends Omit<CommittedContactRead, "phase"> {
  readonly phase: "ended";
  readonly endedAt: AffordanceStoryTime;
  readonly endedByEventRef: ContactEventRef;
  readonly endReason: ContactEndReason;
}

/** The fields an update may change. Surfaces, actor, and kind are identity. */
export type CommittedContactUpdate = Partial<
  Pick<CommittedContactRead, "pressure" | "contactArea" | "motion" | "materialBetween" | "implicitAdjustments">
>;

/**
 * What happened to the projection.
 *
 * `contact_continued` is not in the spec's union, which described the no-write
 * case in prose only. Making it a case is what lets "an unchanged sustained
 * contact keeps its id without a duplicate start event" be asserted by a test
 * instead of inferred from the absence of one.
 */
export type ContactLifecycleCommit =
  | { readonly kind: "contact_started"; readonly contact: CommittedContactRead }
  | {
      readonly kind: "contact_updated";
      readonly contactId: ContactId;
      readonly eventRef: ContactEventRef;
      readonly patch: CommittedContactUpdate;
      readonly storyTime: AffordanceStoryTime;
      readonly contact: CommittedContactRead;
    }
  | {
      readonly kind: "contact_continued";
      readonly contactId: ContactId;
      readonly storyTime: AffordanceStoryTime;
      readonly contact: CommittedContactRead;
    }
  | {
      readonly kind: "contact_ended";
      readonly contactId: ContactId;
      readonly eventRef: ContactEventRef;
      readonly reason: ContactEndReason;
      readonly storyTime: AffordanceStoryTime;
      readonly contact: EndedContactRecord;
    };

/** The one commit kind that removes a contact from the projection. */
export type ContactEndedCommit = Extract<ContactLifecycleCommit, { kind: "contact_ended" }>;
