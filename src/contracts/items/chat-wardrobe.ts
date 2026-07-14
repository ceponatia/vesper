import { diag, type DiagnosticSink } from "../diagnostics";
import { clothingSubtypeLabel } from "./subtypes";

/**
 * Chat wardrobe parity (docs/developer-notes/chat-wardrobe-parity.plan.md) — the pure
 * matching + worn-list reducer the archivist's garment-level add/remove proposals fold
 * through (rung 2). The chat lane holds a list of worn **item ids**; the archivist emits
 * free-text garment phrases ("she slips off her jacket"), so these helpers resolve each
 * phrase against the loaded item descriptors. Kept PURE (the caller does the item IO) so
 * the reducer is snapshot-testable and the whole fold degrades — a missing garment skips
 * with a diagnostic, never fails the turn (docs/resilience.md).
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
 * Match a free-text garment phrase to the best candidate by token overlap on
 * name / subtype / description. Returns undefined when nothing overlaps (the
 * caller degrades). Ties keep the FIRST candidate (worn/pool order is meaningful).
 * PURE.
 */
export function matchGarment(
  phrase: string,
  candidates: readonly GarmentDescriptor[],
): GarmentDescriptor | undefined {
  const needle = garmentTokens(phrase);
  if (needle.size === 0) return undefined;
  let best: GarmentDescriptor | undefined;
  let bestScore = 0;
  for (const item of candidates) {
    const hay = candidateTokens(item);
    let score = 0;
    for (const token of needle) if (hay.has(token)) score += 1;
    if (score > bestScore) {
      bestScore = score;
      best = item;
    }
  }
  return bestScore >= 1 ? best : undefined;
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
