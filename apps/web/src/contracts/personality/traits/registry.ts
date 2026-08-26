import { z, type ZodType } from "zod";
import { buildRegistryCore, type RegistryParseResult } from "../../registry";
import type { TraitCategory } from "./category-ids";
import { axisRange, type PersonalityTraitDefinition, type TraitBand } from "./types";

/**
 * The personality trait registry — built on the shared registry spine
 * (`contracts/registry`), with the trait-specific surface (category lookup, band
 * readout, lexicon resolution) layered on. Separate from the attribute registry by
 * design: traits must never reach an image prompt.
 */
export interface TraitRegistry {
  readonly definitions: readonly PersonalityTraitDefinition[];
  byId(id: string): PersonalityTraitDefinition | undefined;
  forCategory(category: TraitCategory): readonly PersonalityTraitDefinition[];
  /** Validate + clamp-check a raw numeric value against the trait's axis range. */
  parseValue(id: string, raw: unknown): RegistryParseResult<number>;
  /** The band a value falls in (value clamped to the axis range first). */
  bandFor(id: string, value: number): TraitBand | undefined;
  /** Free-text term → scored trait positions (forge expansion + authoring, §3 Note 4). */
  resolveLexicon(term: string): ReadonlyArray<{ id: string; value: number }>;
}

function valueSchemaFor(def: PersonalityTraitDefinition): ZodType<number> {
  const { min, max } = axisRange(def.axis);
  return z.number().min(min).max(max);
}

/** First band whose `max` covers the (clamped) value; bands are ascending by `max`. */
export function bandForValue(def: PersonalityTraitDefinition, value: number): TraitBand | undefined {
  const { min, max } = axisRange(def.axis);
  const v = Math.min(max, Math.max(min, value));
  return def.bands.find((b) => v <= b.max) ?? def.bands[def.bands.length - 1];
}

/** Index (0-based, ascending) of the band a value falls in; defensive 0 when unresolved. */
export function bandIndexForValue(def: PersonalityTraitDefinition, value: number): number {
  const band = bandForValue(def, value);
  const idx = band ? def.bands.indexOf(band) : -1;
  return idx < 0 ? 0 : idx;
}

/**
 * Clamp `shifted` so its band sits at most `maxSteps` bands from `authored`'s band
 * (character-fidelity slice 3): a render-time overlay may *color* disposition but
 * never carry a trait more than `maxSteps` bands from the value the author set — so
 * a long, warm chat can't homogenize every character toward one warm/open reading.
 * When the shift overshoots, the value is pulled to the near edge of the furthest
 * allowed band in the shift's direction; no overshoot ⇒ `shifted` returned unchanged.
 */
export function clampValueToBandSteps(
  def: PersonalityTraitDefinition,
  authored: number,
  shifted: number,
  maxSteps: number,
): number {
  const authoredIdx = bandIndexForValue(def, authored);
  const shiftedIdx = bandIndexForValue(def, shifted);
  const lastIdx = def.bands.length - 1;
  const lo = Math.max(0, authoredIdx - maxSteps);
  const hi = Math.min(lastIdx, authoredIdx + maxSteps);
  const allowedIdx = Math.max(lo, Math.min(hi, shiftedIdx));
  if (allowedIdx === shiftedIdx) return shifted;
  // Overshot: going up ⇒ the top of the allowed band; going down ⇒ just inside its
  // bottom (one past the previous band's max), or the axis floor for band 0.
  if (shifted > authored) return def.bands[allowedIdx]?.max ?? shifted;
  const prevMax = allowedIdx > 0 ? def.bands[allowedIdx - 1]?.max : undefined;
  return prevMax === undefined ? axisRange(def.axis).min : prevMax + 1;
}

export function buildTraitRegistry(definitions: readonly PersonalityTraitDefinition[]): TraitRegistry {
  const core = buildRegistryCore<PersonalityTraitDefinition, number>({
    definitions,
    valueSchemaFor,
    idLabel: "trait",
    validate: (def) => {
      const { max } = axisRange(def.axis);
      if (def.bands.length === 0) throw new Error(`Trait ${def.id} has no bands`);
      const last = def.bands[def.bands.length - 1];
      if (last && last.max < max) throw new Error(`Trait ${def.id} bands do not cover the axis max (${max})`);
      let prev = -Infinity;
      for (const band of def.bands) {
        if (band.max < prev) throw new Error(`Trait ${def.id} bands are not ascending by max`);
        prev = band.max;
      }
    },
  });

  const lexiconIndex = new Map<string, Array<{ id: string; value: number }>>();
  for (const def of definitions) {
    for (const entry of def.lexicon) {
      const key = entry.term.toLowerCase();
      const list = lexiconIndex.get(key) ?? [];
      list.push({ id: def.id, value: entry.value });
      lexiconIndex.set(key, list);
    }
  }

  return {
    definitions,
    byId: core.byId,
    forCategory: (category) => definitions.filter((d) => d.category === category),
    parseValue: core.parseValue,
    bandFor: (id, value) => {
      const def = core.byId(id);
      return def ? bandForValue(def, value) : undefined;
    },
    resolveLexicon: (term) => lexiconIndex.get(term.toLowerCase()) ?? [],
  };
}
