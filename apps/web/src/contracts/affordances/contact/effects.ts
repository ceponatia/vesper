import { affordanceEvidence, type AffordanceEvidence, type AffordanceIntensityBand, type AffordanceStoryTime, type AffordanceSubjectId } from "../core";
import { CONTACT_KEY_FIELD_SEPARATOR } from "./identity";
import type { ContactBodySurfaceRef } from "./surfaces";
import type { SurfaceTransferProposal } from "./transfer";
import type { CommittedContactRead, ContactMotionBand, ContactPressureBand } from "./types";

/**
 * Effect proposals — contact's requests for owner-committed aftermath.
 *
 * A proposal is NOT truth. Contact calculates that a committed contact could
 * leave something behind; the destination state owner validates current state
 * and commits its own transaction, or refuses. Nothing here mutates anything,
 * nothing here is observable, and nothing here carries narrator text — the
 * three-layer boundary in one sentence.
 *
 * The union has TWO implemented members: the pressure mark (first proof) and
 * the conserved surface transfer (second proof, in `transfer.ts`).
 * Transfer joined on 2026-08-26 with its complete proposal → owner-transaction
 * path, and it is FIXTURE-ONLY by owner ruling (2026-08-25). The third of the
 * three known gaps is closed — a transfer-bearing settle now writes
 * every row it touched inside one database transaction — but the first two are
 * open: the player and ensemble members still have no body-surface owner, and
 * the chat lane's contact layers still carry a coverage-region identity rather
 * than an owner-addressable one. So no chat-lane pairing resolves a source
 * material read or a path, and nothing in production proposes one.
 *
 * The remaining proposal families stay deliberately absent rather than
 * stubbed. A standalone `GarmentOperationProposal` waits on the contact→
 * wardrobe operation seam — note that a transfer's intermediate leg is NOT one
 * of those: it is one leg of a single indivisible conserved event, and splitting
 * it into a second proposal would make the transfer's atomicity impossible to
 * state. `ScratchProposal` waits on an owner that does not exist at all — a type
 * with no owner behind it is exactly the "pressure mark and scratch are not
 * synonyms" smuggling path this union forbids. A new member joins it when its
 * complete proposal → owner-transaction path ships.
 */

// ---------------------------------------------------------------------------
// The proposal
// ---------------------------------------------------------------------------

/**
 * The mark kinds contact knows how to PROPOSE. Contact's own token, distinct
 * from the body-surface owner's vocabulary on purpose (the owner may not be
 * imported from here — import direction runs the other way): the owner
 * transaction validates every proposed kind against its own closed vocabulary,
 * so a kind named here that no owner supports commits nothing.
 */
export const contactMarkKinds = ["pressure"] as const;
export type ContactMarkKind = (typeof contactMarkKinds)[number];

/**
 * A requested temporary body mark. Everything a complete proposal carries and
 * nothing more: identity, the two owners, the exact locus, a semantic band, the
 * mechanics evidence behind it, and story time. No narrator text, ever.
 */
export interface BodyMarkProposal {
  readonly kind: "body_mark";
  /**
   * Stable idempotency key, derived from the causal contact event — the same
   * committed contact proposes the same key on every replay, and the owner
   * commits a given key at most once.
   */
  readonly idempotencyKey: string;
  /** Who made the contact — the acting side's owner identity. */
  readonly sourceSubjectId: AffordanceSubjectId;
  /** Whose body would carry the mark — the owner the proposal is addressed to. */
  readonly targetSubjectId: AffordanceSubjectId;
  /** The exact locus the mark would occupy: the committed contact's own target surface. */
  readonly locus: ContactBodySurfaceRef;
  readonly markKind: ContactMarkKind;
  /** Semantic magnitude, in the shared intensity vocabulary. The owner maps it to its own scale. */
  readonly magnitudeBand: AffordanceIntensityBand;
  /** The committed pressure that qualified the mark — mechanics evidence, verbatim. */
  readonly pressure: ContactPressureBand;
  /** The committed motion band, when the contact carried one. Evidence only. */
  readonly motionBand?: ContactMotionBand;
  /** Whether the committed transmission reached skin — the qualifying path fact. */
  readonly directSkinContact: boolean;
  /** The causal event's story time. */
  readonly storyTime: AffordanceStoryTime;
  readonly evidence: readonly AffordanceEvidence[];
}

/** The effect-proposal union. One member per shipped proposal → owner-transaction path (see the header). */
export type ContactEffectProposal = BodyMarkProposal | SurfaceTransferProposal;

// ---------------------------------------------------------------------------
// The pressure-mark producer
// ---------------------------------------------------------------------------

/**
 * The QUALIFYING RULE, from the contact core's own committed vocabulary:
 *
 * - `firm` committed pressure proposes a `strong` mark;
 * - `moderate` proposes a `clear` one;
 * - `trace`, `light`, and UNSTATED pressure propose nothing. Unstated is the
 *   load-bearing case — an unknown pressure is not a trace press (the
 *   `CommittedContactRead` doc's own law), so it cannot be the lightest thing
 *   that would still mark.
 */
const MARKING_PRESSURE: Readonly<Partial<Record<ContactPressureBand, AffordanceIntensityBand>>> = {
  moderate: "clear",
  firm: "strong",
};

/**
 * The pressure marks one committed contact proposes: at most one, at the
 * contact's own target surface.
 *
 * Pure and total over `CommittedContactRead` — same committed read, same
 * proposals, same idempotency key, which is what makes a retake's replay land
 * on the identical owner write. The rule fails closed on every axis:
 *
 * - an OBJECT target proposes nothing — furniture has no body to mark;
 * - pressure must be committed at a qualifying band (see `MARKING_PRESSURE`);
 * - the committed transmission must reach skin (`directSkinContact`). Pressure
 *   through fabric is filtered by a material model nobody owns yet, and a
 *   coarse guess here would be exactly the pretend physics the contact core
 *   refuses to tune in.
 *
 * The idempotency key joins the contact's identity to the event that last
 * committed its mechanics: a retried exchange re-derives the same key (no
 * duplicate), while a later update that re-commits qualifying pressure is a
 * NEW physical event with its own key — pressing harder again marks again.
 */
export function contactMarkProposals(contact: CommittedContactRead): readonly BodyMarkProposal[] {
  if (contact.target.kind !== "body") return [];
  if (contact.pressure === undefined) return [];
  const magnitudeBand = MARKING_PRESSURE[contact.pressure];
  if (magnitudeBand === undefined) return [];
  if (!contact.transmission.directSkinContact) return [];
  return [
    {
      kind: "body_mark",
      idempotencyKey: ["body_mark", contact.contactId, contact.lastUpdatedByEventRef].join(
        CONTACT_KEY_FIELD_SEPARATOR,
      ),
      sourceSubjectId: contact.actorId,
      targetSubjectId: contact.target.subjectId,
      locus: contact.target,
      markKind: "pressure",
      magnitudeBand,
      pressure: contact.pressure,
      ...(contact.motion === undefined ? {} : { motionBand: contact.motion.band }),
      directSkinContact: contact.transmission.directSkinContact,
      storyTime: contact.lastUpdatedAt,
      evidence: [
        affordanceEvidence("contact", contact.contactId, contact.pressure),
        ...(contact.motion === undefined ? [] : [affordanceEvidence("contact", "motion", contact.motion.band)]),
        affordanceEvidence("coverage", "transmission", "direct_skin"),
      ],
    },
  ];
}
