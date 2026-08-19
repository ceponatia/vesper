import type {
  ImageCameraFact,
  ImageConceptId,
  ImagePromptSegmentKind,
  ImageSourceRef,
  ImageSubjectDigest,
  ImageWorldFact,
} from "@vesper/image-core";
import { visualStateLocusKey } from "../visual-state";
import type { VisualImageDigest, VisualImageFact } from "./visual-digest";

/**
 * The character slice of a world digest, wrapped from the existing
 * `VisualImageDigest` (model-aware-image-prompts.plan.md §"Character facts").
 *
 * The plan's ruling is that this WRAPS rather than replaces: visual state already
 * owns what a character looks like right now — the committed cut, the mandatory
 * identity lane, camera-resolved optional detail, intended morphology, the
 * consent gate and three fingerprints — and a second appearance owner would be a
 * second answer to the same question.
 *
 * So this adapter adds no truth and re-ranks nothing. It translates one closed
 * vocabulary into another: the visual digest's prompt-segment classification into
 * the prompt program's concept registry, and its required/optional lanes into
 * projection dispositions. Everything else — keys, values, source refs, truth
 * fingerprints, priorities — travels through unchanged, which is what keeps
 * "no reformatting, no duplication" checkable rather than aspirational.
 *
 * The one thing it ADDS is morphology protection tags. `@vesper/image-core` must
 * not learn what a species feature group is, and visual state must not learn what
 * `extra_appendages` means to a Qwen negative block, so the handshake happens
 * here: a non-baseline feature group is tagged, and the tag is what stops the
 * anatomy exclusions from forbidding a tail.
 */

/**
 * The concept each visual segment kind becomes.
 *
 * Exhaustive over the whole segment vocabulary, though only seven of its members
 * are reachable — `visualImageFactSegmentKind` returns no others. The unreachable
 * ones are listed rather than defaulted so a classifier that grows an eighth
 * answer stops the build here, where somebody decides what it means.
 *
 * `setting` is the interesting one. Visual state routes a garment left at a scene
 * locus there rather than to `wardrobe`, on the reasoning that a jacket over a
 * chair is scenery. Scenery it stays: it becomes `location.contents`, which also
 * has the right side effect — a render that describes the discarded jacket must
 * not simultaneously be told to keep its background free of unrelated objects.
 */
function conceptOfSegmentKind(kind: ImagePromptSegmentKind): ImageConceptId {
  switch (kind) {
    case "identity":
      return "subject.identity";
    case "age":
      return "subject.apparent_age";
    case "morphology":
      return "subject.morphology";
    case "wardrobe":
      return "subject.wardrobe";
    case "exposure":
      return "subject.exposure";
    case "pose":
      return "subject.body_language";
    case "current_state":
      return "subject.current_state";
    case "setting":
      return "location.contents";
    // The rest of the segment vocabulary is unreachable from
    // `visualImageFactSegmentKind`, which returns only the seven kinds above.
    // They are listed rather than caught by a default so that a classifier which
    // grows an eighth answer is a compile error here — somebody then decides what
    // the new kind MEANS instead of inheriting a fallback. Until then, a subject
    // fact of unknown shape is neutral droppable appearance detail, which is the
    // safe direction: it reaches the prompt, and it is the first thing a budget
    // squeeze gives up.
    case "operation":
    case "framing":
    case "lighting":
    case "atmosphere":
    case "style":
    case "quality":
      return "subject.appearance";
  }
}

/**
 * The protection tags a morphology fact carries.
 *
 * A species feature group is a non-baseline appendage — a tail, wings, horns,
 * an extra pair of arms — so it protects the two anatomy exclusions that would
 * otherwise forbid it. Ordinary anatomy protects NOTHING, which is deliberate:
 * a human shoulder is exactly the case the duplication exclusions exist to
 * defend, and a projection that protected it would switch the block off for
 * every character.
 */
function morphologyTags(fact: VisualImageFact, morphology: ReadonlySet<string>): readonly string[] {
  if (!morphology.has(fact.key)) return fact.semanticTags;
  const isSpeciesFeature = fact.semanticTags.includes("species_feature_group") || fact.kindId.includes("species");
  if (!isSpeciesFeature) return fact.semanticTags;
  return [...fact.semanticTags, "morphology.extra_appendage", "morphology.extra_limb"];
}

/** One visual fact as a world fact, with nothing re-decided. */
function toWorldFact(fact: VisualImageFact, ref: string, morphology: ReadonlySet<string>): ImageWorldFact {
  const source: ImageSourceRef = {
    owner: "character.visual_state",
    key: fact.sourceKey,
    entityId: fact.subjectId,
  };
  return {
    key: fact.key,
    concept: conceptOfSegmentKind(fact.segmentKind),
    value: fact.value,
    subjectRef: ref,
    locus: visualStateLocusKey(fact.locus),
    semanticTags: morphologyTags(fact, morphology),
    // The mandatory lane IS `required_visual`. The digest already applied the
    // consent gate and the visibility rules, so there is no second judgment here.
    disposition: fact.required ? "required_visual" : "optional_visual",
    priority: fact.priority,
    source,
    truthFingerprint: fact.truthFingerprint,
  };
}

/**
 * Every subject in one committed visual digest, as world-digest slices.
 *
 * `label` comes from the caller because visual state does not carry display
 * names — it describes what a body looks like, not what anybody calls it — and a
 * prompt naming `subject.chr_7f2a` would put a database id in a provider payload.
 * A subject with no supplied label falls back to a neutral noun rather than its
 * id.
 */
export function projectSubjectDigests(
  digest: VisualImageDigest,
  labels: Readonly<Record<string, string>> = {},
): readonly ImageSubjectDigest[] {
  return digest.subjects.map((subject) => {
    const ref = `subject.${subject.subjectId}`;
    const morphologyKeys = new Set(subject.morphology.map((fact) => fact.key));
    const facts = [...subject.required, ...subject.optional].map((fact) => toWorldFact(fact, ref, morphologyKeys));
    const byKey = new Map(facts.map((fact) => [fact.key, fact]));
    return {
      kind: "subject",
      ref,
      entityId: subject.subjectId,
      label: labels[subject.subjectId]?.trim() || "the subject",
      facts,
      // Re-read from the mapped facts rather than mapped twice, so the two lists
      // can never disagree about a fact's tags or disposition.
      morphology: subject.morphology.map((fact) => byKey.get(fact.key)).filter((fact) => fact !== undefined),
      missingRequired: subject.missingMandatory,
    };
  });
}

/**
 * The digest's camera reads, in the prompt program's own band vocabulary.
 *
 * The two vocabularies are member-for-member identical today, which makes this
 * look like a cast — and it is on purpose. `@vesper/image-core` keeps its own
 * copy so a game-side band change surfaces here, in an adapter somebody has to
 * think about, rather than reaching a negative guard as a string it does not
 * recognize.
 */
export function projectCameraFacts(digest: VisualImageDigest): readonly ImageCameraFact[] {
  const source: ImageSourceRef = { owner: "character.visual_state", key: "camera" };
  return digest.cameraFacts.map((fact): ImageCameraFact => {
    switch (fact.component) {
      case "framing":
        return { component: "framing", band: fact.band, source };
      case "distance":
        return { component: "distance", band: fact.band, source };
      case "angle":
        return { component: "angle", band: fact.band, source };
      case "motion":
        return { component: "motion", band: fact.band, source };
      case "lighting":
        return { component: "lighting", band: fact.band, source };
    }
  });
}
