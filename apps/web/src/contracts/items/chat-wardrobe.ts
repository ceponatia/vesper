import { diag, type DiagnosticSink } from "../diagnostics";
import { garmentIdentitiesIn } from "./garment-nouns";
import { clothingSubtypeLabel } from "./subtypes";

/**
 * Chat wardrobe parity — the pure matching + worn-list reducer the archivist's
 * garment-level add/remove proposals fold through (rung 2). The chat lane holds a list
 * of worn **item ids**; the archivist emits free-text garment phrases ("she slips off
 * her jacket"), so these helpers resolve each phrase against the loaded item
 * descriptors. Kept PURE (the caller does the item IO) so the reducer is
 * snapshot-testable and the whole fold degrades — a missing garment skips with a
 * diagnostic, never fails the turn (docs/resilience.md).
 */

/** Minimal descriptor for matching a free-text garment phrase to a library item. */
export interface GarmentDescriptor {
  id: string;
  name: string;
  subtype?: string | null;
  description?: string;
}

/** Verbs/pronouns/filler that carry no garment identity — dropped before token overlap. */
const GARMENT_STOPWORDS: ReadonlySet<string> = new Set([
  "her", "his", "their", "the", "and", "off", "some", "into", "out", "with", "your",
  "she", "he", "they", "slips", "slid", "takes", "took", "pulls", "pulled", "removes",
  "removed", "puts", "put", "changes", "changed", "strips", "stripped", "sheds", "shed",
  "drops", "dropped", "loses", "lost", "back", "onto", "over", "under", "away", "again",
  "clothes", "clothing", "outfit", "wearing", "wear", "pair", "piece", "now",
]);

/** Significant lowercase tokens (>2 chars, non-stopword) from free text. */
function garmentTokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length > 2 && !GARMENT_STOPWORDS.has(t)),
  );
}

/** A candidate's searchable tokens: name + subtype label + description. */
function candidateTokens(item: GarmentDescriptor): Set<string> {
  const label = clothingSubtypeLabel(item.subtype) ?? "";
  return garmentTokens([item.name, label, item.description ?? ""].join(" "));
}

/**
 * The canonical garment identities a candidate IS. The item's named type wins;
 * the description is consulted only when the name + subtype label name no
 * registry garment at all — a description's incidental comparison text ("cut
 * like a jacket") must never re-type the item it describes.
 */
function candidateIdentities(item: GarmentDescriptor): Set<string> {
  const label = clothingSubtypeLabel(item.subtype) ?? "";
  const named = garmentIdentitiesIn(`${item.name} ${label}`);
  return named.size > 0 ? named : garmentIdentitiesIn(item.description ?? "");
}

/** How many entries two sets share. */
function sharedCount(needle: ReadonlySet<string>, hay: ReadonlySet<string>): number {
  let count = 0;
  for (const value of needle) if (hay.has(value)) count += 1;
  return count;
}

/**
 * Match a free-text garment phrase to the best candidate. Two layers:
 *
 * 1. **Identity gate.** When the phrase names a registry garment
 *    (`garment-nouns.ts`), only candidates sharing an identity are eligible —
 *    both sides fold through the same table, so "boot"/"boots", "t-shirt"/"tee"
 *    and "tank top" compare equal, and raw material/adjective overlap can NEVER
 *    promote a mistyped candidate ("leather boots" must not take off a leather
 *    jacket).
 * 2. **Token overlap ranks the eligible.** Shared-identity count first, then the
 *    raw name/subtype/description overlap, which is what separates same-type
 *    candidates ("black suede boots" vs "brown leather boots"). An
 *    identity-sharing candidate with zero raw overlap is still a match — that is
 *    the plural/alias fix.
 *
 * A phrase naming no registry garment (custom pieces, categories outside the
 * vocabulary) falls back to raw token overlap alone. Returns undefined when
 * nothing is eligible (the caller degrades). Ties keep the FIRST candidate
 * (worn/pool order is meaningful). PURE.
 */
export function matchGarment(
  phrase: string,
  candidates: readonly GarmentDescriptor[],
): GarmentDescriptor | undefined {
  const needle = garmentTokens(phrase);
  if (needle.size === 0) return undefined;
  const phraseIdentities = garmentIdentitiesIn(phrase);
  const gated = phraseIdentities.size > 0;
  let best: GarmentDescriptor | undefined;
  let bestIdentityScore = 0;
  let bestTokenScore = 0;
  for (const item of candidates) {
    const tokenScore = sharedCount(needle, candidateTokens(item));
    const identityScore = gated ? sharedCount(phraseIdentities, candidateIdentities(item)) : 0;
    if (gated && identityScore === 0) continue;
    const better =
      identityScore > bestIdentityScore ||
      (identityScore === bestIdentityScore && tokenScore > bestTokenScore);
    if (!better) continue;
    bestIdentityScore = identityScore;
    bestTokenScore = tokenScore;
    best = item;
  }
  // Ungated matches still need one shared token; a gated one is carried by its identity.
  return best;
}

export interface WornGarmentChange {
  /** Garments the fiction removed this exchange — matched against currently-worn items. */
  removed: readonly string[];
  /** Garments the fiction added — matched against the wardrobe pool, else free-text overlay. */
  added: readonly string[];
}

/**
 * Apply the archivist's garment-level deltas (rung 2) to a worn item-id list. Removals match
 * the currently-worn items and drop the id; additions match the character's wardrobe pool and
 * add the id, and an unmatched addition — a narrated-but-unowned garment ("a borrowed hoodie")
 * — appends to the free-text overlay (ruling: no minted chat-scoped items for v1). Unmatched
 * removals skip with a diagnostic. Order: removals first (a change often swaps one off for
 * another). PURE — the caller loads `worn`/`pool` and persists the result.
 */
export function applyWornGarmentChanges(input: {
  wornIds: readonly string[];
  /** Loaded descriptors for the currently-worn ids — remove-match candidates. */
  worn: readonly GarmentDescriptor[];
  /** Loaded descriptors for the character's known wardrobe — add-match candidates. */
  pool: readonly GarmentDescriptor[];
  change: WornGarmentChange;
  /** The current free-text overlay (unowned garments riding alongside the worn list). */
  overlay: string;
  sink?: DiagnosticSink;
}): { wornIds: string[]; overlay: string } {
  const ids = [...input.wornIds];
  const overlays: string[] = input.overlay.trim() ? [input.overlay.trim()] : [];

  for (const phrase of input.change.removed) {
    const stillWorn = input.worn.filter((w) => ids.includes(w.id));
    const match = matchGarment(phrase, stillWorn);
    if (!match) {
      input.sink?.push(
        diag("info", "chat_wardrobe.remove_unmatched", `no worn garment matched "${phrase}" — removal skipped`),
      );
      continue;
    }
    const idx = ids.indexOf(match.id);
    if (idx >= 0) ids.splice(idx, 1);
  }

  for (const phrase of input.change.added) {
    const candidates = input.pool.filter((p) => !ids.includes(p.id));
    const match = matchGarment(phrase, candidates);
    if (match) {
      ids.push(match.id);
      continue;
    }
    const trimmed = phrase.trim();
    if (trimmed && !overlays.some((o) => o.toLowerCase() === trimmed.toLowerCase())) {
      overlays.push(trimmed);
      input.sink?.push(
        diag("info", "chat_wardrobe.add_overlay", `added garment "${phrase}" has no library item — kept as free-text overlay`),
      );
    }
  }

  return { wornIds: ids, overlay: overlays.join("; ") };
}
