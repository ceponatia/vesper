/**
 * Per-character BODY-SURFACE state — what is on the skin and hair right now:
 * extraction-proposed, fixed-point, lazily dried on the story clock, on the
 * garment-condition precedent.
 *
 * This is an AUTHORITATIVE owner, which is the whole point: before it existed the
 * hair domain had no wetness input in the chat lane, and the adapter
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
 * 4. **Absent, dry, and INVALID are three different answers — and absence only
 *    means dry while every stored key can be assigned to a location.** An absent
 *    location is honestly dry: nothing ever recorded wetting it. A corrupt stored
 *    ENTRY is not: it is quarantined as `{ status: "invalid" }` and every read
 *    says so. A corrupt stored KEY is worse than either, because an unassignable
 *    key could have named ANY location — so it quarantines under its own raw
 *    identity *and* poisons the absence inference, and every absent location in
 *    that record reads invalid rather than dry (owner ruling 2026-08-26). The
 *    asymmetry is deliberate: a corrupt VALUE has known scope (the location its
 *    key names) and poisons nothing else. Either way a bad jsonb blob can never
 *    buy the mobility that dry hair has and wet hair does not.
 *
 *    An unassignable key is nonetheless a **tombstone, not a material fact** —
 *    it records that a fact was lost, and names no location to be true about —
 *    so it is the one thing a write at capacity may spend to make room
 *    (`setBodySurfaceWetness`; the 2026-08-26 ruling's own refinement of the
 *    material-capacity law). Without that exception
 *    the poison could wedge a full record shut permanently, which is the
 *    opposite of what law 4 exists to protect.
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
 * (the 2026-08-22 ruling that
 * the body-surface domain owns all current material/condition on skin, not a
 * contact-local store per aftermath family). Marks inherit every law above:
 * fixed point, lazy fading on the story clock, integrate-on-write, per-entry
 * quarantine, bounded jsonb. Two mark-specific laws:
 *
 * 6. **A mark record is keyed by its IDEMPOTENCY IDENTITY**, derived by the
 *    proposer from the causal contact event — so a retried commit lands on the
 *    key it already wrote and changes nothing, structurally rather than by a
 *    comparison someone has to remember.
 * 7. **A mark's fade anchors at `createdAtMinutes` and is never restamped.** A
 *    mark is one physical event's residue; pressing again is a NEW event with
 *    its own key, never a refresh of the old one. Absent entry = no mark, and a
 *    mark that fades to zero is pruned on the next write (the wetness rule).
 *
 * **Deposits are the THIRD module of this same owner** (owner ruling
 * 2026-08-25). Mud, blood, dust, food,
 * paint, and cosmetics on skin were the visual layer's largest current-state
 * gap — garments could carry them and the body under those garments could not —
 * and they land here rather than in a store of their own for the same stated
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

// Public body-surface contract. Schema and quarantine have one owner; each
// operation family reads that contract directly without importing this entry.
export {
  bodySurfaceWetnessCauses,
  bodySurfaceWetnessCauseSchema,
  type BodySurfaceWetnessCause,
  BODY_SURFACE_UNIT_ONE,
  BODY_SURFACE_MAX_LOCATIONS,
  bodySurfaceWetnessSchema,
  type BodySurfaceWetness,
  bodySurfaceInvalidEntrySchema,
  type BodySurfaceInvalidEntry,
  BODY_SURFACE_INVALID_ENTRY,
  type BodySurfaceUnusableKeyEntry,
  BODY_SURFACE_UNUSABLE_KEY_ENTRY,
  type BodySurfaceEntry,
  isInvalidSurfaceEntry,
  isUnusableSurfaceKeyEntry,
  bodySurfaceMarkKinds,
  bodySurfaceMarkKindSchema,
  type BodySurfaceMarkKind,
  bodySurfaceMarkBands,
  type BodySurfaceMarkBand,
  BODY_SURFACE_MAX_MARKS,
  BODY_SURFACE_MARK_ID_MAX_LENGTH,
  bodySurfaceMarkSchema,
  type BodySurfaceMark,
  type BodySurfaceMarkSlot,
  isInvalidMarkSlot,
  BODY_SURFACE_MAX_DEPOSITS,
  bodySurfaceDepositSchema,
  type BodySurfaceDeposit,
  type BodySurfaceDepositSlot,
  isInvalidDepositSlot,
  BODY_SURFACE_MAX_TRANSFER_RECEIPTS,
  bodySurfaceTransferReceiptSchema,
  type BodySurfaceTransferReceipt,
  type BodySurfaceTransferReceiptSlot,
  isInvalidTransferReceiptSlot,
  bodySurfaceStateSchema,
  type BodySurfaceState,
  emptyBodySurfaceState,
} from "./body-surface/schema";
export {
  BODY_SURFACE_DRY_RATE_PER_HOUR,
  bodySurfaceWetnessEntry,
  type BodySurfaceWetnessRead,
  type BodySurfaceReadOptions,
  bodySurfaceWetnessAt,
  setBodySurfaceWetness,
  pruneDryBodySurface,
} from "./body-surface/wetness";
export {
  BODY_SURFACE_MARK_FADE_RATE_PER_HOUR,
  BODY_SURFACE_MARK_BAND_MAGNITUDE,
  bodySurfaceMarkBandOf,
  bodySurfaceMarkBandFloor,
  bodySurfaceMarkSlot,
  type BodySurfaceMarkRead,
  bodySurfaceMarkAt,
  commitBodySurfaceMark,
  pruneFadedBodySurfaceMarks,
} from "./body-surface/marks";
export {
  BODY_SURFACE_DEPOSIT_REMOVAL_FLOOR,
  bodySurfaceDepositIdFor,
  bodySurfaceDepositSlot,
  type BodySurfaceDepositRead,
  bodySurfaceDepositAt,
  bodySurfaceDepositsAt,
  commitBodySurfaceDeposit,
  reduceBodySurfaceDeposits,
  type BodySurfaceTakeResult,
  type BodySurfaceAcceptRefusal,
  type BodySurfaceAcceptResult,
  takeBodySurfaceDeposit,
  acceptBodySurfaceDeposit,
} from "./body-surface/deposits";
export {
  BODY_SURFACE_TRANSFER_RECEIPT_HORIZON_MINUTES,
  bodySurfaceTransferCommitted,
  bodySurfaceTransferReceipt,
  pruneBodySurfaceTransferReceipts,
  type BodySurfaceReceiptRefusal,
  type BodySurfaceReceiptResult,
  recordBodySurfaceTransferReceipt,
} from "./body-surface/transfer-receipts";
