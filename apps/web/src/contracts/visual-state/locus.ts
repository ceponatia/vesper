import { z } from "zod";
import { bodyLocusKey, bodyLocusRefSchema } from "../appearance-features";
import type { VisualStateLocusKind } from "./vocabulary";

/**
 * Where a visual feature sits.
 *
 * Body paths, garment parts and relations are registry-validated committed
 * identities. There is deliberately no free-text `other` locus: a feature whose
 * home cannot be named is a feature no consumer can compose, occlude, or
 * suppress, and the plan's answer to that is silence.
 */

export const visualStateLocusRefSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("body"), locus: bodyLocusRefSchema }),
  z.object({
    kind: z.literal("garment_part"),
    garmentInstanceId: z.string().min(1),
    partId: z.string().min(1),
  }),
  z.object({ kind: z.literal("item"), itemInstanceId: z.string().min(1) }),
  z.object({ kind: z.literal("subject"), subjectId: z.string().min(1) }),
  z.object({ kind: z.literal("relation"), relationId: z.string().min(1) }),
]);

export type VisualStateLocusRef = z.infer<typeof visualStateLocusRefSchema>;

/** The locus kind a reference carries — what a kind definition's `allowedLoci` gates. */
export function visualStateLocusKind(ref: VisualStateLocusRef): VisualStateLocusKind {
  return ref.kind;
}

/**
 * Percent-escape an id before it becomes a key segment.
 *
 * Garment part ids, instance ids and relation ids are opaque authoring slugs
 * that may legally contain either separator this key uses — the colon inside a
 * locus and the slash between a feature key's three segments. Without escaping:
 *
 * - `{garmentInstanceId: "g1", partId: "cuff:left"}` and
 *   `{garmentInstanceId: "g1:cuff", partId: "left"}` both render
 *   `garment_part:g1:cuff:left`;
 * - `key("s1", {itemInstanceId: "i1/held"}, "x")` and
 *   `key("s1", {itemInstanceId: "i1"}, "held/x")` both render
 *   `s1/item:i1/held/x`.
 *
 * Two different places with one key is a silent cross-wiring of composition
 * edges and observer memory rows rather than an error anything would report.
 *
 * ONLY the id inside a locus is escaped. The subject and aspect segments are
 * left exactly as `appearanceFeatureKey` writes them, because byte-identity with
 * `ProjectedFeatureTruth.key` is what keeps live observer-memory rows matching —
 * escaping the outer segments would turn a latent aliasing bug into an active
 * orphaning one.
 *
 * The escape character is escaped first, so the encoding is injective: two
 * different id pairs can never produce one segment.
 */
function encodeLocusSegment(value: string): string {
  return value.replaceAll("%", "%25").replaceAll(":", "%3A").replaceAll("/", "%2F");
}

/**
 * Deterministic key for a locus — the middle segment of every feature key.
 *
 * The `body` case is DELIBERATELY unprefixed AND unescaped: it renders exactly
 * `bodyLocusKey(locus)`, so an adapted `ProjectedFeatureTruth` keeps a
 * byte-identical feature key and observer visual memory — which is keyed on
 * that string and holds rows for real conversations — keeps matching. That is
 * safe where `encodeLocusSegment` is needed elsewhere because body locations are
 * registry-validated members of a closed vocabulary, not free-form ids. Every
 * locus kind the appearance projection never produced carries its kind as a
 * prefix, so the namespaces cannot collide.
 */
export function visualStateLocusKey(ref: VisualStateLocusRef): string {
  switch (ref.kind) {
    case "body":
      return bodyLocusKey(ref.locus);
    case "garment_part":
      return `garment_part:${encodeLocusSegment(ref.garmentInstanceId)}:${encodeLocusSegment(ref.partId)}`;
    case "item":
      return `item:${encodeLocusSegment(ref.itemInstanceId)}`;
    case "subject":
      return `subject:${encodeLocusSegment(ref.subjectId)}`;
    case "relation":
      return `relation:${encodeLocusSegment(ref.relationId)}`;
  }
}

/**
 * The same injective escape, for an id embedded in a key's ASPECT segment.
 *
 * An aspect that carries an opaque id (a deposit id, a damage-mark id, a
 * condition key) has the identical aliasing problem the locus segments have:
 * the id may legally contain `/` or `:`, and unescaped it can render the same
 * key as a different (subject, locus, aspect) triple. Closed-enum aspect
 * discriminators (`presentation.grooming:brows`) stay bare, exactly as body
 * loci do — escaping is only for ids another owner mints.
 */
export function encodeVisualStateKeySegment(value: string): string {
  return encodeLocusSegment(value);
}
