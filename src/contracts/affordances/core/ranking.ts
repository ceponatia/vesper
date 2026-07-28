import { z } from "zod";
import {
  affordanceIntensityBandSchema,
  affordanceStoryTimeSchema,
  AFFORDANCE_INTENSITY_WEIGHT,
  type AffordanceIntensityBand,
  type AffordanceObservation,
  type AffordanceStoryTime,
} from "./types";

/**
 * Ranking, anti-repeat, and the strict cue cap — modelled on `splitGarmentCues`
 * (`items/garment-observation.ts`) and its `garmentCueStateSchema` memory, which
 * proved the pattern for wardrobe cues.
 *
 * The scarce resource is the narrator's attention, so the gate is repetition,
 * not truth: a read that is still true but was already said stays in the memory
 * and out of the prompt. Three rules, in this order:
 *
 * 1. **Gate** — a candidate emits only when its `repeatKey` is new or its band
 *    MOVED since the last time that key was recorded. Three quiet exchanges in
 *    the same damp hair say nothing; the exchange it dries says one thing.
 * 2. **Rank** — surviving candidates sort by intensity weight, stable within a
 *    band, so the same cut always picks the same cue.
 * 3. **Cap** — at most `AFFORDANCE_CUES_PER_EXCHANGE` survive. The cap applies
 *    AFTER gating, so unchanged reads never crowd out a change.
 *
 * The memory is lossless where it matters: `bands` records the current band of
 * EVERY candidate this cut, emitted or not (garment's semantics exactly), so a
 * read that lost the cap is not re-offered next exchange as though it were new,
 * and a read that later changes band is correctly recognised as having moved.
 * Keys whose candidate left the cut simply stop being written — that is how the
 * memory stays bounded without an eviction policy.
 */

/** The plan's strict "one or two". */
export const AFFORDANCE_CUES_PER_EXCHANGE = 2;

/** Max entries any one cue-memory record retains (overflow drops the tail). */
export const AFFORDANCE_CUE_MEMORY_MAX = 48;

const repeatKeySchema = z.string().trim().min(1).max(160);

function capRecord<T>(record: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(record).slice(0, AFFORDANCE_CUE_MEMORY_MAX));
}

/**
 * What has already been said, and in which band.
 *
 * This crosses a JSONB trust boundary once a lane persists it beside the state
 * it describes (the garment `cueState` precedent: riding the same rollback
 * anchor is what makes a retake reproduce the identical read). Hence `.catch`
 * and `.default` on every field — a corrupt memory degrades to "nothing said
 * yet", which is chatty for one exchange, rather than rejecting the whole
 * state blob.
 */
export const affordanceCueStateSchema = z.object({
  /** `repeatKey` → the band last recorded for it. The gate reads only this. */
  bands: z
    .record(repeatKeySchema, affordanceIntensityBandSchema.catch("subtle"))
    .catch({})
    .default({})
    .transform(capRecord),
  /** Recently EMITTED repeat keys, most recent first — recency provenance for later novelty rules. */
  cues: z
    .array(repeatKeySchema)
    .catch([])
    .default([])
    .transform((keys) => keys.slice(0, AFFORDANCE_CUE_MEMORY_MAX)),
  /** `repeatKey` → the story time its band last moved. */
  changedAt: z.record(repeatKeySchema, affordanceStoryTimeSchema).catch({}).default({}).transform(capRecord),
});

export type AffordanceCueState = z.infer<typeof affordanceCueStateSchema>;

/** No cue history yet — the degraded default and the pre-seed value. */
export function emptyAffordanceCueState(): AffordanceCueState {
  return { bands: {}, cues: [], changedAt: {} };
}

export interface AffordanceCueSelection {
  /** The ≤ cap cues to offer this exchange: changed bands only, strongest first. */
  readonly cues: readonly AffordanceObservation[];
  /** The memory to persist as next exchange's `previous`. */
  readonly nextCues: AffordanceCueState;
}

/**
 * Select this exchange's cues from the perception-safe candidates.
 *
 * Candidates arrive already filtered by perception — a hidden read must never
 * reach this function, because recording its band would make the memory claim
 * the narrator said something it never saw.
 */
export function selectAffordanceCues(input: {
  candidates: readonly AffordanceObservation[];
  previous?: AffordanceCueState;
  cap?: number;
  atStoryTime?: AffordanceStoryTime;
}): AffordanceCueSelection {
  const previous = input.previous ?? emptyAffordanceCueState();
  const at = input.atStoryTime ?? 0;
  const cap = Math.max(0, input.cap ?? AFFORDANCE_CUES_PER_EXCHANGE);

  // Rank first: the dedupe below keeps the strongest read per key, and ties keep
  // the domains' own registration order (Array#sort is stable).
  const ranked = [...input.candidates].sort(
    (left, right) => AFFORDANCE_INTENSITY_WEIGHT[right.intensityBand] - AFFORDANCE_INTENSITY_WEIGHT[left.intensityBand],
  );

  const bands: Record<string, AffordanceIntensityBand> = {};
  const changedAt: Record<string, number> = {};
  const changed: AffordanceObservation[] = [];
  for (const candidate of ranked) {
    if (bands[candidate.repeatKey] !== undefined) continue; // one read per key; the rank already picked
    bands[candidate.repeatKey] = candidate.intensityBand;
    const moved = previous.bands[candidate.repeatKey] !== candidate.intensityBand;
    changedAt[candidate.repeatKey] = moved ? at : (previous.changedAt[candidate.repeatKey] ?? at);
    if (moved) changed.push(candidate);
  }

  const cues = changed.slice(0, cap);
  const emitted = cues.map((cue) => cue.repeatKey);
  const recent = [...emitted, ...previous.cues.filter((key) => !emitted.includes(key))].slice(
    0,
    AFFORDANCE_CUE_MEMORY_MAX,
  );
  return { cues, nextCues: { bands: capRecord(bands), cues: recent, changedAt: capRecord(changedAt) } };
}
