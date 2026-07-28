import type { BodyRhythmKind } from "@/contracts/simulation/bodies";
import { seedDurableBodyRhythms } from "@/server/engine";

/**
 * The reference daily life the body/routine/corpus suites all run against:
 * 23:00–07:00 sleep, a 06:45–07:00 wash, and (for the routine lane) a
 * 12:00–13:00 meal. Rhythms are authored data read at integration time, so the
 * exact minute boundaries are load-bearing — the suites' crossing arithmetic
 * (e.g. hygiene 9 000 → "grimy" 2 500 at 150/h) is derived from them.
 *
 * Copied verbatim in five files before this. The values below are those copies,
 * unchanged.
 */

/** 23:00 (minute 1 380) to 07:00 (minute 420) — the window wraps midnight. */
export const SLEEP_START_MINUTE = 1_380;
export const SLEEP_END_MINUTE = 420;
/** 06:45 to 07:00 — ends exactly when sleep does, so waking is already washed. */
export const WASH_START_MINUTE = 405;
export const WASH_END_MINUTE = 420;
/** 12:00 to 13:00 — routine-store's lunch. */
export const MEAL_START_MINUTE = 720;
export const MEAL_END_MINUTE = 780;

/** One authored rhythm row, in the seeder's INPUT shape (plain ids). */
export interface ReferenceRhythmRow {
  actorId: string;
  kind: BodyRhythmKind;
  startMinuteOfDay: number;
  endMinuteOfDay: number;
}

export function sleepRhythmRow(actorId: string): ReferenceRhythmRow {
  return { actorId, kind: "sleep", startMinuteOfDay: SLEEP_START_MINUTE, endMinuteOfDay: SLEEP_END_MINUTE };
}

export function washRhythmRow(actorId: string): ReferenceRhythmRow {
  return { actorId, kind: "wash", startMinuteOfDay: WASH_START_MINUTE, endMinuteOfDay: WASH_END_MINUTE };
}

export function mealRhythmRow(actorId: string): ReferenceRhythmRow {
  return { actorId, kind: "meal", startMinuteOfDay: MEAL_START_MINUTE, endMinuteOfDay: MEAL_END_MINUTE };
}

export interface ReferenceRhythmOptions {
  /**
   * Keep the 06:45–07:00 wash window (default true).
   *
   * Pass `false` for any test about the HYGIENE alarm: with a wash window the
   * daily reset suppresses that alarm outright, so "sleep only" is what makes
   * the grimy crossing fire (gate5-corpus's `seedSleepOnlyRhythm`, and
   * body-store's own precedent).
   */
  wash?: boolean;
  /** Add the 12:00–13:00 meal window (default false) — the routine lane's lunch. */
  meal?: boolean;
}

/**
 * Seed one actor's reference rhythms onto a branch. Seed BEFORE initializing the
 * actor's body: alarms armed before a rhythm seed re-validate at fire time and
 * may retire stale, so the ordering keeps a fixture's initial alarms exact.
 *
 * Returns the rows it wrote, so a suite can assert against the same values it
 * seeded instead of restating them.
 */
export async function seedReferenceRhythms(
  branchId: string,
  actorId: string,
  options: ReferenceRhythmOptions = {},
): Promise<ReferenceRhythmRow[]> {
  const rows: ReferenceRhythmRow[] = [sleepRhythmRow(actorId)];
  if (options.wash !== false) rows.push(washRhythmRow(actorId));
  if (options.meal === true) rows.push(mealRhythmRow(actorId));
  await seedDurableBodyRhythms({ branchId, rows });
  return rows;
}
