import { z } from "zod";
import { surfaceDepositKindSchema, type SurfaceDepositKind } from "../../materials/surface-deposits";
import {
  affordanceEvidence,
  AFFORDANCE_UNIT_ONE,
  unitIntervalSchema,
  type AffordanceEvidence,
  type AffordanceStoryTime,
  type AffordanceSubjectId,
  type UnitInterval,
} from "../core";
import { CONTACT_KEY_FIELD_SEPARATOR } from "./identity";
import type { ContactBodySurfaceRef } from "./surfaces";
import type { CommittedContactRead, ContactMotionBand, ContactPressureBand } from "./types";

/**
 * Conserved surface transfer — the proposal, and the two owner-backed reads it
 * is not allowed to author (romantic-contact-affordances.spec.effects.md §9,
 * §15 stage 8; owner rulings 2026-08-25 and 2026-08-26).
 *
 * A transfer says: *this much of this substance left that surface, and all of
 * it arrived somewhere*. That is a stronger proof than the pressure mark
 * precisely because it spans owners and has to be atomic — and it is the reason
 * this module authors almost nothing.
 *
 * **Contact holds none of the three truths a transfer needs.** It knows a
 * contact was committed. It does not know what material is on the source
 * surface, because the body-surface owner holds that and the import direction
 * runs the other way (`effects.ts` header). It does not know what a layer lets
 * through, because the wardrobe/material owner holds that. So the producer
 * takes all three as arguments and combines them:
 *
 * ```text
 * committed contact  +  source material read  +  resolved path
 *          \                    |                     /
 *           +--------- surfaceTransferProposals ------+
 *                              |
 *                    a proposal, which is not truth
 * ```
 *
 * **Throughput is not moisture.** `ContactMaterialLayerRead` already carries a
 * `moistureTransmission` channel, and reusing it here was the tempting move —
 * it composes, it is plumbed, and the chat lane's zero is exactly the blocker
 * §15 stage 8 names. It would also have been wrong. Moisture transmission
 * answers "does dampness reach the other side"; a substance moving through a
 * layer is a different question with a different answer per substance, and
 * coupling them would mean that retuning how cotton carries damp silently
 * retunes how dust travels through it. So a transfer path carries its own
 * per-layer, per-substance `throughput`, on the same unit algebra and with the
 * same ordering discipline, and nothing else.
 *
 * **The path is resolved, not intrinsic.** `throughput` is the effective answer
 * for *this* material crossing *this* layer under *this* contact, not a
 * constant on a fabric. Its eventual owner is wardrobe/material mechanics; for
 * the fixture-only proof, fixtures stand in for that owner, and a lane that
 * cannot answer supplies no path and proposes no transfer. `absorbency` is not
 * this number and never was — it says how much water a fibre takes UP from a
 * wetting source, not what passes through it.
 */

// ---------------------------------------------------------------------------
// The two reads contact is handed
// ---------------------------------------------------------------------------

/**
 * What is actually on the source surface, as the surface's own owner reports
 * it.
 *
 * `depositId` is the load-bearing field. A transfer moves ONE named substance
 * off ONE record, and the body-surface owner's general removal path takes the
 * same amount off every substance standing at a location — so a proposal that
 * addressed a location rather than a record would move the mud and destroy the
 * blood standing beside it.
 */
export interface SurfaceTransferMaterialRead {
  /** The owner's own record identity for this material. Opaque here. */
  readonly depositId: string;
  readonly kind: SurfaceDepositKind;
  /** Where it stands — the contact's own source surface. */
  readonly locus: ContactBodySurfaceRef;
  /** How much of it stands there right now, in fixed point. */
  readonly amount: number;
  readonly evidence: readonly AffordanceEvidence[];
}

export const surfaceTransferMaterialReadSchema: z.ZodType<SurfaceTransferMaterialRead> = z.object({
  depositId: z.string().trim().min(1).max(512),
  kind: surfaceDepositKindSchema,
  locus: z.custom<ContactBodySurfaceRef>(),
  amount: z.number().int().min(1).max(AFFORDANCE_UNIT_ONE),
  evidence: z.array(z.custom<AffordanceEvidence>()).readonly(),
});

/**
 * One interposed layer a transfer must cross, addressed the way its OWNER
 * addresses it.
 *
 * `ContactMaterialLayerRead` deliberately carries a coverage-region id, because
 * a sensory channel only needs to know something is in the way. A transfer has
 * to put material ONTO that something, so the handle carried here has to be one
 * the interposed thing's own owner can validate and credit. That is the second
 * of the three gaps §15 stage 8 names — the chat lane's layers carry a
 * coverage-region identity rather than an owner-addressable one — and it is why
 * that lane resolves no path today.
 */
export interface SurfaceTransferPathLayer {
  /**
   * The owner's own handle for this layer. **Opaque here**, exactly as
   * `ContactMaterialLayerRead.layerId` is opaque, and for a reason this layer's
   * own neutrality test enforces: contact may not learn what a layer is made
   * of, who tailors it, or how its owner addresses a part of it. The lane that
   * resolved the path knows that mapping, and the lane's transaction is where
   * it is used.
   */
  readonly layerId: string;
  /** 0 is nearest the SOURCE surface. Ties break on `layerId`, so order is total. */
  readonly order: number;
  /**
   * How much of THIS substance survives THIS crossing, in unit fixed point.
   * `0` means the layer keeps all of it; `AFFORDANCE_UNIT_ONE` means it passes
   * untouched.
   */
  readonly throughput: UnitInterval;
  readonly evidence: readonly AffordanceEvidence[];
}

export const surfaceTransferPathLayerSchema: z.ZodType<SurfaceTransferPathLayer> = z.object({
  layerId: z.string().trim().min(1).max(256),
  order: z.number().int().min(-1_000).max(1_000),
  throughput: unitIntervalSchema,
  evidence: z.array(z.custom<AffordanceEvidence>()).readonly(),
});

/**
 * The whole crossing, source surface to destination surface.
 *
 * An EMPTY layer list is the meaningful common case: skin on skin, everything
 * that leaves arrives. It is not the same as an absent path, which is the lane
 * saying it cannot answer — and an unanswerable path proposes nothing rather
 * than guessing that nothing is in the way.
 */
export interface ResolvedSurfaceTransferPath {
  readonly layers: readonly SurfaceTransferPathLayer[];
  /** The surface the material would end up on, when anything gets through. */
  readonly destination: ContactBodySurfaceRef;
  readonly evidence: readonly AffordanceEvidence[];
}

/** Layers in a total, deterministic order, so a retake resolves the identical path. */
export function sortSurfaceTransferPathLayers(
  layers: readonly SurfaceTransferPathLayer[],
): readonly SurfaceTransferPathLayer[] {
  return [...layers].sort((left, right) =>
    left.order === right.order ? left.layerId.localeCompare(right.layerId) : left.order - right.order,
  );
}

// ---------------------------------------------------------------------------
// The proposal
// ---------------------------------------------------------------------------

/**
 * A requested conserved transfer (effects spec §6's required fields, §9's law).
 *
 * `amount` is an INTENT, not a promise. The owner transaction re-reads the
 * source record inside its own transactional cut and takes what is actually
 * there, which may be less; the amount that genuinely left is what every
 * destination leg is then sized from. A proposal that promised an exact
 * quantity the source no longer has would be a proposal that could only be
 * honoured by inventing material.
 */
export interface SurfaceTransferProposal {
  readonly kind: "surface_transfer";
  /**
   * Stable idempotency key, derived from the causal contact event and the
   * source record. Covers the whole settlement — source debit, every
   * intermediate credit, and the destination credit are one identity, because
   * §9's atomicity law has nothing to attach to if the legs are keyed apart.
   */
  readonly idempotencyKey: string;
  /** Whose surface the material leaves. */
  readonly sourceSubjectId: AffordanceSubjectId;
  /** Whose surface it would land on. */
  readonly targetSubjectId: AffordanceSubjectId;
  /** The exact source record and locus, as its owner reported it. */
  readonly material: SurfaceTransferMaterialRead;
  /** The resolved crossing, in deterministic order. */
  readonly path: ResolvedSurfaceTransferPath;
  /** How much contact asks to move, in fixed point. The transaction may move less. */
  readonly amount: number;
  /** The committed pressure that qualified the move — mechanics evidence, verbatim. */
  readonly pressure: ContactPressureBand;
  /** The committed motion band, when the contact carried one. Evidence only. */
  readonly motionBand?: ContactMotionBand;
  readonly storyTime: AffordanceStoryTime;
  readonly evidence: readonly AffordanceEvidence[];
}

// ---------------------------------------------------------------------------
// The producer (effects spec §9)
// ---------------------------------------------------------------------------

/**
 * The QUALIFYING RULE, and the fraction of the standing material each committed
 * band moves.
 *
 * Pressure alone qualifies, on the pressure mark's own vocabulary and for its
 * reason: `trace`, `light`, and UNSTATED pressure move nothing, and unstated is
 * the load-bearing case, because an unknown pressure is not a light one. Motion
 * cannot qualify a transfer by itself — a hand resting still on a muddy knee
 * has moved nothing — but a committed glide over a surface takes more of what
 * is there than a still press does, so it raises the fraction where it exists.
 *
 * These are the OWNER-side numbers in the same sense as the deposit band table:
 * a producer cannot state a magnitude, it can only present committed mechanics
 * and let this table say what they mean.
 */
const TRANSFER_PRESSURE_FRACTION: Readonly<Partial<Record<ContactPressureBand, number>>> = {
  moderate: 2_500,
  firm: 5_000,
};

/**
 * What committed motion adds to the fraction.
 *
 * Only RELATIVE motion is in this table, and that is §16's "no relative motion
 * -> no glide" expressed as data: `still` and `pressing` are absent, because a
 * hand bearing down without travelling has taken nothing off the surface it is
 * resting on, however hard it presses.
 */
const TRANSFER_MOTION_BONUS: Readonly<Partial<Record<ContactMotionBand, number>>> = {
  sliding: 2_500,
  rolling: 2_000,
  tapping: 1_000,
};

/**
 * Below this, there is nothing worth moving and no proposal is made. Not the
 * body-surface owner's removal floor, which is washing's cleanup policy — this
 * is the smaller question of whether a beat is worth proposing at all.
 */
export const SURFACE_TRANSFER_MIN_AMOUNT = 250;

/**
 * The conserved transfers one committed contact proposes, given what its source
 * surface carries and what the crossing lets through: at most one, for the one
 * material it was handed.
 *
 * Pure and total over its three inputs — same reads, same proposal, same
 * idempotency key, which is what makes a retake's replay land on the identical
 * settlement (effects spec §13). It fails closed on every axis (§14):
 *
 * - an OBJECT target proposes nothing, because furniture has no surface owner;
 * - a target that is not the path's destination proposes nothing, since a
 *   crossing that ends somewhere other than what was touched is not this
 *   contact's transfer;
 * - a source locus that is not the contact's own source surface proposes
 *   nothing — contact may not move material off a surface it did not commit;
 * - pressure must be committed at a qualifying band;
 * - the material must still be there, and the qualifying fraction of it must
 *   clear `SURFACE_TRANSFER_MIN_AMOUNT`.
 *
 * Note what is NOT a refusal here: a fully blocking layer. `throughput: 0` is a
 * perfectly ordinary transfer whose destination happens to be the garment
 * (§9's "an intermediate garment receives material when path says it does").
 * A blocking layer stops material reaching skin; it does not stop it moving.
 */
export function surfaceTransferProposals(input: {
  contact: CommittedContactRead;
  material: SurfaceTransferMaterialRead;
  path: ResolvedSurfaceTransferPath;
}): readonly SurfaceTransferProposal[] {
  const { contact, material, path } = input;
  if (contact.target.kind !== "body") return [];
  if (contact.pressure === undefined) return [];
  if (material.locus.subjectId !== contact.source.subjectId) return [];
  if (material.locus.locationId !== contact.source.locationId) return [];
  if (path.destination.subjectId !== contact.target.subjectId) return [];
  if (path.destination.locationId !== contact.target.locationId) return [];
  const pressureFraction = TRANSFER_PRESSURE_FRACTION[contact.pressure];
  if (pressureFraction === undefined) return [];
  const motionBonus = contact.motion === undefined ? 0 : (TRANSFER_MOTION_BONUS[contact.motion.band] ?? 0);
  const fraction = Math.min(AFFORDANCE_UNIT_ONE, pressureFraction + motionBonus);
  const amount = Math.floor((material.amount * fraction) / AFFORDANCE_UNIT_ONE);
  if (amount < SURFACE_TRANSFER_MIN_AMOUNT) return [];
  return [
    {
      kind: "surface_transfer",
      // The source RECORD is in the key, not just the contact: one committed
      // press can move mud and blood off the same hand as two conserved events,
      // and keying them together would make the second one look like a retry.
      idempotencyKey: ["surface_transfer", contact.contactId, contact.lastUpdatedByEventRef, material.depositId].join(
        CONTACT_KEY_FIELD_SEPARATOR,
      ),
      sourceSubjectId: contact.source.subjectId,
      targetSubjectId: contact.target.subjectId,
      material,
      path: { ...path, layers: sortSurfaceTransferPathLayers(path.layers) },
      amount,
      pressure: contact.pressure,
      ...(contact.motion === undefined ? {} : { motionBand: contact.motion.band }),
      storyTime: contact.lastUpdatedAt,
      evidence: [
        affordanceEvidence("contact", contact.contactId, contact.pressure),
        ...(contact.motion === undefined ? [] : [affordanceEvidence("contact", "motion", contact.motion.band)]),
        ...material.evidence,
        ...path.evidence,
      ],
    },
  ];
}
