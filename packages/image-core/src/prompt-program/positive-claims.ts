import type { ImagePromptSegmentKind } from "../render-intent/prompt-segments";
import { imagePromptSegmentKinds, isMandatoryImagePromptSegmentKind } from "../render-intent/prompt-segments";
import { imageConcept, imageConceptChannelRank, type ImageConceptId } from "./concepts";
import {
  imageRelationConcept,
  isRequiredImageWorldFact,
  type ImageSourceRef,
  type ImageWorldDigest,
  type ImageWorldFact,
} from "./world-digest";

/**
 * A model-neutral positive claim: one thing the image MUST contain, said in
 * concepts rather than in any model's words.
 *
 * This is the seam that decides whether a new model is a day of work or a week.
 * `ImagePromptSegment` already classifies prompt content semantically, but its
 * payload is finished prose plus an optional tag spelling — so every future
 * dialect would need the application to supply another pre-rendered wording, and
 * the application would be back to knowing how nine models like their sentences.
 * A claim carries the MEANING and leaves the wording to the dialect, which is
 * what makes "research its dialect and implement a compiler" the whole cost of
 * adding a model.
 *
 * Claims are produced two ways and both are recorded. Most come from the world
 * digest through {@link selectImagePositiveClaims}. A few are generated from a
 * negative constraint whose endpoint has no negative field, where "no blurry
 * text" becomes an affirmative "crisp, legible lettering" — those carry
 * {@link ImagePositiveClaim.fromConstraintId} so provenance can still say the
 * negative pack owns them.
 */
export interface ImagePositiveClaim {
  /** Unique within a program. Derived from the fact key or the operation member. */
  readonly id: string;
  readonly concept: ImageConceptId;
  /** Copied from the concept registry so ordering never has to re-look it up. */
  readonly segmentKind: ImagePromptSegmentKind;
  readonly value: unknown;
  readonly subjectRef?: string;
  readonly locus?: string;
  /** The other end of a relation claim — the object being worn, held or contained. */
  readonly objectRef?: string;
  readonly semanticTags: readonly string[];
  readonly required: boolean;
  readonly priority: number;
  readonly source: ImageSourceRef;
  /** Set when a negative constraint became this claim (positive-replacement transport). */
  readonly fromConstraintId?: string;
}

/**
 * The priority band the operation contract's own claims occupy.
 *
 * Deliberately above anything a projection assigns: the change contract, the
 * subject count and the required lettering are facts about the JOB, and a job
 * that loses its own definition to a budget squeeze has stopped being the render
 * that was asked for. Projections use 0–1 unit priorities, so a single band well
 * clear of them is enough.
 */
const OPERATION_PRIORITY = 100;

/** The source ref operation-derived claims carry. */
const OPERATION_SOURCE: ImageSourceRef = { owner: "image.operation", key: "operation" };

/**
 * Turn one immutable world digest into the ordered positive claims a dialect
 * compiles.
 *
 * Selection follows the canonical order — operation first, then subjects, camera,
 * relations, items, location, style — but that order is about which claim is
 * BUILT first, not which sentence comes first. Emission order is the prompt
 * segment vocabulary's canonical order, applied by
 * {@link orderImagePositiveClaims}, so a dialect that wants its medium up front
 * can still reorder within its own compile.
 *
 * Nothing is invented here. Every claim traces to a fact, a relation, a camera
 * band or an operation member the digest already carried, which is what keeps
 * "the prompt says only what the world says" checkable rather than aspirational.
 */
export function selectImagePositiveClaims(digest: ImageWorldDigest): readonly ImagePositiveClaim[] {
  const claims: ImagePositiveClaim[] = [];
  const { operation } = digest;

  // 1. The job. An edit's delta leads; a generation states its cast size.
  if (operation.change) {
    const change = operation.change;
    claims.push(
      operationClaim("operation.change", "change", change.value, { concept: change.concept, task: operation.task }),
    );
    if (change.preserve.length > 0) {
      claims.push(operationClaim("operation.preserve", "preserve", [...change.preserve].sort()));
    }
    if (change.geometry !== "locked") {
      claims.push(operationClaim("operation.geometry", "geometry", change.geometry));
    }
    for (const replacement of change.replacements) {
      // A replacement is authoritative truth, so it enters as an ordinary claim
      // for its own concept rather than as prose inside the delta — otherwise a
      // dialect could only ever repeat it verbatim.
      claims.push(factClaim(replacement, { forceRequired: true }));
    }
  }
  claims.push(operationClaim("operation.subject_count", "subject_count", operation.subjectCount));
  for (const [index, entry] of operation.literalText.entries()) {
    claims.push({
      ...operationClaim("operation.literal_text", `literal_text.${index}`, entry.text),
      ...(entry.surfaceRef === undefined ? {} : { objectRef: entry.surfaceRef }),
      semanticTags: entry.language === undefined ? ["literal_text"] : ["literal_text", `language:${entry.language}`],
      source: entry.source,
    });
  }
  for (const reference of digest.references) {
    claims.push({
      ...operationClaim("operation.reference_role", `reference.${reference.role}`, reference.role),
      ...(reference.subjectRef === undefined ? {} : { subjectRef: reference.subjectRef }),
      required: reference.required,
      source: reference.source,
    });
  }

  // 2–4, 7. Subjects: identity, morphology, age, wardrobe and exposure all arrive
  // as facts already classified by their concept, so the projection's own
  // required/optional split is the mandatory floor with nothing re-decided here.
  for (const subject of digest.subjects) {
    for (const fact of subject.facts) claims.push(factClaim(fact));
  }

  // 5. Camera. Bands rather than sentences; the dialect phrases them.
  for (const fact of digest.camera) {
    claims.push({
      id: `camera.${fact.component}`,
      concept: `camera.${fact.component}` as ImageConceptId,
      segmentKind: segmentKindOf(`camera.${fact.component}`),
      value: fact.band,
      semanticTags: [`camera:${fact.component}`, `band:${fact.band}`],
      // Camera facts are optional by construction: a framing hint that cannot be
      // fitted costs composition, while a dropped identity anchor costs the
      // person. The change contract's geometry member is where a REQUIRED camera
      // change lives.
      required: false,
      priority: 0.9,
      source: fact.source,
    });
  }

  // 6, 8. Relations. These bind the right person to the right object, so a
  // required relation is genuinely mandatory — an umbrella held by nobody is a
  // different picture.
  for (const relation of digest.relations) {
    const concept = imageRelationConcept(relation.kind);
    claims.push({
      id: `relation.${relation.kind}.${relation.subjectRef}.${relation.objectRef}`,
      concept,
      segmentKind: segmentKindOf(concept),
      value: relation.kind,
      subjectRef: relation.subjectRef,
      objectRef: relation.objectRef,
      semanticTags: [`relation:${relation.kind}`],
      required: relation.required,
      priority: relation.required ? 1 : 0.8,
      source: relation.source,
    });
  }

  // 8–9. Items and the location, in that order: a target item is a first-class
  // subject of an item render, and the place it sits in is context around it.
  for (const item of digest.items) {
    for (const fact of item.facts) claims.push(factClaim(fact));
  }
  for (const fact of digest.location?.facts ?? []) claims.push(factClaim(fact));

  // 11. Style and rendering intent, last selected and last emitted.
  if (operation.style.medium !== "unspecified") {
    claims.push(operationClaim("style.medium", "style.medium", operation.style.medium));
  }
  for (const [index, descriptor] of operation.style.descriptors.entries()) {
    claims.push({
      ...operationClaim("style.descriptor", `style.descriptor.${index}`, descriptor),
      required: false,
      priority: 0.5,
    });
  }

  return orderImagePositiveClaims(claims);
}

/** One digest fact as a claim, keeping the projection's own classification. */
function factClaim(fact: ImageWorldFact, opts?: { forceRequired?: boolean }): ImagePositiveClaim {
  return {
    id: fact.key,
    concept: fact.concept,
    segmentKind: segmentKindOf(fact.concept),
    value: fact.value,
    ...(fact.subjectRef === undefined ? {} : { subjectRef: fact.subjectRef }),
    ...(fact.locus === undefined ? {} : { locus: fact.locus }),
    semanticTags: fact.semanticTags,
    required: opts?.forceRequired === true || isRequiredImageWorldFact(fact),
    priority: fact.priority,
    source: fact.source,
  };
}

/** One operation-contract member as a claim. */
function operationClaim(
  concept: ImageConceptId,
  idSuffix: string,
  value: unknown,
  extraValue?: Record<string, unknown>,
): ImagePositiveClaim {
  return {
    id: `operation.${idSuffix}`,
    concept,
    segmentKind: segmentKindOf(concept),
    value: extraValue === undefined ? value : { value, ...extraValue },
    semanticTags: [],
    required: true,
    priority: OPERATION_PRIORITY,
    source: OPERATION_SOURCE,
  };
}

/**
 * A concept's segment kind, or `operation` when the id is somehow unregistered.
 *
 * The fallback is unreachable through the digest builder, which drops facts with
 * unknown concepts — but `camera.<component>` is assembled as a template string
 * here, and a sixth camera component added to the digest without a matching
 * concept would otherwise land in `undefined`. Falling back to a MANDATORY kind
 * is the safe direction: the claim survives fitting and shows up in provenance
 * rather than vanishing.
 */
function segmentKindOf(concept: ImageConceptId): ImagePromptSegmentKind {
  return imageConcept(concept)?.segmentKind ?? "operation";
}

/**
 * Put claims into the order a prompt says them.
 *
 * Canonical segment-kind order first — the same tuple every compiled prompt
 * already obeys — then mandatory before optional within a kind, then the concept
 * channel, then priority descending, then id. The channel tiebreak is what keeps
 * a subject's wardrobe ahead of an item's when both land in `wardrobe`, and the
 * id tiebreak is what makes the order total, and therefore the fingerprint
 * stable.
 */
export function orderImagePositiveClaims(claims: readonly ImagePositiveClaim[]): ImagePositiveClaim[] {
  return [...claims].sort((left, right) => {
    const kindDelta = segmentRank(left.segmentKind) - segmentRank(right.segmentKind);
    if (kindDelta !== 0) return kindDelta;
    const requiredDelta = Number(right.required) - Number(left.required);
    if (requiredDelta !== 0) return requiredDelta;
    const channelDelta = channelRankOf(left) - channelRankOf(right);
    if (channelDelta !== 0) return channelDelta;
    const priorityDelta = right.priority - left.priority;
    if (priorityDelta !== 0) return priorityDelta;
    return left.id.localeCompare(right.id);
  });
}

function segmentRank(kind: ImagePromptSegmentKind): number {
  return imagePromptSegmentKinds.indexOf(kind);
}

function channelRankOf(claim: ImagePositiveClaim): number {
  const definition = imageConcept(claim.concept);
  return definition ? imageConceptChannelRank(definition.channel) : Number.MAX_SAFE_INTEGER;
}

/**
 * Whether a claim may be dropped to fit a budget.
 *
 * A claim is protected when the projection said so OR when its segment kind is
 * one the segment vocabulary already promotes — the identity lock, the age
 * anchor, the wardrobe authority and the edit delta. Consulting both is the
 * point: a projection that marked its age anchor optional does not get to
 * override an owner ruling, and a projection that marked a lighting note
 * required does not get overridden either.
 */
export function isMandatoryImagePositiveClaim(claim: ImagePositiveClaim): boolean {
  return claim.required || isMandatoryImagePromptSegmentKind(claim.segmentKind);
}

/** The claims a subject ref owns, in emission order — a dialect's grouping helper. */
export function imageClaimsForSubject(
  claims: readonly ImagePositiveClaim[],
  subjectRef: string,
): readonly ImagePositiveClaim[] {
  return claims.filter((claim) => claim.subjectRef === subjectRef);
}
