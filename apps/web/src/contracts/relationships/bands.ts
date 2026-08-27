import { z } from "zod";
import { stageMidpoint } from "./stages";

/**
 * Relationship model v2 axes: the one affinity
 * scalar splits into two independent axes —
 *
 * - **Familiarity** (0..100, slow ratchet — you can't un-know someone): how well
 *   two people know each other. Governs address rights, what can be assumed or
 *   referenced, the disclosure *ceiling*, how well they read the other.
 * - **Regard** (−100..100, volatile — this is the old affinity scalar): how they
 *   feel about each other. Governs warmth of tone, the *desire* to initiate,
 *   patience, and the escalation floor.
 *
 * Bands — never raw values — appear in prompts and gate behavior; boundaries are
 * data (tune by editing this file). The regard ladder is the old stage ladder
 * minus its two familiarity-flavored rungs: `stranger` becomes `neutral` and
 * `acquaintance`'s range folds into `friendly` (knowledge is the other axis's
 * job now). `stages.ts` remains the sessions lane's vocabulary until the session
 * refactor (plan slice 7); `stageToAxes` below is the bridge.
 *
 * A third axis (`attraction`) is reserved — a record field addition, never a
 * schema migration (deferral confirmed 2026-07-07).
 */

export const REGARD_MIN = -100;
export const REGARD_MAX = 100;
export const FAMILIARITY_MIN = 0;
export const FAMILIARITY_MAX = 100;

export interface AxisBand {
  id: string;
  label: string;
  /** Inclusive bounds on the axis scalar. */
  min: number;
  max: number;
}

export const regardBands: readonly AxisBand[] = [
  { id: "hostile", label: "Hostile", min: -100, max: -61 },
  { id: "wary", label: "Wary", min: -60, max: -36 },
  { id: "cool", label: "Cool", min: -35, max: -15 },
  { id: "neutral", label: "Neutral", min: -14, max: 14 },
  { id: "friendly", label: "Friendly", min: 15, max: 49 },
  { id: "warm", label: "Warm", min: 50, max: 64 },
  { id: "close", label: "Close", min: 65, max: 78 },
  { id: "cherished", label: "Cherished", min: 79, max: 89 },
  { id: "devoted", label: "Devoted", min: 90, max: 96 },
  { id: "smitten", label: "Smitten", min: 97, max: 100 },
];

export const familiarityBands: readonly AxisBand[] = [
  { id: "strangers", label: "Strangers", min: 0, max: 9 },
  { id: "introduced", label: "Introduced", min: 10, max: 29 },
  { id: "acquainted", label: "Acquainted", min: 30, max: 54 },
  { id: "familiar", label: "Familiar", min: 55, max: 79 },
  { id: "deeply_known", label: "Deeply known", min: 80, max: 100 },
];

export type RegardBandId = (typeof regardBands)[number]["id"];
export type FamiliarityBandId = (typeof familiarityBands)[number]["id"];

export function clampRegard(value: number): number {
  return Math.min(REGARD_MAX, Math.max(REGARD_MIN, Math.round(value)));
}

export function clampFamiliarity(value: number): number {
  return Math.min(FAMILIARITY_MAX, Math.max(FAMILIARITY_MIN, Math.round(value)));
}

const NEUTRAL_BAND = regardBands[3] as AxisBand;
const STRANGERS_BAND = familiarityBands[0] as AxisBand;

export function regardBandForValue(value: number): AxisBand {
  const v = clampRegard(value);
  // Boundaries cover [-100,100] contiguously (tested); fallback is defensive.
  return regardBands.find((b) => v >= b.min && v <= b.max) ?? NEUTRAL_BAND;
}

export function familiarityBandForValue(value: number): AxisBand {
  const v = clampFamiliarity(value);
  return familiarityBands.find((b) => v >= b.min && v <= b.max) ?? STRANGERS_BAND;
}

export function regardBandById(id: string): AxisBand | undefined {
  return regardBands.find((b) => b.id === id);
}

export function familiarityBandById(id: string): AxisBand | undefined {
  return familiarityBands.find((b) => b.id === id);
}

/** Midpoint of a band — used when seeding a scalar from an authored band pick. */
export function bandMidpoint(band: AxisBand): number {
  return Math.round((band.min + band.max) / 2);
}

export function regardBandMidpoint(id: string): number {
  const band = regardBandById(id);
  return band ? bandMidpoint(band) : 0;
}

export function familiarityBandMidpoint(id: string): number {
  const band = familiarityBandById(id);
  return band ? bandMidpoint(band) : 0;
}

/** A regard band id validated against the registry, self-healing to `neutral`. */
export const regardBandIdSchema = z
  .string()
  .refine((id) => regardBandById(id) !== undefined, { message: "unknown regard band" })
  .catch("neutral");

/** A familiarity band id validated against the registry, self-healing to `strangers`. */
export const familiarityBandIdSchema = z
  .string()
  .refine((id) => familiarityBandById(id) !== undefined, { message: "unknown familiarity band" })
  .catch("strangers");

/**
 * The familiarity ratchet (owner ruling 2026-07-07 — "moments + time"). It only
 * ever climbs: exchange TRICKLE (time spent together) lifts it at most to the
 * top of `acquainted` — time alone never makes you `familiar` — while archivist
 * MOMENTS (a real disclosure or shared experience) push past the ceiling, capped
 * per scene so one intense night can't take strangers to deeply-known.
 */
export const FAMILIARITY_TRICKLE_CEILING = (familiarityBands[2] as AxisBand).max; // top of `acquainted`
/** One trickle tick (the engine applies it every few exchanges, not per exchange). */
export const FAMILIARITY_TRICKLE_STEP = 1;
/** One archivist-recorded disclosure/shared experience. */
export const FAMILIARITY_MOMENT_STEP = 3;
/** Max total familiarity gain within one scene/visit. */
export const FAMILIARITY_SCENE_CAP = 8;

/** Apply a familiarity gain; the ratchet never moves down and trickle respects its ceiling. */
export function tickFamiliarity(current: number, kind: "trickle" | "moment", sceneGainSoFar: number): number {
  const base = clampFamiliarity(current);
  const step = kind === "trickle" ? FAMILIARITY_TRICKLE_STEP : FAMILIARITY_MOMENT_STEP;
  const budget = Math.max(0, FAMILIARITY_SCENE_CAP - sceneGainSoFar);
  let next = Math.min(base + Math.min(step, budget), FAMILIARITY_MAX);
  if (kind === "trickle") next = Math.min(next, Math.max(base, FAMILIARITY_TRICKLE_CEILING));
  return Math.max(base, next);
}

/**
 * The old-stage → axes bridge: what familiarity each conflated stage implied.
 * Negative stages map to `introduced` (you've interacted enough to be disliked);
 * the regard scalar migrates unchanged (same −100..100 domain), so a stored
 * affinity keeps its value and only re-bands (old `acquaintance` values now read
 * `friendly`-low). Used by state migration and authored-stage seeding.
 */
export const stageFamiliarity: Readonly<Record<string, FamiliarityBandId>> = {
  hostile: "introduced",
  wary: "introduced",
  cool: "introduced",
  stranger: "strangers",
  acquaintance: "introduced",
  friendly: "acquainted",
  warm: "acquainted",
  close: "familiar",
  cherished: "familiar",
  devoted: "deeply_known",
  smitten: "deeply_known",
};

/** Seed both axis scalars from an authored old-vocabulary stage id. */
export function stageToAxes(stageId: string): { familiarity: number; regard: number } {
  const band = stageFamiliarity[stageId];
  return {
    familiarity: band ? familiarityBandMidpoint(band) : 0,
    regard: stageMidpoint(stageId),
  };
}

/**
 * Map an old-vocabulary stage id to the two band ids (for migrating authored
 * `{stage}` shapes into the authored record). The two evicted rungs re-home:
 * `stranger` → `neutral`, `acquaintance` → `friendly`; every other stage id is
 * also a regard band id.
 */
export function stageToBandIds(stageId: string): { familiarity: FamiliarityBandId; regard: RegardBandId } {
  const familiarity = stageFamiliarity[stageId] ?? "strangers";
  const regard =
    stageId === "stranger" ? "neutral" : stageId === "acquaintance" ? "friendly" : regardBandById(stageId)?.id;
  return { familiarity, regard: regard ?? "neutral" };
}

/**
 * The reverse bridge for contracts still keyed to the old stage vocabulary
 * (mood's touch welcomeness, emotion labels, disposition shifts — shared with
 * the sessions lane until plan slice 7): every regard band id IS a stage id
 * except `neutral`, which reads as `stranger` there.
 */
export function regardBandToStageId(bandId: string): string {
  return bandId === "neutral" ? "stranger" : bandId;
}
