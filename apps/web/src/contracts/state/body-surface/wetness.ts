// One stored body-surface domain; its laws are documented in state/body-surface.ts.
import {
  type BodySurfaceState,
  type BodySurfaceEntry,
  isUnusableSurfaceKeyEntry,
  isInvalidSurfaceEntry,
  BODY_SURFACE_UNIT_ONE,
  SECONDS_PER_MINUTE,
  type BodySurfaceWetnessCause,
  BODY_SURFACE_MAX_LOCATIONS,
} from "./schema";
import { clampFixedPoint, linearDriftStep } from "@/lib/fixed-point";

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
/** Both quarantines and the poisoned absence collapse here — a caller may spend none of them. */
const INVALID_READ: BodySurfaceWetnessRead = { status: "invalid" };

/**
 * Does this record hold a key nobody can assign to a location?
 *
 * The question absence has to ask before answering "dry" (law 4). Cheap by
 * construction: the record is capped at `BODY_SURFACE_MAX_LOCATIONS`, and the
 * scan only runs on the absent branch.
 */
function bodySurfaceHoldsUnusableKey(state: BodySurfaceState): boolean {
  for (const entry of Object.values(state.wetness)) {
    if (isUnusableSurfaceKeyEntry(entry)) return true;
  }
  return false;
}

export interface BodySurfaceReadOptions {
  /**
   * Hold the committed level instead of drying it forward — the caller has an
   * authoritative reason the surface is not drying right now (standing outdoor
   * precipitation is the one live case; see law 5 in `state/body-surface.ts`). Never raises the
   * level: raising requires a committed proposal.
   */
  readonly suspendDrying?: boolean;
}

/**
 * Wetness at `atMinutes`, dried forward from the last change — the LAZY read.
 *
 * Total and monotone: a `known` result is never negative, never above the stored
 * level, and integrating to a minute at or before the last write is the identity
 * (the "queries never persist" law both lanes inherit). Reading changes
 * nothing; `applySurfaceWetnessProposals` is the only thing that persists.
 *
 * **An absent location is dry only in a record whose keys are all assignable**
 * (law 4). Quarantining an unusable key under its raw identity is necessary and
 * NOT sufficient: if `"  hair  "` sits in quarantine and a caller then asks for
 * `hair`, that canonical key is absent, absence means dry, and the corrupt row
 * has still bought the convenient physical answer. So an unassignable key makes
 * every absence in its record read `invalid` — the SAME status a corrupt entry
 * reads, deliberately, because every consumer already handles it conservatively
 * (the hair domain treats wetness as structural and falls silent; the visual
 * adapter files `affordance.input.invalid`) and a fourth answer would buy
 * nothing they could act on.
 *
 * A fresh authoritative write still heals the location it NAMES, because a
 * present key outranks the poison — and when the record is full it makes room by
 * spending an unassignable key rather than refusing (`setBodySurfaceWetness`),
 * so the poison can never wedge a full record shut. What it does not do is heal
 * the RECORD: absence keeps reading invalid for as long as any unassignable key
 * is still standing.
 */
export function bodySurfaceWetnessAt(
  state: BodySurfaceState,
  locationId: string,
  atMinutes: number,
  options?: BodySurfaceReadOptions,
): BodySurfaceWetnessRead {
  const entry = state.wetness[locationId];
  if (entry === undefined) return bodySurfaceHoldsUnusableKey(state) ? INVALID_READ : DRY_READ;
  if (isInvalidSurfaceEntry(entry)) return INVALID_READ;
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
 *
 * **At capacity a new location reclaims the slot of an UNASSIGNABLE KEY, and of
 * nothing else** (the material-capacity law, refined by the
 * 2026-08-26 ruling). That law protects committed material FACTS — an owner may
 * never make room by destroying one. A key nobody can assign to a location is not a
 * fact but a tombstone saying one was lost, so trading it for a named write
 * strictly increases what the record knows: *some unknown location may be wet*
 * becomes *this location is definitely this wet*. A real entry is never
 * reclaimed, and neither is a VALUE-quarantined one — that entry's key still
 * names a location, so it is a real, if unreadable, fact about a known place.
 *
 * Without the exception the poison of law 4 could wedge the record shut: an
 * unassignable key occupies a slot AND makes every absence read invalid, so a
 * full record answers "unknown" for `hair`, sends the authoritative write here,
 * is refused for having no `hair` key to update — and `pruneDryBodySurface`
 * declines to prune a poisoned record, so nothing frees the slot and that
 * location is suppressed for the life of the row.
 *
 * The reclaim picks by **sorted key order**, so a retake of the same exchange
 * against the same stored blob reproduces the identical record.
 *
 * A record full of REAL entries still refuses, returning the SAME reference.
 * That is the capacity law working rather than the bug above, and
 * `applySurfaceWetnessProposals` reports it as `chat_surface.wetness_capacity`
 * instead of letting it pass for a quiet exchange.
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
    const tombstone = Object.keys(wetness)
      .sort()
      .find((key) => {
        const entry = wetness[key];
        return entry !== undefined && isUnusableSurfaceKeyEntry(entry);
      });
    if (tombstone === undefined) return state;
    delete wetness[tombstone];
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
 *
 * And in a record holding an unassignable KEY, nothing prunes at all: absence
 * there reads INVALID rather than dry (law 4), so dropping a dried-out entry
 * would trade a true authoritative fact for silence. Housekeeping does not get
 * to cost information.
 *
 * Which does mean housekeeping can never free a slot in a poisoned record — and
 * that is exactly why `setBodySurfaceWetness` reclaims the unassignable key's own
 * slot at capacity. Recovery is an authoritative write stating a truth, never a
 * prune quietly deciding a fact stopped mattering.
 */
export function pruneDryBodySurface(
  state: BodySurfaceState,
  atMinutes: number,
  options?: BodySurfaceReadOptions,
): BodySurfaceState {
  if (bodySurfaceHoldsUnusableKey(state)) return state;
  const dry = Object.keys(state.wetness).filter((locationId) => {
    const read = bodySurfaceWetnessAt(state, locationId, atMinutes, options);
    return read.status === "known" && read.level <= 0;
  });
  if (dry.length === 0) return state;
  const wetness = { ...state.wetness };
  for (const locationId of dry) delete wetness[locationId];
  return { ...state, wetness };
}