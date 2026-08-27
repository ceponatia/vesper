import { z } from "zod";
import { fnv1aHex } from "@/lib/hash";
import { parseOrNull } from "@/lib/parse";
import { appearanceCanonicalFingerprint, validateBodyLocusRef } from "../appearance-features";
import { affordanceEvidenceKinds, type AffordanceEvidence } from "../affordances/core";
import { diag, type DiagnosticSink } from "../diagnostics";
import {
  VISUAL_STATE_FEATURE_MALFORMED,
  VISUAL_STATE_KIND_UNKNOWN,
  VISUAL_STATE_LOCUS_INVALID,
  VISUAL_STATE_LOCUS_NOT_ALLOWED,
  VISUAL_STATE_TAG_REJECTED,
  VISUAL_STATE_VALUE_INVALID,
} from "./diagnostics";
import { visualStateLocusKey, visualStateLocusKind, visualStateLocusRefSchema, type VisualStateLocusRef } from "./locus";
import { visualStateAttentionPriorsSchema, type VisualStateAttentionPriors } from "./priors";
import { visualStateRelationshipSchema, type VisualStateRelationship } from "./relationships";
import { visualStateKindRegistry } from "./registry";
import { visualStateSourceRefSchema, type VisualStateSourceRef } from "./sources";
import {
  visualStateLayerSchema,
  visualStateStabilitySchema,
  type VisualStateLayer,
  type VisualStateStability,
} from "./vocabulary";

/**
 * One normalized visual feature.
 *
 * `key` is stable for the CONCEPTUAL feature; `truthFingerprint` changes with
 * its value. That split is what lets observer memory notice "her hair is damp
 * now" without losing "this is the same hair I already know about".
 *
 * A feature is DERIVED. It is never the write target for another owner's fact,
 * carries no prose, and knows nothing about who is looking — visibility,
 * salience and consumer digests are downstream of this file.
 */
export interface VisualStateFeature<TValue = unknown> {
  readonly version: 1;
  readonly key: string;
  readonly subjectId: string;
  readonly kindId: string;
  readonly layer: VisualStateLayer;
  readonly locus: VisualStateLocusRef;
  readonly sourceRef: VisualStateSourceRef;
  readonly value: TValue;
  readonly truthFingerprint: string;
  readonly semanticTags: readonly string[];
  readonly stability: VisualStateStability;
  readonly relationships: readonly VisualStateRelationship[];
  readonly priors: VisualStateAttentionPriors;
  readonly evidence: readonly AffordanceEvidence[];
  readonly changedAtMinutes?: number;
  readonly validUntilMinutes?: number;
}

/**
 * The one key builder — `subject/<locus key>/<aspect>`.
 *
 * Identical in shape to `appearanceFeatureKey`, and that is the point: a
 * body-locus feature adapted from the appearance projection produces a
 * byte-identical key, so the visual memory rows real conversations already hold
 * keep matching.
 */
export function visualStateFeatureKey(
  subjectId: string,
  locus: VisualStateLocusRef,
  aspect: string,
): string {
  return `${subjectId}/${visualStateLocusKey(locus)}/${aspect}`;
}

/**
 * A feature value's deterministic fingerprint: canonical JSON with sorted object
 * keys, no clock, no randomness, no locale.
 *
 * It delegates to the appearance projection's canonicalizer rather than hashing,
 * so ONE fingerprint form exists across the seam. A hashed form here would look
 * tidier and would silently stop matching every fingerprint observer memory has
 * already stored — the failure would be invisible, which is exactly the class of
 * bug this contract exists to prevent.
 */
export function visualStateFingerprint(value: unknown): string {
  return appearanceCanonicalFingerprint(value);
}

/**
 * Digest separators. Control characters, so no key, tag, or canonical-JSON
 * fingerprint can contain one — two different feature lists therefore cannot
 * flatten to the same digest input.
 */
const DIGEST_FIELD_SEPARATOR = "\u0000";
const DIGEST_RECORD_SEPARATOR = "\u001f";

/**
 * A fixed-width digest over an ORDERED feature list — "is this the same visual
 * moment?" in eight hex characters.
 *
 * This is where a hash belongs (FNV-1a, the repository's one string hash): the
 * input is unbounded and only equality is ever asked of the output. A render's
 * provenance can store it to tell "same composition, retry it" from "the
 * character's current state moved". Order is part of the digest, so it is only
 * meaningful over a snapshot's sorted features.
 */
export function visualStateFeaturesFingerprint(features: readonly VisualStateFeature[]): string {
  const parts = features.map((feature) => `${feature.key}${DIGEST_FIELD_SEPARATOR}${feature.truthFingerprint}`);
  return fnv1aHex(parts.join(DIGEST_RECORD_SEPARATOR));
}

// ---------------------------------------------------------------------------
// Semantic tags
// ---------------------------------------------------------------------------

/**
 * The longest a tag may be. Vocabulary is short by nature (`shoulder_length`,
 * `prosthetic`, `left`); a long tag is prose that escaped its owner, and the
 * plan forbids prose becoming visual truth.
 */
const SEMANTIC_TAG_MAX_LENGTH = 64;

function isVocabularyTag(tag: string): boolean {
  return tag.length > 0 && tag.length <= SEMANTIC_TAG_MAX_LENGTH && !/\s/.test(tag);
}

function sanitizeSemanticTags(
  tags: readonly string[],
  key: string,
  sink: DiagnosticSink | undefined,
  path: string,
): readonly string[] {
  const kept: string[] = [];
  for (const tag of tags) {
    if (isVocabularyTag(tag)) {
      kept.push(tag);
      continue;
    }
    sink?.push(
      diag("warn", VISUAL_STATE_TAG_REJECTED, "Semantic tag is prose, not vocabulary", {
        path,
        context: { key, length: tag.length },
      }),
    );
  }
  return kept;
}

// ---------------------------------------------------------------------------
// Validation — one gate, shared by the boundary parser and every adapter
// ---------------------------------------------------------------------------

const visualStateEvidenceSchema = z.object({
  kind: z.enum(affordanceEvidenceKinds),
  ref: z.string().min(1),
  detail: z.string().min(1).optional(),
});

const storyMinutesSchema = z.number().int().min(0);

/** The wire shape of a feature. Kind-specific value parsing happens after this. */
export const visualStateFeatureSchema = z.object({
  version: z.literal(1),
  key: z.string().min(1),
  subjectId: z.string().min(1),
  kindId: z.string().min(1),
  layer: visualStateLayerSchema,
  locus: visualStateLocusRefSchema,
  sourceRef: visualStateSourceRefSchema,
  value: z.unknown(),
  truthFingerprint: z.string().min(1),
  semanticTags: z.array(z.string()),
  stability: visualStateStabilitySchema,
  relationships: z.array(visualStateRelationshipSchema),
  priors: visualStateAttentionPriorsSchema,
  evidence: z.array(visualStateEvidenceSchema),
  changedAtMinutes: storyMinutesSchema.optional(),
  validUntilMinutes: storyMinutesSchema.optional(),
});

/**
 * Validate one candidate against its registered kind, returning the accepted
 * feature or `null` with a diagnostic.
 *
 * Every path into the contract runs through here — the boundary parser and each
 * source adapter — so "what a valid feature is" has exactly one definition and
 * an adapter cannot accidentally admit something the parser would refuse.
 *
 * It fails CLOSED, without exception: a record the wire schema rejects, an
 * unknown kind, a locus the kind does not allow, a body locus the registry
 * cannot validate, a value the kind's schema rejects, or a key that disagrees
 * with the record's own subject and locus all suppress the feature. Unknown is
 * never treated as permission.
 *
 * The wire schema runs HERE rather than only in the boundary parser, so an
 * adapter and a replayed record are held to identical constraints. When it did
 * not, an adapter could mint a feature with an empty `truthFingerprint` that the
 * parser would have refused — and an empty fingerprint compares equal to a
 * memory row whose own fingerprint failed to parse, which reads as "unchanged"
 * and is invisible.
 */
export function validateVisualStateFeature(
  candidate: VisualStateFeature,
  sink?: DiagnosticSink,
  path = "visual_state.feature",
): VisualStateFeature | null {
  const shape = visualStateFeatureSchema.safeParse(candidate);
  if (!shape.success) {
    sink?.push(
      diag("warn", VISUAL_STATE_FEATURE_MALFORMED, shape.error.issues.map((issue) => issue.message).join("; "), {
        path,
        context: { key: candidate.key, kindId: candidate.kindId },
      }),
    );
    return null;
  }

  const kind = visualStateKindRegistry.byId(candidate.kindId);
  if (!kind) {
    sink?.push(
      diag("warn", VISUAL_STATE_KIND_UNKNOWN, `Unknown visual state kind ${candidate.kindId}`, {
        path,
        context: { key: candidate.key, kindId: candidate.kindId },
      }),
    );
    return null;
  }

  if (kind.layer !== candidate.layer) {
    sink?.push(
      diag("warn", VISUAL_STATE_FEATURE_MALFORMED, `${candidate.kindId} is a ${kind.layer} kind`, {
        path,
        context: { key: candidate.key, layer: candidate.layer },
      }),
    );
    return null;
  }

  const locusKind = visualStateLocusKind(candidate.locus);
  if (!visualStateKindRegistry.allowsLocus(candidate.kindId, locusKind)) {
    sink?.push(
      diag("warn", VISUAL_STATE_LOCUS_NOT_ALLOWED, `${candidate.kindId} may not sit at a ${locusKind} locus`, {
        path,
        context: { key: candidate.key, kindId: candidate.kindId, locusKind },
      }),
    );
    return null;
  }

  // A body locus must survive registry validation UNCHANGED. The appearance
  // read may heal an unsupported detail path down to the coarse locus, but a
  // feature already carries a key built from the fine locus, so healing here
  // would leave the key describing a place the record no longer claims.
  if (candidate.locus.kind === "body") {
    const validation = validateBodyLocusRef(candidate.locus.locus, sink, path);
    if (!validation.ok || validation.coarsened) {
      sink?.push(
        diag("warn", VISUAL_STATE_LOCUS_INVALID, "Body locus is not usable as written", {
          path,
          context: { key: candidate.key },
        }),
      );
      return null;
    }
  }

  const keyPrefix = `${candidate.subjectId}/${visualStateLocusKey(candidate.locus)}/`;
  if (!candidate.key.startsWith(keyPrefix) || candidate.key.length === keyPrefix.length) {
    sink?.push(
      diag("warn", VISUAL_STATE_FEATURE_MALFORMED, "Feature key disagrees with its subject and locus", {
        path,
        context: { key: candidate.key, expectedPrefix: keyPrefix },
      }),
    );
    return null;
  }

  const parsedValue = visualStateKindRegistry.parseValue(candidate.kindId, candidate.value);
  if (!parsedValue.ok) {
    sink?.push(
      diag("warn", VISUAL_STATE_VALUE_INVALID, parsedValue.issues.join("; "), {
        path,
        context: { key: candidate.key, kindId: candidate.kindId },
      }),
    );
    return null;
  }

  return {
    ...candidate,
    value: parsedValue.value,
    semanticTags: sanitizeSemanticTags(candidate.semanticTags, candidate.key, sink, path),
  };
}

/**
 * The trust boundary: a raw feature record — a persisted debug snapshot, a
 * replayed cut — becomes a validated feature or `null` (docs/resilience.md §1).
 * Never throws.
 *
 * The wire schema runs twice on this path, once here and once inside
 * `validateVisualStateFeature`. That is deliberate: this call also unwraps a
 * JSON string and reports the standard boundary diagnostic, while the one in the
 * validator is what makes an ADAPTER answer to the same constraints. Neither can
 * be dropped without one of the two paths losing a check.
 */
export function parseVisualStateFeature(
  raw: unknown,
  sink?: DiagnosticSink,
  path = "visual_state.feature",
): VisualStateFeature | null {
  const parsed = parseOrNull(visualStateFeatureSchema, raw, sink, path);
  if (parsed === null) {
    sink?.push(
      diag("warn", VISUAL_STATE_FEATURE_MALFORMED, "Visual state feature is not a usable record", { path }),
    );
    return null;
  }
  const candidate: VisualStateFeature = {
    version: 1,
    key: parsed.key,
    subjectId: parsed.subjectId,
    kindId: parsed.kindId,
    layer: parsed.layer,
    locus: parsed.locus,
    sourceRef: parsed.sourceRef,
    value: parsed.value,
    truthFingerprint: parsed.truthFingerprint,
    semanticTags: parsed.semanticTags,
    stability: parsed.stability,
    relationships: parsed.relationships,
    priors: parsed.priors,
    evidence: parsed.evidence,
    changedAtMinutes: parsed.changedAtMinutes,
    validUntilMinutes: parsed.validUntilMinutes,
  };
  return validateVisualStateFeature(candidate, sink, path);
}
