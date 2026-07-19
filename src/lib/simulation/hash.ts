/**
 * Generic deterministic hashing/ordering utilities shared across the simulation
 * pure layer. They live in their own module (rather than any one event family's
 * kernel) so every projector, replay, and store can depend on identical
 * canonicalization without a cross-family import. No IO, no clock, no ambient
 * randomness (engine.spec §31–32).
 */

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
  const serialized = JSON.stringify(canonicalize(value));
  let hash = 0x811c9dc5;
  for (let index = 0; index < serialized.length; index += 1) {
    hash ^= serialized.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
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
