import type {
  ImageCameraFact,
  ImageConceptId,
  ImagePromptSegmentKind,
  ImageSourceRef,
  ImageSourceRevision,
  ImageSubjectDigest,
  ImageWorldFact,
  ImageWorldSuppression,
} from "@vesper/image-core";
import { visualStateLocusKey } from "../visual-state";
import { entityReadToken } from "./entity-digest";
import type { VisualImageDigest, VisualImageFact } from "./visual-digest";

/**
 * The character slice of a world digest, wrapped from the existing
 * `VisualImageDigest`.
 *
 * **Scaffold, not a finished character projection.** This is the structural half
 * of the character cutover: it translates one closed vocabulary into another and
 * nothing else. It is not bound to any production lane, and it cannot become one
 * on its own — see "What this deliberately cannot say" below. The character
 * image adapter (`character-adapter.ts`, `projectCharacterWorldSlices`) is the
 * seam's other half: it CONSUMES this projection and joins the canonical
 * owners' semantic values onto the selection, rather than anybody writing a
 * fourth route-specific appearance formatter.
 *
 * The plan's ruling is that this WRAPS rather than replaces: visual state already
 * owns which facts apply to this committed cut and whether each is required or
 * merely camera-visible — the mandatory identity lane, camera-resolved optional
 * detail, intended morphology, the consent gate and three fingerprints — and a
 * second appearance owner would be a second answer to the same question.
 *
 * So this adapter adds no truth and re-ranks nothing. It translates the visual
 * digest's prompt-segment classification into the prompt program's concept
 * registry, and its required/optional lanes into projection dispositions.
 * Everything else — keys, source refs, truth fingerprints, priorities — travels
 * through unchanged, which is what keeps "no reformatting, no duplication"
 * checkable rather than aspirational.
 *
 * The one thing it ADDS is morphology protection tags. `@vesper/image-core` must
 * not learn what a species feature group is, and visual state must not learn what
 * `extra_appendages` means to a Qwen negative block, so the handshake happens
 * here: a non-baseline feature group is tagged, and the tag is what stops the
 * anatomy exclusions from forbidding a tail.
 *
 * ## Where the semantic value comes from
 *
 * Visual state selects facts; it does not always carry what they SAY. Appearance
 * facts reach a snapshot through `visual-state/compat.ts`, which adapts
 * `ProjectedFeatureTruth` — a shape with a `truthFingerprint` and no semantic
 * value at all — so it files the fingerprint as the feature's `value`. That
 * fingerprint is canonical JSON, which makes it look readable (`"crooked"`,
 * `{"state":"absent"}`) and is exactly why it is dangerous: it is provenance, and
 * a dialect that emitted it would be putting a change-detection token in a
 * provider payload while appearing to describe a nose.
 *
 * This adapter therefore never treats a fingerprint as prompt semantics, and it
 * never decodes one either — inferring "crooked nose" from a hash-shaped string
 * would be the invention this whole layer exists to prevent. Instead the caller
 * supplies {@link SubjectDigestProjectionInput.semanticValue}, which is where the
 * canonical character/body/attribute/wardrobe owners answer. A fact with no
 * semantic value from either side is SUPPRESSED with a reason, and a required one
 * additionally lands in `missingRequired`, so a character lane compiled with
 * `refuseOnMissingRequired` fails closed instead of rendering a character whose
 * anchors quietly turned into hashes.
 *
 * ## What this deliberately cannot say — the character adapter's scope
 *
 * Three inputs never arrive through this translation, and each is a deliberate
 * absence rather than an oversight. `projectCharacterWorldSlices` closes all
 * three; a lane binds through it, never through this function alone:
 *
 * 1. **Apparent age.** `VisualImageDigest` classifies `identity.apparent_age`
 *    into the protected `age` segment, but no appearance catalog entry projects
 *    it, so no age fact reaches this projection. The character adapter states
 *    the anchor itself from the attribute registry, under the owner-ruled adult
 *    floor.
 * 2. **Exposure and coverage.** Exposure is a composition read over the garment
 *    coverage readout, not an ordinary `VisualImageFact` — `visualImageFactSegmentKind`
 *    deliberately never returns `exposure`. The character adapter adds the
 *    authoritative exposure claims; expecting them to arrive through this
 *    function would silently drop wardrobe authority.
 * 3. **Authored absences.** `subject.absence` — the concept that takes the
 *    `missing_limbs` and `missing_digits` exclusions off the table — needs to
 *    know that an anatomy fact says "absent". That is semantic content this
 *    projection does not have, so an authored amputation leaves HERE as an
 *    opaque anatomy fact, suppressed rather than mistagged; the character
 *    adapter resolves the anatomy row and re-files the fact.
 */

// ---------------------------------------------------------------------------
// Semantic value — the join with the canonical owners
// ---------------------------------------------------------------------------

/**
 * The reason a fact was dropped for carrying no semantic value.
 *
 * Named rather than inlined because the character adapter's own tests will assert
 * on it, and because a suppression reason is the only trace a dropped fact
 * leaves in provenance.
 */
export const IMAGE_SUBJECT_VALUE_UNRESOLVED = "visual_state.value_unresolved";

/** The projection owner name subject facts carry — a diagnostic handle, never prompt text. */
export const IMAGE_SUBJECT_PROJECTION_OWNER = "character.visual_state";

/**
 * Whether a fact's `value` is its own truth fingerprint rather than anything a
 * prompt could say.
 *
 * Exact equality is a precise detector, not a heuristic: a fingerprint is the
 * canonical JSON of a value, so a real string value (`crooked`) never equals its
 * own fingerprint (`"crooked"`, quotes included), and a real object value is not
 * a string at all. The one construction that satisfies it is the compat adapter
 * assigning `value: record.truthFingerprint`, which is exactly the case being
 * detected.
 *
 * Exported because the character adapter needs to know which facts it must go and
 * resolve BEFORE it calls this projection — that is the batch it has to load from
 * the canonical owners.
 */
export function imageSubjectFactNeedsSemanticValue(
  fact: Pick<VisualImageFact, "value" | "truthFingerprint">,
): boolean {
  return fact.value === fact.truthFingerprint;
}

/**
 * The semantic value of one selected fact, from its canonical owner.
 *
 * Consulted ONLY for facts that carry none of their own, so an owner cannot
 * quietly override truth the visual snapshot already holds — a species feature
 * group's `{ group: "wings" }` is authoritative and is never routed through here.
 * Returning `undefined` means "this owner has nothing to say", which suppresses
 * the fact rather than guessing.
 */
export type ImageSubjectSemanticValueResolver = (fact: VisualImageFact) => unknown;

export interface SubjectDigestProjectionInput {
  readonly digest: VisualImageDigest;
  /**
   * Display names by subject id.
   *
   * Supplied by the caller because visual state does not carry them — it
   * describes what a body looks like, not what anybody calls it — and a prompt
   * naming `subject.chr_7f2a` would put a database id in a provider payload.
   */
  readonly labels?: Readonly<Record<string, string>>;
  readonly semanticValue?: ImageSubjectSemanticValueResolver;
}

/**
 * The subject slices plus everything they lost.
 *
 * Suppressions travel beside the subjects rather than inside them because
 * `ImageWorldDigest` collects them across every projection: the caller hands this
 * list straight to `buildImageWorldDigest`, and a dropped character fact then
 * shows up in the same provenance record as a dropped item field.
 */
export interface SubjectDigestProjection {
  readonly subjects: readonly ImageSubjectDigest[];
  readonly suppressions: readonly ImageWorldSuppression[];
}

// ---------------------------------------------------------------------------
// Vocabulary translation
// ---------------------------------------------------------------------------

/**
 * The concept each visual segment kind becomes.
 *
 * Exhaustive over the whole segment vocabulary, though only seven of its members
 * are reachable — `visualImageFactSegmentKind` returns no others. The unreachable
 * ones are listed rather than defaulted so a classifier that grows an eighth
 * answer stops the build here, where somebody decides what it means.
 *
 * For every REACHABLE kind the concept it maps to declares that same segment
 * kind, so a fact's classification survives the translation intact. That is the
 * invariant the tests pin: visual state decides where a fact is said, and this
 * table may not quietly re-file it somewhere cheaper.
 *
 * `setting` is the interesting one. Visual state routes a garment left at a scene
 * locus there rather than to `wardrobe`, on the reasoning that a jacket over a
 * chair is scenery. Scenery it stays: it becomes `location.contents`, which is
 * also a `setting` concept and has the right side effect — a render that
 * describes the discarded jacket must not simultaneously be told to keep its
 * background free of unrelated objects.
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
 *
 * Authored ABSENCES are the gap this cannot close: `morphology.absent_limb`
 * would need to know an anatomy fact says "absent", which is semantic content
 * this projection does not have. The character adapter resolves the anatomy row
 * and re-files such a fact as `subject.absence`; from here alone an amputation
 * leaves opaque and suppressed rather than mistagged.
 */
function morphologyTags(fact: VisualImageFact, morphology: ReadonlySet<string>): readonly string[] {
  if (!morphology.has(fact.key)) return fact.semanticTags;
  const isSpeciesFeature = fact.semanticTags.includes("species_feature_group") || fact.kindId.includes("species");
  if (!isSpeciesFeature) return fact.semanticTags;
  return [...fact.semanticTags, "morphology.extra_appendage", "morphology.extra_limb"];
}

/** One visual fact as a world fact, with nothing re-decided. */
function toWorldFact(
  fact: VisualImageFact,
  ref: string,
  morphology: ReadonlySet<string>,
  value: unknown,
): ImageWorldFact {
  const source: ImageSourceRef = {
    owner: IMAGE_SUBJECT_PROJECTION_OWNER,
    key: fact.sourceKey,
    entityId: fact.subjectId,
  };
  return {
    key: fact.key,
    concept: conceptOfSegmentKind(fact.segmentKind),
    value,
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

// ---------------------------------------------------------------------------
// The projection
// ---------------------------------------------------------------------------

/**
 * Every subject in one committed visual digest, as world-digest slices.
 *
 * A subject with no supplied label falls back to a neutral noun rather than its
 * id: `ref` and `entityId` are handles for relations and provenance and must
 * never reach a provider, and the label is the one field a compiled sentence may
 * use to name somebody.
 */
export function projectSubjectDigests(input: SubjectDigestProjectionInput): SubjectDigestProjection {
  const labels = input.labels ?? {};
  const suppressions: ImageWorldSuppression[] = [];

  const subjects = input.digest.subjects.map((subject): ImageSubjectDigest => {
    const ref = `subject.${subject.subjectId}`;
    const morphologyKeys = new Set(subject.morphology.map((fact) => fact.key));
    const facts: ImageWorldFact[] = [];
    const unresolvedRequired: string[] = [];

    for (const fact of [...subject.required, ...subject.optional]) {
      const value = imageSubjectFactNeedsSemanticValue(fact) ? input.semanticValue?.(fact) : fact.value;
      if (value === undefined) {
        suppressions.push({
          key: fact.key,
          owner: IMAGE_SUBJECT_PROJECTION_OWNER,
          reason: IMAGE_SUBJECT_VALUE_UNRESOLVED,
        });
        // A lost mandatory anchor is the caller's decision, not silently fine:
        // this is what makes `refuseOnMissingRequired` refuse rather than render
        // a character missing the fact that keeps them recognizable.
        if (fact.required) unresolvedRequired.push(fact.key);
        continue;
      }
      facts.push(toWorldFact(fact, ref, morphologyKeys, value));
    }

    const byKey = new Map(facts.map((fact) => [fact.key, fact]));
    return {
      kind: "subject",
      ref,
      entityId: subject.subjectId,
      label: labels[subject.subjectId]?.trim() || "the subject",
      facts,
      // Re-read from the mapped facts rather than mapped twice, so the two lists
      // can never disagree about a fact's tags or disposition — and so a
      // suppressed morphology fact leaves both, instead of surviving here as a
      // guard for a claim the prompt never makes.
      morphology: subject.morphology.map((fact) => byKey.get(fact.key)).filter((fact) => fact !== undefined),
      // Two disjoint ways to lose a mandatory fact: the digest never got it
      // (degradation upstream), or it arrived with no semantic value (here).
      missingRequired: [...subject.missingMandatory, ...unresolvedRequired],
    };
  });

  return { subjects, suppressions };
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
  const source: ImageSourceRef = { owner: IMAGE_SUBJECT_PROJECTION_OWNER, key: "camera" };
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

// ---------------------------------------------------------------------------
// Standalone-character read token
// ---------------------------------------------------------------------------

/** The character row's revision record — one entry in the standalone read token. */
export function standaloneCharacterSourceRevision(characterId: string, revision: string): ImageSourceRevision {
  return { owner: IMAGE_SUBJECT_PROJECTION_OWNER, entityId: characterId, revision };
}

export interface StandaloneCharacterReadInput {
  readonly characterId: string;
  /** The character row's own revision — `characters.updatedAt` as an ISO string. */
  readonly revision: string;
  /**
   * Every OTHER owner the projection read in the same transaction — wardrobe
   * item rows, the identity pack — each in its owner's own terms. Omitting an
   * owner that fed the render means an edit to that owner mints the SAME token,
   * and a retry quietly renders the new state under the old composition's name.
   */
  readonly extraRevisions?: readonly ImageSourceRevision[];
}

/**
 * The `transactional_projection` token for a character render OUTSIDE any
 * conversation. An avatar or library portrait has no
 * committed cut to name, so the token — a hash over the sorted source
 * revisions, exactly as the item/location lanes mint theirs — stands in for
 * one: the caller uses it as the assembly `cutId` and the digest's `forCutId`,
 * and pairs it with a `{ kind: "standalone_character" }` scope. Two reads of
 * unchanged rows mint the same token; any source moving mints a new one.
 */
export function standaloneCharacterReadToken(input: StandaloneCharacterReadInput): string {
  return entityReadToken([
    standaloneCharacterSourceRevision(input.characterId, input.revision),
    ...(input.extraRevisions ?? []),
  ]);
}
