import type { AffordanceSubjectId } from "../affordances/core";

/**
 * Where a sensory fact stands.
 *
 * The vocabulary is REUSED, never re-invented: a body locus names a
 * `bodyLocationRegistry` id — the same tree wardrobe coverage, image prompts,
 * and the contact core address — and `detail` is the same opaque domain-owned
 * sub-surface token the contact core carries. The types are this package's OWN
 * because of import direction: producers (the contact routing seam among them)
 * adapt their surface refs INTO these, so the presentation owners never import
 * a producer domain and stay shared across all of them.
 */

export const sensoryLocusSides = ["left", "right", "center"] as const;
export type SensoryLocusSide = (typeof sensoryLocusSides)[number];

/** A sensory fact standing at a character's body location. */
export interface SensoryBodyLocus {
  readonly kind: "body";
  readonly subjectId: AffordanceSubjectId;
  /** A `bodyLocationRegistry` id. Validated by consumers against the registry, not here. */
  readonly locationId: string;
  readonly side?: SensoryLocusSide;
  /** Domain-owned sub-surface token. Opaque to this package. */
  readonly detail?: string;
}

/** A sensory fact standing on something that is not a body. */
export interface SensoryObjectLocus {
  readonly kind: "object";
  readonly entityId: string;
  readonly surfaceId: string;
}

export type SensoryLocus = SensoryBodyLocus | SensoryObjectLocus;

/**
 * The stable identity key for one locus. Identity only — never shown to
 * anyone: access laws compare keys (a committed oral contact names the surface
 * it touches), and an id that leaked into prose would be worse than silence.
 */
export function sensoryLocusKey(locus: SensoryLocus): string {
  const parts: readonly string[] =
    locus.kind === "body"
      ? ["body", locus.subjectId, locus.locationId, locus.side ?? "", locus.detail ?? ""]
      : ["object", locus.entityId, locus.surfaceId];
  return parts.join("|");
}
