import { garmentStructuralFacts, type GarmentStructuralFact } from "./garment-digest";
import type { GarmentReadout } from "./garment-effective-coverage";
import {
  emptyGarmentCueState,
  garmentConditionKeys,
  type GarmentConditionKey,
  type GarmentCueState,
} from "./garment-instance";
import type { WornVisibility } from "./visibility";

/**
 * The bounded GARMENT CUE BLOCK (clothing-state-graph.plan.md §"Derived wardrobe
 * and observation read" steps 7–8, §"Narration and image policy").
 *
 * Authority is the digest's job (`garment-digest.ts`). This file owns
 * **attention**: at most one or two perception-safe, ranked observations per
 * exchange, drawn from the plan's six families —
 *
 *   closure_open · part_rolled · part_displaced ·
 *   surface_damp_or_wet · deposit_visible · damage_visible
 *
 * — and gated by exactly the pattern the meter cues already use
 * (`splitStateCues`, audit §1.6): a flat `key → band` map inside the rollback
 * blob, `changed = band !== prevBands[key]`, and only changed reads surface.
 * Unchanged clothing therefore produces NO fresh cue (an acceptance criterion) —
 * it stays available in the digest, which is where consistency lives.
 *
 * Two hard laws:
 *
 * - **hidden parts cannot produce visual cues.** A bloodied camisole under a
 *   closed opaque shirt keeps its state and says nothing (fixture F12). The
 *   caller supplies the resolver's verdict; absent, nothing is assumed hidden.
 * - **bands only.** Every phrase here is built from a band word and a part label.
 *   There is no path from a stored fixed-point value to this module's output.
 */

/** The six observation families the plan names. */
export const garmentCueFamilies = [
  "closure_open",
  "part_rolled",
  "part_displaced",
  "surface_damp_or_wet",
  "deposit_visible",
  "damage_visible",
] as const;
export type GarmentCueFamily = (typeof garmentCueFamilies)[number];

/** Max cues one exchange may surface (the plan's "one or two"). */
export const GARMENT_CUES_PER_EXCHANGE = 2;

/**
 * Family salience — which kind of read earns the scarce slot when several changed
 * at once. A tear outranks a rolled sleeve; ranking is otherwise deterministic
 * (band depth, then the repeat key) so the same cut always picks the same cue.
 */
const FAMILY_WEIGHT: Readonly<Record<GarmentCueFamily, number>> = {
  damage_visible: 5,
  deposit_visible: 4,
  part_displaced: 4,
  closure_open: 3,
  surface_damp_or_wet: 3,
  part_rolled: 2,
};

/** One ranked, perception-safe garment observation (the plan's example shape). */
export interface GarmentObservation {
  /** Stable observation-kind id, e.g. `garment.part_rolled`. */
  id: string;
  garmentId: string;
  garmentName: string;
  /** The part this read is about; the garment root for whole-garment reads. */
  partId: string;
  partLabel: string;
  family: GarmentCueFamily;
  visibility: WornVisibility;
  /** The semantic band this read is IN ("substantial", "soaked", "mud", "tear"). */
  intensityBand: string;
  semanticTags: string[];
  /** `garment:part:kind:band` — the plan's repeat key, band included. */
  repeatKey: string;
  /** `garment:part:kind` — the persisted map key (the repeat key minus its band). */
  cueKey: string;
  /** The narrator-facing sentence. Bands and labels only, never a number. */
  phrase: string;
  /** Ranking weight; higher wins a slot. */
  salience: number;
}

/** One actor's worn readouts plus how the cue phrases refer to them. */
export interface GarmentObservationActor {
  /** Possessive the phrases lead with ("Wren's", "your"). */
  possessive: string;
  readouts: readonly GarmentReadout[];
  /**
   * `garmentId:partId` (and bare `garmentId`) → the visibility resolver's verdict.
   * A part with no entry falls back to its garment's, then to `visible`: we can
   * suppress what we know is buried, never guess something into hiding.
   */
  visibility?: Readonly<Record<string, WornVisibility>>;
}

const BAND_DEPTH: Readonly<Record<string, number>> = {
  slight: 0,
  moderate: 1,
  substantial: 2,
  extreme: 3,
  partly_open: 1,
  open: 2,
  rolled: 1,
  damp: 0,
  wet: 2,
  soaked: 3,
  off_shoulder: 2,
  lifted: 2,
};

function visibilityOf(actor: GarmentObservationActor, garmentId: string, partId: string): WornVisibility {
  return actor.visibility?.[`${garmentId}:${partId}`] ?? actor.visibility?.[garmentId] ?? "visible";
}

/** Assemble one observation; the caller decides whether it survives perception. */
function observation(input: {
  family: GarmentCueFamily;
  readout: GarmentReadout;
  partId: string;
  partLabel: string;
  band: string;
  phrase: string;
  visibility: WornVisibility;
  semanticTags?: readonly string[];
}): GarmentObservation {
  const cueKey = `${input.readout.garmentId}:${input.partId}:${input.family}`;
  return {
    id: `garment.${input.family}`,
    garmentId: input.readout.garmentId,
    garmentName: input.readout.name,
    partId: input.partId,
    partLabel: input.partLabel,
    family: input.family,
    visibility: input.visibility,
    intensityBand: input.band,
    semanticTags: [...(input.semanticTags ?? [])],
    repeatKey: `${cueKey}:${input.band}`,
    cueKey,
    phrase: input.phrase,
    salience: FAMILY_WEIGHT[input.family] * 4 + (BAND_DEPTH[input.band] ?? 0),
  };
}

/** The presentation families, from the shared structural facts. */
function presentationObservations(
  actor: GarmentObservationActor,
  readout: GarmentReadout,
  fact: GarmentStructuralFact,
): GarmentObservation[] {
  const visibility = visibilityOf(actor, readout.garmentId, fact.partId);
  const base = {
    readout,
    partId: fact.partId,
    partLabel: fact.label,
    band: fact.band,
    visibility,
    semanticTags: fact.degree ? [fact.degree] : [],
  };
  const subject = `${actor.possessive} ${readout.name}`;
  switch (fact.band) {
    case "partly_open":
      return [observation({ ...base, family: "closure_open", phrase: `${subject} sits partly unfastened at the ${fact.label}` })];
    case "open":
      return [observation({ ...base, family: "closure_open", phrase: `${subject} hangs open at the ${fact.label}` })];
    case "rolled":
      return [observation({ ...base, family: "part_rolled", phrase: `${subject} is rolled back at the ${fact.label}` })];
    case "off_shoulder":
      return [observation({ ...base, family: "part_displaced", phrase: `the ${fact.label} of ${subject} has slipped off the shoulder` })];
    case "lifted":
      return [observation({ ...base, family: "part_displaced", phrase: `the ${fact.label} of ${subject} is riding up` })];
    default:
      return [];
  }
}

const WET_BANDS: readonly string[] = ["damp", "wet", "soaked"];

/**
 * Wetness at `damp` or above.
 *
 * The whole-garment band is the WORST across base and overrides (slice 4), so a
 * soaked hem alone would otherwise say "her shirt is soaked through" — true of
 * the guard, false of the eye. When a region carries that same band it is the
 * REASON for it, and the located read wins: the whole-garment cue is dropped and
 * the hem speaks for itself. A garment soaked all over keeps its one cue, because
 * no region is claiming responsibility.
 */
function wetnessObservations(actor: GarmentObservationActor, readout: GarmentReadout): GarmentObservation[] {
  const subject = `${actor.possessive} ${readout.name}`;
  const whole = readout.condition.wetness;
  const regional = readout.conditionParts.flatMap((part) => {
    const band = part.bands.wetness;
    if (band === undefined || !WET_BANDS.includes(band)) return [];
    return [
      observation({
        family: "surface_damp_or_wet",
        readout,
        partId: part.partId,
        partLabel: part.label,
        band,
        phrase: `the ${part.label} of ${subject} is ${band}`,
        visibility: visibilityOf(actor, readout.garmentId, part.partId),
        semanticTags: ["regional"],
      }),
    ];
  });
  const explained = regional.some((entry) => entry.intensityBand === whole);
  if (!WET_BANDS.includes(whole) || explained) return regional;
  return [
    observation({
      family: "surface_damp_or_wet",
      readout,
      partId: "",
      partLabel: readout.name,
      band: whole,
      phrase: whole === "damp" ? `${subject} is damp` : `${subject} is ${whole} through`,
      visibility: visibilityOf(actor, readout.garmentId, ""),
      semanticTags: ["whole_garment"],
    }),
    ...regional,
  ];
}

/** Located contaminants and damage marks — each on the part that carries it. */
function markObservations(actor: GarmentObservationActor, readout: GarmentReadout): GarmentObservation[] {
  const subject = `${actor.possessive} ${readout.name}`;
  const deposits = readout.deposits.map((deposit) => {
    const partId = deposit.partIds[0] ?? "";
    const label = deposit.labels[0] ?? readout.name;
    const where = deposit.partIds.length > 0 ? `the ${label} of ${subject}` : subject;
    return observation({
      family: "deposit_visible",
      readout,
      partId,
      partLabel: label,
      band: `${deposit.kind}_${deposit.intensity ?? "slight"}`,
      phrase:
        deposit.freshness === "fresh"
          ? `${deposit.kind} is still wet on ${where}`
          : `${deposit.kind} has dried into ${where}`,
      visibility: visibilityOf(actor, readout.garmentId, partId),
      semanticTags: [deposit.kind, deposit.freshness],
    });
  });
  const damage = readout.damage.map((mark) =>
    observation({
      family: "damage_visible",
      readout,
      partId: mark.partId,
      partLabel: mark.label,
      band: `${mark.kind}_${mark.severity ?? "slight"}`,
      phrase: `there is a ${mark.kind} at the ${mark.label} of ${subject}`,
      visibility: visibilityOf(actor, readout.garmentId, mark.partId),
      semanticTags: [mark.kind],
    }),
  );
  return [...deposits, ...damage];
}

/**
 * Every observation this cut supports, across the six families, for every actor —
 * already perception-gated (`hidden` parts are dropped) and deterministically
 * ordered. Selection and repeat gating are `splitGarmentCues`'s job.
 */
export function garmentObservations(actors: readonly GarmentObservationActor[]): GarmentObservation[] {
  const all = actors.flatMap((actor) =>
    actor.readouts.flatMap((readout) => [
      ...garmentStructuralFacts(readout).flatMap((fact) => presentationObservations(actor, readout, fact)),
      ...wetnessObservations(actor, readout),
      ...markObservations(actor, readout),
    ]),
  );
  return all
    .filter((entry) => entry.visibility !== "hidden")
    .sort((a, b) => b.salience - a.salience || a.repeatKey.localeCompare(b.repeatKey));
}

/** The anti-repetition split — `splitStateCues`'s shape, for garments. */
export interface GarmentCueSplit {
  /** The ≤2 cues to surface this exchange: changed bands only, most salient first. */
  selected: GarmentObservation[];
  /** Everything else this cut supports — standing state, carried by the digest, never restated. */
  standing: GarmentObservation[];
  /** The cue memory to persist as next exchange's `previous`. */
  next: GarmentCueState;
}

/**
 * Split the current observations against the bands last surfaced.
 *
 * A cue is fresh only when its band DIFFERS from the persisted map — so three
 * quiet exchanges in the same shirt emit nothing, and the roll on the fourth
 * emits exactly one (fixture F20). Standing reads are deliberately never
 * back-filled into the empty slots: "unchanged clothing produces no fresh cue" is
 * an acceptance criterion, and the digest already carries them for consistency.
 *
 * `next` carries forward: the cue bands, the per-garment condition bands (slice
 * 4's hysteresis handoff), and a last-changed stamp per key. Keys whose garment
 * left the cut simply stop being written, which is how the memory stays bounded.
 */
export function splitGarmentCues(input: {
  observations: readonly GarmentObservation[];
  readouts: readonly GarmentReadout[];
  previous?: GarmentCueState;
  /** Chat-clock minute of this cut — the `changedAt` stamp. */
  atMinutes?: number;
  limit?: number;
}): GarmentCueSplit {
  const previous = input.previous ?? emptyGarmentCueState();
  const atMinutes = input.atMinutes ?? 0;
  const limit = input.limit ?? GARMENT_CUES_PER_EXCHANGE;

  const cues: Record<string, string> = {};
  const changedAt: Record<string, number> = {};
  const changed: GarmentObservation[] = [];
  for (const entry of input.observations) {
    if (cues[entry.cueKey] !== undefined) continue; // one read per key; the salience sort already picked
    cues[entry.cueKey] = entry.intensityBand;
    const moved = previous.cues[entry.cueKey] !== entry.intensityBand;
    changedAt[entry.cueKey] = moved ? atMinutes : (previous.changedAt[entry.cueKey] ?? atMinutes);
    if (moved) changed.push(entry);
  }
  const selected = changed.slice(0, limit);
  const standing = input.observations.filter((entry) => !selected.includes(entry));

  const bands: Record<string, Record<string, string>> = {};
  for (const readout of input.readouts) {
    bands[readout.garmentId] = Object.fromEntries(
      garmentConditionKeys.map((channel: GarmentConditionKey) => [channel, readout.condition[channel]]),
    );
  }
  return { selected, standing, next: { cues, bands, changedAt } };
}

/** The bands this garment last REPORTED — slice 4's `previousBands` input, from the cue memory. */
export function garmentPreviousBands(
  state: GarmentCueState | undefined,
  garmentId: string,
): Partial<Record<GarmentConditionKey, string>> {
  return state?.bands[garmentId] ?? {};
}

/**
 * The compact per-scene image facts (plan §"Narration and image policy": "scene
 * images may consume the same semantic read"). Deliberately NOT repeat-gated — an
 * image has no repetition problem, it needs the whole current truth of the frame,
 * including the transient bands OQ8 keeps out of the identity key.
 */
export function garmentSceneNotes(
  actors: readonly GarmentObservationActor[],
  limit = 6,
): string[] {
  return garmentObservations(actors)
    .map((entry) => entry.phrase)
    .slice(0, limit);
}
