/**
 * The one string hash in the app — 32-bit FNV-1a, non-cryptographic.
 *
 * It was hand-rolled five times in two spellings of the same constants
 * (image-pipeline-consolidation.plan.md C10). Two of those copies are
 * **determinism seams** whose divergence is invisible by construction:
 *
 * - **The character forge's reproducibility** (`server/authoring/character-forge.ts`):
 *   social-card ids are `card_<base36 of the label hash>` and visual defaults index
 *   a vocabulary pool by the seed hash, so the same seed must keep producing the
 *   same character.
 * - **The chat-look cache key** (`server/images/chat-look.ts`): `chatLookKey` is
 *   the `meta.lookKey` that decides whether a chat's cached look anchor is stale.
 *   If the key moves, every existing chat misses its cache and silently
 *   re-renders its anchor.
 *
 * Neither seam throws when it drifts — it just quietly stops being correct.
 * **So the algorithm can never change.** Its output is golden-pinned in
 * `hash.test.ts`; a failure there means the hash moved, not that the pins are
 * stale. Use it for cache keys, stable ids and checksums; never for security.
 *
 * Not to be confused with `contracts/affordances/guidance/fingerprint.ts`, which
 * deliberately runs two independently-parameterized FNV lanes to widen its
 * fingerprint — a different algorithm with its own documented rationale.
 */

const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/**
 * FNV-1a over the string's UTF-16 code units, as an unsigned 32-bit integer.
 * Cheap, allocation-free, and stable across runs and machines.
 */
export function fnv1a32(text: string): number {
  let hash = FNV_OFFSET_BASIS;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, FNV_PRIME);
  }
  return hash >>> 0;
}

/** The same hash as a fixed-width 8-character hex string — the cache-key form. */
export function fnv1aHex(text: string): string {
  return fnv1a32(text).toString(16).padStart(8, "0");
}
