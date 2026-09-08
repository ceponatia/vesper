import type {
  ImageCameraFact,
  ImageChangeContract,
  ImageConceptId,
  ImageItemDigest,
  ImageLocationDigest,
  ImageOperationContract,
  ImageProfileOperation,
  ImageReferenceFact,
  ImageSourceRevision,
  ImageStyleIntent,
  ImageStyleMedium,
  ImageSubjectDigest,
  ImageWorldDigestInput,
  ImageWorldFact,
  ImageWorldRead,
  ImageWorldRelation,
} from "@vesper/image-core";
import { AFFORDANCE_UNIT_ONE } from "../affordances/core/fixed-point";
import {
  projectCharacterWorldSlices,
  type CharacterApparentAgePolicy,
  type CharacterSubjectSources,
} from "./character-adapter";
import { entityReadToken } from "./entity-digest";
import { projectCameraFacts, standaloneCharacterSourceRevision } from "./subject-digest";
import type { VisualImageDigest } from "./visual-digest";

/**
 * Character-lane world-digest glue: the tranche-1 operation contracts and the
 * one assembly that turns a committed visual digest plus its canonical owners
 * into a ready `ImageWorldDigestInput`.
 *
 * This is the character analogue of `entity-digest.ts`'s
 * `itemImageOperation`/`locationImageOperation` half, and it deliberately owns
 * NOTHING the adapter stack already owns. Visual state selects the facts, the
 * character image adapter (`projectCharacterWorldSlices`) joins the canonical
 * owners' semantic values onto that selection, and this module only arranges the
 * finished slices around the operation, the camera, the read token and the
 * references — the four inputs `buildImageWorldDigest` still needs and no lower
 * layer can supply. It re-decides no value, re-ranks no fact, and drops no loss
 * record: the adapter's suppressions and `missingRequired` flow through intact,
 * which is what lets a lane compiled with `refuseOnMissingRequired` refuse
 * before provider spend rather than render an unjoined subject.
 *
 * **Reached through one seam.** `character-prompt-program.ts` is the single
 * caller that turns a lane's realized cut into a compiled program, for the
 * shadow that measures a cutover and the production render that performs one
 * alike. A character-bearing lane keeps its legacy prompt path until its own
 * binding is promoted from candidate to active.
 *
 * Pure by construction: everything arrives as plain values. The server lane that
 * reads the owners in one transaction owns the read and supplies the revisions.
 */

// ---------------------------------------------------------------------------
// Operation contracts — the tranche-1 lanes
// ---------------------------------------------------------------------------

/**
 * The style a character lane deliberately renders in.
 *
 * Defaults are the honest minimum — a photographic medium and NO descriptors —
 * because the spec authors no character style wording: descriptors are the
 * lane's own choice at cutover (an avatar's `realistic`/`anime` toggle, a
 * scene's atmosphere), and a curated list here would be prose the projection
 * invented. The bound positive pack contributes its rendering intent exactly
 * when the operation states none, so an empty list is a decision the pack layer
 * already knows how to answer.
 */
export interface CharacterStyleInput {
  readonly medium?: ImageStyleMedium;
  readonly descriptors?: readonly string[];
}

function characterStyleIntent(style: CharacterStyleInput | undefined): ImageStyleIntent {
  return { medium: style?.medium ?? "photographic", descriptors: style?.descriptors ?? [] };
}

/**
 * The job a standalone character portrait is: one person, described from text.
 *
 * `subjectCount: 1` is a claim, not bookkeeping — it is what arms the
 * single-subject integrity block and tells every anatomy guard there is exactly
 * one body to defend.
 */
export function characterPortraitImageOperation(
  input: { readonly style?: CharacterStyleInput } = {},
): ImageOperationContract {
  return {
    kind: "generate",
    task: "portrait",
    strategy: "text_to_image_description",
    subjectCount: 1,
    style: characterStyleIntent(input.style),
    literalText: [],
  };
}

/**
 * The job a portrait variant is: one explicit change to a referenced identity,
 * with everything the change did not name preserved by derivation
 * ({@link characterChangeContract}), never by "preserve everything".
 */
export function characterVariantImageOperation(
  input: { readonly change?: ImageChangeContract; readonly style?: CharacterStyleInput } = {},
): ImageOperationContract {
  return {
    kind: "edit",
    task: "variant",
    strategy: "instruction_edit",
    subjectCount: 1,
    style: characterStyleIntent(input.style),
    literalText: [],
    ...(input.change === undefined ? {} : { change: input.change }),
  };
}

/**
 * The chat-look mint: the same one-change edit shape as a variant, on the lane
 * whose requested change is the outfit the conversation just settled on.
 */
export function characterChatLookImageOperation(
  input: { readonly change?: ImageChangeContract; readonly style?: CharacterStyleInput } = {},
): ImageOperationContract {
  return {
    kind: "edit",
    task: "chat_look",
    strategy: "instruction_edit",
    subjectCount: 1,
    style: characterStyleIntent(input.style),
    literalText: [],
    ...(input.change === undefined ? {} : { change: input.change }),
  };
}

/**
 * A chat scene render. `subjectCount` is the cast size the render asserts —
 * separate from however many subject slices the digest carries, exactly as the
 * entity lanes' `subjectCount: 0` asserts "no people" rather than implying it.
 *
 * `kind` defaults to the bound scene profile's shape (`edit` over an identity
 * reference); the text-to-image degradation rung passes `"generate"`, which
 * swaps the strategy with it — the two travel together because a binding pins
 * one strategy and a mismatched pair would compile a program no binding matches.
 */
export function characterSceneImageOperation(input: {
  readonly subjectCount: number;
  readonly kind?: ImageProfileOperation;
  readonly change?: ImageChangeContract;
  readonly style?: CharacterStyleInput;
}): ImageOperationContract {
  const kind = input.kind ?? "edit";
  return {
    kind,
    task: "scene",
    strategy: kind === "edit" ? "instruction_edit" : "text_to_image_description",
    subjectCount: input.subjectCount,
    style: characterStyleIntent(input.style),
    literalText: [],
    ...(input.change === undefined ? {} : { change: input.change }),
  };
}

// ---------------------------------------------------------------------------
// The change contract — a derived preserve set, never "preserve everything"
// ---------------------------------------------------------------------------

/** The one requested change, before the preserve set is derived. */
export interface CharacterChangeInput {
  /** The concept the change replaces — `subject.wardrobe` for an outfit swap. */
  readonly concept: ImageConceptId;
  /** The change as the dialect will phrase it — the instruction's semantic value. */
  readonly value: unknown;
  /** The facts that REPLACE current truth, when the lane states them as facts. */
  readonly replacements?: readonly ImageWorldFact[];
  /** Defaults to `locked`: an identity edit may not re-crop or move the camera. */
  readonly geometry?: ImageChangeContract["geometry"];
}

/**
 * Derive one lane's change contract over the assembled subject slices.
 *
 * The preserve set is every REQUIRED anchor the change does not touch: facts of
 * the changed concept and the replacement keys are excluded, optional detail is
 * excluded (it was always droppable and pinning it would fight the edit), and
 * everything else — identity, morphology, the age anchor — must survive. This
 * is the spec's instruction-edit ruling made structural: "preserve everything"
 * is the wording the research blames for Qwen's squashed-figure geometry
 * failure, so the set is derived and finite rather than a blanket.
 *
 * Whether a `subject.wardrobe` change must also drop the CURRENT
 * `subject.exposure` claims from the preserve set (they describe the outfit
 * being replaced) is an open Round 2 question — this derivation excludes only
 * the changed concept, and the lane that first binds an outfit edit settles it.
 */
export function characterChangeContract(
  input: CharacterChangeInput,
  subjects: readonly ImageSubjectDigest[],
): ImageChangeContract {
  const replacements = input.replacements ?? [];
  const replaced = new Set(replacements.map((fact) => fact.key));
  const preserve = subjects
    .flatMap((subject) => subject.facts)
    .filter(
      (fact) =>
        fact.disposition === "required_visual" && fact.concept !== input.concept && !replaced.has(fact.key),
    )
    .map((fact) => fact.key)
    .sort();
  return {
    concept: input.concept,
    value: input.value,
    replacements,
    preserve,
    geometry: input.geometry ?? "locked",
  };
}

// ---------------------------------------------------------------------------
// The assembly
// ---------------------------------------------------------------------------

/** One character row's contribution to a standalone read token. */
export interface CharacterRevisionInput {
  readonly characterId: string;
  /** The row's own revision — `characters.updatedAt` as an ISO string. */
  readonly revision: string;
}

/**
 * Where this render's read token comes from.
 *
 * A chat/scene render names its COMMITTED CUT: the caller supplies the cut
 * token and the assembly never mints one, because the cut id is the staleness
 * check's whole meaning. A standalone render (avatar, library portrait) has no
 * cut, so the token is minted from the character rows plus every other owner
 * read in the same transaction — the same `entityReadToken` hash the
 * item/location lanes and `standaloneCharacterReadToken` already mint, so a
 * lane's token does not move at cutover.
 */
export type CharacterWorldReadInput =
  | { readonly kind: "committed_cut"; readonly token: string }
  | {
      readonly kind: "standalone_character";
      readonly characters: readonly CharacterRevisionInput[];
      /** Wardrobe rows, the identity pack — every other owner the read touched. */
      readonly extraRevisions?: readonly ImageSourceRevision[];
    };

/**
 * What a LANE states about the camera, layered over the committed cut's own
 * viewing context.
 *
 * The context answers where the frame is from the visibility model's reads —
 * distance, angle, framing, motion, light. Two things it cannot answer, and both
 * are here rather than in that model:
 *
 * - **A component the render deliberately asserts nothing about.** Silence is an
 *   instruction: a scene whose camera never moved must not carry a framing
 *   sentence the fiction never asked for, and the only layer that knows a
 *   component is at its default is the one that resolved the shot.
 * - **A fact the visibility model has no read for.** Camera height is the case:
 *   how high the lens sits changes nothing about what an observer can make out,
 *   so weighting it would mean inventing detail tables for a fact that is not a
 *   visibility fact — and it would move `visualImageCameraFingerprint` for every
 *   lane at once.
 *
 * A lane fact WINS over the context's fact for the same component: the lane
 * resolved the camera and the context derived its reads from that resolution.
 */
export interface CharacterCameraAssemblyInput {
  readonly facts?: readonly ImageCameraFact[];
  readonly silent?: readonly ImageCameraFact["component"][];
}

export interface CharacterWorldDigestAssemblyInput {
  readonly digest: VisualImageDigest;
  /** Display names by subject id — the one field a compiled sentence may name somebody by. */
  readonly labels?: Readonly<Record<string, string>>;
  /** Canonical owners by subject id. A subject with no entry fails its anchors closed. */
  readonly sources: Readonly<Record<string, CharacterSubjectSources>>;
  /**
   * The lane's apparent-age policy, handed to the projection untouched: `omit`
   * states no subject's age (a scene inherits it from the references), absent
   * or `state` anchors it from the sheet ({@link CharacterApparentAgePolicy}).
   */
  readonly apparentAge?: CharacterApparentAgePolicy;
  readonly operation: ImageOperationContract;
  readonly read: CharacterWorldReadInput;
  readonly location?: ImageLocationDigest | null;
  readonly items?: readonly ImageItemDigest[];
  readonly relations?: readonly ImageWorldRelation[];
  /**
   * Facts about the SHOT rather than about the committed cut — the mood, whose
   * eyes it is through, the staged arrangement, what each person is doing.
   *
   * Passed through untouched: a scene is planned above this layer and this
   * assembly re-decides no value it is handed.
   */
  readonly scene?: readonly ImageWorldFact[];
  /** The lane's own camera statement — see {@link CharacterCameraAssemblyInput}. */
  readonly camera?: CharacterCameraAssemblyInput;
  /** Passed through untouched — reference planning stays the lane's own job. */
  readonly references?: readonly ImageReferenceFact[];
  /**
   * Facts a ROUTE states about a subject beyond its committed cut, by subject
   * id — today the intimate reveal a permitting scene rung carries
   * (`subject-reveal.ts`). Appended to that subject's projected facts untouched:
   * the route decided them, and this assembly re-decides no value it is handed.
   */
  readonly subjectFacts?: Readonly<Record<string, readonly ImageWorldFact[]>>;
  /** Revisions recorded beside a committed cut, or added to a standalone token. */
  readonly sourceRevisions?: readonly ImageSourceRevision[];
}

/** The assembled input plus the one aggregate a lane refuses on. */
export interface CharacterWorldDigestAssembly {
  /** Ready for `buildImageWorldDigest` — nothing left to derive. */
  readonly input: ImageWorldDigestInput;
  /**
   * Every subject's missing mandatory keys, deduplicated and sorted. Non-empty
   * means degradation reached a required anchor; an identity-critical lane
   * refuses on it before provider spend, a tolerant lane proceeds knowingly.
   */
  readonly missingRequired: readonly string[];
}

/**
 * The context's camera facts, with the lane's silence and its own facts applied.
 *
 * Order is the whole of it: silence first, then the lane's facts, so a lane can
 * state a component it also silenced from the context without the two fighting.
 * A component named in neither list passes through exactly as the committed cut
 * asserted it.
 */
function layeredCameraFacts(
  context: readonly ImageCameraFact[],
  lane: CharacterCameraAssemblyInput | undefined,
): readonly ImageCameraFact[] {
  if (lane === undefined) return context;
  const silent = new Set<string>(lane.silent ?? []);
  const stated = new Set<string>((lane.facts ?? []).map((fact) => fact.component));
  return [
    ...context.filter((fact) => !silent.has(fact.component) && !stated.has(fact.component)),
    ...(lane.facts ?? []),
  ];
}

function characterWorldRead(input: CharacterWorldDigestAssemblyInput): {
  read: ImageWorldRead;
  sourceRevisions: readonly ImageSourceRevision[];
  camera: readonly ImageCameraFact[];
} {
  const camera = layeredCameraFacts(projectCameraFacts(input.digest), input.camera);
  if (input.read.kind === "committed_cut") {
    return {
      read: { kind: "committed_cut", token: input.read.token, atMinutes: input.digest.atMinutes },
      sourceRevisions: input.sourceRevisions ?? [],
      camera,
    };
  }
  const revisions = [
    ...input.read.characters.map((character) =>
      standaloneCharacterSourceRevision(character.characterId, character.revision),
    ),
    ...(input.read.extraRevisions ?? []),
    ...(input.sourceRevisions ?? []),
  ];
  return {
    read: {
      kind: "transactional_projection",
      token: entityReadToken(revisions),
      atMinutes: input.digest.atMinutes,
    },
    sourceRevisions: revisions,
    camera,
  };
}

/**
 * One committed visual digest, joined to its canonical owners and arranged as a
 * complete `ImageWorldDigestInput`.
 *
 * Fail-closed is preserved rather than re-implemented: the adapter's
 * suppressions become the digest's suppressions, each subject's
 * `missingRequired` rides its slice into `buildImageWorldDigest` untouched, and
 * the aggregate is ALSO returned flat so a lane can refuse without walking the
 * slices. Deterministic over its inputs — two assemblies of the same values
 * build byte-equal digests with the same fingerprint, which is what makes
 * "retry this exact composition" answerable for character renders exactly as it
 * is for items and locations.
 */
/** The concept a reference-anchored subject's identity fact carries. */
export const CHARACTER_IDENTITY_ANCHOR_CONCEPT: ImageConceptId = "subject.identity";

/** The projection owner of the identity anchor — this module, not a world owner. */
export const CHARACTER_IDENTITY_ANCHOR_OWNER = "image.character.identity_anchor";

/** The anchor's fact-key suffix, and the canonical name its shadow ledger row reduces to. */
export const CHARACTER_IDENTITY_ANCHOR_MEMBER = "identity_anchor";

/**
 * The emission-ledger key a legacy builder records when it ships its own
 * identity-lock sentence.
 *
 * The ledger is evidence of what a builder actually EMITTED, and the shadow
 * compares it against the compiled program's kept claims under one canonical
 * name. A lane that ships an identity lock but ledgers nothing for it makes the
 * compiled side's anchor look like a leak — a divergence reported against a
 * prompt that states the very thing — so the row is recorded wherever the
 * sentence is. Spelled `<subjectId>/<member>` so `shadowFactName` reduces it to
 * the same name `subject.<subjectId>.<member>` reduces to.
 */
export function characterIdentityAnchorLedgerKey(subjectId: string): string {
  return `${subjectId}/${CHARACTER_IDENTITY_ANCHOR_MEMBER}`;
}

/**
 * The identity anchor a subject carries when this render is built FROM a
 * reference image of them.
 *
 * An edit lane's digest deliberately states no identity descriptors — the
 * reference image shows the face, and describing it back would invite the model
 * to repaint what it should be copying. But "say nothing about the face" and
 * "let the face change" are opposite instructions, and without a claim in this
 * concept a compiled program has no identity protection at all: the endpoint
 * dialects emit their identity lock FROM `subject.identity`, so a digest that
 * never states it produces a prompt that never locks anything.
 *
 * The legacy builders solved this with a route-owned sentence carrying one
 * endpoint's lock wording. That is the right answer for a legacy string and the
 * wrong one for a world digest: the digest states what is TRUE — this subject is
 * the person in reference image N — and each dialect decides how its endpoint
 * says so. The value here is a model-neutral descriptor for exactly that reason;
 * the byte-exact lock wording lives in the dialect that owns the endpoint.
 *
 * Required, so no budget squeeze can drop a person's likeness, and synthesized
 * only for a subject some REQUIRED identity reference actually names — an
 * anchor without an anchor point would be a claim the payload cannot support.
 * A subject whose projection already states identity keeps its own facts and
 * gains nothing here, so a describe-the-face lane cannot end up locking twice.
 */
function identityAnchoredSubjects(
  subjects: readonly ImageSubjectDigest[],
  references: readonly ImageReferenceFact[],
): readonly ImageSubjectDigest[] {
  const anchored = new Set(
    references
      .filter((reference) => reference.role === "identity" && reference.required && reference.subjectRef !== undefined)
      .map((reference) => reference.subjectRef),
  );
  if (anchored.size === 0) return subjects;
  return subjects.map((subject) => {
    if (!anchored.has(subject.ref)) return subject;
    if (subject.facts.some((fact) => fact.concept === CHARACTER_IDENTITY_ANCHOR_CONCEPT)) return subject;
    const anchor: ImageWorldFact = {
      key: `${subject.ref}.${CHARACTER_IDENTITY_ANCHOR_MEMBER}`,
      concept: CHARACTER_IDENTITY_ANCHOR_CONCEPT,
      value: "the same person shown in the reference image",
      subjectRef: subject.ref,
      semanticTags: ["identity.reference_anchor"],
      disposition: "required_visual",
      priority: AFFORDANCE_UNIT_ONE,
      source: {
        owner: CHARACTER_IDENTITY_ANCHOR_OWNER,
        key: CHARACTER_IDENTITY_ANCHOR_MEMBER,
        entityId: subject.entityId,
      },
      truthFingerprint: "identity:reference_anchor",
    };
    return { ...subject, facts: [anchor, ...subject.facts] };
  });
}

function requiredIdentityReferenceSubjects(
  references: readonly ImageReferenceFact[],
): ReadonlySet<string> {
  return new Set(
    references
      .filter((reference) => reference.role === "identity" && reference.required && reference.subjectRef !== undefined)
      .map((reference) => reference.subjectRef as string),
  );
}

export function assembleCharacterWorldDigest(
  input: CharacterWorldDigestAssemblyInput,
): CharacterWorldDigestAssembly {
  const references = input.references ?? [];
  const slices = projectCharacterWorldSlices({
    digest: input.digest,
    ...(input.labels === undefined ? {} : { labels: input.labels }),
    sources: input.sources,
    ...(input.apparentAge === undefined ? {} : { apparentAge: input.apparentAge }),
    identityReferenceSubjects: requiredIdentityReferenceSubjects(references),
  });
  const { read, sourceRevisions, camera } = characterWorldRead(input);
  const routeFacts = input.subjectFacts ?? {};
  const subjects = slices.subjects.map((subject) => {
    const extra = routeFacts[subject.entityId] ?? [];
    if (extra.length === 0) return subject;
    // An intimate route may restate the one ordinary-safe silhouette attribute
    // (`breasts.size`) through subject-reveal. Let that route-owned typed fact
    // replace the ordinary appearance spelling so the compiler receives the
    // value exactly once; ordinary routes retain the appearance fact.
    const routeAttributeIds = new Set(
      extra.filter((fact) => fact.concept === "subject.intimate_anatomy").map((fact) => fact.source.key),
    );
    const baseFacts = subject.facts.filter(
      (fact) => !(fact.concept === "subject.appearance" && routeAttributeIds.has(fact.source.key)),
    );
    const known = new Set(baseFacts.map((fact) => fact.key));
    return { ...subject, facts: [...baseFacts, ...extra.filter((fact) => !known.has(fact.key))] };
  });
  const digestInput: ImageWorldDigestInput = {
    read,
    ...(input.scene === undefined ? {} : { scene: input.scene }),
    subjects: identityAnchoredSubjects(subjects, references),
    ...(input.location === undefined ? {} : { location: input.location }),
    ...(input.items === undefined ? {} : { items: input.items }),
    ...(input.relations === undefined ? {} : { relations: input.relations }),
    camera,
    operation: input.operation,
    ...(input.references === undefined ? {} : { references: input.references }),
    suppressions: slices.suppressions,
    sourceRevisions,
  };
  const missingRequired = [...new Set(slices.subjects.flatMap((subject) => subject.missingRequired))].sort();
  return { input: digestInput, missingRequired };
}
