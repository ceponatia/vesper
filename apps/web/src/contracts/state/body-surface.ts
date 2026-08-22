import { z } from "zod";
import { clampFixedPoint, FIXED_POINT_ONE, linearDriftStep } from "@/lib/fixed-point";

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
});
export type BodySurfaceState = z.infer<typeof bodySurfaceStateSchema>;

/** Nothing wet — the seed value and the degraded default at every trust boundary. */
export function emptyBodySurfaceState(): BodySurfaceState {
  return { wetness: {} };
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
  if (Object.keys(marks).length === 0) return { wetness: state.wetness };
  return { ...state, marks };
}
