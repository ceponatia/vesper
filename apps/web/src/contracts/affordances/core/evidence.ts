/**
 * Affordance evidence — the provenance trail behind one read.
 *
 * Two laws:
 *
 * - evidence is **debug output only**. It explains why a read said what it said
 *   (which attribute, which state input, which coverage verdict); it never
 *   reaches a narrator prompt, an image prompt, or persisted prose.
 * - evidence is **flat and stringly**. A `ref` names the source in the source's
 *   own vocabulary (`hair.length`, `state.wetness`, `garment:g_hood`), so the
 *   core can carry it without knowing any domain.
 */

/** Where one piece of evidence came from. */
export const affordanceEvidenceKinds = [
  /** A resolved canonical attribute value. */
  "attribute",
  /** Authoritative live state (a meter, a stored fixed-point channel). */
  "state",
  /** An effective-coverage / visibility verdict. */
  "coverage",
  /** Scene-level environment (wind, precipitation, light). */
  "environment",
  /** An asserted body/body or body/surface contact. */
  "contact",
  /** A committed causal event (splash, gust, impact). */
  "event",
  /** The lane adapter itself — which read produced (or failed to produce) an input. */
  "adapter",
] as const;

export type AffordanceEvidenceKind = (typeof affordanceEvidenceKinds)[number];

export interface AffordanceEvidence {
  readonly kind: AffordanceEvidenceKind;
  /** The source in its own vocabulary — an attribute id, input key, or instance id. */
  readonly ref: string;
  /** Optional short elaboration ("shoulder_length", "unavailable"). Never prose. */
  readonly detail?: string;
}

/** One evidence entry. */
export function affordanceEvidence(kind: AffordanceEvidenceKind, ref: string, detail?: string): AffordanceEvidence {
  return detail === undefined ? { kind, ref } : { kind, ref, detail };
}

/**
 * Merge evidence lists, keeping first-seen order and dropping exact repeats.
 *
 * The staged pipeline collects from several layers that legitimately cite the
 * same source (an adapter records the input it read; the profile records the
 * attribute it mapped), and a provenance list is a SET — repeating an entry
 * carries no extra information and only makes debug output harder to read.
 */
export function mergeAffordanceEvidence(
  ...lists: readonly (readonly AffordanceEvidence[])[]
): readonly AffordanceEvidence[] {
  const seen = new Set<string>();
  const merged: AffordanceEvidence[] = [];
  for (const list of lists) {
    for (const entry of list) {
      const key = `${entry.kind}\u0000${entry.ref}\u0000${entry.detail ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(entry);
    }
  }
  return merged;
}
