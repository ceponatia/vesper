import { unitIntervalSchema, type UnitInterval } from "../../../core";

/**
 * The one bounds proof every hair axis runs at definition time (architecture
 * spec §"Attribute contribution definitions": *"contributions are bounded and
 * typed"*).
 *
 * The tables below are hand-written integers, so the type alone is not the
 * proof — a typo of `90_000` for `9_000` type-checks through `toUnitInterval`'s
 * clamp and would silently saturate an axis. This runs at module load and
 * throws, because a miscalibrated table is a bug in a definition file, not
 * degraded runtime data.
 */
export function unitFieldIssue(fields: Readonly<Record<string, UnitInterval>>): string | null {
  for (const [name, value] of Object.entries(fields)) {
    if (!unitIntervalSchema.safeParse(value).success) return `${name} is not a unit interval`;
  }
  return null;
}
