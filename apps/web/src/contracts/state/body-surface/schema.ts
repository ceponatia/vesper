// One stored body-surface domain; its laws are documented in state/body-surface.ts.
import { z } from "zod";
import { FIXED_POINT_ONE } from "@/lib/fixed-point";
import { surfaceDepositKindSchema } from "../../materials/surface-deposits";

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/**
 * How a surface got wet. CLOSED vocabulary — the extraction may only pick from
 * it, and the affordance adapter maps a subset onto the hair domain's committed
 * causal events. `other` exists so a real wetting the fiction did not explain
 * ("she comes back from the kitchen with damp hair") is still recorded as wet
 * without inventing weather.
 */
export const bodySurfaceWetnessCauses = ["rain", "immersion", "splash", "other"] as const;
export const bodySurfaceWetnessCauseSchema = z.enum(bodySurfaceWetnessCauses);
export type BodySurfaceWetnessCause = z.infer<typeof bodySurfaceWetnessCauseSchema>;

/** `1.0` on the shared fixed-point scale — a soaked surface. */
export const BODY_SURFACE_UNIT_ONE = FIXED_POINT_ONE;

/** Max wetness entries one character's surface retains (bounded jsonb, no eviction policy needed). */
export const BODY_SURFACE_MAX_LOCATIONS = 32;

export const SECONDS_PER_MINUTE = 60;

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

/** A body-location id (`bodyLocationRegistry`), kept as a loose key so a future location never breaks a stored row. */
const locationKeySchema = z.string().trim().min(1).max(64);

/**
 * One location's standing wetness — the VALID shape.
 *
 * `level` and `updatedAtMinutes` are deliberately **strict**. There is no
 * conservative repair for a magnitude: healing a corrupt level to `0` reads as
 * "known dry", and dry hair has *higher* mobility than wet hair, so the repair
 * would buy a wind-motion cue where the honest answer is silence — precisely the
 * "invalid must never become a convenient default" law the affordance core is
 * built on. An entry that fails here is quarantined, not repaired and not
 * dropped (see `wetnessRecordSchema`).
 *
 * `cause` stays lenient because it is PROVENANCE only: it can add a tag to an
 * observation and nothing else, so degrading it to "no recorded reason" is
 * strictly conservative.
 */
export const bodySurfaceWetnessSchema = z.object({
  /** Fixed point `0 … BODY_SURFACE_UNIT_ONE`. */
  level: z.number().int().min(0).max(BODY_SURFACE_UNIT_ONE),
  /** Story minute this location's wetness last CHANGED — the drying anchor AND the cause's freshness stamp. */
  updatedAtMinutes: z.number().int().min(0),
  cause: bodySurfaceWetnessCauseSchema.optional().catch(undefined),
});
export type BodySurfaceWetness = z.infer<typeof bodySurfaceWetnessSchema>;

/**
 * The quarantine marker a corrupt entry becomes. It ROUND-TRIPS: the next save
 * writes it back verbatim and the next load parses it back to itself, because
 * persisting it is the honest record — that location's wetness data is gone and
 * pretending otherwise is the bug.
 */
export const bodySurfaceInvalidEntrySchema = z.object({ status: z.literal("invalid") });
export type BodySurfaceInvalidEntry = z.infer<typeof bodySurfaceInvalidEntrySchema>;
/** Frozen: every quarantined slot shares this one value, so nothing may edit it into a level. */
export const BODY_SURFACE_INVALID_ENTRY: BodySurfaceInvalidEntry = Object.freeze({ status: "invalid" } as const);

/**
 * The second quarantine marker: the stored KEY could not be assigned to a
 * location, so nobody knows which part of the body this row was ever about.
 *
 * It carries `scope: "key"` rather than reusing `BODY_SURFACE_INVALID_ENTRY`
 * because the two failures have different BLAST RADIUS and a reader has to be
 * able to tell them apart (law 4). A corrupt value is confined to the location
 * its key names; an unassignable key has unknown scope, and that is what makes
 * every absence in the same record unsafe to read as dry. It is a superset of
 * the value marker on purpose — `isInvalidSurfaceEntry` answers `true` for both,
 * so no caller can spend either as a level.
 */
export interface BodySurfaceUnusableKeyEntry {
  readonly status: "invalid";
  readonly scope: "key";
}
/** Frozen for the value marker's reason: one shared value nothing may edit into a level. */
export const BODY_SURFACE_UNUSABLE_KEY_ENTRY: BodySurfaceUnusableKeyEntry = Object.freeze({
  status: "invalid",
  scope: "key",
} as const);

/** One stored slot: a parsed wetness record, or either quarantine marker. */
export type BodySurfaceEntry = BodySurfaceWetness | BodySurfaceInvalidEntry | BodySurfaceUnusableKeyEntry;

/** True for BOTH markers — unreadable is unreadable, whichever half of the row died. */
export function isInvalidSurfaceEntry(
  entry: BodySurfaceEntry,
): entry is BodySurfaceInvalidEntry | BodySurfaceUnusableKeyEntry {
  return "status" in entry;
}

/** True only for the key marker — the one failure whose scope is unknown. */
export function isUnusableSurfaceKeyEntry(entry: BodySurfaceEntry): entry is BodySurfaceUnusableKeyEntry {
  return "scope" in entry;
}

/**
 * Item-lenient by construction (docs/resilience.md §3), and **quarantining rather
 * than dropping**: one corrupt location can never void a character's whole
 * surface state, and it can never silently become a physical claim either.
 *
 * Dropping was the original design and it was wrong, because ABSENT already
 * means something specific and true — *nothing ever recorded wetting this
 * location*, i.e. dry. Deleting a corrupt entry launders "we do not know" into
 * "we know she is dry". So a failed entry is replaced by
 * `BODY_SURFACE_INVALID_ENTRY`, every read is forced to handle it, and an
 * authoritative write (a fresh proposal) is what heals it.
 *
 * **The KEY is validated per entry, and never by `z.record`'s key schema.** A
 * key schema rejects the whole RECORD rather than the entry that carried the bad
 * key — measured, one stored `""` or one 80-character key voided a whole
 * character's surface state, valid siblings included, and the field's `.catch({})`
 * left nothing behind to say so. That is catastrophic HERE in a way it is not in
 * the three identity-keyed modules beside it: this record's absence default is a
 * physical CLAIM. Losing it does not merely forget that hair was soaked, it
 * asserts that hair is dry, and dry hair carries mobility that wet hair does not.
 * A corrupt jsonb row would have bought a wind-motion cue.
 *
 * The bound is this module's own — `locationKeySchema`'s 64, deliberately not the
 * 512 the mark/deposit/transfer identities use. A body location is a registry id,
 * not an event identity.
 *
 * **A stored key is accepted only under EXACTLY the identity it was written
 * under.** `locationKeySchema` trims, so the comparison below is what refuses a
 * padded key rather than silently trimming `"  hair  "` into the real `hair`.
 * Normalisation belongs at a write boundary; persisted authority is read as
 * written. Nothing in the write path can emit a padded key, which makes the strict
 * reading stronger rather than weaker: a stored `"  hair  "` is not another
 * spelling this code produces, it is data whose intended identity nobody knows.
 * Do NOT add a compatibility repair here. If one is ever needed it has to be an
 * explicit upcaster with defined collision rules, because `"hair"` and
 * `"  hair  "` standing in one stored record would otherwise collapse into a
 * single identity and object iteration order would decide which physical state
 * survived.
 */
const wetnessRecordSchema = z
  .record(z.string(), z.unknown())
  .catch({})
  .default({})
  .transform((raw) => {
    const wetness: Record<string, BodySurfaceEntry> = {};
    for (const [locationId, value] of Object.entries(raw).slice(0, BODY_SURFACE_MAX_LOCATIONS)) {
      const key = locationKeySchema.safeParse(locationId);
      if (!key.success || key.data !== locationId) {
        // Under its OWN raw key: dropping it would claim the row never existed,
        // and truncating or trimming it would invent an identity. The read law
        // in `bodySurfaceWetnessAt` is the other half of this — an unassignable
        // key could have named any location, so it also stops absence in this
        // record from reading as dry.
        wetness[locationId] = BODY_SURFACE_UNUSABLE_KEY_ENTRY;
        continue;
      }
      const parsed = bodySurfaceWetnessSchema.safeParse(value);
      wetness[locationId] = parsed.success ? parsed.data : BODY_SURFACE_INVALID_ENTRY;
    }
    return wetness;
  });

// ---------------------------------------------------------------------------
// Marks — vocabulary and shape
// ---------------------------------------------------------------------------

/**
 * The mark kinds this owner supports. CLOSED vocabulary, one member: the
 * pressure mark is the first end-to-end effect proof, and
 * scratch/skin damage is EXPLICITLY not a member — it has no owner, and a
 * stored `"scratch"` must quarantine rather than ride in as a pressure mark.
 * Adding a kind is a data edit here plus an owner ruling, never a schema
 * migration.
 */
export const bodySurfaceMarkKinds = ["pressure"] as const;
export const bodySurfaceMarkKindSchema = z.enum(bodySurfaceMarkKinds);
export type BodySurfaceMarkKind = z.infer<typeof bodySurfaceMarkKindSchema>;

/** The semantic bands a mark reads in. Shared shape with the affordance intensity trio on purpose. */
export const bodySurfaceMarkBands = ["subtle", "clear", "strong"] as const;
export type BodySurfaceMarkBand = (typeof bodySurfaceMarkBands)[number];

/** Max mark entries one character retains (bounded jsonb; faded marks prune on write). */
export const BODY_SURFACE_MAX_MARKS = 16;

/**
 * The idempotency-identity key a mark record is stored under. Bounded so a
 * hostile blob cannot grow the jsonb without limit; the owner transaction
 * REFUSES an over-long key rather than truncating it, because a truncated
 * identity is two different events sharing one slot.
 */
export const BODY_SURFACE_MARK_ID_MAX_LENGTH = 512;

/**
 * One committed mark — the VALID shape. `magnitude`, `createdAtMinutes`, and
 * `kind` are all **strict**, for the wetness level's exact reason: each one is
 * either a state-moving number or the vocabulary fence itself, and a repair
 * would let corruption (or an unowned kind like scratch) buy a visible claim.
 * `side`/`detail` are lenient PROVENANCE — the exact-locus tokens the contact
 * core carried, degradable to "unstated" with nothing lost but a tag.
 */
export const bodySurfaceMarkSchema = z.object({
  /** A body-location id (`bodyLocationRegistry`), loose like the wetness keys. */
  locationId: locationKeySchema,
  kind: bodySurfaceMarkKindSchema,
  /** Fixed point `1 … BODY_SURFACE_UNIT_ONE` at creation. Zero never persists — a faded mark is pruned. */
  magnitude: z.number().int().min(1).max(BODY_SURFACE_UNIT_ONE),
  /** Story minute the mark was committed — the fade anchor, never restamped (law 7). */
  createdAtMinutes: z.number().int().min(0),
  side: z.string().trim().min(1).max(64).optional().catch(undefined),
  detail: z.string().trim().min(1).max(64).optional().catch(undefined),
});
export type BodySurfaceMark = z.infer<typeof bodySurfaceMarkSchema>;

/** One stored mark slot: a parsed mark, or the shared quarantine marker. */
export type BodySurfaceMarkSlot = BodySurfaceMark | BodySurfaceInvalidEntry;

export function isInvalidMarkSlot(slot: BodySurfaceMarkSlot): slot is BodySurfaceInvalidEntry {
  return "status" in slot;
}

/**
 * The record shape all three identity-keyed modules share — marks, deposits and
 * transfer receipts. Item-lenient and quarantining exactly like the wetness
 * record: one corrupt mark can neither void the record nor become a visible
 * mark, and a stored kind outside the vocabulary (the smuggled-scratch case)
 * fails the item and lands in quarantine rather than reading as the nearest
 * supported thing.
 *
 * **The KEY is validated per item, deliberately, because a record-level key
 * rejection is silently catastrophic.** `z.record`'s key schema rejects the
 * whole RECORD, not the entry that carried the bad key — and every field that
 * uses this shape is `.optional().catch(undefined)`, so one stored key that is
 * empty or past `BODY_SURFACE_MARK_ID_MAX_LENGTH` used to swallow the failure
 * and leave the record ABSENT, deleting every valid sibling with nothing on the
 * record to say so. What that costs is different in each module:
 *
 * - `transfers` — an absent record makes `bodySurfaceTransferCommitted` answer
 *   `false` for a transfer that already committed, so the settlement debits and
 *   credits a second time. That defeats "a retry cannot
 *   transfer twice" in the exact direction this module is built to avoid: the
 *   item-level quarantine answers `true` on purpose, so an unreadable receipt
 *   SUPPRESSES a re-run, and a record-level rejection threw that decision away.
 * - `deposits` — one bad key and every deposit on that body silently vanishes,
 *   which is the unowned sink this owner must not become; the conservation law
 *   leans on that staying true.
 * - `marks` — same shape, same class.
 *
 * So an entry whose key fails the bounds keeps its OWN key and holds
 * `BODY_SURFACE_INVALID_ENTRY`. Not dropped — absence is a claim here ("no
 * mark", "clean", "never transferred"), and laundering unknown into it is the
 * thing the marker exists to prevent. Not truncated either, for the reason the
 * owner transaction refuses an over-long key rather than shortening it: a
 * truncated identity is two different events sharing one slot.
 *
 * The per-module cap still bounds the record, so a corrupt blob full of junk
 * keys cannot grow the jsonb.
 */
function bodySurfaceKeyedRecordSchema<TEntry>(entrySchema: z.ZodType<TEntry>, maxEntries: number) {
  return z.record(z.string(), z.unknown()).transform((raw) => {
    const record: Record<string, TEntry | BodySurfaceInvalidEntry> = {};
    for (const [key, value] of Object.entries(raw).slice(0, maxEntries)) {
      if (key.length < 1 || key.length > BODY_SURFACE_MARK_ID_MAX_LENGTH) {
        record[key] = BODY_SURFACE_INVALID_ENTRY;
        continue;
      }
      const parsed = entrySchema.safeParse(value);
      record[key] = parsed.success ? parsed.data : BODY_SURFACE_INVALID_ENTRY;
    }
    return record;
  });
}

const marksRecordSchema = bodySurfaceKeyedRecordSchema(bodySurfaceMarkSchema, BODY_SURFACE_MAX_MARKS);

// ---------------------------------------------------------------------------
// Deposits — vocabulary and shape (owner ruling 2026-08-25)
// ---------------------------------------------------------------------------

/** Max deposit entries one character retains (bounded jsonb; the garment store's own cap). */
export const BODY_SURFACE_MAX_DEPOSITS = 12;

/**
 * One committed deposit — the VALID shape. `kind`, `amount` and
 * `createdAtMinutes` are **strict** for the wetness level's exact reason: two
 * of them move state and the third is the vocabulary fence, and a repair would
 * let a corrupt row buy a visible claim. Note that `unknown` is a real member
 * of the vocabulary, so a *quarantined* kind is genuinely unreadable data
 * rather than an unnamed substance — those are different answers and stay two.
 * `cause` is lenient PROVENANCE, degradable to "no recorded reason".
 *
 * There is deliberately **no second `extent` axis** beside `amount`, though the
 * garment record carries one. A garment spans parts and can be muddy at the hem
 * alone; a body deposit is already located at exactly one body location, so the
 * extent IS the locus. Adding an axis no producer can distinguish would be
 * precision this lane cannot back — and the garment reducer itself writes its
 * two axes from one degree band, which is the same admission.
 */
export const bodySurfaceDepositSchema = z.object({
  /** A body-location id (`bodyLocationRegistry`), loose like the wetness keys. */
  locationId: locationKeySchema,
  kind: surfaceDepositKindSchema,
  /** Fixed point `1 … BODY_SURFACE_UNIT_ONE`. Zero never persists — a removed deposit is dropped. */
  amount: z.number().int().min(1).max(BODY_SURFACE_UNIT_ONE),
  /** Story minute the material landed — the FRESHNESS anchor, and only that. */
  createdAtMinutes: z.number().int().min(0),
  cause: z.string().trim().min(1).max(80).optional().catch(undefined),
});
export type BodySurfaceDeposit = z.infer<typeof bodySurfaceDepositSchema>;

/** One stored deposit slot: a parsed deposit, or the shared quarantine marker. */
export type BodySurfaceDepositSlot = BodySurfaceDeposit | BodySurfaceInvalidEntry;

export function isInvalidDepositSlot(slot: BodySurfaceDepositSlot): slot is BodySurfaceInvalidEntry {
  return "status" in slot;
}

/** Item-lenient and quarantining — key included — exactly like the marks record. */
const depositsRecordSchema = bodySurfaceKeyedRecordSchema(bodySurfaceDepositSchema, BODY_SURFACE_MAX_DEPOSITS);

// ---------------------------------------------------------------------------
// Transfer receipts — shape (owner ruling 2026-08-26)
// ---------------------------------------------------------------------------

/**
 * How many conserved transfers one surface remembers having sourced. Small on
 * purpose: a receipt exists to answer "did this exact causal event already
 * move material", and that question is only ever asked about the exchange
 * currently settling or the one a retake is replaying.
 */
export const BODY_SURFACE_MAX_TRANSFER_RECEIPTS = 8;

/**
 * One committed transfer, from the source surface's point of view. STRICT on
 * every field: a receipt whose amount or minute cannot be read is a receipt
 * that cannot answer either of the questions it exists for, and repairing one
 * would let a corrupt row either suppress a real transfer or wave a duplicate
 * through.
 */
export const bodySurfaceTransferReceiptSchema = z.object({
  /** Exactly what left this surface under this identity. */
  amount: z.number().int().min(1).max(BODY_SURFACE_UNIT_ONE),
  /** Story minute the transfer committed — the prune anchor, and only that. */
  atMinutes: z.number().int().min(0),
});
export type BodySurfaceTransferReceipt = z.infer<typeof bodySurfaceTransferReceiptSchema>;

export type BodySurfaceTransferReceiptSlot = BodySurfaceTransferReceipt | BodySurfaceInvalidEntry;

export function isInvalidTransferReceiptSlot(
  slot: BodySurfaceTransferReceiptSlot,
): slot is BodySurfaceInvalidEntry {
  return "status" in slot;
}

/**
 * Item-lenient and quarantining, exactly like the three records beside it — and
 * the module where the shared shape's per-item KEY check matters most, since an
 * absent record here reads as "never transferred" and licenses the double debit
 * conservation forbids.
 */
const transfersRecordSchema = bodySurfaceKeyedRecordSchema(
  bodySurfaceTransferReceiptSchema,
  BODY_SURFACE_MAX_TRANSFER_RECEIPTS,
);

export const bodySurfaceStateSchema = z.object({
  /**
   * Body-location id → standing wetness, or a quarantine marker. An ABSENT
   * location is dry (the default, and the only default) *unless* the record
   * holds a key nobody can assign to a location, which poisons that inference
   * — see law 4 and `bodySurfaceWetnessAt`. A quarantined entry is explicitly
   * unknown, which is a different answer from dry and must stay one.
   */
  wetness: wetnessRecordSchema,
  /**
   * Idempotency key → committed temporary mark, or the quarantine marker.
   * OPTIONAL and absent until the first mark commits, so a chat that never ran
   * the contact-effects leg persists byte-identical state to before marks
   * existed; the mark writes drop the key again when the last mark prunes. A
   * wholly corrupt record degrades to absent — "no marks" claims nothing, which
   * is what makes that repair conservative where healing a LEVEL never is.
   */
  marks: marksRecordSchema.optional().catch(undefined),
  /**
   * Deposit identity → committed material, or the quarantine marker. OPTIONAL
   * and absent until the first deposit commits, on the `marks` key's rule and
   * for its reason: a chat whose fiction never put anything on anybody persists
   * byte-identical state to before this module existed, and the deposit writes
   * drop the key again when the last deposit is removed.
   */
  deposits: depositsRecordSchema.optional().catch(undefined),
  /**
   * Transfer idempotency key → the receipt for material that already left this
   * surface. OPTIONAL and absent until the first conserved transfer commits, on
   * the two keys above's rule.
   *
   * A receipt is not body state, and it lives here anyway, deliberately
   * (ruling 2026-08-26). A conserved transfer requires that a retry cannot
   * transfer twice and that a retake removes both sides or neither — and an
   * ADDING destination cannot tell a retry from a second helping by looking at
   * its own amount, so the transaction needs a durable record of the causal
   * identity. That record has to fail and roll back with the DEBIT, or a
   * half-applied transfer leaves a receipt claiming it happened. This state is
   * the one durable store already riding exactly the anchor the debit rides:
   * it is written in the same value, restored by the same `pre_exchange_state`,
   * and dropped by the same retake. A separate table would have to be taught
   * that boundary; a key here inherits it.
   */
  transfers: transfersRecordSchema.optional().catch(undefined),
});
export type BodySurfaceState = z.infer<typeof bodySurfaceStateSchema>;

/** Nothing wet — the seed value and the degraded default at every trust boundary. */
export function emptyBodySurfaceState(): BodySurfaceState {
  return { wetness: {} };
}

/**
 * Drop one optional module's key entirely, leaving every other module alone.
 *
 * The point is the "leaving every other module alone" half. Both optional
 * modules empty out to ABSENCE rather than to `{}`, so a fully healed record
 * persists byte-identically to one that never held anything — and rebuilding
 * the state from a literal to achieve that would silently discard whichever
 * sibling module happened to be populated at the time.
 */
export function withoutBodySurfaceKey(state: BodySurfaceState, key: "marks" | "deposits" | "transfers"): BodySurfaceState {
  const next = { ...state };
  delete next[key];
  return next;
}