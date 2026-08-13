/**
 * Generic deterministic hashing/ordering utilities shared across the simulation
 * pure layer. They live in their own module (rather than any one event family's
 * kernel) so every projector, replay, and store can depend on identical
 * canonicalization without a cross-family import. No IO, no clock, no ambient
 * randomness (engine.spec §31–32).
 *
 * The checksum itself is the repository-wide FNV-1a from `@vesper/contracts`
 * (the application reaches the same function through `@/lib/hash`); what this
 * module owns is the CANONICALIZATION in front of it.
 */

import { fnv1aHex } from "@vesper/contracts";

/** Recursively key-sort objects so structurally-equal values serialize identically. */
export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, canonicalize(record[key])]),
    );
  }
  return value;
}

/** Stable non-cryptographic checksum for deterministic replay/equality evidence. */
export function simulationHash(value: unknown): string {
  return fnv1aHex(JSON.stringify(canonicalize(value)));
}

/** Total order over strings with no locale surprises (byte-wise comparison). */
export function compareStableText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/** De-duplicate and stably sort a string set for canonical projection ordering. */
export function sortedUnique<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].sort(compareStableText);
}
