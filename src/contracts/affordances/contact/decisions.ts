import { z } from "zod";
import { affordanceSubjectIdSchema, type AffordanceEvidence, type AffordanceSubjectId } from "../core";

/**
 * The three permissions a contact needs before it can be committed, plus the
 * implicit-adjustment policy (romantic-contact-affordances.spec.contact-core.md
 * §"Action context" and §"Implicit adjustment policy").
 *
 * Every one of them is a RESULT the lane hands in, never something this layer
 * calculates. The plan's rule is blunt about why: *"This system describes
 * physical consequences. It does not decide desire, consent, attraction,
 * pleasure, climax, withdrawal, or any other character choice."* A permission
 * derived from arousal, affinity, relationship stage, narrative framing, or the
 * mere feasibility of the movement is not a permission, and the shape of these
 * types is what stops one from being manufactured here.
 *
 * All three carry `unresolved` as a first-class value, and all three treat it as
 * a refusal. "We could not ask" and "yes" must never be the same answer.
 */

// ---------------------------------------------------------------------------
// Action kind → required permission scope
// ---------------------------------------------------------------------------

/**
 * How intimate the attempted contact is. A registry, not a schema: adding a kind
 * is a data edit in this file plus a row in the two tables below.
 */
export const contactActionKinds = ["incidental", "casual", "affectionate", "romantic", "intimate"] as const;
export const contactActionKindSchema = z.enum(contactActionKinds);
export type ContactActionKind = z.infer<typeof contactActionKindSchema>;

/** The permission scope an action kind needs a grant for. */
export const contactPolicyScopes = [
  "incidental_contact",
  "casual_touch",
  "affectionate_touch",
  "romantic_touch",
  "intimate_touch",
] as const;
export const contactPolicyScopeSchema = z.enum(contactPolicyScopes);
export type ContactPolicyScope = z.infer<typeof contactPolicyScopeSchema>;

export const CONTACT_ACTION_SCOPE: Readonly<Record<ContactActionKind, ContactPolicyScope>> = {
  incidental: "incidental_contact",
  casual: "casual_touch",
  affectionate: "affectionate_touch",
  romantic: "romantic_touch",
  intimate: "intimate_touch",
};

/**
 * Which kinds need an explicit adult-eligibility pass for every participant.
 *
 * **Settled law** (owner, 2026-07-30 — romantic-contact-affordances.audit.md
 * §"Owner decisions needed" 1). Every participant, the player persona included,
 * must be POSITIVELY adult for `romantic` and `intimate` contact; an unknown,
 * non-numeric, or fantasy-scaled age reads `unresolved` and therefore fails
 * closed. The ordinary social kinds are not gated: gating them would fail every
 * fixture without making any character safer. Romantically- or fetish-framed
 * foot play is `romantic` and is never relabeled to make a trial commit.
 */
export function contactActionRequiresAdultEligibility(kind: ContactActionKind): boolean {
  switch (kind) {
    case "romantic":
    case "intimate":
      return true;
    case "incidental":
    case "casual":
    case "affectionate":
      return false;
  }
}

/**
 * Which kinds need an interaction-permission grant.
 *
 * **Settled law** (owner, 2026-07-30 — romantic-contact-affordances.audit.md
 * §"Owner decisions needed" 3): permission-neutral incidental, casual, and
 * affectionate touch; a grant required for romantic and intimate. Ordinary
 * social contact is what the chat lane already narrates freely and has no
 * permission owner for, so demanding a grant it cannot produce would block the
 * foot trial without changing a single narrated outcome. Romantic and intimate
 * contact demand one and therefore fail closed in legacy chat until an owner
 * exists.
 */
export function contactActionRequiresPermission(kind: ContactActionKind): boolean {
  switch (kind) {
    case "romantic":
    case "intimate":
      return true;
    case "incidental":
    case "casual":
    case "affectionate":
      return false;
  }
}

// ---------------------------------------------------------------------------
// Actor control and target agency
// ---------------------------------------------------------------------------

export const contactControlStatuses = ["allowed", "denied", "unresolved"] as const;
export const contactControlStatusSchema = z.enum(contactControlStatuses);
export type ContactControlStatus = z.infer<typeof contactControlStatusSchema>;

/**
 * Proof that the initiating principal may author THIS actor's voluntary
 * movement. Player-authored narration about an NPC is not control.
 */
export interface ContactActorControlDecision {
  readonly status: ContactControlStatus;
  readonly actorId: AffordanceSubjectId;
  readonly evidence: readonly AffordanceEvidence[];
}

export const contactAgencyStatuses = ["allowed", "denied", "unresolved", "not_required"] as const;
export const contactAgencyStatusSchema = z.enum(contactAgencyStatuses);
export type ContactAgencyStatus = z.infer<typeof contactAgencyStatusSchema>;

/**
 * Proof that ONE named body's own behaviour authority committed a voluntary
 * adjustment on their side. Separate from actor control because being touched is
 * not the same as moving: an attempt may be entirely within the actor's control
 * and still need the other body to shift, and only that body's owner may decide
 * that it does.
 *
 * `targetId` is REQUIRED, and it is the key: the resolver matches every moved
 * non-actor participant against the decision naming that participant. An
 * optional identity let one answer about one character be spent on a movement of
 * another, which is the whole failure this field exists to prevent — so the
 * context carries a LIST of these, one per moved body, not a single decision
 * loosely associated with "the target".
 *
 * `not_required` is the ordinary case for a body nothing asked to move, and it
 * is NOT a grant: a decision that says `not_required` while an adjustment moves
 * that same body is a contradiction, and the resolver treats it as no answer.
 */
export interface ContactTargetAgencyDecision {
  readonly status: ContactAgencyStatus;
  readonly targetId: AffordanceSubjectId;
  readonly evidence: readonly AffordanceEvidence[];
}

// ---------------------------------------------------------------------------
// Participant eligibility
// ---------------------------------------------------------------------------

export const contactEligibilityStatuses = ["eligible", "ineligible", "unresolved", "not_required"] as const;
export const contactEligibilityStatusSchema = z.enum(contactEligibilityStatuses);
export type ContactEligibilityStatus = z.infer<typeof contactEligibilityStatusSchema>;

/**
 * The product life-stage/adult ruling for every participant.
 *
 * `participantIds` is not decoration: the resolver checks that the decision
 * actually COVERS both ends of the contact, so a lane that answered about one
 * character cannot have its answer spent on the other. A known minor is always
 * `ineligible`; unknown, non-numeric, fantasy-scaled, and player ages are
 * `unresolved`, which fails the romantic/intimate gate closed — **ruled by the
 * owner 2026-07-30** (audit §"Owner decisions needed" 1). The ruling adds an
 * explicit `adult | minor | unresolved` declaration, independent of display age,
 * that a lane adapter maps into this read; existing records default to
 * `unresolved`, and the repo-wide `isMinorAge` fail-open fallback is
 * deliberately unchanged.
 */
export interface ContactParticipantEligibilityRead {
  readonly status: ContactEligibilityStatus;
  readonly participantIds: readonly AffordanceSubjectId[];
  readonly evidence: readonly AffordanceEvidence[];
}

// ---------------------------------------------------------------------------
// Interaction permission
// ---------------------------------------------------------------------------

export const contactPolicyStatuses = ["allowed", "denied", "withdrawn", "unresolved", "not_required"] as const;
export const contactPolicyStatusSchema = z.enum(contactPolicyStatuses);
export type ContactPolicyStatus = z.infer<typeof contactPolicyStatusSchema>;

/**
 * The lane's permission owner's answer, with the scopes it covers.
 *
 * Scope membership is checked EXACTLY: the core never widens a grant, because
 * "permission for the more intimate thing implies permission for the less
 * intimate thing" is a product ruling and not an obvious one. A lane that
 * believes a broader grant subsumes a narrower one lists both scopes.
 */
export interface ContactInteractionPolicyRead {
  readonly status: ContactPolicyStatus;
  readonly scopes: readonly ContactPolicyScope[];
  readonly evidence: readonly AffordanceEvidence[];
}

// ---------------------------------------------------------------------------
// Implicit adjustment policy
// ---------------------------------------------------------------------------

/**
 * The closed set of movements small enough to ride along with an action.
 *
 * Being a closed vocabulary IS the spec's "small, ordinary, and mechanically
 * unambiguous" test — a movement that cannot be named as one of these four is,
 * by construction, not one of them. Standing, rolling over, spreading legs,
 * pulling a trapped limb free, crossing a room, and an expressive toe curl are
 * all unnameable here, which is the point.
 */
export const contactAdjustmentKinds = ["lean", "joint_rotation", "limb_reposition", "head_angle"] as const;
export const contactAdjustmentKindSchema = z.enum(contactAdjustmentKinds);
export type ContactAdjustmentKind = z.infer<typeof contactAdjustmentKindSchema>;

/** Why a proposed adjustment is too big to be implicit. */
export const contactAdjustmentBlockCodes = [
  "outside_current_proximity",
  "moves_material_layer",
  "new_intimate_exposure",
  "posture_or_place_change",
  "support_transfer",
  "overcomes_resistance",
  "expresses_choice",
] as const;
export const contactAdjustmentBlockCodeSchema = z.enum(contactAdjustmentBlockCodes);
export type ContactAdjustmentBlockCode = z.infer<typeof contactAdjustmentBlockCodeSchema>;

/**
 * An adjustment as the lane proposes it, with the seven answers the policy needs.
 *
 * Every flag is stated by the owner that knows, never inferred here. A lane that
 * cannot answer one of them says `true` for the blocking value and gets an
 * explicit requirement — the conservative direction.
 */
export interface ContactAdjustmentProposal {
  readonly id: string;
  readonly subjectId: AffordanceSubjectId;
  readonly kind: ContactAdjustmentKind;
  readonly withinCurrentProximity: boolean;
  readonly movesMaterialLayer: boolean;
  readonly newlyExposesIntimateSurface: boolean;
  readonly changesPostureOrPlace: boolean;
  readonly requiresSupportTransfer: boolean;
  readonly overcomesResistanceOrConstraint: boolean;
  readonly expressesChoiceOrReaction: boolean;
  readonly evidence: readonly AffordanceEvidence[];
}

/**
 * An adjustment that PASSED the policy. Deliberately a narrower type than the
 * proposal and constructible only by `classifyContactAdjustment`, so a committed
 * contact cannot carry an adjustment nobody admitted.
 */
export interface ContactMinimalPoseAdjustment {
  readonly id: string;
  readonly subjectId: AffordanceSubjectId;
  readonly kind: ContactAdjustmentKind;
  readonly evidence: readonly AffordanceEvidence[];
}

export type ContactAdjustmentVerdict =
  | { readonly status: "implicit"; readonly adjustment: ContactMinimalPoseAdjustment }
  | { readonly status: "explicit_required"; readonly blocks: readonly ContactAdjustmentBlockCode[] };

/**
 * Apply the eight-condition policy. Every failing condition is reported, not just
 * the first: one debug pass should name everything that makes a movement a scene
 * beat rather than a detail.
 */
export function classifyContactAdjustment(proposal: ContactAdjustmentProposal): ContactAdjustmentVerdict {
  const blocks: ContactAdjustmentBlockCode[] = [];
  if (!proposal.withinCurrentProximity) blocks.push("outside_current_proximity");
  if (proposal.movesMaterialLayer) blocks.push("moves_material_layer");
  if (proposal.newlyExposesIntimateSurface) blocks.push("new_intimate_exposure");
  if (proposal.changesPostureOrPlace) blocks.push("posture_or_place_change");
  if (proposal.requiresSupportTransfer) blocks.push("support_transfer");
  if (proposal.overcomesResistanceOrConstraint) blocks.push("overcomes_resistance");
  if (proposal.expressesChoiceOrReaction) blocks.push("expresses_choice");
  if (blocks.length > 0) return { status: "explicit_required", blocks };
  return {
    status: "implicit",
    adjustment: {
      id: proposal.id,
      subjectId: proposal.subjectId,
      kind: proposal.kind,
      evidence: proposal.evidence,
    },
  };
}

// ---------------------------------------------------------------------------
// Explicit requirements and rejections
// ---------------------------------------------------------------------------

/** What the scene has to do first, when an attempt needs a visible transition. */
export const contactRequirementCodes = [
  "reposition",
  "close_distance",
  "free_limb",
  "change_support",
  "remove_material_layer",
  "open_closure",
  "target_must_act",
] as const;
export const contactRequirementCodeSchema = z.enum(contactRequirementCodes);
export type ContactRequirementCode = z.infer<typeof contactRequirementCodeSchema>;

export interface ContactActionRequirement {
  readonly code: ContactRequirementCode;
  readonly subjectId?: AffordanceSubjectId;
  /** Short structured elaboration (a layer id, a block code). Never prose. */
  readonly detail?: string;
  readonly evidence: readonly AffordanceEvidence[];
}

/**
 * Why an attempt was refused outright. An ANSWER somebody gave, not a
 * degradation — every reason here names an authority that spoke.
 *
 * The line between this vocabulary and the one below is the line between a
 * refusal the fiction must carry and a gap the fiction must not invent. A
 * `rejected` resolution obliges the narrator to resolve it — she pulls back, he
 * cannot reach — so a reason may only live here when somebody actually said no:
 * a control owner that denied, a body's authority that refused to move, a
 * participant the product ruled ineligible, a permission owner that denied or
 * withdrew, a reach read that placed the surfaces apart. Scope-not-covered
 * belongs here too: a grant that exists and does not name this action is an
 * answer about this action, not a silence.
 *
 * **Correction, 2026-07-31 (owner).** The four `*_unresolved` reasons used to
 * live here, so "we could not read the owner" reached the narrator as a refusal
 * and got narrated as one — the resolver's own comments said it should produce
 * silence. They moved to `contactUnresolvedReasons` below.
 */
export const contactRejectionReasons = [
  "actor_control_denied",
  "target_agency_denied",
  "participant_ineligible",
  "permission_denied",
  "permission_withdrawn",
  "permission_scope_missing",
  "out_of_reach",
] as const;
export const contactRejectionReasonSchema = z.enum(contactRejectionReasons);
export type ContactRejectionReason = z.infer<typeof contactRejectionReasonSchema>;

/**
 * Why the resolver could not decide. Degradation, not an answer — narrate
 * nothing, and let the gap surface through diagnostics and the debug UI.
 *
 * Two families, deliberately in one vocabulary because they produce one
 * behaviour: an owner that could not be READ (`*_unavailable`, and the
 * `*_unresolved` authority reasons), and an input nobody meant
 * (`action_invalid`). Both mean the world did not answer, and the only honest
 * output for an unanswered world is silence — a fictionalized refusal would
 * invent a character's decision out of a missing adapter.
 */
export const contactUnresolvedReasons = [
  "action_invalid",
  "actor_control_unresolved",
  "target_agency_unresolved",
  "participant_eligibility_unresolved",
  "permission_unresolved",
  "geometry_unavailable",
  "support_unavailable",
  "material_unavailable",
] as const;
export const contactUnresolvedReasonSchema = z.enum(contactUnresolvedReasons);
export type ContactUnresolvedReason = z.infer<typeof contactUnresolvedReasonSchema>;

/** Boundary schema for a subject id inside a parsed decision. */
export const contactSubjectIdSchema = affordanceSubjectIdSchema;
