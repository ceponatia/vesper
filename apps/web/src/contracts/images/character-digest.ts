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
import { projectCharacterWorldSlices, type CharacterSubjectSources } from "./character-adapter";
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

export interface CharacterWorldDigestAssemblyInput {
  readonly digest: VisualImageDigest;
  /** Display names by subject id — the one field a compiled sentence may name somebody by. */
  readonly labels?: Readonly<Record<string, string>>;
  /** Canonical owners by subject id. A subject with no entry fails its anchors closed. */
  readonly sources: Readonly<Record<string, CharacterSubjectSources>>;
  readonly operation: ImageOperationContract;
  readonly read: CharacterWorldReadInput;
  readonly location?: ImageLocationDigest | null;
  readonly items?: readonly ImageItemDigest[];
  readonly relations?: readonly ImageWorldRelation[];
  /** Passed through untouched — reference planning stays the lane's own job. */
  readonly references?: readonly ImageReferenceFact[];
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

function characterWorldRead(input: CharacterWorldDigestAssemblyInput): {
  read: ImageWorldRead;
  sourceRevisions: readonly ImageSourceRevision[];
  camera: readonly ImageCameraFact[];
} {
  const camera = projectCameraFacts(input.digest);
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
export function assembleCharacterWorldDigest(
  input: CharacterWorldDigestAssemblyInput,
): CharacterWorldDigestAssembly {
  const slices = projectCharacterWorldSlices({
    digest: input.digest,
    ...(input.labels === undefined ? {} : { labels: input.labels }),
    sources: input.sources,
  });
  const { read, sourceRevisions, camera } = characterWorldRead(input);
  const digestInput: ImageWorldDigestInput = {
    read,
    subjects: slices.subjects,
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
