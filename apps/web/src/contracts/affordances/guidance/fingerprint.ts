/**
 * Deterministic guidance fingerprints.
 *
 * Selection ties break by fingerprint and a retake must reproduce the same
 * ordering from the same committed cut, so the digest is a pure function of the
 * identifying fields: no clock, no counter, no randomness, no locale, no crypto
 * import. Same inputs ⇒ same string in every process, on every machine, forever.
 *
 * The technique is the one `appearance-features/projection.ts` established for
 * `truthFingerprint` (a canonical ordered string, hashed) without its canonical
 * JSON step — a candidate builder already knows its own fields, so it passes
 * them as an ordered list rather than handing over an object whose key order
 * would have to be normalized.
 *
 * Two 32-bit FNV-1a lanes with different bases AND different multipliers are
 * concatenated into 16 hex digits. One 32-bit lane collides in the tens of
 * thousands of candidates by the birthday bound; two uncorrelated lanes push
 * that past anything a turn can produce, and a collision would only mis-ORDER
 * two candidates, never merge them.
 */

/** The canonical 32-bit FNV-1a offset basis and prime (lane A). */
const FNV_BASIS_A = 0x811c_9dc5;
const FNV_PRIME_A = 0x0100_0193;

/** Lane B: a different basis and a different odd multiplier, so the lanes do not track each other. */
const FNV_BASIS_B = 0x1000_0193;
const FNV_PRIME_B = 0x0100_01b3;

/**
 * Unit separator between parts. A control character cannot appear in an id, a
 * claim code, or a locus id, so `["ab","c"]` and `["a","bc"]` cannot collide by
 * concatenation.
 */
const PART_SEPARATOR = "\u001f";

/** Separator inside one list-valued part. */
const LIST_SEPARATOR = ",";

const HEX_WIDTH = 8;

function fnv1a(input: string, basis: number, prime: number): number {
  let hash = basis;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, prime);
  }
  return hash >>> 0;
}

function hex(value: number): string {
  return value.toString(16).padStart(HEX_WIDTH, "0");
}

/**
 * Hash the canonical identifying fields of one candidate.
 *
 * Order-sensitive by design: the caller decides which parts are a sequence and
 * which are a set (see `guidanceUnorderedPart`), and swapping two fields must
 * produce a different identity.
 */
export function guidanceFingerprint(parts: readonly string[]): string {
  const canonical = parts.join(PART_SEPARATOR);
  return `${hex(fnv1a(canonical, FNV_BASIS_A, FNV_PRIME_A))}${hex(fnv1a(canonical, FNV_BASIS_B, FNV_PRIME_B))}`;
}

/**
 * A part whose MEMBERSHIP is the identity — ids, loci, prohibited codes. Sorted
 * with the default comparator (UTF-16 code units) rather than `localeCompare`,
 * which is locale-dependent and would make a fingerprint machine-specific.
 */
export function guidanceUnorderedPart(values: readonly string[]): string {
  return [...values].sort().join(LIST_SEPARATOR);
}

/** A part whose SEQUENCE is the identity — before → after, a resolver's result order. */
export function guidanceOrderedPart(values: readonly string[]): string {
  return values.join(LIST_SEPARATOR);
}

/**
 * Lexicographic fingerprint order — the last tie-break in every selection tier.
 * Deliberately not `localeCompare`: ordering must not depend on the host locale.
 */
export function compareGuidanceFingerprints(left: string, right: string): number {
  if (left < right) return -1;
  return left > right ? 1 : 0;
}
