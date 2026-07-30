import type {
  CommittedContactRead,
  ContactActionKind,
  ContactAreaBand,
  ContactBodySurfaceRef,
  ContactMaterialLayerRead,
  ContactMaterialTransmissionRead,
  ContactMotionBand,
  ContactPressureBand,
  ContactSurfaceRef,
} from "../../contact";
import {
  affordanceEvidence,
  type AffordanceEvidence,
  type AffordanceResolutionContext,
  type AffordanceStateSnapshot,
  type AffordanceSubjectId,
  type DomainFrame,
} from "../../core";
import type { FootCoarseConditionRead } from "./condition";
import type { FootwearContactRead } from "./footwear";
import type { FootEffectiveMechanics } from "./mechanics";
import type { FootStructuralProfile } from "./profile";
import type { FootArticulationRead, FootSupportRead } from "./support";
import {
  footContactLocationIds,
  footLocus,
  footSurfaceForDetail,
  footSurfaceForLocation,
  type FootLocusRef,
} from "./topology";

/**
 * Stage 3 — one subject's foot view of one committed cut.
 *
 * The live inputs are declared here, in the domain that consumes them, and every
 * one of them is something an OWNER must assert. Absence is modelled as absence:
 * no `contact` key means the lane has no committed contact for this foot, which
 * the core turns into suppression before any resolver runs.
 *
 * ## The contact is the slice-1 contact
 *
 * `FootContactRead` is a projection of `CommittedContactRead` and nothing else.
 * It cannot be built from an intent, a resolution, or an ended contact — the
 * contact core's types make those unassignable — so "no committed contact ⇒ no
 * observation" is enforced one layer down rather than by a check here.
 *
 * ## No pressure marks, no residue transfer, no temperature
 *
 * Deliberately missing from this frame, following the garment domain's rule that
 * carrying an input no phenomenon reads is an invitation to read it. Marks and
 * transfer are slice 4; contact temperature has no authoritative read in either
 * lane and is deferred rather than guessed.
 */

/** The body location foot observations roll up to when nothing finer applies. */
export const FOOT_LOCATION_ID = "feet";

/** Which end of a contact this foot is. Orientation, never a claim about consent. */
export const footContactRoles = ["foot_touched", "foot_touching"] as const;
export type FootContactRole = (typeof footContactRoles)[number];

export interface FootContactRead {
  readonly contactId: string;
  readonly role: FootContactRole;
  /** Where the contact sits on the foot. */
  readonly primary: FootLocusRef;
  /** The loci a moving contact crosses, in order. `[primary]` when it is still. */
  readonly path: readonly FootLocusRef[];
  readonly actionKind: ContactActionKind;
  readonly pressure?: ContactPressureBand;
  readonly contactArea?: ContactAreaBand;
  readonly motion?: ContactMotionBand;
  readonly materialBetween: readonly ContactMaterialLayerRead[];
  readonly transmission: ContactMaterialTransmissionRead;
  readonly evidence: readonly AffordanceEvidence[];
}

/** This end of the contact, when it is a foot belonging to the subject being read. */
function subjectFootEnd(ref: ContactSurfaceRef, subjectId: AffordanceSubjectId): ContactBodySurfaceRef | undefined {
  if (ref.kind !== "body") return undefined;
  if (ref.subjectId !== subjectId || !footContactLocationIds.has(ref.locationId)) return undefined;
  return ref;
}

/**
 * The surface a contact end names.
 *
 * The detail token wins; a bare registry locus falls back to the surface that
 * locus stands for. `feet` alone resolves to NOTHING — a contact on the whole
 * foot names no region, and every regional observation this domain makes needs
 * one. Choosing the sole would be picking the most narratable answer rather than
 * the true one.
 */
function surfaceOf(ref: ContactBodySurfaceRef): FootLocusRef | undefined {
  const surfaceId = footSurfaceForDetail(ref.detail) ?? footSurfaceForLocation(ref.locationId);
  return surfaceId === undefined ? undefined : footLocus(surfaceId, ref.side);
}

/**
 * Project a committed contact onto this subject's foot, or `null` when it does
 * not touch one.
 *
 * Both ends are checked, and the acting end is preferred when both are this
 * subject's feet (one foot against the other): the source is the one that moved.
 */
export function footContactFromCommitted(input: {
  contact: CommittedContactRead;
  subjectId: AffordanceSubjectId;
}): FootContactRead | null {
  const { contact } = input;
  const sourceEnd = subjectFootEnd(contact.source, input.subjectId);
  const targetEnd = subjectFootEnd(contact.target, input.subjectId);

  const end = sourceEnd ?? targetEnd;
  if (end === undefined) return null;

  const primary = surfaceOf(end);
  if (primary === undefined) return null;

  const crossed = (contact.motion?.pathDetailIds ?? []).flatMap((token) => {
    const surfaceId = footSurfaceForDetail(token);
    return surfaceId === undefined ? [] : [footLocus(surfaceId, end.side)];
  });

  return {
    contactId: contact.contactId,
    role: sourceEnd === undefined ? "foot_touched" : "foot_touching",
    primary,
    path: crossed.length > 0 ? crossed : [primary],
    actionKind: contact.actionKind,
    ...(contact.pressure === undefined ? {} : { pressure: contact.pressure }),
    ...(contact.contactArea === undefined ? {} : { contactArea: contact.contactArea }),
    ...(contact.motion === undefined ? {} : { motion: contact.motion.band }),
    materialBetween: contact.materialBetween,
    transmission: contact.transmission,
    evidence: [affordanceEvidence("contact", `contact:${contact.contactId}`, contact.actionKind)],
  };
}

// ---------------------------------------------------------------------------
// State, context, frame
// ---------------------------------------------------------------------------

/**
 * What `deriveMechanics` needs: the owner's coarse condition and what is worn.
 *
 * The COARSE read travels, not the distributed one — the distribution needs the
 * structural profile (retention and airflow are profile terms) and the staged
 * pipeline hands the profile to `deriveMechanics`. An absent `coarse` is the
 * lane saying nothing, which becomes the all-unknown condition there.
 */
export interface FootAffordanceState extends AffordanceStateSnapshot {
  readonly coarse?: FootCoarseConditionRead;
  readonly footwear?: FootwearContactRead;
  /** Committed pose per foot — read at this stage only for its effect on the toe spaces. */
  readonly articulations: readonly FootArticulationRead[];
}

/**
 * What `buildFrame` needs: the causes the phenomena check for.
 *
 * The distributed per-surface condition is deliberately NOT here. Every
 * phenomenon reads it through `mechanics`, and carrying a second copy would let
 * one resolver read a raw moisture value while another read the derived one.
 */
/**
 * Support and articulation are PER FOOT, so both are lists keyed by side rather
 * than one subject-wide answer. A single entry would make "the left foot is
 * trapped and the right is free" unrepresentable, and would let a pose read
 * describe the foot nobody is touching.
 */
export interface FootResolutionContext extends AffordanceResolutionContext {
  readonly footwear?: FootwearContactRead;
  readonly contact?: FootContactRead;
  readonly supports: readonly FootSupportRead[];
  readonly articulations: readonly FootArticulationRead[];
  /** The lane positively asserted a tactile channel for the toucher. */
  readonly tactile: boolean;
  readonly evidence: readonly AffordanceEvidence[];
}

export interface FootAffordanceFrame extends DomainFrame<FootStructuralProfile, FootEffectiveMechanics> {
  readonly footwear?: FootwearContactRead;
  readonly contact?: FootContactRead;
  readonly supports: readonly FootSupportRead[];
  readonly articulations: readonly FootArticulationRead[];
  readonly tactile: boolean;
}

export function buildFootFrame(
  profile: FootStructuralProfile,
  mechanics: FootEffectiveMechanics,
  context: FootResolutionContext,
): FootAffordanceFrame {
  return {
    subjectId: context.subjectId,
    storyTime: context.storyTime,
    profile,
    mechanics,
    evidence: context.evidence,
    ...(context.footwear === undefined ? {} : { footwear: context.footwear }),
    ...(context.contact === undefined ? {} : { contact: context.contact }),
    supports: context.supports,
    articulations: context.articulations,
    tactile: context.tactile,
  };
}
