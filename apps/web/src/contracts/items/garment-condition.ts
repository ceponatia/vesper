import { addClamped, proportionalDecayStep, scaleFixedPoint } from "@/lib/fixed-point";
import { diag, type DiagnosticSink } from "../diagnostics";
import {
  surfaceDepositFreshnessBandOf,
  surfaceDepositFreshnessBands,
  SURFACE_DEPOSIT_FRESHNESS_HALF_LIFE_MINUTES,
  type SurfaceDepositFreshnessBand,
} from "../materials/surface-deposits";
import { garmentPartNode, type GarmentBlueprint } from "./garment-blueprint";
import {
  garmentMaterialProfile,
  GARMENT_DEGREE_BAND_VALUES,
  GARMENT_UNIT_ONE,
  type GarmentDegreeBand,
  type GarmentMaterialProfile,
  type GarmentUnit,
} from "./garment-material";
import {
  garmentConditionKeys,
  GARMENT_MAX_DAMAGE_MARKS,
  GARMENT_MAX_DEPOSITS,
  GARMENT_MAX_REGION_OVERRIDES,
  type GarmentCleanTarget,
  type GarmentConditionKey,
  type GarmentConditionOverride,
  type GarmentConditionState,
  type GarmentConditionVector,
  type GarmentDamageKind,
  type GarmentDamageMark,
  type GarmentDeposit,
  type GarmentDepositKind,
  type GarmentOperation,
} from "./garment-instance";

/**
 * The CONDITION reducer and its gradients (clothing-state-graph.plan.md §Slice 4
 * · §"Condition vector, regional overrides, and marks"; promotion ruling R4).
 *
 * Slice 2 taught the store how a garment MOVES and slice 3 how it is ARRANGED;
 * this module owns what has HAPPENED to its material — how wet, how soiled, how
 * creased, how worn, what is stuck to it and what is torn.
 *
 * Five rules hold it together:
 *
 * 1. **One kernel, two lanes.** Every number here runs through the shared
 *    `lib/fixed-point.ts` primitives the successor's §25 meter substrate uses —
 *    no floating-point turn math, no second implementation of exponential
 *    approach. The chat lane never imports a successor persistence contract.
 * 2. **No tick loop.** Integration is LAZY: an operation (or a read) integrates
 *    from `integratedAtMinutes` to the event minute, applies a clamped source,
 *    and only an operation persists. A read that changes nothing writes nothing,
 *    which is what keeps two reads at different minutes from rounding apart.
 * 3. **Only `wetness` moves on its own.** It approaches dry at a
 *    `dryingRate`-scaled half-life. `cleanliness` and `wear` never change because
 *    a prompt was built, and `crease_load` accumulates only through events with
 *    near-zero automatic recovery.
 * 4. **The base vector is a DEFAULT, never an average.** A wet hem override
 *    coexists with a dry garment base; a whole-garment band is the worst reading
 *    across base and overrides, so mud at the hem still makes the garment read
 *    soiled. An override that converges back to the base value is dropped.
 * 5. **Deposits and damage are located FACTS, not channels.** Drying moves
 *    wetness and never touches a deposit; only cleaning removes one, and only
 *    where it was applied.
 *
 * Bands (never fixed point) are what a model or narrator may see, and the band
 * reader is HYSTERETIC so a boundary value cannot alternate damp/wet between two
 * reads.
 */

// --- Material response ---------------------------------------------------------

/**
 * Drying half-life at the extremes of `dryingRate`. A soaked synthetic shell
 * (0.9) halves every ~35 story minutes; denim (0.15) takes ~3½ hours. Coarse on
 * purpose — these exist to make materials DIVERGE, not to be meteorology.
 */
export const GARMENT_DRYING_HALF_LIFE_SLOWEST_MINUTES = 240;
export const GARMENT_DRYING_HALF_LIFE_FASTEST_MINUTES = 12;

/** Half-life, in story minutes, of the wetness remaining in this material. */
export function garmentDryingHalfLifeMinutes(profile: GarmentMaterialProfile): number {
  const span = GARMENT_DRYING_HALF_LIFE_SLOWEST_MINUTES - GARMENT_DRYING_HALF_LIFE_FASTEST_MINUTES;
  return Math.max(1, GARMENT_DRYING_HALF_LIFE_SLOWEST_MINUTES - scaleFixedPoint(span, profile.dryingRate));
}

/**
 * The material a part is made of — its own profile, else the root's, else the
 * conservative `unknown`. Omit `partId` for the garment's own (root) material,
 * which is what the BASE vector integrates with.
 */
export function garmentPartMaterialProfile(
  blueprint: GarmentBlueprint,
  partId?: string,
): GarmentMaterialProfile {
  const node = partId === undefined ? undefined : garmentPartNode(blueprint, partId);
  const root = garmentPartNode(blueprint, blueprint.rootNodeId);
  return garmentMaterialProfile(node?.materialProfileId ?? root?.materialProfileId);
}

// --- Bands ---------------------------------------------------------------------

export const garmentWetnessBands = ["dry", "damp", "wet", "soaked"] as const;
export const garmentCleanlinessBands = ["filthy", "soiled", "marked", "clean", "fresh"] as const;
export const garmentCreaseBands = ["smooth", "creased", "rumpled", "crumpled"] as const;
export const garmentWearBands = ["pristine", "worn", "shabby", "threadbare"] as const;

export type GarmentConditionBand =
  | (typeof garmentWetnessBands)[number]
  | (typeof garmentCleanlinessBands)[number]
  | (typeof garmentCreaseBands)[number]
  | (typeof garmentWearBands)[number];

/** Ascending by fixed-point floor; the first floor is always 0, so a band always resolves. */
type ConditionBandLadder = readonly (readonly [GarmentUnit, GarmentConditionBand])[];

/**
 * Each channel's ladder, stated in ITS OWN direction. `cleanliness` runs
 * soiled→clean like the stored value, so `filthy` sits at the bottom and `fresh`
 * at the top; the other three run neutral→extreme.
 */
export const GARMENT_CONDITION_BAND_LADDERS: Readonly<Record<GarmentConditionKey, ConditionBandLadder>> = {
  wetness: [
    [0, "dry"],
    [1_500, "damp"],
    [4_500, "wet"],
    [8_000, "soaked"],
  ],
  cleanliness: [
    [0, "filthy"],
    [1_500, "soiled"],
    [4_500, "marked"],
    [7_500, "clean"],
    [9_500, "fresh"],
  ],
  crease_load: [
    [0, "smooth"],
    [1_500, "creased"],
    [4_500, "rumpled"],
    [8_000, "crumpled"],
  ],
  wear: [
    [0, "pristine"],
    [1_500, "worn"],
    [4_500, "shabby"],
    [8_000, "threadbare"],
  ],
};

/** The "nothing to report" band per channel — what a fresh garment reads. */
export const GARMENT_CONDITION_NEUTRAL_BANDS: Readonly<Record<GarmentConditionKey, GarmentConditionBand>> = {
  wetness: "dry",
  cleanliness: "fresh",
  crease_load: "smooth",
  wear: "pristine",
};

/**
 * How far BELOW a band's floor a value must fall before the band is allowed to
 * drop back (5% of the scale). Crossing UP needs only the floor; crossing DOWN
 * needs floor − this. That asymmetry is the whole point: a value parked on 4_500
 * would otherwise alternate "damp"/"wet" between two reads of the same garment.
 */
export const GARMENT_BAND_HYSTERESIS = 500;

/** The band a stored value falls in, with no memory of what was reported before. */
export function garmentConditionBand(channel: GarmentConditionKey, value: number): GarmentConditionBand {
  const ladder = GARMENT_CONDITION_BAND_LADDERS[channel];
  let band: GarmentConditionBand = GARMENT_CONDITION_NEUTRAL_BANDS[channel];
  for (const [floor, label] of ladder) {
    if (value >= floor) band = label;
  }
  return band;
}

/**
 * The band to REPORT, given the band last reported. Rising is immediate; falling
 * must clear `GARMENT_BAND_HYSTERESIS` below the previous band's floor, so a
 * garment hovering on a boundary keeps saying the same thing.
 *
 * `previous` is whatever the consumer last showed (slice 6's cue map is the
 * durable home for it); an unknown or absent previous band degrades to the plain
 * reading, never to a throw.
 */
export function hystereticGarmentConditionBand(
  channel: GarmentConditionKey,
  value: number,
  previous: string | null | undefined,
): GarmentConditionBand {
  const ladder = GARMENT_CONDITION_BAND_LADDERS[channel];
  const plain = garmentConditionBand(channel, value);
  if (previous === null || previous === undefined) return plain;
  const previousIndex = ladder.findIndex(([, label]) => label === previous);
  const plainIndex = ladder.findIndex(([, label]) => label === plain);
  if (previousIndex < 0 || plainIndex < 0 || plainIndex >= previousIndex) return plain;
  const previousFloor = ladder[previousIndex]?.[0] ?? 0;
  return value < previousFloor - GARMENT_BAND_HYSTERESIS ? plain : ladder[previousIndex]?.[1] ?? plain;
}

// --- Deposit freshness (derived, never stored twice) ---------------------------

/** ALIASES of the shared surface vocabulary — see `garmentDepositKinds` for why. */
export const garmentDepositFreshnessBands = surfaceDepositFreshnessBands;
export type GarmentDepositFreshnessBand = SurfaceDepositFreshnessBand;

/** Half-life of "this just happened" — phrasing only; freshness never removes a deposit. */
export const GARMENT_DEPOSIT_FRESHNESS_HALF_LIFE_MINUTES = SURFACE_DEPOSIT_FRESHNESS_HALF_LIFE_MINUTES;

/**
 * A deposit's freshness AT a story minute. Derived from the stored stamp rather
 * than integrated into the row, because freshness drives phrasing only: it must
 * never be a second thing a retake has to restore, and it is emphatically not a
 * removal clock (a week-old mud stain is `set`, not gone).
 */
export function garmentDepositFreshnessAt(deposit: GarmentDeposit, atMinutes: number): GarmentUnit {
  return proportionalDecayStep({
    value: deposit.freshness,
    target: 0,
    halfLife: GARMENT_DEPOSIT_FRESHNESS_HALF_LIFE_MINUTES,
    elapsed: Math.max(0, atMinutes - deposit.atMinutes),
  });
}

export function garmentDepositFreshnessBand(deposit: GarmentDeposit, atMinutes: number): GarmentDepositFreshnessBand {
  return surfaceDepositFreshnessBandOf(garmentDepositFreshnessAt(deposit, atMinutes));
}

// --- Reading the vector --------------------------------------------------------

/** Read one channel out of a full vector. */
function channelOf(vector: GarmentConditionVector, channel: GarmentConditionKey): GarmentUnit {
  return vector[channel];
}

/**
 * Write one channel into a partial override. A literal switch rather than a
 * computed key, so the strict four-channel shape survives the write.
 */
function withOverrideChannel(
  override: GarmentConditionOverride,
  channel: GarmentConditionKey,
  value: GarmentUnit,
): GarmentConditionOverride {
  switch (channel) {
    case "wetness":
      return { ...override, wetness: value };
    case "cleanliness":
      return { ...override, cleanliness: value };
    case "crease_load":
      return { ...override, crease_load: value };
    case "wear":
      return { ...override, wear: value };
  }
}

/** The same write over a full vector — the one-channel patch laid over every channel. */
function withChannel(
  vector: GarmentConditionVector,
  channel: GarmentConditionKey,
  value: GarmentUnit,
): GarmentConditionVector {
  const patch = withOverrideChannel({}, channel, value);
  return {
    wetness: patch.wetness ?? vector.wetness,
    cleanliness: patch.cleanliness ?? vector.cleanliness,
    crease_load: patch.crease_load ?? vector.crease_load,
    wear: patch.wear ?? vector.wear,
  };
}

/**
 * The EFFECTIVE vector for one part: its override laid over the base. Absent
 * channels inherit — the base is a default, not an average, so "the hem is wet"
 * says nothing about the collar.
 */
export function garmentConditionAtPart(
  condition: GarmentConditionState,
  partId: string | undefined,
): GarmentConditionVector {
  const override = partId === undefined ? undefined : condition.regionOverrides[partId];
  if (!override) return condition.base;
  let vector = condition.base;
  for (const channel of garmentConditionKeys) {
    const value = override[channel];
    if (value !== undefined) vector = withChannel(vector, channel, value);
  }
  return vector;
}

/**
 * The WHOLE-GARMENT reading: the worst value across the base and every region
 * override, per channel — wetter, dirtier, more creased, more worn wins. This is
 * why a muddy hem makes the garment read soiled without the deposit ever having
 * to touch the base (fixture F8).
 */
export function garmentWorstConditionVector(condition: GarmentConditionState): GarmentConditionVector {
  let worst = condition.base;
  for (const override of Object.values(condition.regionOverrides)) {
    if (!override) continue;
    for (const channel of garmentConditionKeys) {
      const value = override[channel];
      if (value === undefined) continue;
      const current = channelOf(worst, channel);
      // `cleanliness` is the one channel whose LOW end is the bad end.
      const beats = channel === "cleanliness" ? value < current : value > current;
      if (beats) worst = withChannel(worst, channel, value);
    }
  }
  return worst;
}

// --- Integration (lazy, analytic, never on a read that persists) ---------------

/** One material's drying step over `elapsedMinutes`, toward bone dry. */
function dryStep(value: GarmentUnit, profile: GarmentMaterialProfile, elapsedMinutes: number): GarmentUnit {
  return proportionalDecayStep({
    value,
    target: 0,
    halfLife: garmentDryingHalfLifeMinutes(profile),
    elapsed: elapsedMinutes,
  });
}

/** Drop override channels that have converged on the base; drop the entry when nothing is left. */
function pruneOverride(
  override: GarmentConditionOverride,
  base: GarmentConditionVector,
): GarmentConditionOverride | undefined {
  let kept: GarmentConditionOverride = {};
  let any = false;
  for (const channel of garmentConditionKeys) {
    const value = override[channel];
    if (value === undefined || value === channelOf(base, channel)) continue;
    kept = withOverrideChannel(kept, channel, value);
    any = true;
  }
  return any ? kept : undefined;
}

/**
 * Integrate a condition forward to `toMinutes`. Pure and total; integrating to a
 * minute at or before the last write is the identity (the §25.2 "queries never
 * persist" law's other half — you can only ever move forward from a material
 * write).
 *
 * ONLY `wetness` moves. The base dries at the ROOT material's rate and each
 * region override at its own part's, which is how a leather-yoked cotton coat
 * dries unevenly without anyone authoring that. Deposits and damage marks are
 * untouched: **a muddy hem survives whole-garment drying.**
 */
export function integrateGarmentCondition(
  condition: GarmentConditionState,
  blueprint: GarmentBlueprint,
  toMinutes: number,
): GarmentConditionState {
  const elapsed = toMinutes - condition.integratedAtMinutes;
  if (elapsed <= 0) return condition;
  const base: GarmentConditionVector = {
    ...condition.base,
    wetness: dryStep(condition.base.wetness, garmentPartMaterialProfile(blueprint), elapsed),
  };
  const regionOverrides: Record<string, GarmentConditionOverride> = {};
  for (const [partId, override] of Object.entries(condition.regionOverrides)) {
    if (!override) continue;
    const dried =
      override.wetness === undefined
        ? override
        : { ...override, wetness: dryStep(override.wetness, garmentPartMaterialProfile(blueprint, partId), elapsed) };
    const pruned = pruneOverride(dried, base);
    if (pruned) regionOverrides[partId] = pruned;
  }
  return { ...condition, base, regionOverrides, integratedAtMinutes: toMinutes };
}

// --- Structural comparison -----------------------------------------------------

/**
 * Everything a retake must restore, in a stable order — deliberately EXCLUDING
 * `integratedAtMinutes`, so "did this operation actually change the garment?"
 * is not answered "yes, it moved the clock".
 */
function conditionFingerprint(condition: GarmentConditionState): string {
  const overrides = Object.entries(condition.regionOverrides)
    .flatMap(([partId, override]) =>
      override ? [`${partId}=${garmentConditionKeys.map((key) => override[key] ?? "-").join(",")}`] : [],
    )
    .sort();
  return JSON.stringify({
    base: garmentConditionKeys.map((key) => channelOf(condition.base, key)),
    overrides,
    deposits: condition.deposits.map((deposit) => [
      deposit.id,
      deposit.kind,
      [...deposit.partIds].sort().join("+"),
      deposit.intensity,
      deposit.extent,
      deposit.freshness,
      deposit.atMinutes,
    ]),
    marks: condition.damageMarks.map((mark) => [
      mark.id,
      mark.kind,
      mark.partId,
      mark.severity,
      mark.extent,
      mark.atMinutes,
    ]),
  });
}

/** Material condition equality — the "this operation changes nothing" test. */
export function sameGarmentCondition(a: GarmentConditionState, b: GarmentConditionState): boolean {
  return conditionFingerprint(a) === conditionFingerprint(b);
}

// --- Operations ----------------------------------------------------------------

/**
 * The operation kinds this slice owns — everything that addresses the material
 * gradients rather than a locus or an arrangement. `accept_transfer` joins them
 * because it writes the same deposit record `deposit` does; what makes it a
 * separate kind is the arithmetic, not the surface it touches (effects spec §9).
 */
export const garmentConditionOperationKinds = [
  "apply_condition",
  "deposit",
  "accept_transfer",
  "clean",
  "damage",
  "repair",
] as const;
export type GarmentConditionOperationKind = (typeof garmentConditionOperationKinds)[number];
export type GarmentConditionOperation = Extract<GarmentOperation, { kind: GarmentConditionOperationKind }>;

/** True when an operation addresses the material gradients rather than a locus or an arrangement. */
export function isGarmentConditionOperation(operation: GarmentOperation): operation is GarmentConditionOperation {
  return (garmentConditionOperationKinds as readonly string[]).includes(operation.kind);
}

/** How thoroughly each clean target lands, as a cleanliness floor. */
export const GARMENT_CLEAN_TARGET_VALUES: Readonly<Record<GarmentCleanTarget, GarmentUnit>> = {
  spot: 6_000,
  clean: 9_000,
  pristine: GARMENT_UNIT_ONE,
};

/** Residue at or under this is nothing anyone can see — the deposit is gone. */
export const GARMENT_DEPOSIT_REMOVAL_FLOOR = 1_000;

/** A damage source is damped by at most half the material's abrasion resistance. */
const DAMAGE_RESISTANCE_SHARE = 5_000;
/** A damage mark also ages the garment: a quarter of its severity lands on `wear`. */
const DAMAGE_WEAR_SHARE = 2_500;

function drop(sink: DiagnosticSink | undefined, code: string, message: string): null {
  sink?.push(diag("info", code, message));
  return null;
}

/** Where a condition-class operation lands: the base vector, some parts, or both. */
interface ConditionScope {
  base: boolean;
  partIds: string[];
  /** True only when the operation named NO parts — the "whole garment" form. */
  wholeGarment: boolean;
}

/**
 * Resolve an operation's `partIds` (OQ7). An EMPTY list is legal on the
 * condition-class operations and means the whole garment — a first-class
 * garment-scoped change, not a fallback. A present but unresolvable handle drops
 * the operation; the garment ROOT is an explicit handle that means the base.
 */
function resolveScope(
  blueprint: GarmentBlueprint,
  partIds: readonly string[],
  kind: string,
  sink?: DiagnosticSink,
): ConditionScope | null {
  if (partIds.length === 0) return { base: true, partIds: [], wholeGarment: true };
  const scope: ConditionScope = { base: false, partIds: [], wholeGarment: false };
  for (const partId of partIds) {
    if (!garmentPartNode(blueprint, partId)) {
      return drop(sink, "garment_op.part_unresolved", `no garment part "${partId}" — ${kind} dropped`);
    }
    if (partId === blueprint.rootNodeId) scope.base = true;
    else if (!scope.partIds.includes(partId)) scope.partIds.push(partId);
  }
  return scope;
}

/**
 * "The whole garment" means the base AND every region currently reading
 * differently from it. Rain does not leave one patch dry because that patch was
 * recorded as an exception, and a wash does not leave a muddy hem behind (fixture
 * F10). An EXPLICIT part list (even one that names the root) is a deliberate
 * selection and is never widened.
 */
function expandRootScope(scope: ConditionScope, condition: GarmentConditionState): ConditionScope {
  if (!scope.wholeGarment) return scope;
  return { base: true, partIds: Object.keys(condition.regionOverrides), wholeGarment: true };
}

/**
 * The clamped source one `apply_condition` degree becomes, in this material.
 *
 * INCREASES are material-scaled — this is where cotton and leather stop being
 * the same garment: the same "substantial" rain lands 0.75 × on cotton's
 * absorbency and 0.12 × on leather's (fixture F7), and the same pose lands on
 * `wrinkleAffinity`. DECREASES are not scaled: towelling a garment off or
 * shaking a crease out removes what is there, and a material coefficient has no
 * business damping a removal.
 *
 * `cleanliness` and `wear` are unscaled in both directions — R4 ships wetness
 * and crease first; those two carry op support and no dynamics of their own.
 */
function conditionSourceDelta(
  channel: GarmentConditionKey,
  degree: GarmentDegreeBand,
  direction: "increase" | "decrease",
  profile: GarmentMaterialProfile,
): number {
  const magnitude = GARMENT_DEGREE_BAND_VALUES[degree];
  if (direction === "decrease") return -magnitude;
  switch (channel) {
    case "wetness":
      return scaleFixedPoint(magnitude, profile.absorbency);
    case "crease_load":
      return scaleFixedPoint(magnitude, profile.wrinkleAffinity);
    case "cleanliness":
    case "wear":
      return magnitude;
  }
}

/** Apply a per-channel change at one scope, writing overrides only where a part differs. */
function writeChannel(
  condition: GarmentConditionState,
  scope: ConditionScope,
  channel: GarmentConditionKey,
  next: (current: GarmentUnit, partId: string | undefined) => GarmentUnit,
): GarmentConditionState {
  const base = scope.base
    ? withChannel(condition.base, channel, next(channelOf(condition.base, channel), undefined))
    : condition.base;
  const regionOverrides: Record<string, GarmentConditionOverride> = {};
  for (const [partId, override] of Object.entries(condition.regionOverrides)) {
    if (!override) continue;
    const pruned = pruneOverride(override, base);
    if (pruned) regionOverrides[partId] = pruned;
  }
  for (const partId of scope.partIds) {
    const current = channelOf(garmentConditionAtPart(condition, partId), channel);
    const candidate = withOverrideChannel(regionOverrides[partId] ?? {}, channel, next(current, partId));
    const pruned = pruneOverride(candidate, base);
    if (pruned) regionOverrides[partId] = pruned;
    else delete regionOverrides[partId];
  }
  return {
    ...condition,
    base,
    regionOverrides: Object.fromEntries(Object.entries(regionOverrides).slice(0, GARMENT_MAX_REGION_OVERRIDES)),
  };
}

/** Deterministic, collision-tolerant deposit identity: same kind + same scope + same minute merges. */
function depositIdFor(partIds: readonly string[], kind: GarmentDepositKind, atMinutes: number): string {
  const scope = partIds.length > 0 ? [...partIds].sort().join("+") : "root";
  return `dep:${kind}:${scope}:${atMinutes}`.slice(0, 64);
}

/** Deterministic damage identity, suffixed when a part takes two of the same in one minute. */
function damageIdFor(
  partId: string,
  kind: GarmentDamageKind,
  atMinutes: number,
  existing: readonly GarmentDamageMark[],
): string {
  const stem = `mark:${kind}:${partId}:${atMinutes}`.slice(0, 58);
  let id = stem;
  let ordinal = 2;
  while (existing.some((mark) => mark.id === id)) {
    id = `${stem}:${ordinal}`;
    ordinal += 1;
  }
  return id;
}

/** The stubbornest material any of a deposit's parts is made of. */
function depositStainRetention(deposit: GarmentDeposit, blueprint: GarmentBlueprint): GarmentUnit {
  const parts = deposit.partIds.length > 0 ? deposit.partIds : [blueprint.rootNodeId];
  return Math.max(...parts.map((partId) => garmentPartMaterialProfile(blueprint, partId).stainRetention));
}

/**
 * What survives cleaning a deposit to `targetValue`: its intensity, damped by how
 * stubbornly the material holds a stain and by how thorough the clean is. A
 * `pristine` target always leaves nothing; a `spot` clean leaves stubborn stains
 * visibly reduced rather than gone.
 */
function depositResidue(deposit: GarmentDeposit, blueprint: GarmentBlueprint, targetValue: GarmentUnit): GarmentUnit {
  const retained = scaleFixedPoint(deposit.intensity, depositStainRetention(deposit, blueprint));
  return scaleFixedPoint(retained, GARMENT_UNIT_ONE - targetValue);
}

/** A deposit after a clean that covered all of it: reduced, or gone (`null`). */
function cleanedDeposit(
  deposit: GarmentDeposit,
  blueprint: GarmentBlueprint,
  targetValue: GarmentUnit,
): GarmentDeposit | null {
  const residue = depositResidue(deposit, blueprint, targetValue);
  if (residue <= GARMENT_DEPOSIT_REMOVAL_FLOOR) return null;
  return { ...deposit, intensity: residue, extent: Math.min(deposit.extent, residue) };
}

/**
 * Record an ORDINARY deposit — the sentence-compiling path, where "there is mud
 * on her sleeve" establishes *at least* that much material at that scope, which
 * is why an identity that already stands is MAX-MERGED rather than added to
 * (`acceptGarmentTransfer` below owns the conserved arithmetic, and the two must
 * never be collapsed behind one name).
 *
 * At capacity a NEW identity is REFUSED (`garment_op.deposit_capacity`) rather
 * than evicting the oldest record. One material-capacity law now holds across
 * both surface owners (romantic-contact-affordances.spec.effects.md §9; owner
 * ruling 2026-08-26): an owner may update a record it already holds, or add one
 * while there is room, but may NEVER make room by destroying another material
 * fact. This path used to `.slice(-GARMENT_MAX_DEPOSITS)`, which read as a
 * policy and behaved as a continuity bug — the mud on her sleeve vanishing
 * because six other things happened to that garment, with no diagnostic, no
 * trace and nothing to tell a narrator the fact had ever existed.
 *
 * Deepening an EXISTING identity still works at capacity, exactly as
 * `acceptGarmentTransfer` allows: the check guards GROWTH, not update.
 *
 * `GARMENT_MAX_DEPOSITS` stays at 12 deliberately, and the objection to
 * refusing is real — a garment accumulates material across many part scopes
 * over a long chat, so its twelve fill faster than a body location's, and a
 * full garment could go quietly deaf to new material. The answer is to MEASURE
 * before resizing, not to resume deleting history: this refusal diagnostic is
 * the instrument, and explicit cleaning already frees capacity (`applyClean`
 * drops any deposit falling under `GARMENT_DEPOSIT_REMOVAL_FLOOR`). Raise the
 * number when the diagnostic says the ceiling is wrong, not before.
 */
function applyDeposit(
  condition: GarmentConditionState,
  operation: Extract<GarmentOperation, { kind: "deposit" }>,
  scope: ConditionScope,
  atMinutes: number,
  sink?: DiagnosticSink,
): GarmentConditionState | null {
  const intensity = GARMENT_DEGREE_BAND_VALUES[operation.degree];
  // A base-scoped deposit is whole-garment; `partIds: []` on the record says so.
  const partIds = scope.base ? [] : [...scope.partIds].sort();
  const id = depositIdFor(partIds, operation.depositKind, atMinutes);
  const existing = condition.deposits.find((deposit) => deposit.id === id);
  if (!existing && condition.deposits.length >= GARMENT_MAX_DEPOSITS) {
    return drop(
      sink,
      "garment_op.deposit_capacity",
      `garment already carries ${GARMENT_MAX_DEPOSITS} deposits — deposit dropped rather than evicting one`,
    );
  }
  const merged: GarmentDeposit = existing
    ? {
        ...existing,
        intensity: Math.max(existing.intensity, intensity),
        extent: Math.max(existing.extent, intensity),
        freshness: GARMENT_UNIT_ONE,
        atMinutes,
      }
    : {
        id,
        kind: operation.depositKind,
        partIds,
        intensity,
        extent: intensity,
        freshness: GARMENT_UNIT_ONE,
        atMinutes,
      };
  // No `.slice(-GARMENT_MAX_DEPOSITS)`, and its absence is the law: the capacity
  // check above already refused the only case that could grow the list, so the
  // slice has nothing left to do except hide a bug by eating a record.
  const deposits = [...condition.deposits.filter((deposit) => deposit.id !== id), merged];
  // A deposit SOILS where it landed: the affected scope can be no cleaner than
  // what the deposit leaves. That is how a hem stain makes the whole garment
  // read soiled without ever writing the base.
  const soiled = writeChannel({ ...condition, deposits }, scope, "cleanliness", (current) =>
    Math.min(current, GARMENT_UNIT_ONE - intensity),
  );
  return soiled;
}

/**
 * Credit an EXACT amount of material to a garment scope — the destination leg
 * of §9's conserved transfer (romantic-contact-affordances.spec.effects.md §9;
 * owner ruling 2026-08-22, "conserved transfer follows the pressure mark").
 *
 * Deliberately NOT `applyDeposit` with a mode flag. `applyDeposit` MAX-MERGES
 * because the sentence it compiles ("there is mud on her sleeve") establishes
 * *at least* that much material, and saying it a second time is not a report
 * that some of it left. That is the right law for continuity extraction and the
 * wrong law for a transfer, whose entire claim is that exactly what left one
 * surface arrived here. Behind one name the two meanings would be
 * indistinguishable at every call site, and the first caller to pick the wrong
 * one breaks conservation silently.
 *
 * Four laws, and each one closes a way the destination could otherwise absorb
 * less than the source lost:
 *
 * - **It ADDS.** `existing + amount`, never `Math.max`. Max-merging a 1_000
 *   credit onto a 4_000 deposit writes 4_000 back and destroys the credit while
 *   the source side still recorded the loss.
 * - **Saturation REFUSES rather than clamping**
 *   (`garment_op.transfer_saturated`). Clamping to `GARMENT_UNIT_ONE` is the
 *   same silent discard with better manners.
 * - **Capacity REFUSES rather than evicting**
 *   (`garment_op.transfer_capacity`) — the one material-capacity law
 *   `applyDeposit` above and the body-surface owner
 *   (`contracts/state/body-surface.ts`) also hold (owner ruling 2026-08-26).
 *   Evicting the oldest record to make room destroys material that was never
 *   part of this transaction — the transfer would "conserve" by deleting
 *   someone else's mud.
 * - **A non-positive or over-unit amount REFUSES**
 *   (`garment_op.transfer_invalid_amount`). A zero leg is a planner bug, not a
 *   no-op to wave through: §9's transaction is an equation, and a leg that moves
 *   nothing should never have been written into it.
 *
 * Every refusal returns `null` with its stable code already on the sink, so the
 * caller drops the whole operation and NOTHING is written — not the deposit, not
 * the cleanliness floor, not even the integration `nextGarmentCondition`
 * computed on the way in. A partial write is precisely the unowned sink §9's
 * atomicity requirement exists to prevent.
 *
 * Two things this reducer deliberately does NOT own:
 *
 * - **Idempotency.** A conserving add is by construction not idempotent, and the
 *   deposit identity is minute-keyed, so a retry inside the same story minute
 *   WOULD credit twice. §9 puts source removal and destination deposition "under
 *   one idempotency key"; that key belongs to the transaction, which must dedupe
 *   before anything reaches here.
 * - **Whether the material should have reached cloth at all.** Path,
 *   permeability, and §9's "material blocked by a garment cannot teleport to
 *   skin" are the transaction's rulings. This leg credits what it is told, to
 *   the scope it is told, and refuses only when it cannot do so exactly.
 */
function acceptGarmentTransfer(
  condition: GarmentConditionState,
  operation: Extract<GarmentOperation, { kind: "accept_transfer" }>,
  scope: ConditionScope,
  atMinutes: number,
  sink?: DiagnosticSink,
): GarmentConditionState | null {
  const amount = Math.trunc(operation.amount);
  // `!(amount > 0)` rather than `amount <= 0` so a NaN that slipped past a
  // hand-built operation refuses instead of arriving as a NaN intensity.
  if (!(amount > 0) || amount > GARMENT_UNIT_ONE) {
    return drop(
      sink,
      "garment_op.transfer_invalid_amount",
      `transfer credit ${operation.amount} is not a unit amount — accept_transfer dropped`,
    );
  }
  // A base-scoped credit is whole-garment; `partIds: []` on the record says so.
  const partIds = scope.base ? [] : [...scope.partIds].sort();
  // The SAME identity space `deposit` writes. One substance, one scope, one
  // minute is one record however it got there: a separate `xfer:` key space
  // would file two records for the same mud on the same cuff, halve the
  // effective capacity, and let a regional clean take one of them and leave the
  // other standing.
  const id = depositIdFor(partIds, operation.depositKind, atMinutes);
  const existing = condition.deposits.find((deposit) => deposit.id === id);
  if (!existing && condition.deposits.length >= GARMENT_MAX_DEPOSITS) {
    return drop(
      sink,
      "garment_op.transfer_capacity",
      `garment already carries ${GARMENT_MAX_DEPOSITS} deposits — accept_transfer dropped rather than evicting one`,
    );
  }
  const total = (existing?.intensity ?? 0) + amount;
  if (total > GARMENT_UNIT_ONE) {
    return drop(
      sink,
      "garment_op.transfer_saturated",
      `${operation.depositKind} at this scope is already ${existing?.intensity ?? 0} — a ${amount} credit would overflow, accept_transfer dropped`,
    );
  }
  // The record's own account of why the material is there outranks a later
  // leg's: a second credit in the same beat deepens the mark, it does not
  // rewrite what put it there.
  const cause = existing?.cause ?? operation.cause;
  // `extent` is NOT a conserved axis and appears nowhere in the transfer
  // equation — the part scope IS the extent here, which is exactly why the
  // body-surface owner has no such axis at all (a body location is its own
  // extent). It rises with the merged total and never falls, because material
  // arriving on a cuff cannot make the mark cover less of the cuff than it
  // already did. Tracking the total rather than the credit also preserves the
  // `extent === intensity` shape a fresh `deposit` writes, so cleaning's
  // `Math.min(extent, residue)` and the band readers keep behaving.
  const credited: GarmentDeposit = existing
    ? {
        ...existing,
        intensity: total,
        extent: Math.max(existing.extent, total),
        freshness: GARMENT_UNIT_ONE,
        atMinutes,
        ...(cause === undefined ? {} : { cause }),
      }
    : {
        id,
        kind: operation.depositKind,
        partIds,
        intensity: total,
        extent: total,
        freshness: GARMENT_UNIT_ONE,
        atMinutes,
        ...(cause === undefined ? {} : { cause }),
      };
  // No `.slice(-GARMENT_MAX_DEPOSITS)`, and its absence is the law: the capacity
  // check above already refused the only case that could grow the list, so the
  // slice would have nothing to do except hide a bug by eating a record.
  const deposits = [...condition.deposits.filter((deposit) => deposit.id !== id), credited];
  // A conserved credit SOILS exactly as an ordinary deposit does. Cleanliness is
  // a derived presentation channel rather than a conserved quantity — nothing in
  // §9's equation reads it — but a credit that left it alone would leave a
  // garment carrying transferred mud still reading pristine to every band reader
  // and narrator, which launders the transfer at the only layer anyone sees. The
  // floor follows the MERGED total, not the credit, so a second leg in the same
  // beat deepens the soiling in step with the deposit, and `Math.min` keeps it
  // monotone: crediting material never scrubs a garment.
  return writeChannel({ ...condition, deposits }, scope, "cleanliness", (current) =>
    Math.min(current, GARMENT_UNIT_ONE - total),
  );
}

function applyClean(
  condition: GarmentConditionState,
  operation: Extract<GarmentOperation, { kind: "clean" }>,
  blueprint: GarmentBlueprint,
  scope: ConditionScope,
): GarmentConditionState {
  const targetValue = GARMENT_CLEAN_TARGET_VALUES[operation.target];
  const cleaned = new Set(scope.partIds);
  const deposits = condition.deposits.flatMap((deposit): GarmentDeposit[] => {
    if (scope.base) {
      // A whole-garment wash reaches everything it can reach.
      const next = cleanedDeposit(deposit, blueprint, targetValue);
      return next ? [next] : [];
    }
    // Regional: a whole-garment deposit is NOT removed by cleaning one part, and
    // a multi-part deposit only loses the parts actually cleaned.
    if (deposit.partIds.length === 0) return [deposit];
    const remaining = deposit.partIds.filter((partId) => !cleaned.has(partId));
    if (remaining.length === deposit.partIds.length) return [deposit];
    if (remaining.length > 0) {
      return [
        {
          ...deposit,
          partIds: remaining,
          extent: scaleFixedPoint(
            deposit.extent,
            Math.floor((remaining.length * GARMENT_UNIT_ONE) / deposit.partIds.length),
          ),
        },
      ];
    }
    const next = cleanedDeposit(deposit, blueprint, targetValue);
    return next ? [next] : [];
  });

  let next = writeChannel({ ...condition, deposits }, scope, "cleanliness", (current) =>
    Math.max(current, targetValue),
  );
  // Only a `pristine` finish is a CARE reset: laundered and pressed. `clean` is a
  // wash — it takes the dirt out and leaves the creases in (fixture F10).
  if (operation.target === "pristine") {
    next = writeChannel(next, scope, "crease_load", () => 0);
  }
  // Damage marks are RETAINED at every target: a wash does not repair a tear.
  return next;
}

function applyDamage(
  condition: GarmentConditionState,
  operation: Extract<GarmentOperation, { kind: "damage" }>,
  blueprint: GarmentBlueprint,
  atMinutes: number,
): GarmentConditionState {
  const profile = garmentPartMaterialProfile(blueprint, operation.partId);
  const magnitude = GARMENT_DEGREE_BAND_VALUES[operation.degree];
  const severity = Math.max(
    1,
    magnitude - scaleFixedPoint(magnitude, scaleFixedPoint(profile.abrasionResistance, DAMAGE_RESISTANCE_SHARE)),
  );
  const mark: GarmentDamageMark = {
    id: damageIdFor(operation.partId, operation.damageKind, atMinutes, condition.damageMarks),
    kind: operation.damageKind,
    partId: operation.partId,
    severity,
    extent: severity,
    atMinutes,
  };
  const damageMarks = [...condition.damageMarks, mark].slice(-GARMENT_MAX_DAMAGE_MARKS);
  return {
    ...condition,
    damageMarks,
    // Damage ages the whole garment, not just the part it landed on.
    base: {
      ...condition.base,
      wear: addClamped(condition.base.wear, scaleFixedPoint(severity, DAMAGE_WEAR_SHARE), GARMENT_UNIT_ONE),
    },
  };
}

/**
 * The next condition for ONE operation, or `null` when it is DROPPED (with its
 * diagnostic already pushed) or changes nothing. Pure over one instance's
 * blueprint + condition; every returned state is integrated to `atMinutes`,
 * which is what makes the integration a material write rather than a query.
 */
export function nextGarmentCondition(
  condition: GarmentConditionState,
  blueprint: GarmentBlueprint,
  operation: GarmentConditionOperation,
  options: { atMinutes: number; sink?: DiagnosticSink },
): GarmentConditionState | null {
  const integrated = integrateGarmentCondition(condition, blueprint, options.atMinutes);
  const next = ((): GarmentConditionState | null => {
    switch (operation.kind) {
      case "apply_condition": {
        const resolved = resolveScope(blueprint, operation.partIds, operation.kind, options.sink);
        if (!resolved) return null;
        const scope = expandRootScope(resolved, integrated);
        return writeChannel(integrated, scope, operation.channel, (current, partId) =>
          addClamped(
            current,
            conditionSourceDelta(
              operation.channel,
              operation.change.degree,
              operation.change.direction,
              garmentPartMaterialProfile(blueprint, partId),
            ),
            GARMENT_UNIT_ONE,
          ),
        );
      }
      case "deposit": {
        const resolved = resolveScope(blueprint, operation.partIds, operation.kind, options.sink);
        if (!resolved) return null;
        return applyDeposit(
          integrated,
          operation,
          expandRootScope(resolved, integrated),
          options.atMinutes,
          options.sink,
        );
      }
      case "accept_transfer": {
        const resolved = resolveScope(blueprint, operation.partIds, operation.kind, options.sink);
        if (!resolved) return null;
        return acceptGarmentTransfer(
          integrated,
          operation,
          expandRootScope(resolved, integrated),
          options.atMinutes,
          options.sink,
        );
      }
      case "clean": {
        const resolved = resolveScope(blueprint, operation.partIds, operation.kind, options.sink);
        if (!resolved) return null;
        return applyClean(integrated, operation, blueprint, expandRootScope(resolved, integrated));
      }
      case "damage": {
        if (!garmentPartNode(blueprint, operation.partId)) {
          return drop(
            options.sink,
            "garment_op.part_unresolved",
            `no garment part "${operation.partId}" — damage dropped`,
          );
        }
        return applyDamage(integrated, operation, blueprint, options.atMinutes);
      }
      case "repair": {
        // `repair` is NOT root-scoped (audit OQ7): an empty list is not "repair
        // everything", it is a proposal that named nothing.
        if (operation.markIds.length === 0) {
          return drop(options.sink, "garment_op.repair_no_marks", "repair named no marks — dropped");
        }
        const known = new Set(integrated.damageMarks.map((mark) => mark.id));
        const resolved = operation.markIds.filter((markId) => known.has(markId));
        for (const markId of operation.markIds) {
          if (!known.has(markId)) {
            options.sink?.push(
              diag("info", "garment_op.mark_unresolved", `no damage mark "${markId}" on this garment — not repaired`),
            );
          }
        }
        if (resolved.length === 0) return null;
        const repaired = new Set(resolved);
        return { ...integrated, damageMarks: integrated.damageMarks.filter((mark) => !repaired.has(mark.id)) };
      }
    }
  })();
  if (!next || sameGarmentCondition(condition, next)) return null;
  return { ...next, integratedAtMinutes: options.atMinutes };
}
