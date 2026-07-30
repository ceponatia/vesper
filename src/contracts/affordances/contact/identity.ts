import { z } from "zod";

/**
 * Lane-neutral identity for the contact core
 * (romantic-contact-affordances.spec.contact-core.md §"Boundary").
 *
 * Three ids, all opaque strings the core never interprets:
 *
 * - `ContactId` — one contact's identity, **derived** rather than minted, so the
 *   same committed inputs always produce the same id. No counter, no clock, no
 *   randomness: a retake that replays the same attempt against the same cut has
 *   to reproduce the identical id or the capture fingerprints diverge.
 * - `ContactEventRef` — the lane's own id for the event that started, updated,
 *   or ended a contact. The successor lane has a branded `EventId`; legacy chat
 *   has message ids and nothing else. Binding the core to either would fork it,
 *   so the core takes a string and stores it verbatim.
 * - `ContactEntityId` — a non-character surface owner (furniture, a wall). A
 *   character is always an `AffordanceSubjectId`; this is the other case.
 *
 * Keys are joined with control characters (`U+001F` between fields, `U+001E`
 * between the two surfaces of a pair) for the same reason the guidance
 * fingerprint does it: a separator that cannot occur inside an id is the only
 * way `["ab","c"]` and `["a","bc"]` are guaranteed not to collide.
 */

const idTextSchema = z.string().trim().min(1).max(256);

/** Field separator inside one surface key. */
export const CONTACT_KEY_FIELD_SEPARATOR = "\u001F";
/** Separator between the two surface keys of a pair. */
export const CONTACT_KEY_PAIR_SEPARATOR = "\u001E";
/** Separator between a pair key and the event that started the contact. */
export const CONTACT_ID_EVENT_SEPARATOR = "\u001D";

/**
 * A committed contact's identity. Wider than the other ids because it is a
 * derived composite (pair key + start event), and truncating it would let two
 * different contacts share an id.
 */
export const contactIdSchema = z.string().trim().min(1).max(1024).brand<"ContactId">();
export type ContactId = z.infer<typeof contactIdSchema>;

/** Construct a contact id. A blank id is a caller bug, not degraded data — it throws. */
export function contactId(raw: string): ContactId {
  return contactIdSchema.parse(raw);
}

/** The lane's id for a lifecycle event. Carried, never parsed. */
export const contactEventRefSchema = idTextSchema.brand<"ContactEventRef">();
export type ContactEventRef = z.infer<typeof contactEventRefSchema>;

export function contactEventRef(raw: string): ContactEventRef {
  return contactEventRefSchema.parse(raw);
}

/** A non-character surface owner. Characters use `AffordanceSubjectId`. */
export const contactEntityIdSchema = idTextSchema.brand<"ContactEntityId">();
export type ContactEntityId = z.infer<typeof contactEntityIdSchema>;

export function contactEntityId(raw: string): ContactEntityId {
  return contactEntityIdSchema.parse(raw);
}

/**
 * The active-projection key for one contact: the two surfaces, order-independent.
 *
 * Order-independent on purpose. "The player's hand on her arch" and "her arch
 * against the player's hand" are ONE touch; keying by the acting direction would
 * let a role swap open a second contact on the same pair of surfaces, and then
 * both would report pressure. The committed read still remembers which side
 * acted — that is the `source`/`target` orientation, fixed at start and never
 * patched.
 */
export function contactPairKeyOf(left: string, right: string): string {
  return left <= right
    ? `${left}${CONTACT_KEY_PAIR_SEPARATOR}${right}`
    : `${right}${CONTACT_KEY_PAIR_SEPARATOR}${left}`;
}

/**
 * A contact's id, derived from its pair key and the event that started it.
 *
 * Including the start event is what makes a contact that ended and started again
 * a NEW contact rather than a resurrection of the old one: the same two surfaces
 * touching after a separation is a different physical fact, and its cue history
 * should start fresh.
 */
export function deriveContactId(input: { pairKey: string; startedByEventRef: ContactEventRef }): ContactId {
  return contactId(`${input.pairKey}${CONTACT_ID_EVENT_SEPARATOR}${input.startedByEventRef}`);
}
