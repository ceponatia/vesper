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
 *    for the caller and returns a number; the caller decides when to persist an
 *    integrated value (integrate on WRITE, never on read).
 * 3. **`updatedAtMinutes` means "when this location's wetness last CHANGED".**
 *    Deliberately not "when it was last integrated": the affordance adapter reads
 *    it as the freshness anchor for the cause ("did the rain land recently
 *    enough to still be the reason?"), and restamping it on every quiet exchange
 *    would make a week-old soaking read as fresh rain forever. So a write only
 *    ever touches the locations a proposal names (plus pruning entries that have
 *    dried all the way to zero — an absent entry IS dry).
 *
 * **Scope this release: the PRIMARY character only.** There is no player or
 * ensemble-member surface state — the extraction field says so, and
 * `finalizeChatState` folds only the primary's row. Extending it is the same
 * shape as the wardrobe's: the player would ride `ChatScenario` (one player, many
 * characters) and ensemble members their own `character_chat_state` rows through
 * the per-member personal pass.
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
 * One location's standing wetness. Every leaf `.catch`es, and the conservative
 * degraded value is DRY: a corrupt level reads `0`, which suppresses the
 * wetness-dependent phenomena rather than inventing a soaking.
 */
export const bodySurfaceWetnessSchema = z.object({
  /** Fixed point `0 … BODY_SURFACE_UNIT_ONE`. */
  level: z.number().int().min(0).max(BODY_SURFACE_UNIT_ONE).catch(0).default(0),
  /** Story minute this location's wetness last CHANGED — the drying anchor AND the cause's freshness stamp. */
  updatedAtMinutes: z.number().int().min(0).catch(0).default(0),
  cause: bodySurfaceWetnessCauseSchema.optional().catch(undefined),
});
export type BodySurfaceWetness = z.infer<typeof bodySurfaceWetnessSchema>;

/**
 * Item-lenient by construction (docs/resilience.md §3): the record parses as
 * `unknown` values and drops the entries that fail, so one corrupt location can
 * never void a character's whole surface state.
 */
const wetnessRecordSchema = z
  .record(locationKeySchema, z.unknown())
  .catch({})
  .default({})
  .transform((raw) => {
    const wetness: Record<string, BodySurfaceWetness> = {};
    for (const [locationId, value] of Object.entries(raw).slice(0, BODY_SURFACE_MAX_LOCATIONS)) {
      const parsed = bodySurfaceWetnessSchema.safeParse(value);
      if (parsed.success) wetness[locationId] = parsed.data;
    }
    return wetness;
  });

export const bodySurfaceStateSchema = z.object({
  /** Body-location id → standing wetness. An ABSENT location is dry (the default, and the only default). */
  wetness: wetnessRecordSchema,
});
export type BodySurfaceState = z.infer<typeof bodySurfaceStateSchema>;

/** Nothing wet — the seed value and the degraded default at every trust boundary. */
export function emptyBodySurfaceState(): BodySurfaceState {
  return { wetness: {} };
}

// ---------------------------------------------------------------------------
// Reads (pure; never mutate)
// ---------------------------------------------------------------------------

/** This location's stored entry, or `undefined` when it has never been wet. */
export function bodySurfaceWetnessEntry(
  state: BodySurfaceState,
  locationId: string,
): BodySurfaceWetness | undefined {
  return state.wetness[locationId];
}

/**
 * Wetness at `atMinutes`, dried forward from the last change — the LAZY read.
 *
 * Total and monotone: the result is never negative, never above the stored
 * level, and integrating to a minute at or before the last write is the identity
 * (the §25.2 "queries never persist" law both lanes inherit). Reading changes
 * nothing; `applySurfaceWetnessProposals` is the only thing that persists.
 */
export function bodySurfaceWetnessAt(state: BodySurfaceState, locationId: string, atMinutes: number): number {
  const entry = state.wetness[locationId];
  if (entry === undefined) return 0;
  const elapsed = atMinutes - entry.updatedAtMinutes;
  if (elapsed <= 0) return clampFixedPoint(entry.level, BODY_SURFACE_UNIT_ONE);
  return clampFixedPoint(
    linearDriftStep({
      value: entry.level,
      target: 0,
      ratePerHourFixedPoint: BODY_SURFACE_DRY_RATE_PER_HOUR,
      elapsedSeconds: elapsed * SECONDS_PER_MINUTE,
      one: BODY_SURFACE_UNIT_ONE,
    }),
    BODY_SURFACE_UNIT_ONE,
  );
}

// ---------------------------------------------------------------------------
// Writes (pure; the caller persists)
// ---------------------------------------------------------------------------

/**
 * Persist a location's wetness at `atMinutes`. A level of zero DROPS the entry:
 * "dry" is the absence default, so a dried-out surface leaves no residue in the
 * jsonb and the record stays bounded without an eviction policy.
 */
export function setBodySurfaceWetness(
  state: BodySurfaceState,
  input: { locationId: string; level: number; atMinutes: number; cause?: BodySurfaceWetnessCause },
): BodySurfaceState {
  const level = clampFixedPoint(Math.trunc(input.level), BODY_SURFACE_UNIT_ONE);
  const wetness = { ...state.wetness };
  if (level <= 0) {
    delete wetness[input.locationId];
    return { wetness };
  }
  if (wetness[input.locationId] === undefined && Object.keys(wetness).length >= BODY_SURFACE_MAX_LOCATIONS) {
    return state;
  }
  wetness[input.locationId] = {
    level,
    updatedAtMinutes: Math.max(0, Math.trunc(input.atMinutes)),
    ...(input.cause === undefined ? {} : { cause: input.cause }),
  };
  return { wetness };
}

/**
 * Drop every entry that has dried all the way to zero by `atMinutes`.
 *
 * The one write that is safe to run on an exchange that proposed nothing: it
 * cannot change what any read returns (a zero entry and an absent entry are the
 * same answer) and it does not restamp `updatedAtMinutes` on anything still wet,
 * so the cause-freshness anchor survives. Returns the SAME reference when
 * nothing was pruned, so a caller can cheaply skip a write.
 */
export function pruneDryBodySurface(state: BodySurfaceState, atMinutes: number): BodySurfaceState {
  const dry = Object.keys(state.wetness).filter((locationId) => bodySurfaceWetnessAt(state, locationId, atMinutes) <= 0);
  if (dry.length === 0) return state;
  const wetness = { ...state.wetness };
  for (const locationId of dry) delete wetness[locationId];
  return { wetness };
}
