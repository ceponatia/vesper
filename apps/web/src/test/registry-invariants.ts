import { expect } from "vitest";
import type { ZodType } from "zod";

/**
 * The invariant assertions every registry test repeats (unique ids, "each row
 * validates", "each cross-registry reference resolves", case-insensitive lookup,
 * band contiguity).
 *
 * These are separate composable functions rather than one `describe` block on
 * purpose: a registry file's interesting tests are its bespoke ones, and a
 * shared suite would either bury them or force every registry into the same
 * shape. Each helper is a single `it` body.
 *
 * `src/test` sits outside every `no-restricted-imports` zone, so contracts/lib
 * tests may import it without breaking their purity boundary.
 */

/** The minimum a registry row must expose for the id-keyed assertions. */
interface RegistryRow {
  id: string;
}

/** Best-effort identity for a failure message when no accessor was supplied. */
function describeDef(def: unknown, index: number): string {
  if (typeof def === "object" && def !== null && "id" in def) {
    const { id } = def as { id: unknown };
    if (typeof id === "string") return id;
  }
  return `#${index}`;
}

/**
 * Generalized uniqueness over any key. `expectUniqueIds` is the `{ id }` case;
 * reach for this directly when the identity column is named something else
 * (e.g. `stageId` in relationships/profile.test.ts).
 */
export function expectUniqueBy<T>(defs: readonly T[], keyOf: (def: T) => string, label = "registry"): void {
  const seen = new Set<string>();
  const duplicates: string[] = [];
  for (const def of defs) {
    const key = keyOf(def);
    if (seen.has(key)) duplicates.push(key);
    else seen.add(key);
  }
  expect(duplicates, `${label}: duplicate ids ${duplicates.join(", ")}`).toEqual([]);
}

/** Every row carries a distinct `id`. Reports WHICH ids collided, not just a count mismatch. */
export function expectUniqueIds<T extends RegistryRow>(defs: readonly T[], label?: string): void {
  expectUniqueBy(defs, (def) => def.id, label);
}

/**
 * Every row satisfies the registry's own definition schema. Collects EVERY
 * failure (with its id) instead of stopping at the first, so one run names all
 * the broken rows.
 */
export function expectAllValidate<T>(defs: readonly T[], schema: ZodType, idOf?: (def: T) => string): void {
  const failures: string[] = [];
  defs.forEach((def, index) => {
    const result = schema.safeParse(def);
    if (!result.success) {
      failures.push(`${idOf ? idOf(def) : describeDef(def, index)}: ${result.error.message}`);
    }
  });
  expect(failures, failures.join("\n")).toEqual([]);
}

/**
 * Every cross-registry reference a row declares resolves in the target registry
 * — the loop that keeps clothing coverage pointing at real body locations and
 * condition effects pointing at real attributes. `resolve` returning
 * `undefined`/`null` counts as unresolved.
 */
export function expectRefsResolve<T>(
  defs: readonly T[],
  refsOf: (def: T) => readonly string[],
  resolve: (ref: string) => unknown,
  label?: (def: T, ref: string) => string,
): void {
  const unresolved: string[] = [];
  defs.forEach((def, index) => {
    for (const ref of refsOf(def)) {
      const target = resolve(ref);
      if (target === undefined || target === null) {
        unresolved.push(label ? label(def, ref) : `${describeDef(def, index)} → ${ref}`);
      }
    }
  });
  expect(unresolved, unresolved.join("\n")).toEqual([]);
}

/**
 * A registry lookup folds case and surrounding whitespace, and misses cleanly
 * (`undefined`, never a throw or a wrong row). `hits` maps each raw spelling to
 * the canonical id it must land on.
 */
export function expectCaseInsensitiveLookup<T extends RegistryRow>(
  lookup: (raw: string) => T | undefined,
  hits: readonly { raw: string; id: string }[],
  miss: string,
): void {
  for (const hit of hits) {
    expect(lookup(hit.raw)?.id, `${JSON.stringify(hit.raw)} should resolve to ${hit.id}`).toBe(hit.id);
  }
  expect(lookup(miss), `${JSON.stringify(miss)} should miss cleanly`).toBeUndefined();
}

/** A half-open-free band: inclusive `min`/`max`, the shape all three ladders use. */
interface NumericBand {
  min: number;
  max: number;
}

/**
 * A band ladder tiles `span` exactly: it starts at the floor, ends at the
 * ceiling, and each band's `min` is its predecessor's `max + 1` — no gap, no
 * overlap, so every integer in range maps to exactly one band.
 */
export function expectContiguousBands(bands: readonly NumericBand[], span: NumericBand): void {
  const sorted = [...bands].sort((left, right) => left.min - right.min);
  expect(sorted.length, "a band ladder needs at least one band").toBeGreaterThan(0);
  expect(sorted[0]?.min, "the ladder must start at the span floor").toBe(span.min);
  expect(sorted[sorted.length - 1]?.max, "the ladder must end at the span ceiling").toBe(span.max);
  for (let index = 0; index < sorted.length; index += 1) {
    const band = sorted[index];
    expect(band?.max, `band ${index} is inverted`).toBeGreaterThanOrEqual(band?.min ?? NaN);
    if (index === 0) continue;
    expect(band?.min, `band ${index} must abut its predecessor`).toBe((sorted[index - 1]?.max ?? NaN) + 1);
  }
}
