import { z } from "zod";
import { clampFixedPoint, FIXED_POINT_ONE, linearDriftStep, proportionalDecayStep } from "@/lib/fixed-point";
import {
  surfaceDepositFreshnessBandOf,
  surfaceDepositKindSchema,
  SURFACE_DEPOSIT_FRESHNESS_HALF_LIFE_MINUTES,
  type SurfaceDepositFreshnessBand,
  type SurfaceDepositKind,
} from "../materials/surface-deposits";

/**
 * Per-character BODY-SURFACE state — what is on the skin and hair right now
 * (body-attribute-affordances.audit.md §"Capability → owner": *"New per-character
 * body-surface wetness state on `ChatState` (Slice 4): extraction-proposed,
 * fixed-point, lazy drying on the story clock (garment-condition precedent)"*).
 *
 * This is an AUTHORITATIVE owner, which is the whole point: before it existed the
 * hair domain had no wetness input in the chat lane, and the audit's adapter
 * result law forbids substituting "probably dry". Narrator prose is never parsed
 * to fill it — the continuity extraction leg proposes typed ops
 * (`turns/chat-surface-ops.ts`) that commit through `parseOr`, exactly as the
 * garment lane does.
 *
 * Three laws, all inherited from `items/garment-condition.ts`:
 *
 * 1. **Fixed point, never floats.** One scale (`0 … FIXED_POINT_ONE`) shared with
 *    the meter kernel and the garment gradients, so a retake reproduces the
 *    identical read from the identical committed state.
 * 2. **Reading never mutates.** `bodySurfaceWetnessAt` integrates drying forward
 *    for the caller and returns a read; the caller decides when to persist an
 *    integrated value (integrate on WRITE, never on read).
 * 3. **`updatedAtMinutes` means "when this location's wetness last CHANGED".**
 *    Deliberately not "when it was last integrated": the affordance adapter reads
 *    it as the freshness anchor for the cause ("did the rain land recently
 *    enough to still be the reason?"), and restamping it on every quiet exchange
 *    would make a week-old soaking read as fresh rain forever. So a write only
 *    ever touches the locations a proposal names (plus pruning entries that have
 *    dried all the way to zero — an absent entry IS dry).
 *
 * Two laws this owner added after review, both about *not* letting a gap become a
 * convenient physical claim:
 *
 * 4. **Absent, dry, and INVALID are three different answers.** An absent location
 *    is honestly dry — nothing ever recorded wetting it. A corrupt stored entry is
 *    not: it is quarantined as `{ status: "invalid" }` and every read says so, so
 *    a bad jsonb blob can never buy the mobility that dry hair has and wet hair
 *    does not.
 * 5. **Standing outdoor precipitation HOLDS wetness** (`suspendDrying`). Drying
 *    forward through a downpour would report a soaked character bone dry after a
 *    few story hours of rain, because "the weather did not change" proposes no
 *    ops. Holding never RAISES the level — raising still requires a committed
 *    proposal — it only declines to dry what is actively being rained on.
 *
 * **Scope this release: the PRIMARY character only.** There is no player or
 * ensemble-member surface state — the extraction field says so, and
 * `finalizeChatState` folds only the primary's row. Extending it is the same
 * shape as the wardrobe's: the player would ride `ChatScenario` (one player, many
 * characters) and ensemble members their own `character_chat_state` rows through
 * the per-member personal pass.
 *
 * **Temporary contact marks are a second module of this SAME owner**
 * (romantic-contact-affordances.spec.effects.md §7 — the 2026-08-22 ruling that
 * the body-surface domain owns all current material/condition on skin, not a
 * contact-local store per aftermath family). Marks inherit every law above:
 * fixed point, lazy fading on the story clock, integrate-on-write, per-entry
 * quarantine, bounded jsonb. Two mark-specific laws:
 *
 * 6. **A mark record is keyed by its IDEMPOTENCY IDENTITY**, derived by the
 *    proposer from the causal contact event — so a retried commit lands on the
 *    key it already wrote and changes nothing, structurally rather than by a
 *    comparison someone has to remember (effects spec §13).
 * 7. **A mark's fade anchors at `createdAtMinutes` and is never restamped.** A
 *    mark is one physical event's residue; pressing again is a NEW event with
 *    its own key, never a refresh of the old one. Absent entry = no mark, and a
 *    mark that fades to zero is pruned on the next write (the wetness rule).
 *
 * **Deposits are the THIRD module of this same owner** (effects spec §7's
 * residue/deposit half; owner ruling 2026-08-25). Mud, blood, dust, food,
 * paint, and cosmetics on skin were the visual layer's largest current-state
 * gap — garments could carry them and the body under those garments could not —
 * and they land here rather than in a store of their own for §7's stated
 * reason: one body-surface domain owns all current material and condition on
 * skin. The substance vocabulary is shared outright with the garment store
 * (`materials/surface-deposits.ts`), so mud on a sleeve and mud on the forearm
 * beneath it can never be different nouns. One deposit-specific law, and it is
 * the one that separates this module from the two above:
 *
 * 8. **Material does not leave on its own.** Wetness dries and marks fade
 *    because both are a surface returning to its resting state. A deposit is a
 *    SUBSTANCE, and a substance that quietly decayed to nothing would make this
 *    owner an unowned sink — the exact thing a conserved transfer must be able
 *    to rely on not happening. Only an explicit removal (a wipe, a wash, and
 *    later a transfer) shrinks a deposit. What DOES move with the clock is
 *    `freshness`, which is phrasing — wet mud, drying mud, set mud — and never
 *    a removal clock.
 */

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

/**
 * The drying law, in one number: a **flat** `3_000` units per story hour toward
 * dry, so a saturated surface (`10_000`) is fully dry in **3⅓ story hours** and a
 * half-damp one in about 100 minutes.
 *
 * Flat rather than material-scaled on purpose. The garment store scales drying by
 * fabric because it knows each part's material; a body surface has no equivalent
 * authoritative material axis, and deriving one from `hair.condition` would put a
 * mechanics calibration in the state layer where the affordance domain could not
 * see or explain it. One documented rate is honest; a fake material model is not.
 */
export const BODY_SURFACE_DRY_RATE_PER_HOUR = 3_000;

const SECONDS_PER_MINUTE = 60;

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

/** One stored slot: a parsed wetness record, or the quarantine marker. */
export type BodySurfaceEntry = BodySurfaceWetness | BodySurfaceInvalidEntry;

export function isInvalidSurfaceEntry(entry: BodySurfaceEntry): entry is BodySurfaceInvalidEntry {
  return "status" in entry;
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
 */
const wetnessRecordSchema = z
  .record(locationKeySchema, z.unknown())
  .catch({})
  .default({})
  .transform((raw) => {
    const wetness: Record<string, BodySurfaceEntry> = {};
    for (const [locationId, value] of Object.entries(raw).slice(0, BODY_SURFACE_MAX_LOCATIONS)) {
      const parsed = bodySurfaceWetnessSchema.safeParse(value);
      wetness[locationId] = parsed.success ? parsed.data : BODY_SURFACE_INVALID_ENTRY;
    }
    return wetness;
  });

// ---------------------------------------------------------------------------
// Marks — vocabulary and shape (effects spec §7–8)
// ---------------------------------------------------------------------------

/**
 * The mark kinds this owner supports. CLOSED vocabulary, one member: the
 * pressure mark is the first end-to-end effect proof (effects spec §8), and
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
 * The fade law, in one number: a **flat** `20_000` units per story hour toward
 * gone. A `strong` mark (`10_000`) is fully gone in **30 story minutes**, a
 * `clear` one (`5_000`) in 15. The calibration is the contact vocabulary's own
 * ceiling: committed pressure tops out at `firm` — a transient imprint, never
 * an injury (scratch/damage has no owner) — and a non-injuring pressure mark
 * that outlived an hour would be a claim the mechanics cannot back. Flat rather
 * than skin-scaled for the wetness rate's exact reason: no authoritative
 * material axis exists to scale by, and inventing one here would be pretend
 * physics.
 */
export const BODY_SURFACE_MARK_FADE_RATE_PER_HOUR = 20_000;

/**
 * Band → the fixed-point magnitude a committed mark of that band starts at.
 * The owner's table, not the proposer's: a proposal says "clear" and this row
 * says what that means, so a hallucinated magnitude is unreachable — the same
 * degree-table discipline as `SURFACE_WETNESS_DEGREE_DELTA`.
 */
export const BODY_SURFACE_MARK_BAND_MAGNITUDE: Readonly<Record<BodySurfaceMarkBand, number>> = {
  subtle: 2_500,
  clear: 5_000,
  strong: BODY_SURFACE_UNIT_ONE,
};

/**
 * Fixed-point floor of each READ band, ascending. Read floors sit below the
 * write magnitudes so a just-committed band survives its own first minutes of
 * fading instead of dropping a band on the next read.
 */
const BODY_SURFACE_MARK_BAND_FLOORS: readonly (readonly [number, BodySurfaceMarkBand])[] = [
  [1, "subtle"],
  [4_000, "clear"],
  [8_000, "strong"],
];

/** The band a current magnitude reads in, or `null` for a fully faded mark. */
export function bodySurfaceMarkBandOf(magnitude: number): BodySurfaceMarkBand | null {
  let band: BodySurfaceMarkBand | null = null;
  for (const [floor, label] of BODY_SURFACE_MARK_BAND_FLOORS) {
    if (magnitude >= floor) band = label;
  }
  return band;
}

/** The fixed-point floor of a mark band. */
export function bodySurfaceMarkBandFloor(band: BodySurfaceMarkBand): number {
  return BODY_SURFACE_MARK_BAND_FLOORS.find(([, label]) => label === band)?.[0] ?? 0;
}

/**
 * The idempotency-identity key a mark record is stored under. Bounded so a
 * hostile blob cannot grow the jsonb without limit; the owner transaction
 * REFUSES an over-long key rather than truncating it, because a truncated
 * identity is two different events sharing one slot.
 */
export const BODY_SURFACE_MARK_ID_MAX_LENGTH = 512;
const markIdKeySchema = z.string().min(1).max(BODY_SURFACE_MARK_ID_MAX_LENGTH);

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
 * Item-lenient and quarantining, exactly like the wetness record: one corrupt
 * mark can neither void the record nor become a visible mark, and a stored kind
 * outside the vocabulary (the smuggled-scratch case) fails the item and lands
 * in quarantine rather than reading as the nearest supported thing.
 */
const marksRecordSchema = z
  .record(markIdKeySchema, z.unknown())
  .transform((raw) => {
    const marks: Record<string, BodySurfaceMarkSlot> = {};
    for (const [markId, value] of Object.entries(raw).slice(0, BODY_SURFACE_MAX_MARKS)) {
      const parsed = bodySurfaceMarkSchema.safeParse(value);
      marks[markId] = parsed.success ? parsed.data : BODY_SURFACE_INVALID_ENTRY;
    }
    return marks;
  });

// ---------------------------------------------------------------------------
// Deposits — vocabulary and shape (effects spec §7; owner ruling 2026-08-25)
// ---------------------------------------------------------------------------

/** Max deposit entries one character retains (bounded jsonb; the garment store's own cap). */
export const BODY_SURFACE_MAX_DEPOSITS = 12;

/**
 * Material at or under this is nothing anyone can see — the deposit is gone and
 * the entry drops. The garment lane's floor, shared so a wiped sleeve and a
 * wiped wrist disappear at the same point.
 */
export const BODY_SURFACE_DEPOSIT_REMOVAL_FLOOR = 1_000;

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

/** Item-lenient and quarantining, exactly like the wetness and marks records. */
const depositsRecordSchema = z
  .record(z.string().min(1).max(BODY_SURFACE_MARK_ID_MAX_LENGTH), z.unknown())
  .transform((raw) => {
    const deposits: Record<string, BodySurfaceDepositSlot> = {};
    for (const [depositId, value] of Object.entries(raw).slice(0, BODY_SURFACE_MAX_DEPOSITS)) {
      const parsed = bodySurfaceDepositSchema.safeParse(value);
      deposits[depositId] = parsed.success ? parsed.data : BODY_SURFACE_INVALID_ENTRY;
    }
    return deposits;
  });

/**
 * The identity a deposit is stored under: substance, place, and the minute it
 * landed. Deterministic, so a replayed exchange lands on the key it already
 * wrote — and so more of the same substance arriving at the same place in the
 * same beat DEEPENS one deposit instead of stacking a second record, while the
 * next story minute is honestly a new one.
 */
export function bodySurfaceDepositIdFor(locationId: string, kind: SurfaceDepositKind, atMinutes: number): string {
  return `dep:${kind}:${locationId}:${Math.max(0, Math.trunc(atMinutes))}`.slice(
    0,
    BODY_SURFACE_MARK_ID_MAX_LENGTH,
  );
}

// ---------------------------------------------------------------------------
// Transfer receipts — shape (effects spec §9; owner ruling 2026-08-26)
// ---------------------------------------------------------------------------

/**
 * How many conserved transfers one surface remembers having sourced. Small on
 * purpose: a receipt exists to answer "did this exact causal event already
 * move material", and that question is only ever asked about the exchange
 * currently settling or the one a retake is replaying.
 */
export const BODY_SURFACE_MAX_TRANSFER_RECEIPTS = 8;

/**
 * How long a receipt is kept, in story minutes. Generous by a wide margin — a
 * retry lands in the same beat and a retake replays one exchange — because the
 * cost of keeping one too long is a few bytes and the cost of dropping one too
 * early is a double debit.
 */
export const BODY_SURFACE_TRANSFER_RECEIPT_HORIZON_MINUTES = 720;

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

/** Item-lenient and quarantining, exactly like the three records beside it. */
const transfersRecordSchema = z
  .record(z.string().min(1).max(BODY_SURFACE_MARK_ID_MAX_LENGTH), z.unknown())
  .transform((raw) => {
    const transfers: Record<string, BodySurfaceTransferReceiptSlot> = {};
    for (const [key, value] of Object.entries(raw).slice(0, BODY_SURFACE_MAX_TRANSFER_RECEIPTS)) {
      const parsed = bodySurfaceTransferReceiptSchema.safeParse(value);
      transfers[key] = parsed.success ? parsed.data : BODY_SURFACE_INVALID_ENTRY;
    }
    return transfers;
  });

export const bodySurfaceStateSchema = z.object({
  /**
   * Body-location id → standing wetness, or the quarantine marker. An ABSENT
   * location is dry (the default, and the only default); a quarantined one is
   * explicitly unknown, which is a different answer and must stay one.
   */
  wetness: wetnessRecordSchema,
  /**
   * Idempotency key → committed temporary mark, or the quarantine marker.
   * OPTIONAL and absent until the first mark commits, so a chat that never ran
   * the contact-effects leg persists byte-identical state to before marks
   * existed; the writes below drop the key again when the last mark prunes. A
   * wholly corrupt record degrades to absent — "no marks" claims nothing, which
   * is what makes that repair conservative where healing a LEVEL never is.
   */
  marks: marksRecordSchema.optional().catch(undefined),
  /**
   * Deposit identity → committed material, or the quarantine marker. OPTIONAL
   * and absent until the first deposit commits, on the `marks` key's rule and
   * for its reason: a chat whose fiction never put anything on anybody persists
   * byte-identical state to before this module existed, and the writes below
   * drop the key again when the last deposit is removed.
   */
  deposits: depositsRecordSchema.optional().catch(undefined),
  /**
   * Transfer idempotency key → the receipt for material that already left this
   * surface. OPTIONAL and absent until the first conserved transfer commits, on
   * the two keys above's rule.
   *
   * A receipt is not body state, and it lives here anyway, deliberately
   * (effects spec §9; ruling 2026-08-26). §9 requires that a retry cannot
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
function withoutBodySurfaceKey(state: BodySurfaceState, key: "marks" | "deposits" | "transfers"): BodySurfaceState {
  const next = { ...state };
  delete next[key];
  return next;
}

// ---------------------------------------------------------------------------
// Reads (pure; never mutate)
// ---------------------------------------------------------------------------

/**
 * This location's stored slot: a wetness record, the quarantine marker, or
 * `undefined` when it has never been wet. Callers that read `cause` or
 * `updatedAtMinutes` must narrow with `isInvalidSurfaceEntry` first.
 */
export function bodySurfaceWetnessEntry(state: BodySurfaceState, locationId: string): BodySurfaceEntry | undefined {
  return state.wetness[locationId];
}

/**
 * The answer to "how wet is this location". THREE answers, not two — the union
 * exists so a caller cannot accidentally spend a corrupt row as a number.
 */
export type BodySurfaceWetnessRead =
  | { readonly status: "known"; readonly level: number }
  | { readonly status: "invalid" };

/** Absent is a KNOWN answer: nothing ever wet this location, so it is dry. */
const DRY_READ: BodySurfaceWetnessRead = { status: "known", level: 0 };

export interface BodySurfaceReadOptions {
  /**
   * Hold the committed level instead of drying it forward — the caller has an
   * authoritative reason the surface is not drying right now (standing outdoor
   * precipitation is the one live case; see law 5 above). Never raises the
   * level: raising requires a committed proposal.
   */
  readonly suspendDrying?: boolean;
}

/**
 * Wetness at `atMinutes`, dried forward from the last change — the LAZY read.
 *
 * Total and monotone: a `known` result is never negative, never above the stored
 * level, and integrating to a minute at or before the last write is the identity
 * (the §25.2 "queries never persist" law both lanes inherit). Reading changes
 * nothing; `applySurfaceWetnessProposals` is the only thing that persists.
 */
export function bodySurfaceWetnessAt(
  state: BodySurfaceState,
  locationId: string,
  atMinutes: number,
  options?: BodySurfaceReadOptions,
): BodySurfaceWetnessRead {
  const entry = state.wetness[locationId];
  if (entry === undefined) return DRY_READ;
  if (isInvalidSurfaceEntry(entry)) return { status: "invalid" };
  const level = clampFixedPoint(entry.level, BODY_SURFACE_UNIT_ONE);
  const elapsed = atMinutes - entry.updatedAtMinutes;
  if (elapsed <= 0 || options?.suspendDrying === true) return { status: "known", level };
  return {
    status: "known",
    level: clampFixedPoint(
      linearDriftStep({
        value: entry.level,
        target: 0,
        ratePerHourFixedPoint: BODY_SURFACE_DRY_RATE_PER_HOUR,
        elapsedSeconds: elapsed * SECONDS_PER_MINUTE,
        one: BODY_SURFACE_UNIT_ONE,
      }),
      BODY_SURFACE_UNIT_ONE,
    ),
  };
}

// ---------------------------------------------------------------------------
// Writes (pure; the caller persists)
// ---------------------------------------------------------------------------

/**
 * Persist a location's wetness at `atMinutes`. A level of zero DROPS the entry:
 * "dry" is the absence default, so a dried-out surface leaves no residue in the
 * jsonb and the record stays bounded without an eviction policy.
 *
 * This is also the **heal** path for a quarantined location: a new authoritative
 * write replaces the marker outright (and a write of zero replaces it with
 * honest absence). Corruption is sticky until something states the truth again,
 * and then it is gone.
 */
export function setBodySurfaceWetness(
  state: BodySurfaceState,
  input: { locationId: string; level: number; atMinutes: number; cause?: BodySurfaceWetnessCause },
): BodySurfaceState {
  const level = clampFixedPoint(Math.trunc(input.level), BODY_SURFACE_UNIT_ONE);
  const wetness = { ...state.wetness };
  if (level <= 0) {
    delete wetness[input.locationId];
    return { ...state, wetness };
  }
  if (wetness[input.locationId] === undefined && Object.keys(wetness).length >= BODY_SURFACE_MAX_LOCATIONS) {
    return state;
  }
  wetness[input.locationId] = {
    level,
    updatedAtMinutes: Math.max(0, Math.trunc(input.atMinutes)),
    ...(input.cause === undefined ? {} : { cause: input.cause }),
  };
  return { ...state, wetness };
}

/**
 * Drop every entry that has dried all the way to zero by `atMinutes`.
 *
 * The one write that is safe to run on an exchange that proposed nothing: it
 * cannot change what any read returns (a zero entry and an absent entry are the
 * same answer) and it does not restamp `updatedAtMinutes` on anything still wet,
 * so the cause-freshness anchor survives. Returns the SAME reference when
 * nothing was pruned, so a caller can cheaply skip a write.
 *
 * A QUARANTINED entry is never pruned — dropping it would turn "unknown" into
 * the absence default, which is "dry", which is exactly the laundering the
 * marker exists to prevent. Only an authoritative write clears it.
 */
export function pruneDryBodySurface(
  state: BodySurfaceState,
  atMinutes: number,
  options?: BodySurfaceReadOptions,
): BodySurfaceState {
  const dry = Object.keys(state.wetness).filter((locationId) => {
    const read = bodySurfaceWetnessAt(state, locationId, atMinutes, options);
    return read.status === "known" && read.level <= 0;
  });
  if (dry.length === 0) return state;
  const wetness = { ...state.wetness };
  for (const locationId of dry) delete wetness[locationId];
  return { ...state, wetness };
}

// ---------------------------------------------------------------------------
// Marks — reads and writes (effects spec §8, §13)
// ---------------------------------------------------------------------------

/** This key's stored slot: a mark, the quarantine marker, or `undefined` when nothing committed under it. */
export function bodySurfaceMarkSlot(state: BodySurfaceState, markId: string): BodySurfaceMarkSlot | undefined {
  return state.marks?.[markId];
}

/**
 * The answer to "what does this mark look like now". THREE answers again:
 * `none` covers absent AND fully faded (the same physical fact — no mark),
 * `invalid` is the quarantine and may not be spent as either.
 */
export type BodySurfaceMarkRead =
  | { readonly status: "none" }
  | { readonly status: "invalid" }
  | { readonly status: "known"; readonly mark: BodySurfaceMark; readonly magnitude: number };

const NO_MARK_READ: BodySurfaceMarkRead = { status: "none" };

/**
 * One mark's magnitude at `atMinutes`, faded forward from its creation — the
 * LAZY read, total and monotone like `bodySurfaceWetnessAt` (identity at or
 * before creation, never negative, never above the stored magnitude). There is
 * deliberately no suspension option: nothing in the environment preserves a
 * pressure mark the way standing rain preserves wetness.
 */
export function bodySurfaceMarkAt(state: BodySurfaceState, markId: string, atMinutes: number): BodySurfaceMarkRead {
  const slot = state.marks?.[markId];
  if (slot === undefined) return NO_MARK_READ;
  if (isInvalidMarkSlot(slot)) return { status: "invalid" };
  const stored = clampFixedPoint(slot.magnitude, BODY_SURFACE_UNIT_ONE);
  const elapsed = atMinutes - slot.createdAtMinutes;
  const magnitude =
    elapsed <= 0
      ? stored
      : clampFixedPoint(
          linearDriftStep({
            value: stored,
            target: 0,
            ratePerHourFixedPoint: BODY_SURFACE_MARK_FADE_RATE_PER_HOUR,
            elapsedSeconds: elapsed * SECONDS_PER_MINUTE,
            one: BODY_SURFACE_UNIT_ONE,
          }),
          BODY_SURFACE_UNIT_ONE,
        );
  if (magnitude <= 0) return NO_MARK_READ;
  return { status: "known", mark: slot, magnitude };
}

/**
 * Commit one mark under its idempotency identity — the owner's half of the
 * pressure-mark transaction (the validating half lives with the proposal apply
 * in `turns/chat-contact-effects.ts`).
 *
 * Laws, in check order:
 *
 * - **A VALID entry under this key wins** (law 6): the same causal event
 *   committing again changes nothing and returns the SAME reference, so a retry
 *   is provably a no-op. A QUARANTINED slot loses — a fresh authoritative
 *   commit is the heal path, exactly as a wetness write heals its marker.
 * - **Faded marks prune as part of the write** (integrate on write): the record
 *   stays bounded without an eviction policy, and the prune cannot change any
 *   read.
 * - **Capacity refuses rather than evicts**: returning the same reference lets
 *   the caller report the refusal instead of silently dropping somebody's mark.
 */
export function commitBodySurfaceMark(
  state: BodySurfaceState,
  input: {
    markId: string;
    locationId: string;
    kind: BodySurfaceMarkKind;
    band: BodySurfaceMarkBand;
    atMinutes: number;
    side?: string;
    detail?: string;
  },
): BodySurfaceState {
  const existing = state.marks?.[input.markId];
  if (existing !== undefined && !isInvalidMarkSlot(existing)) return state;
  const pruned = pruneFadedBodySurfaceMarks(state, input.atMinutes);
  const marks = { ...pruned.marks };
  if (marks[input.markId] === undefined && Object.keys(marks).length >= BODY_SURFACE_MAX_MARKS) {
    return state;
  }
  marks[input.markId] = {
    locationId: input.locationId,
    kind: input.kind,
    magnitude: BODY_SURFACE_MARK_BAND_MAGNITUDE[input.band],
    createdAtMinutes: Math.max(0, Math.trunc(input.atMinutes)),
    ...(input.side === undefined ? {} : { side: input.side }),
    ...(input.detail === undefined ? {} : { detail: input.detail }),
  };
  return { ...pruned, marks };
}

/**
 * Drop every mark that has fully faded by `atMinutes` — the marks mirror of
 * `pruneDryBodySurface`, with the same three guarantees: it cannot change what
 * any read returns, it returns the SAME reference when nothing was pruned, and
 * it never evicts a quarantined slot (that would launder unknown into "never
 * marked"). When the last mark goes, the `marks` key goes with it, so a fully
 * healed record persists byte-identically to one that never held a mark.
 */
export function pruneFadedBodySurfaceMarks(state: BodySurfaceState, atMinutes: number): BodySurfaceState {
  if (state.marks === undefined) return state;
  const faded = Object.keys(state.marks).filter(
    (markId) => bodySurfaceMarkAt(state, markId, atMinutes).status === "none",
  );
  if (faded.length === 0) return state;
  const marks = { ...state.marks };
  for (const markId of faded) delete marks[markId];
  if (Object.keys(marks).length === 0) return withoutBodySurfaceKey(state, "marks");
  return { ...state, marks };
}

// ---------------------------------------------------------------------------
// Deposits — reads and writes (effects spec §7)
// ---------------------------------------------------------------------------

/** This key's stored slot: a deposit, the quarantine marker, or `undefined` when nothing landed under it. */
export function bodySurfaceDepositSlot(state: BodySurfaceState, depositId: string): BodySurfaceDepositSlot | undefined {
  return state.deposits?.[depositId];
}

/**
 * The answer to "what is on this surface now". THREE answers, like every other
 * read here — except that `none` means ABSENT only. A deposit's amount does not
 * fall on its own: material stays until something removes it, so there is no
 * such thing as a deposit that quietly faded to nothing.
 */
export type BodySurfaceDepositRead =
  | { readonly status: "none" }
  | { readonly status: "invalid" }
  | {
      readonly status: "known";
      readonly deposit: BodySurfaceDeposit;
      readonly amount: number;
      readonly freshness: SurfaceDepositFreshnessBand;
    };

const NO_DEPOSIT_READ: BodySurfaceDepositRead = { status: "none" };

/**
 * One deposit at `atMinutes`. Pure and total, and the ONE thing that moves with
 * the clock is `freshness` — wet mud becoming dried mud becoming set mud.
 *
 * That asymmetry is the module's central law and it is deliberate: freshness is
 * PHRASING and amount is MATERIAL. Letting the clock reduce the amount would
 * make the surface an unowned sink — material would vanish from the world with
 * nobody having removed it, which is precisely the thing a later conserved
 * transfer must be able to rely on not happening. When skin should shed a
 * substance over time, that is a grooming or physiology owner stating so, not a
 * decay constant hidden here.
 */
export function bodySurfaceDepositAt(
  state: BodySurfaceState,
  depositId: string,
  atMinutes: number,
): BodySurfaceDepositRead {
  const slot = state.deposits?.[depositId];
  if (slot === undefined) return NO_DEPOSIT_READ;
  if (isInvalidDepositSlot(slot)) return { status: "invalid" };
  const amount = clampFixedPoint(slot.amount, BODY_SURFACE_UNIT_ONE);
  if (amount <= 0) return NO_DEPOSIT_READ;
  const freshness = proportionalDecayStep({
    value: BODY_SURFACE_UNIT_ONE,
    target: 0,
    halfLife: SURFACE_DEPOSIT_FRESHNESS_HALF_LIFE_MINUTES,
    elapsed: Math.max(0, atMinutes - slot.createdAtMinutes),
  });
  return { status: "known", deposit: slot, amount, freshness: surfaceDepositFreshnessBandOf(freshness) };
}

/**
 * Every deposit standing on one location, newest first, quarantined slots
 * excluded. The read a projection or a narrator guidance leg wants: "what is on
 * her hands" is a question about a place, not about an identity.
 */
export function bodySurfaceDepositsAt(
  state: BodySurfaceState,
  locationId: string,
  atMinutes: number,
): readonly { readonly depositId: string; readonly read: Extract<BodySurfaceDepositRead, { status: "known" }> }[] {
  const rows: { depositId: string; read: Extract<BodySurfaceDepositRead, { status: "known" }> }[] = [];
  for (const depositId of Object.keys(state.deposits ?? {})) {
    const slot = state.deposits?.[depositId];
    if (slot === undefined || isInvalidDepositSlot(slot) || slot.locationId !== locationId) continue;
    const read = bodySurfaceDepositAt(state, depositId, atMinutes);
    if (read.status === "known") rows.push({ depositId, read });
  }
  return rows.sort((left, right) =>
    right.read.deposit.createdAtMinutes === left.read.deposit.createdAtMinutes
      ? left.depositId.localeCompare(right.depositId)
      : right.read.deposit.createdAtMinutes - left.read.deposit.createdAtMinutes,
  );
}

/**
 * Put material on a surface, under its deterministic identity.
 *
 * Laws, in check order:
 *
 * - **The same substance in the same place in the same beat DEEPENS one
 *   deposit** rather than stacking a second record: the stored amount rises to
 *   the greater of the two and the entry keeps its original anchor. Rising
 *   only, because the fiction saying "there is mud on her hands" a second time
 *   is not a report that some of it left.
 * - **A QUARANTINED slot loses to a fresh authoritative write**, the wetness
 *   heal path exactly.
 * - **Capacity refuses rather than evicts**, returning the SAME reference so
 *   the caller can report the refusal instead of silently dropping material.
 */
export function commitBodySurfaceDeposit(
  state: BodySurfaceState,
  input: {
    locationId: string;
    kind: SurfaceDepositKind;
    amount: number;
    atMinutes: number;
    cause?: string;
  },
): BodySurfaceState {
  const amount = clampFixedPoint(Math.trunc(input.amount), BODY_SURFACE_UNIT_ONE);
  if (amount <= 0) return state;
  const atMinutes = Math.max(0, Math.trunc(input.atMinutes));
  const depositId = bodySurfaceDepositIdFor(input.locationId, input.kind, atMinutes);
  const deposits = { ...state.deposits };
  const existing = deposits[depositId];
  if (existing !== undefined && !isInvalidDepositSlot(existing)) {
    if (existing.amount >= amount) return state;
    deposits[depositId] = { ...existing, amount };
    return { ...state, deposits };
  }
  if (existing === undefined && Object.keys(deposits).length >= BODY_SURFACE_MAX_DEPOSITS) return state;
  deposits[depositId] = {
    locationId: input.locationId,
    kind: input.kind,
    amount,
    createdAtMinutes: atMinutes,
    ...(input.cause === undefined ? {} : { cause: input.cause }),
  };
  return { ...state, deposits };
}

/**
 * Take material off a surface — the ONLY way a deposit ever shrinks.
 *
 * Scoped by place, and optionally by substance, because that is how the fiction
 * says it: wiping her cheek takes off whatever is on her cheek, while washing
 * the blood off her hands names the substance. Everything at or under the
 * removal floor is dropped, so a nearly-clean surface leaves no residue in the
 * jsonb and the record stays bounded without an eviction policy.
 *
 * A QUARANTINED slot is never removed — dropping it would turn "unknown" into
 * the absence default, which is "clean", which is the laundering the marker
 * exists to prevent. Only an authoritative write clears it.
 */
export function reduceBodySurfaceDeposits(
  state: BodySurfaceState,
  input: { locationId: string; amount: number; kind?: SurfaceDepositKind },
): BodySurfaceState {
  if (state.deposits === undefined) return state;
  const removal = clampFixedPoint(Math.trunc(input.amount), BODY_SURFACE_UNIT_ONE);
  if (removal <= 0) return state;
  const deposits = { ...state.deposits };
  let changed = false;
  for (const [depositId, slot] of Object.entries(deposits)) {
    if (isInvalidDepositSlot(slot)) continue;
    if (slot.locationId !== input.locationId) continue;
    if (input.kind !== undefined && slot.kind !== input.kind) continue;
    const remaining = slot.amount - removal;
    changed = true;
    if (remaining <= BODY_SURFACE_DEPOSIT_REMOVAL_FLOOR) delete deposits[depositId];
    else deposits[depositId] = { ...slot, amount: remaining };
  }
  if (!changed) return state;
  if (Object.keys(deposits).length === 0) return withoutBodySurfaceKey(state, "deposits");
  return { ...state, deposits };
}

// ---------------------------------------------------------------------------
// Deposits — the conserving pair (effects spec §9; owner ruling 2026-08-26)
// ---------------------------------------------------------------------------

/**
 * Why there are two more deposit writers here rather than a mode flag on the
 * two above.
 *
 * `commitBodySurfaceDeposit` and `reduceBodySurfaceDeposits` mean what the
 * fiction means. "There is mud on her hands" establishes *at least* that much
 * material, so the commit RAISES and never adds — saying it twice is not a
 * report that some of it left. "She washes her hands" is an explicit sink, so
 * the reduce sweeps everything under `BODY_SURFACE_DEPOSIT_REMOVAL_FLOOR` away
 * with it and takes the same amount off every substance standing there.
 *
 * Neither is a conserving move, and §9's transfer law is nothing but
 * conservation: exactly what leaves one surface arrives on the others, in this
 * representation, atomically. Stretching the two writers above until the
 * conservation tests happened to pass would have quietly changed what the
 * fiction's own sentences mean. So a transfer gets its own pair, and they are
 * deliberately unmistakable:
 *
 * - `takeBodySurfaceDeposit` reports **exactly** how much actually left, and
 *   does NOT inherit the removal floor. Taking 1,000 off a 1,400 deposit leaves
 *   400 standing, because 400 units of mud are still on her hand and the shared
 *   band reader calls anything from 1 upward `slight`. The floor is a cleanup
 *   policy that belongs to washing, where the vanished trace went somewhere a
 *   modelled sink accounts for.
 * - `acceptBodySurfaceDeposit` **adds**, and refuses rather than clamping,
 *   evicting, or discarding an overflow. A destination that silently absorbs
 *   less than the source lost is the unowned sink §7 exists to prevent.
 *
 * Both are keyed by the exact deposit identity rather than by location, because
 * a transfer moves one named substance and the reduce's take-from-everything
 * behaviour would destroy the blood while moving the mud.
 */

/** What a conserving take actually removed. `taken` is the number the transaction must deposit. */
export interface BodySurfaceTakeResult {
  readonly state: BodySurfaceState;
  /** Exactly the material that left, in fixed point. Zero means nothing moved and `state` is the input. */
  readonly taken: number;
}

/** Why a conserving accept refused. Every one of these means nothing was written. */
export type BodySurfaceAcceptRefusal = "invalid_amount" | "saturated" | "quarantined" | "capacity";

export type BodySurfaceAcceptResult =
  | { readonly status: "accepted"; readonly state: BodySurfaceState; readonly depositId: string; readonly accepted: number }
  | { readonly status: "refused"; readonly reason: BodySurfaceAcceptRefusal };

/**
 * Take material off one named deposit, and report exactly how much left.
 *
 * Total and non-throwing on every axis (docs/resilience.md). A missing slot, a
 * quarantined slot, and a non-positive request all answer `taken: 0` with the
 * input state by reference — a quarantined slot most deliberately of all, since
 * moving material out of an unreadable amount would invent the amount.
 *
 * A request larger than what stands takes everything that is there. That is not
 * a degraded answer: the planner asked to move a substance and the surface had
 * less of it than expected, so the honest conserved quantity is what was
 * actually there, and `taken` is what the destination leg must receive.
 */
export function takeBodySurfaceDeposit(
  state: BodySurfaceState,
  input: { depositId: string; amount: number },
): BodySurfaceTakeResult {
  const request = clampFixedPoint(Math.trunc(input.amount), BODY_SURFACE_UNIT_ONE);
  if (request <= 0) return { state, taken: 0 };
  const slot = state.deposits?.[input.depositId];
  if (slot === undefined || isInvalidDepositSlot(slot)) return { state, taken: 0 };
  const taken = Math.min(request, slot.amount);
  const remaining = slot.amount - taken;
  const deposits = { ...state.deposits };
  // Remaining material stays, however little of it: the removal floor is
  // washing's policy, and a transfer that swept it would destroy the difference
  // between what left and what arrived.
  if (remaining <= 0) delete deposits[input.depositId];
  else deposits[input.depositId] = { ...slot, amount: remaining };
  if (Object.keys(deposits).length === 0) return { state: withoutBodySurfaceKey(state, "deposits"), taken };
  return { state: { ...state, deposits }, taken };
}

/**
 * Put an exact amount of material on a surface, ADDING to whatever already
 * stands under that identity.
 *
 * Refuses, never approximates. The four refusals are the four ways a
 * destination could otherwise absorb less than the source lost:
 *
 * - `invalid_amount` — a non-positive amount. A zero leg is a planner bug, not
 *   a no-op to wave through: §9's transaction is an equation, and a leg that
 *   moves nothing should never have been in it.
 * - `saturated` — the sum would pass `BODY_SURFACE_UNIT_ONE`. Clamping here
 *   would be the silent discard.
 * - `quarantined` — an unreadable slot stands under this identity. Adding to an
 *   amount nobody can read would invent the total; overwriting it would launder
 *   the marker.
 * - `capacity` — the record is full and refuses rather than evicting, exactly
 *   as `commitBodySurfaceDeposit` does.
 *
 * The identity is the ordinary `dep:<kind>:<location>:<minute>` one, so
 * material arriving in the same beat deepens one record and a replay lands on
 * the key it already wrote.
 */
export function acceptBodySurfaceDeposit(
  state: BodySurfaceState,
  input: {
    locationId: string;
    kind: SurfaceDepositKind;
    amount: number;
    atMinutes: number;
    cause?: string;
  },
): BodySurfaceAcceptResult {
  const amount = Math.trunc(input.amount);
  if (amount <= 0 || amount > BODY_SURFACE_UNIT_ONE) return { status: "refused", reason: "invalid_amount" };
  const atMinutes = Math.max(0, Math.trunc(input.atMinutes));
  const depositId = bodySurfaceDepositIdFor(input.locationId, input.kind, atMinutes);
  const existing = state.deposits?.[depositId];
  if (existing !== undefined && isInvalidDepositSlot(existing)) return { status: "refused", reason: "quarantined" };
  if (existing === undefined && Object.keys(state.deposits ?? {}).length >= BODY_SURFACE_MAX_DEPOSITS) {
    return { status: "refused", reason: "capacity" };
  }
  const total = (existing?.amount ?? 0) + amount;
  if (total > BODY_SURFACE_UNIT_ONE) return { status: "refused", reason: "saturated" };
  const deposits = { ...state.deposits };
  deposits[depositId] =
    existing === undefined
      ? {
          locationId: input.locationId,
          kind: input.kind,
          amount: total,
          createdAtMinutes: atMinutes,
          ...(input.cause === undefined ? {} : { cause: input.cause }),
        }
      : { ...existing, amount: total };
  return { status: "accepted", state: { ...state, deposits }, depositId, accepted: amount };
}

// ---------------------------------------------------------------------------
// Transfer receipts — reads and writes (effects spec §9)
// ---------------------------------------------------------------------------

/**
 * Has this exact causal identity already moved material off this surface?
 *
 * The one question the transaction asks BEFORE any debit or credit. A
 * quarantined slot answers `true`, and that is the conservative direction: an
 * unreadable receipt means something was written under this identity, and
 * re-running a transfer that may already have committed is the failure §9
 * forbids, while skipping one that did not is a beat that quietly does not
 * happen.
 */
export function bodySurfaceTransferCommitted(state: BodySurfaceState, transferKey: string): boolean {
  return state.transfers?.[transferKey] !== undefined;
}

/** The receipt under this identity, for evidence and traces. Quarantined slots included. */
export function bodySurfaceTransferReceipt(
  state: BodySurfaceState,
  transferKey: string,
): BodySurfaceTransferReceiptSlot | undefined {
  return state.transfers?.[transferKey];
}

/**
 * Drop receipts older than the horizon. Called on the write path, never on a
 * read: pruning a receipt cannot change any answer about the body, and doing it
 * lazily at read time would make two readers of the same state disagree about
 * whether a transfer may run.
 */
export function pruneBodySurfaceTransferReceipts(state: BodySurfaceState, atMinutes: number): BodySurfaceState {
  if (state.transfers === undefined) return state;
  const now = Math.max(0, Math.trunc(atMinutes));
  const transfers: Record<string, BodySurfaceTransferReceiptSlot> = {};
  for (const [key, slot] of Object.entries(state.transfers)) {
    // A quarantined receipt has no readable minute, so the horizon cannot
    // retire it. It stays, and the capacity rule below is what eventually
    // reports the record as full — a refusal, which is honest, rather than a
    // guess about when an unreadable entry stopped mattering.
    if (isInvalidTransferReceiptSlot(slot)) transfers[key] = slot;
    else if (now - slot.atMinutes <= BODY_SURFACE_TRANSFER_RECEIPT_HORIZON_MINUTES) transfers[key] = slot;
  }
  if (Object.keys(transfers).length === Object.keys(state.transfers).length) return state;
  if (Object.keys(transfers).length === 0) return withoutBodySurfaceKey(state, "transfers");
  return { ...state, transfers };
}

/** Why a receipt could not be recorded. Both mean the transfer must not commit. */
export type BodySurfaceReceiptRefusal = "duplicate" | "capacity";

export type BodySurfaceReceiptResult =
  | { readonly status: "recorded"; readonly state: BodySurfaceState }
  | { readonly status: "refused"; readonly reason: BodySurfaceReceiptRefusal };

/**
 * Record that this causal identity moved `amount` off this surface.
 *
 * Refuses on a standing key rather than overwriting: the transaction is
 * supposed to have short-circuited on `bodySurfaceTransferCommitted` long
 * before reaching here, so arriving with a duplicate means the caller debited
 * something it should not have, and the honest answer is to refuse the whole
 * settlement rather than to paper over it with a fresh receipt.
 *
 * Refuses at capacity for the reason the deposit record does: evicting the
 * oldest receipt would make the transfer it recorded runnable a second time,
 * which is the exact duplicate this module exists to prevent.
 */
export function recordBodySurfaceTransferReceipt(
  state: BodySurfaceState,
  input: { transferKey: string; amount: number; atMinutes: number },
): BodySurfaceReceiptResult {
  const pruned = pruneBodySurfaceTransferReceipts(state, input.atMinutes);
  if (bodySurfaceTransferCommitted(pruned, input.transferKey)) return { status: "refused", reason: "duplicate" };
  const transfers = { ...pruned.transfers };
  if (Object.keys(transfers).length >= BODY_SURFACE_MAX_TRANSFER_RECEIPTS) {
    return { status: "refused", reason: "capacity" };
  }
  transfers[input.transferKey] = {
    amount: clampFixedPoint(Math.trunc(input.amount), BODY_SURFACE_UNIT_ONE),
    atMinutes: Math.max(0, Math.trunc(input.atMinutes)),
  };
  return { status: "recorded", state: { ...pruned, transfers } };
}
