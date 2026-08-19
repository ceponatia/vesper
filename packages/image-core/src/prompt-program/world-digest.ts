import { fnv1aHex } from "@vesper/contracts";
import type { ImageReferenceRole } from "../capabilities/image-model-capabilities";
import type { ImageProfileOperation, ImageProfileTask, ImagePromptStrategy } from "../models/image-model-profiles";
import { stableJson } from "../render-kernel/stable-json";
import type {
  ImageAngleBand,
  ImageDistanceBand,
  ImageFramingBand,
  ImageLightingBand,
  ImageMotionBand,
} from "./camera-bands";
import { imageConcept, type ImageConceptChannel, type ImageConceptId } from "./concepts";
import type { ImageStyleMedium } from "./conflict-keys";

/**
 * The atomic world digest — ONE immutable set of facts both prompt channels
 * compile from (model-aware-image-prompts.plan.md §"Atomic world digest").
 *
 * The rule this shape exists to make structural: **facts are selected once and
 * prose is written last**. Before it, a location arrived at the prompt builder
 * as a formatted sentence, an item as a different formatted sentence, and a
 * character as a third — so teaching a new model to describe a place meant
 * re-deriving what a place IS inside that model's file. A digest replaces all
 * three with typed facts carrying their own provenance, and every dialect reads
 * the same ones.
 *
 * Three properties are load-bearing:
 *
 * 1. **One read.** Every fact in a digest was read at one point in time, and the
 *    digest says which point ({@link ImageWorldRead}). The positive and negative
 *    channels receive the same object, so a negative constraint can never be
 *    evaluated against a wardrobe the positive prompt did not describe.
 * 2. **No reach-back.** The digest is deep-frozen at construction and no
 *    compiler is given anything else. A dialect physically cannot consult live
 *    state, because it never receives a handle to any.
 * 3. **Deterministic identity.** {@link ImageWorldDigest.fingerprint} is a
 *    function of the ordered facts and their source revisions, so "retry this
 *    exact composition" and "render current state" are distinguishable after the
 *    fact rather than a guess.
 *
 * What lives HERE versus in the application: this module owns the shape, the
 * ordering, the fingerprint and the validation. The application owns projection —
 * turning a character's visual snapshot, a location row and an item row into
 * these facts — because only it knows what a Vesper garment or ambient blob is.
 */

// ---------------------------------------------------------------------------
// Projection dispositions — the classification a source field must carry
// ---------------------------------------------------------------------------

/**
 * What one source field's projection decided about it
 * (plan §"'All information' means all image-eligible truth").
 *
 * The point of naming the negative answers is that they are DECISIONS. A field
 * classified `nonvisual` was looked at and ruled out; a field with no
 * classification at all is an oversight, and the application's coverage check
 * fails on exactly that difference. Without this, a new world field disappears
 * from every render silently and nobody finds out until an image is wrong.
 *
 * - `required_visual` — the image is wrong without it; fitting may never drop it.
 * - `optional_visual` — real visual detail, first to go under a budget squeeze.
 * - `relational` — binds entities together rather than describing one.
 * - `reference_only` — reaches the render as an image reference, not as words.
 * - `nonvisual` — true, but nothing a picture can show (a scent, a rule).
 * - `restricted` — visual but deliberately withheld (consent, secrecy, policy).
 * - `unsupported` — no dialect can express it yet; recorded so it stays visible.
 */
export const imageProjectionDispositions = [
  "required_visual",
  "optional_visual",
  "relational",
  "reference_only",
  "nonvisual",
  "restricted",
  "unsupported",
] as const;
export type ImageProjectionDisposition = (typeof imageProjectionDispositions)[number];

/**
 * The dispositions that put a fact INTO the digest. The other four are recorded
 * by the application's coverage registry and never produce a fact — which is why
 * a digest cannot leak a restricted field by accident: there is no shape for one.
 */
const FACT_DISPOSITIONS: ReadonlySet<ImageProjectionDisposition> = new Set([
  "required_visual",
  "optional_visual",
  "relational",
]);

/** Whether a disposition produces a digest fact at all. */
export function imageDispositionProducesFact(disposition: ImageProjectionDisposition): boolean {
  return FACT_DISPOSITIONS.has(disposition);
}

// ---------------------------------------------------------------------------
// Provenance primitives
// ---------------------------------------------------------------------------

/**
 * Where a fact came from, in the owner's own terms.
 *
 * `owner` is a stable projection name (`character.visual_state`,
 * `location.definition`, `item.instance`) rather than a table name, because the
 * thing a diagnostic needs to identify is the PROJECTION that produced the fact —
 * that is what an operator would go and fix.
 *
 * This never reaches a provider. Structurally, not by convention: every dialect
 * compiler receives claims, and a claim's `source` is not among the fields any
 * compiler in this package reads.
 */
export interface ImageSourceRef {
  readonly owner: string;
  /** The owner's own key for this fact — a feature key, a column name, a field path. */
  readonly key: string;
  /** The entity the fact is about, when the owner scopes facts by entity. */
  readonly entityId?: string;
}

/**
 * A source's revision at read time — the second half of "was this the same
 * world?".
 *
 * A fingerprint says the selected FACTS match. A revision says the SOURCE has
 * not moved, which is the stronger claim a retry needs: two reads of a location
 * can select identical facts while the row underneath gained a field that this
 * digest's projection did not know to look at.
 */
export interface ImageSourceRevision {
  readonly owner: string;
  readonly entityId: string;
  /** Whatever the owner uses to version itself — an updatedAt, a cut id, a hash. */
  readonly revision: string;
}

/**
 * The read this digest describes.
 *
 * `committed_cut` is a chat/scene render: the token is the committed cut id and
 * the character snapshot must match it. `transactional_projection` is a
 * standalone portrait, item or location render, where the application read every
 * owner in one transaction (or an equivalent consistent projection) and minted a
 * token from the source revisions.
 *
 * The kinds are separate because their staleness checks differ: a cut can be
 * superseded by a retake, while a transactional projection can only be
 * invalidated by a source revision moving.
 */
export interface ImageWorldRead {
  readonly kind: "committed_cut" | "transactional_projection";
  readonly token: string;
  readonly atMinutes?: number;
}

/** Something the projection deliberately or regretfully left out. */
export interface ImageWorldSuppression {
  /** The fact key or field path that did not make it. */
  readonly key: string;
  readonly owner: string;
  /** A diagnostic code or short reason — `visual_state.intimate.gated`, `unsupported`. */
  readonly reason: string;
}

// ---------------------------------------------------------------------------
// Facts
// ---------------------------------------------------------------------------

/**
 * One typed thing the world says about this image.
 *
 * A fact is NOT prose and NOT a model's spelling. `value` is structured — a
 * string, a number, a small record — and the dialect decides how to say it. That
 * is the difference between this and the prompt segments it will eventually be
 * compiled into: a segment already knows how it reads, a fact only knows what it
 * means.
 *
 * `priority` and `disposition` together decide survival under a budget squeeze:
 * `required_visual` is the mandatory floor, and priority orders everything else.
 */
export interface ImageWorldFact {
  /** Unique within the digest. Two owners projecting the same idea still differ here. */
  readonly key: string;
  readonly concept: ImageConceptId;
  readonly value: unknown;
  /** The subject/item/location ref this fact is about, when it is about one. */
  readonly subjectRef?: string;
  /** A body location, a surface, a part — whatever the owner's locus vocabulary is. */
  readonly locus?: string;
  readonly semanticTags: readonly string[];
  readonly disposition: ImageProjectionDisposition;
  /** Higher survives longer. Comparable only against other facts in the same digest. */
  readonly priority: number;
  readonly source: ImageSourceRef;
  /** The owner's own fingerprint of this fact's truth, when it has one. */
  readonly truthFingerprint?: string;
}

/** Whether a fact is on the mandatory lane. */
export function isRequiredImageWorldFact(fact: ImageWorldFact): boolean {
  return fact.disposition === "required_visual";
}

/**
 * One entity's slice of the digest.
 *
 * Subjects, locations and items share one shape rather than getting three
 * near-identical ones. The kind discriminates them where it matters (the
 * selector walks subjects before items before the location), and everything else
 * — facts, morphology, missing required keys — means the same thing for all
 * three. Three copies of this interface would be three places to forget a field.
 */
export interface ImageEntityDigest {
  readonly kind: "subject" | "location" | "item";
  /** The handle relations and claims use to point at this entity. Unique in the digest. */
  readonly ref: string;
  /** A display-neutral identifier for the underlying row, for provenance only. */
  readonly entityId: string;
  /**
   * The name this entity may be called BY A PROMPT — a character's name, an
   * item's name, a location's name.
   *
   * Separate from `ref` and `entityId` because those are handles and must never
   * reach a provider: a relation compiled as "subject.chr_7f2a holds item.itm_91"
   * would put database ids in the payload. The label is the projection's own
   * answer to "what would you call this in a sentence", which is a decision only
   * the application can make.
   */
  readonly label: string;
  readonly facts: readonly ImageWorldFact[];
  /**
   * The morphology subset — the negative anatomy block's guard input.
   *
   * A subset rather than a filter over `facts` because only the projection knows
   * which of its facts describe body structure, and the negative system must not
   * have to infer that from a concept id.
   */
  readonly morphology: readonly ImageWorldFact[];
  /**
   * Keys the owner marked required that the projection LOST to degradation.
   *
   * Non-empty is a caller decision, not automatically fatal: a scene may
   * legitimately proceed without one optional-turned-missing anchor, while an
   * identity-critical render must refuse. The compiler reports it; the profile
   * eligibility rules decide.
   */
  readonly missingRequired: readonly string[];
}

/** A character-bearing entity slice. */
export type ImageSubjectDigest = ImageEntityDigest & { readonly kind: "subject" };
/** A place's entity slice. */
export type ImageLocationDigest = ImageEntityDigest & { readonly kind: "location" };
/** An object's entity slice — definition facts and instance state alike. */
export type ImageItemDigest = ImageEntityDigest & { readonly kind: "item" };

// ---------------------------------------------------------------------------
// Relations
// ---------------------------------------------------------------------------

/**
 * The relation vocabulary (plan §"Relations are facts").
 *
 * Ownership, containment, wearing, holding, contact and placement are not prose
 * glue. A model compiler needs them as data to bind the right person to the right
 * object and the right reference image — "she holds a red umbrella" is
 * unrecoverable from two independent facts once there are two women in frame.
 */
export const imageWorldRelationKinds = [
  "wears",
  "holds",
  "contains",
  "attached_to",
  "located_at",
  "left_of",
  "right_of",
  "in_front_of",
  "behind",
  "contact",
  "acts_on",
] as const;
export type ImageWorldRelationKind = (typeof imageWorldRelationKinds)[number];

export interface ImageWorldRelation {
  readonly kind: ImageWorldRelationKind;
  /** An entity ref in this digest. */
  readonly subjectRef: string;
  /** An entity ref in this digest. */
  readonly objectRef: string;
  readonly required: boolean;
  readonly source: ImageSourceRef;
}

/** The concept a relation kind compiles as. */
export function imageRelationConcept(kind: ImageWorldRelationKind): ImageConceptId {
  switch (kind) {
    case "wears":
      return "relation.wears";
    case "holds":
      return "relation.holds";
    case "contains":
      return "relation.contains";
    case "attached_to":
      return "relation.attached_to";
    case "located_at":
      return "relation.located_at";
    case "left_of":
    case "right_of":
    case "in_front_of":
    case "behind":
      return "relation.placement";
    case "contact":
      return "relation.contact";
    case "acts_on":
      return "relation.acts_on";
  }
}

// ---------------------------------------------------------------------------
// Camera, operation, references
// ---------------------------------------------------------------------------

/**
 * One resolved camera condition, as a band rather than a sentence.
 *
 * Bands rather than free text because the negative composition block has to
 * decide whether `close_up`, `cropped` and `blur` are requested outcomes, and it
 * can only do that against a closed vocabulary. A discriminated union rather
 * than `{ component, band: string }` for the same reason one level down: the
 * guard switches on the component and reads the band, and a mismatched pair
 * would be a runtime surprise in the one place that must not have any.
 */
export type ImageCameraFact =
  | { readonly component: "framing"; readonly band: ImageFramingBand; readonly source: ImageSourceRef }
  | { readonly component: "distance"; readonly band: ImageDistanceBand; readonly source: ImageSourceRef }
  | { readonly component: "angle"; readonly band: ImageAngleBand; readonly source: ImageSourceRef }
  | { readonly component: "motion"; readonly band: ImageMotionBand; readonly source: ImageSourceRef }
  | { readonly component: "lighting"; readonly band: ImageLightingBand; readonly source: ImageSourceRef };

/** Text that must appear in the image, letter-exact. */
export interface ImageLiteralText {
  readonly text: string;
  /** The entity ref carrying the text — a sign, a garment, a label. */
  readonly surfaceRef?: string;
  /** BCP-47-ish tag when the text is not English; advisory to the dialect. */
  readonly language?: string;
  readonly source: ImageSourceRef;
}

/** The medium and descriptors this render is deliberately in. */
export interface ImageStyleIntent {
  readonly medium: ImageStyleMedium;
  readonly descriptors: readonly string[];
}

/** What an instruction edit changes, and what it must leave alone. */
export interface ImageChangeContract {
  /** The one requested change, as a concept/value pair the dialect phrases. */
  readonly concept: ImageConceptId;
  readonly value: unknown;
  /** The facts that REPLACE current truth — authoritative, not suggestions. */
  readonly replacements: readonly ImageWorldFact[];
  /**
   * Fact keys that must survive the edit.
   *
   * A derived set rather than "preserve everything", which is the wording the
   * research blames for Qwen's squashed-figure geometry failure: told to keep the
   * background and placement while changing the pose, the model compressed the
   * person to satisfy both.
   */
  readonly preserve: readonly string[];
  /** Whether the edit may expand the canvas, re-crop, or move the viewpoint. */
  readonly geometry: "locked" | "canvas_may_expand" | "recompose";
}

/**
 * What this render is for — the first thing selected and the first thing said.
 *
 * `subjectCount` is separate from `subjects.length` on purpose: an establishing
 * shot of a room asserts ZERO people while carrying no subject slices at all, and
 * "no people" is a claim the render has to make rather than an absence it can
 * leave implied.
 */
export interface ImageOperationContract {
  readonly kind: ImageProfileOperation;
  readonly task: ImageProfileTask;
  readonly strategy: ImagePromptStrategy;
  readonly subjectCount: number;
  readonly style: ImageStyleIntent;
  readonly literalText: readonly ImageLiteralText[];
  readonly change?: ImageChangeContract;
}

/** A reference image this render intends to send, and what it is for. */
export interface ImageReferenceFact {
  readonly role: ImageReferenceRole;
  /** The entity the reference depicts, when it depicts one. */
  readonly subjectRef?: string;
  readonly required: boolean;
  readonly source: ImageSourceRef;
}

// ---------------------------------------------------------------------------
// The digest
// ---------------------------------------------------------------------------

export interface ImageWorldDigest {
  readonly version: 1;
  readonly read: ImageWorldRead;
  /** Deterministic over the ordered facts, relations, camera, operation and revisions. */
  readonly fingerprint: string;
  readonly subjects: readonly ImageSubjectDigest[];
  readonly location: ImageLocationDigest | null;
  readonly items: readonly ImageItemDigest[];
  readonly relations: readonly ImageWorldRelation[];
  readonly camera: readonly ImageCameraFact[];
  readonly operation: ImageOperationContract;
  readonly references: readonly ImageReferenceFact[];
  readonly suppressions: readonly ImageWorldSuppression[];
  readonly sourceRevisions: readonly ImageSourceRevision[];
}

/** Everything a digest needs, before ordering, validation and fingerprinting. */
export interface ImageWorldDigestInput {
  readonly read: ImageWorldRead;
  readonly subjects?: readonly ImageSubjectDigest[];
  readonly location?: ImageLocationDigest | null;
  readonly items?: readonly ImageItemDigest[];
  readonly relations?: readonly ImageWorldRelation[];
  readonly camera?: readonly ImageCameraFact[];
  readonly operation: ImageOperationContract;
  readonly references?: readonly ImageReferenceFact[];
  readonly suppressions?: readonly ImageWorldSuppression[];
  readonly sourceRevisions?: readonly ImageSourceRevision[];
}

/** A problem found while building a digest — never a throw. */
export interface ImageWorldDigestIssue {
  readonly code:
    | "world_digest.duplicate_ref"
    | "world_digest.duplicate_fact_key"
    | "world_digest.unknown_concept"
    | "world_digest.dangling_relation"
    | "world_digest.nonfact_disposition"
    | "world_digest.blank_read_token";
  readonly detail: string;
}

export interface ImageWorldDigestResult {
  readonly digest: ImageWorldDigest;
  /**
   * Everything the build corrected or dropped.
   *
   * Issues rather than exceptions per docs/resilience.md §2: a projection that
   * emitted one bad fact must still get its render, and the caller decides
   * whether an issue makes the profile ineligible. A digest is always returned.
   */
  readonly issues: readonly ImageWorldDigestIssue[];
}

/**
 * Build the one immutable digest a render compiles from.
 *
 * Four things happen here and nowhere else:
 *
 * 1. **Validation** — refs are unique, fact keys are unique, concepts are
 *    registered, relations point at entities that exist, and every fact carries a
 *    disposition that actually produces a fact. Each failure drops the offending
 *    member with an issue rather than failing the build, so one malformed
 *    projection cannot cost a render every other fact it had.
 * 2. **Ordering** — entities by ref, facts by channel then priority then key.
 *    Deterministic order is what makes the fingerprint meaningful and what makes
 *    two compiles of the same world byte-equal.
 * 3. **Fingerprinting** — over the ordered result, including source revisions.
 * 4. **Freezing** — deeply, so "no compiler may reach back into live state" has
 *    teeth: a compiler handed this object cannot mutate it into a different
 *    world, and it is handed nothing else.
 */
export function buildImageWorldDigest(input: ImageWorldDigestInput): ImageWorldDigestResult {
  const issues: ImageWorldDigestIssue[] = [];
  if (input.read.token.trim().length === 0) {
    issues.push({ code: "world_digest.blank_read_token", detail: "the read token was blank" });
  }

  const seenRefs = new Set<string>();
  const seenFactKeys = new Set<string>();

  const takeEntity = <T extends ImageEntityDigest>(entity: T): T | null => {
    if (seenRefs.has(entity.ref)) {
      issues.push({ code: "world_digest.duplicate_ref", detail: entity.ref });
      return null;
    }
    seenRefs.add(entity.ref);
    const facts = orderFacts(entity.facts.filter((fact) => keepFact(fact, seenFactKeys, issues)));
    const keptKeys = new Set(facts.map((fact) => fact.key));
    return {
      ...entity,
      facts,
      // Morphology is re-derived from the KEPT facts so a dropped fact cannot
      // survive as a protection: a malformed appendage fact that never reached
      // the prompt must not silently switch off the anatomy exclusions either.
      morphology: orderFacts(entity.morphology.filter((fact) => keptKeys.has(fact.key))),
      missingRequired: [...entity.missingRequired].sort(),
    };
  };

  const subjects = compact((input.subjects ?? []).map(takeEntity)).sort(byRef);
  const location = input.location ? takeEntity(input.location) : null;
  const items = compact((input.items ?? []).map(takeEntity)).sort(byRef);

  const relations = (input.relations ?? [])
    .filter((relation) => {
      const ok = seenRefs.has(relation.subjectRef) && seenRefs.has(relation.objectRef);
      if (!ok) {
        issues.push({
          code: "world_digest.dangling_relation",
          detail: `${relation.kind}: ${relation.subjectRef} -> ${relation.objectRef}`,
        });
      }
      return ok;
    })
    .slice()
    .sort(byRelation);

  const camera = [...(input.camera ?? [])].sort((left, right) => left.component.localeCompare(right.component));
  const references = [...(input.references ?? [])].sort(byReference);
  const suppressions = [...(input.suppressions ?? [])].sort(
    (left, right) => left.owner.localeCompare(right.owner) || left.key.localeCompare(right.key),
  );
  const sourceRevisions = [...(input.sourceRevisions ?? [])].sort(
    (left, right) => left.owner.localeCompare(right.owner) || left.entityId.localeCompare(right.entityId),
  );

  const digest: ImageWorldDigest = {
    version: 1,
    read: input.read,
    fingerprint: "",
    subjects,
    location,
    items,
    relations,
    camera,
    operation: input.operation,
    references,
    suppressions,
    sourceRevisions,
  };
  const fingerprinted: ImageWorldDigest = { ...digest, fingerprint: imageWorldDigestFingerprint(digest) };
  return { digest: deepFreeze(fingerprinted), issues };
}

/**
 * The digest's identity: everything that decides what the image should contain.
 *
 * `suppressions` are deliberately EXCLUDED. They record why something is absent,
 * and two reads that suppressed the same fact for differently-worded reasons
 * describe the same world — including them would make "retry same composition"
 * fail over a diagnostic string. Source revisions ARE included: a moved source is
 * a different world even when the selected facts happen to match.
 */
export function imageWorldDigestFingerprint(digest: Omit<ImageWorldDigest, "fingerprint">): string {
  return fnv1aHex(
    stableJson({
      version: digest.version,
      read: { kind: digest.read.kind, token: digest.read.token, atMinutes: digest.read.atMinutes },
      subjects: digest.subjects.map(entityFingerprintInput),
      location: digest.location ? entityFingerprintInput(digest.location) : null,
      items: digest.items.map(entityFingerprintInput),
      relations: digest.relations.map((relation) => [
        relation.kind,
        relation.subjectRef,
        relation.objectRef,
        relation.required,
      ]),
      camera: digest.camera.map((fact) => [fact.component, fact.band]),
      operation: {
        kind: digest.operation.kind,
        task: digest.operation.task,
        strategy: digest.operation.strategy,
        subjectCount: digest.operation.subjectCount,
        style: digest.operation.style,
        literalText: digest.operation.literalText.map((entry) => [entry.text, entry.surfaceRef, entry.language]),
        change: digest.operation.change
          ? {
              concept: digest.operation.change.concept,
              value: digest.operation.change.value,
              geometry: digest.operation.change.geometry,
              preserve: [...digest.operation.change.preserve].sort(),
              replacements: digest.operation.change.replacements.map(factFingerprintInput),
            }
          : null,
      },
      references: digest.references.map((entry) => [entry.role, entry.subjectRef, entry.required]),
      sourceRevisions: digest.sourceRevisions.map((entry) => [entry.owner, entry.entityId, entry.revision]),
    }),
  );
}

function entityFingerprintInput(entity: ImageEntityDigest): unknown {
  return {
    kind: entity.kind,
    ref: entity.ref,
    entityId: entity.entityId,
    facts: entity.facts.map(factFingerprintInput),
    missingRequired: entity.missingRequired,
  };
}

/**
 * A fact's contribution: its identity, meaning, value and disposition.
 *
 * `truthFingerprint` is included when the owner supplied one and the raw `value`
 * is included regardless. Both, rather than either: a fingerprint alone would
 * make two owners' unrelated facts collide if they ever chose the same hash
 * scheme, and a value alone would miss an owner-side change to a field this
 * projection does not carry.
 */
function factFingerprintInput(fact: ImageWorldFact): unknown {
  return {
    key: fact.key,
    concept: fact.concept,
    value: fact.value,
    subjectRef: fact.subjectRef,
    locus: fact.locus,
    tags: [...fact.semanticTags].sort(),
    disposition: fact.disposition,
    priority: fact.priority,
    truth: fact.truthFingerprint,
  };
}

/** Whether one fact survives validation, recording why when it does not. */
function keepFact(fact: ImageWorldFact, seen: Set<string>, issues: ImageWorldDigestIssue[]): boolean {
  if (seen.has(fact.key)) {
    issues.push({ code: "world_digest.duplicate_fact_key", detail: fact.key });
    return false;
  }
  if (imageConcept(fact.concept) === null) {
    issues.push({ code: "world_digest.unknown_concept", detail: `${fact.key}: ${fact.concept}` });
    return false;
  }
  if (!imageDispositionProducesFact(fact.disposition)) {
    // A `restricted` or `nonvisual` field arriving as a fact is a projection bug
    // with a privacy edge, so it is dropped rather than downgraded: the whole
    // point of those dispositions is that the value never reaches a prompt.
    issues.push({ code: "world_digest.nonfact_disposition", detail: `${fact.key}: ${fact.disposition}` });
    return false;
  }
  seen.add(fact.key);
  return true;
}

/**
 * Facts in deterministic order: concept channel, then required before optional,
 * then priority descending, then key.
 *
 * Key last is what makes the order TOTAL — without it two facts identical in
 * every ranked field would sort by whatever order the projection built them in,
 * and a projection that iterated a map would fingerprint differently run to run.
 */
function orderFacts(facts: readonly ImageWorldFact[]): ImageWorldFact[] {
  return [...facts].sort((left, right) => {
    const channelDelta = channelRankOf(left) - channelRankOf(right);
    if (channelDelta !== 0) return channelDelta;
    const requiredDelta = Number(isRequiredImageWorldFact(right)) - Number(isRequiredImageWorldFact(left));
    if (requiredDelta !== 0) return requiredDelta;
    const priorityDelta = right.priority - left.priority;
    if (priorityDelta !== 0) return priorityDelta;
    return left.key.localeCompare(right.key);
  });
}

function channelRankOf(fact: ImageWorldFact): number {
  const definition = imageConcept(fact.concept);
  return definition ? channelRank(definition.channel) : Number.MAX_SAFE_INTEGER;
}

const CHANNEL_RANK: readonly ImageConceptChannel[] = [
  "operation",
  "subject",
  "camera",
  "relation",
  "item",
  "location",
  "style",
  "raw",
];

function channelRank(channel: ImageConceptChannel): number {
  return CHANNEL_RANK.indexOf(channel);
}

function byRef(left: ImageEntityDigest, right: ImageEntityDigest): number {
  return left.ref.localeCompare(right.ref);
}

function byRelation(left: ImageWorldRelation, right: ImageWorldRelation): number {
  return (
    left.kind.localeCompare(right.kind) ||
    left.subjectRef.localeCompare(right.subjectRef) ||
    left.objectRef.localeCompare(right.objectRef)
  );
}

function byReference(left: ImageReferenceFact, right: ImageReferenceFact): number {
  return left.role.localeCompare(right.role) || (left.subjectRef ?? "").localeCompare(right.subjectRef ?? "");
}

function compact<T>(values: readonly (T | null)[]): T[] {
  return values.filter((value): value is T => value !== null);
}

/**
 * Freeze an object graph in place.
 *
 * Recursive rather than a shallow `Object.freeze`, because the property being
 * bought is that a dialect cannot edit a fact's `value` record or push onto a
 * fact list — a shallow freeze leaves both open. Cycles are impossible here (the
 * digest is a tree of plain data), so no visited set is needed; `Object.isFrozen`
 * short-circuits repeat visits to shared literals anyway.
 */
function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const entry of Object.values(value as Record<string, unknown>)) deepFreeze(entry);
  return value;
}

/** Every fact in the digest, in entity then camera-free order — the selector's input. */
export function imageWorldDigestFacts(digest: ImageWorldDigest): readonly ImageWorldFact[] {
  return [
    ...digest.subjects.flatMap((subject) => subject.facts),
    ...digest.items.flatMap((item) => item.facts),
    ...(digest.location?.facts ?? []),
  ];
}

/** Every entity slice, subjects first — the ref-resolution helper compilers use. */
export function imageWorldDigestEntities(digest: ImageWorldDigest): readonly ImageEntityDigest[] {
  return [...digest.subjects, ...digest.items, ...(digest.location ? [digest.location] : [])];
}

/** The entity a ref names, or null. */
export function imageWorldEntity(digest: ImageWorldDigest, ref: string): ImageEntityDigest | null {
  return imageWorldDigestEntities(digest).find((entity) => entity.ref === ref) ?? null;
}
