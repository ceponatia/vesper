import {
  activeImagePromptBinding,
  baseImageModelSlug,
  buildImageWorldDigest,
  compileImagePromptProgram,
  imageNegativePack,
  imagePositivePack,
  imagePromptBudgetFromBinding,
  imagePromptDialectForBinding,
  planIntentReferences,
  IMAGE_PROMPT_PROGRAM_META_KEY,
  IMAGE_WORLD_STATE_META_KEY,
  type ImageConceptId,
  type ImageDialectReference,
  type ImageOperationContract,
  type ImagePromptProfileBinding,
  type ImagePromptRegister,
  type ImagePromptStrategy,
  type ImageLocationDigest,
  type ImageReferenceFact,
  type ImageRenderReference,
  type ImageSubjectDigest,
  type ImageWorldFact,
  type ResolvedImageProfile,
} from "@vesper/image-core";
import type { AttributeValue, HairOcclusion, RealizedBody, RegionExposure, VisualImageDigest } from "@/contracts";
import {
  mergeVisualImageCastDigests,
  type VisualImageCastMergeRefusal,
} from "@/contracts/images/visual-digest";
import type { CharacterApparentAgePolicy, CharacterSubjectSources } from "@/contracts/images/character-adapter";
import { subjectIntimateRevealFacts } from "@/contracts/images/subject-reveal";
import { diag, type DiagnosticSink } from "@/contracts/diagnostics";
import {
  assembleCharacterWorldDigest,
  characterChangeContract,
  characterPortraitImageOperation,
  characterVariantImageOperation,
  type CharacterCameraAssemblyInput,
  type CharacterWorldDigestAssemblyInput,
  type CharacterWorldReadInput,
} from "@/contracts/images/character-digest";
import type { PortraitVariantKind } from "@/contracts/images/portrait-variant";
// The character pack seeds register their packs and bindings at import time, and
// this module is the one place a character lane resolves a binding — so the
// registration import belongs here rather than being duplicated at every
// caller. A module that imported this one alone and skipped the seeds would
// silently resolve `unbound` for every lane. All three files together are the
// whole character surface: the two Qwen endpoints, and every other model the
// profile picker offers (#256).
import "./packs-character-endpoints";
import "./packs-qwen-2511";
import "./packs-qwen-2512-portrait";

/**
 * THE CHARACTER PROMPT-PROGRAM SEAM (issue #256) — the one path that turns a
 * lane's realized visual cut into a compiled prompt program. It is the ONLY
 * prompt path a character lane has (#251): the avatar, the portrait variant,
 * the chat-look mint and every scene rung compile here or refuse before
 * provider spend, and nothing anywhere phrases a character from prose.
 *
 * The assembly, the operation contract, the binding, the packs, the reference
 * planning, the budget and the compile all live here exactly once, so the four
 * lanes cannot drift apart in what a "compiled character prompt" means. What
 * differs per lane is stated by the lane as input — its cut, its operation,
 * its references, its camera — and what a lane does with each of the three
 * answers is the lane's own law:
 *
 * | answer | what it means | what a lane does |
 * |---|---|---|
 * | `compiled` | a program for this render | sends exactly its prompt and references |
 * | `refused` | a configuration or compile fault on a lane that IS bound | fails the row BEFORE provider spend, or (chat look) mints nothing |
 * | `unbound` | no `active` row for this (model, task, profile key) | fails the row naming the three coordinates, or (scene) drops the rung |
 *
 * `unbound` is deliberately a THIRD result rather than a refusal. It is the
 * honest "no row for this (model, task, profile key)", and it stays a real
 * answer even now that every character profile the picker offers is bound
 * (#256): a lane whose profile key gains a row later, an operator-added
 * model with no dialect, and `chat_place` — the one identity-free chat lane,
 * deliberately unbound — all land here. It never degrades to a different
 * prompt: the binding table is where a lane's words are authorized, so an
 * endpoint missing from it is an endpoint the lane may not speak for
 * ({@link characterPromptUnboundRefusal} names the row an operator has to
 * add). A refusal, by contrast, is a real configuration or compile fault on a
 * lane that IS bound, and rendering something else there would hide it behind
 * acceptable-looking images.
 *
 * ## Reference planning belongs here
 *
 * A dialect describes the references it is told about — the Qwen family numbers
 * them (`Image 1: …`), the prose family names them by role — and every dialect
 * picks its single- versus multi-reference identity lock by reference COUNT.
 * All of that must describe the payload, and the payload is
 * `planIntentReferences`'s output, not the lane's own list: planning drops roles
 * the profile disallows, binds control roles to their own provider fields, and
 * reorders required references ahead of optional ones. A program numbered from
 * the caller's list is exactly the state `PlannedImageReferences.renumbered`
 * exists to flag — the prompt calling the room "image two" while the payload
 * sends the person there. So this module plans first, compiles against the
 * result, REFUSES a numbering dialect whose plan renumbered
 * ({@link IMAGE_CHARACTER_PROMPT_REFERENCES_RENUMBERED}), and hands back the
 * planned list so the caller sends the same one it just described.
 */

/** The binding table's task for a character lane — the profile-task vocabulary. */
export type CharacterPromptTask = "portrait" | "variant" | "chat_look" | "scene";

/** The lane label a diagnostic and a reference fact's source key carry. */
export type CharacterPromptLane = "avatar" | "variant" | "chat_look" | "scene";

/**
 * Whether each lane's compiled prompt states its subjects' apparent age — the
 * one place that policy is decided, keyed by lane so no caller can set it.
 *
 * The standalone and reference-edit lanes state it: a portrait has nothing
 * else to take the age from, and on an edit the text anchor is deliberately
 * authoritative beside the reference (docs/images/pipelines/avatars.md
 * §Apparent age). A scene states none: its cast inherit their visible age
 * from their identity references, so the adapter withholds every subject's
 * anchor as a designed suppression on every rung, and the age is never a
 * missing anchor a `refuseOnMissingRequired` rung would refuse on.
 */
export const CHARACTER_LANE_APPARENT_AGE: Readonly<Record<CharacterPromptLane, CharacterApparentAgePolicy>> = {
  avatar: "state",
  variant: "state",
  chat_look: "state",
  scene: "omit",
};

/**
 * How a lane's compiled prompt REFERS to a subject the payload also carries a
 * required identity reference for.
 *
 * - `label` — the person's display name is offered to the dialect, which uses
 *   it wherever a sentence names somebody.
 * - `reference_binding` — no name is offered at all, and the dialect introduces
 *   the subject by the image that shows them.
 */
export type CharacterPromptSubjectNaming = "label" | "reference_binding";

/**
 * The naming policy per lane — the second thing this table settles once and no
 * caller may set, beside {@link CHARACTER_LANE_APPARENT_AGE}.
 *
 * Every lane but the scene names its subject. A portrait, a variant and a look
 * mint are renders OF a person the prompt has to be able to talk about, and on
 * an edit the name beside the reference costs nothing: those lanes send one
 * face and the prompt's sentences are all about it.
 *
 * A scene states none (issue #544 F2). Its cast arrive bound to identity
 * references, and on the fictional-celebrity workflow the display name is a real
 * person's name standing beside a photograph of somebody else — a competing
 * identity cue in the same prompt as the reference it contradicts, repeated once
 * per claim. So the reference-anchored subjects of a scene are introduced by
 * their image instead, which is what the payload actually supports; the dialect
 * owns that wording.
 *
 * The policy applies ONLY to a subject some required identity reference in the
 * planned send list actually shows — the same predicate the digest's own
 * identity anchor is synthesized under (`identityAnchoredSubjects`,
 * `contracts/images/character-digest.ts`). A cast member with no reference of
 * their own — the single-reference rung's bystander, the bare-prompt rung's
 * whole cast — has no image to be introduced by, so they keep their name and the
 * prompt can still tell them apart.
 */
export const CHARACTER_LANE_SUBJECT_NAMING: Readonly<Record<CharacterPromptLane, CharacterPromptSubjectNaming>> = {
  avatar: "label",
  variant: "label",
  chat_look: "label",
  scene: "reference_binding",
};

/**
 * One subject's realized cut, in the vocabulary every lane already exposes
 * (`StandaloneSubjectCut`, `ChatLookCut`, `SceneSubjectVisualSlice`).
 */
export interface CharacterPromptSubjectCut {
  readonly subjectId: string;
  readonly name?: string;
  readonly digest: VisualImageDigest;
  readonly attributes: readonly AttributeValue[];
  readonly exposure: RegionExposure;
  /**
   * How much of the subject's hair their worn headwear hides — resolved once at
   * the lane's wardrobe seam (docs/contracts/items/README.md §Hair occlusion)
   * and carried beside `exposure`, never re-derived from garment names.
   */
  readonly hairOcclusion: HairOcclusion;
  readonly realizedBody: RealizedBody;
}

/**
 * One reference the lane intends to send, and — for an identity image — WHO it
 * shows.
 *
 * The subject is carried beside the reference rather than inside it because
 * `ImageRenderReference` is the package's transport shape and knows nothing
 * about Vesper's cast. It is what lets a two-person scene bind each face to its
 * own person: without it the digest could only anchor every identity image to
 * one subject, which on an ensemble render is the claim that both photographs
 * show the same woman.
 */
export interface CharacterPromptReference {
  readonly reference: ImageRenderReference;
  /** The cast member this image depicts. Required in practice for `identity`. */
  readonly subjectId?: string;
  /**
   * A short clause qualifying what this image IS, woven into the sentence that
   * introduces its slot — "seen from behind, the same person".
   *
   * Beside `subjectId` rather than inside it because the two answer different
   * questions, and only the second one has an answer when a lane sends TWO
   * images of one person: `subjectId` says both show Mira, and this says why the
   * second one exists. A reference-view send is that case
   * (`contracts/images/reference-views.ts` owns the clauses); every other lane
   * leaves it unset and compiles byte-identically.
   */
  readonly description?: string;
}

export interface CharacterPromptProgramInput {
  readonly lane: CharacterPromptLane;
  readonly task: CharacterPromptTask;
  /**
   * The lane's FINAL resolved profile — after any model pairing. The variant
   * lane's `nsfw_test` kind and the chat scene lane's intimate route both pair
   * the picked profile with the model that loads the anatomy LoRA, and resolving
   * a binding from the pre-pairing profile would bind a program to a model the
   * render will not run on.
   */
  readonly profile: ResolvedImageProfile;
  /**
   * Narrow resolution to the binding rows registered for one profile key.
   * Supplied, a key no row carries resolves null rather than falling back to a
   * sibling profile's row.
   */
  readonly bindingProfileKey?: string;
  /**
   * Narrow resolution to the row registered for one JOB SHAPE.
   *
   * The scene lane needs it and nothing else does: its degradation chain asks
   * one profile for a multi-reference edit, then a single-reference edit, then a
   * bare text-to-image render, and the third states a different strategy. A
   * binding pins one strategy and the compile refuses a mismatched pair, so each
   * shape resolves its own row. It must agree with the strategy
   * {@link CharacterPromptProgramInput.operation} states, or the compile refuses
   * on exactly that disagreement.
   */
  readonly bindingStrategy?: ImagePromptStrategy;
  /**
   * Every person this render draws, in cast order — one entry for a portrait,
   * variant or look mint, N for an ensemble scene (#256).
   *
   * A LIST rather than a single cut because visual state commits one cut per
   * PERSON: the scene lane realizes each cast member from their own snapshot
   * under the shared camera, and folding them into the one multi-subject digest
   * the assembly takes is this module's job
   * ({@link mergeVisualImageCastDigests}). Empty refuses — a character program
   * with no character is not a degraded render, it is a bug upstream.
   */
  readonly cuts: readonly CharacterPromptSubjectCut[];
  /**
   * What this render says about the SHOT — the mood, whose eyes it is through,
   * the staged arrangement, what each person is doing.
   *
   * The scene lane lowers them from its resolved plan; every other lane states
   * none, and an absent list leaves the program byte-identical to what it
   * compiled before the field existed.
   */
  readonly scene?: readonly ImageWorldFact[];
  /** The place this render is set in, when the lane has one to state. */
  readonly location?: ImageLocationDigest | null;
  /** The lane's own camera statement, layered over the committed cut's viewing reads. */
  readonly camera?: CharacterCameraAssemblyInput;
  /**
   * Whether this render's ROUTE permits intimate anatomy.
   *
   * The committed cut never carries it — the visual-state selection keeps its
   * consent gate shut in every lane — so a permitting route projects each cut's
   * exposed intimate anatomy as typed `subject.intimate_anatomy` facts beside
   * the digest (`contracts/images/subject-reveal.ts`), from the same resolved
   * attributes and coverage readout the cut was selected over. Absent or false
   * projects nothing: a moderated rung, and every lane that does not decide
   * this per render, compiles the cut alone.
   */
  readonly intimateReveal?: boolean;
  /**
   * The REGISTER the compiled prompt speaks in — a description of the picture to
   * make, or an instruction to carry out (#549).
   *
   * Absent is the ordinary case and the honest one: which register an endpoint
   * reads best is the dialect's knowledge rather than a lane's, and every
   * production lane leaves this alone so its prompts move with the dialect's
   * own default. A caller states it only when it is deliberately compiling the
   * other spelling — the Image Lab's fixed A/B, where the two registers of one
   * digest are the same picture asked for twice and the difference in the
   * output is attributable to the words.
   */
  readonly register?: ImagePromptRegister;
  readonly read: CharacterWorldReadInput;
  /**
   * The references the lane would hand `renderImageIntent`, in the lane's own
   * order. This module plans them and compiles against the plan.
   */
  readonly references: readonly CharacterPromptReference[];
  /**
   * Built over the ASSEMBLED subject slices, so a change contract can derive
   * its preserve set from the real facts rather than from a guess.
   */
  readonly operation: (subjects: readonly ImageSubjectDigest[]) => ImageOperationContract;
  /**
   * A TASK question, not a prompt one: a variant of a specific person is
   * worthless without her identity anchors, so every production lane refuses
   * — while a bench that wants to measure the loss may compile THROUGH it and
   * read `missingRequired` off the result.
   */
  readonly refuseOnMissingRequired: boolean;
  readonly sink?: DiagnosticSink;
}

/** A compiled program, plus what the compile learned on the way. */
export interface CharacterPromptProgram {
  readonly kind: "compiled";
  /** The positive text: what the row stores and what the intent sends. */
  readonly prompt: string;
  /** The compiled exclusions, or null when this endpoint exposes no field for them. */
  readonly negativePrompt: string | null;
  /** `meta.promptProgram` and `meta.worldState`, ready to merge onto the row. */
  readonly meta: Record<string, unknown>;
  readonly binding: ImagePromptProfileBinding;
  /**
   * The references in FINAL send order — primary slots first, then the images
   * bound to their own provider fields. The caller sends exactly this, in this
   * order, or the prompt's slot numbers stop describing the payload.
   */
  readonly sentReferences: readonly ImageRenderReference[];
  /** The primary field's images alone, which are the slots the prompt numbers. */
  readonly numberedReferences: readonly ImageRenderReference[];
  /** The assembly's aggregated missing anchors — empty unless the compile tolerated them. */
  readonly missingRequired: readonly string[];
  /** The assembled subject slices, pre-build: the facts the prompt was compiled from. */
  readonly subjects: readonly ImageSubjectDigest[];
  /** The claims that survived to the prompt, by id. */
  readonly keptClaimIds: readonly string[];
}

/**
 * No binding for this (model, task[, profileKey]). An ORDINARY answer, never an
 * error — but never a prompt either: the lane fails its render naming the row
 * ({@link characterPromptUnboundRefusal}), or drops the rung.
 */
export interface CharacterPromptProgramUnbound {
  readonly kind: "unbound";
  readonly modelSlug: string;
  readonly task: CharacterPromptTask;
  readonly profileKey: string | null;
}

/**
 * The operator-facing text for an unbound lane: the three coordinates a
 * binding row has to be added for. A failed row carries it as its own message,
 * so the studio tile says which endpoint the lane may not speak for.
 */
export function characterPromptUnboundRefusal(unbound: CharacterPromptProgramUnbound): string {
  const profile = unbound.profileKey === null ? "" : `, profile ${unbound.profileKey}`;
  return `no active prompt binding for ${unbound.modelSlug} (task ${unbound.task}${profile})`;
}

/**
 * A configuration gap or a compile refusal on a lane that IS bound. The lane
 * fails its render on it and sends nothing else, because a binding that
 * resolved and then could not compile is a fault to surface rather than to
 * paper over.
 */
export interface CharacterPromptProgramRefusal {
  readonly kind: "refused";
  readonly code: string;
  /** Operator-facing text — the failed row's own message. */
  readonly refusal: string;
  readonly context: Record<string, unknown>;
}

export type CharacterPromptProgramResult =
  | CharacterPromptProgram
  | CharacterPromptProgramUnbound
  | CharacterPromptProgramRefusal;

export function isCharacterPromptCompiled(result: CharacterPromptProgramResult): result is CharacterPromptProgram {
  return result.kind === "compiled";
}

export function isCharacterPromptUnbound(result: CharacterPromptProgramResult): result is CharacterPromptProgramUnbound {
  return result.kind === "unbound";
}

export function isCharacterPromptRefusal(result: CharacterPromptProgramResult): result is CharacterPromptProgramRefusal {
  return result.kind === "refused";
}

/** A bound pack version is not registered — a configuration gap, not a compile fault. */
export const IMAGE_CHARACTER_PROMPT_PACK_MISSING = "image_prompt_program.pack_missing";

/**
 * The slot numbers this prompt asserts would not describe the payload the lane
 * is about to send — refused before provider spend.
 *
 * ## It is a tripwire, not a bug detector
 *
 * Nothing here is currently wrong, and that is the point. This module numbers
 * from `planned.primary` and hands that list back as `sentReferences`. The
 * scene lane sends exactly that list, and the transport's own planning of it is
 * a fixed point — an already-planned list re-plans to itself — so the slot the
 * prompt calls N IS the image the provider receives at N by construction. The
 * other character lanes hand the transport the same list they handed this seam,
 * which the same planner reduces to the same order.
 *
 * `renumbered` is the condition under which a LANE's own order and the order
 * its profile's policy imposes have diverged — the one state in which a reader
 * of the lane's code would expect a different slot from the one the prompt
 * names. No production lane diverges today: every one orders identity first,
 * which is what the policies rank first, and capacity trims from the tail. So
 * this refusal fires only when somebody changes that, and it fires before
 * provider spend instead of after a plausible-looking image of the wrong
 * composition has been saved.
 *
 * Refused rather than warned because the failure it guards is invisible in the
 * output: the render succeeds, and the row's prompt and payload are each
 * internally consistent.
 *
 * Scoped to numbering dialects: the prose family names references by role and
 * the tag family names none at all, so neither can misname a slot it never
 * asserts.
 */
export const IMAGE_CHARACTER_PROMPT_REFERENCES_RENUMBERED = "image_prompt_program.references_renumbered";

const PATH = "images.character_prompt";

/**
 * The identity/location reference FACTS the digest records for the send list.
 *
 * Derived from what is actually SENT — the numbered slots plus the images bound
 * to dedicated provider fields — because an identity anchor planning pushed out
 * is exactly as absent as one the lane never had, and marking it required here
 * would have the compile defend a reference the payload does not carry.
 */
function referenceFacts(
  lane: string,
  subjectOf: (reference: ImageRenderReference) => string | undefined,
  references: readonly ImageRenderReference[],
): ImageReferenceFact[] {
  return references.map((reference, index) => {
    const subjectId = reference.role === "identity" ? subjectOf(reference) : undefined;
    return {
      role: reference.role,
      ...(subjectId === undefined ? {} : { subjectRef: `subject.${subjectId}` }),
      // `required` follows the ROLE, not the binding: an identity image the
      // caller could not attribute is still an identity image, and marking it
      // optional would let the compile drop the one reference the render is of.
      required: reference.role === "identity",
      source: { owner: PATH, key: `${lane}.reference.${index}` },
    };
  });
}

/**
 * The subject refs some REQUIRED identity reference in the send list shows.
 *
 * The identical predicate `identityAnchoredSubjects` synthesizes the digest's
 * own identity anchor under (`contracts/images/character-digest.ts`), applied
 * here over the very facts that function will be handed — so the subject this
 * seam declines to name is exactly the subject the digest binds to an image, and
 * the two cannot answer differently. Spelled out rather than imported because
 * the contracts module keeps it private; the facts are the shared truth.
 */
function referenceAnchoredSubjects(references: readonly ImageReferenceFact[]): ReadonlySet<string> {
  return new Set(
    references.flatMap((reference) =>
      reference.role === "identity" && reference.required && reference.subjectRef !== undefined
        ? [reference.subjectRef]
        : [],
    ),
  );
}

/** The dialect's slots, over the PRIMARY field's images in send order. */
function dialectReferences(
  subjectOf: (reference: ImageRenderReference) => string | undefined,
  describe: (reference: ImageRenderReference) => string | undefined,
  references: readonly ImageRenderReference[],
): ImageDialectReference[] {
  return references.map((reference, index) => {
    const subjectId = reference.role === "identity" ? subjectOf(reference) : undefined;
    const description = describe(reference);
    return {
      position: index + 1,
      role: reference.role,
      ...(subjectId === undefined ? {} : { subjectRef: `subject.${subjectId}` }),
      ...(description === undefined ? {} : { description }),
    };
  });
}

/**
 * The cast's cuts as the assembly's inputs, minus the operation and references.
 *
 * One merged digest, one `sources` entry per person and one label per person
 * who has a name AND whose lane names them. The merge is what turns N committed
 * cuts into the single multi-subject digest `assembleCharacterWorldDigest`
 * takes; everything else here is a keyed fold, so a cast of one produces
 * byte-identically what the single-cut spelling produced before this function
 * took a list.
 *
 * `naming` and `anchored` are the label seam (#544 F2): under
 * `reference_binding` a subject the payload carries a required identity
 * reference for is offered no label, so the dialect introduces them by their
 * image rather than by a name competing with it. Nothing else here changes —
 * `cut.name` is untouched and every diagnostic, refusal and provenance reader
 * downstream still takes the name from the cut.
 */
function castAssembly(
  cuts: readonly CharacterPromptSubjectCut[],
  read: CharacterWorldReadInput,
  world: Pick<CharacterWorldDigestAssemblyInput, "scene" | "location" | "camera">,
  intimateReveal: boolean,
  naming: CharacterPromptSubjectNaming,
  anchored: ReadonlySet<string>,
): Omit<CharacterWorldDigestAssemblyInput, "operation" | "references"> | VisualImageCastMergeRefusal {
  const merged = mergeVisualImageCastDigests(cuts.map((cut) => cut.digest));
  if (!merged.ok) return merged.refusal;
  const labels: Record<string, string> = {};
  const sources: Record<string, CharacterSubjectSources> = {};
  // The route's own facts about each person, beside the cut: the intimate
  // reveal, on a route that permits it. Projected here from the cut's resolved
  // attributes and coverage readout, because this is the one place that has
  // both and the assembly re-decides nothing it is handed.
  const subjectFacts: Record<string, readonly ImageWorldFact[]> = {};
  for (const cut of cuts) {
    const boundToReference = naming === "reference_binding" && anchored.has(`subject.${cut.subjectId}`);
    if (cut.name !== undefined && !boundToReference) labels[cut.subjectId] = cut.name;
    sources[cut.subjectId] = {
      attributes: cut.attributes,
      exposure: cut.exposure,
      hairOcclusion: cut.hairOcclusion,
      realizedBody: cut.realizedBody,
    };
    if (intimateReveal) {
      const reveal = subjectIntimateRevealFacts({
        subjectId: cut.subjectId,
        attributes: cut.attributes,
        exposure: cut.exposure,
        realizedBody: cut.realizedBody,
      });
      if (reveal.length > 0) subjectFacts[cut.subjectId] = reveal;
    }
  }
  return {
    digest: merged.digest,
    ...(Object.keys(labels).length === 0 ? {} : { labels }),
    sources,
    ...(Object.keys(subjectFacts).length === 0 ? {} : { subjectFacts }),
    read,
    // The lane's scene statement rides through untouched. Spread conditionally so
    // a lane that states none assembles exactly the input it did before the
    // scene reached this seam.
    ...(world.scene === undefined ? {} : { scene: world.scene }),
    ...(world.location === undefined ? {} : { location: world.location }),
    ...(world.camera === undefined ? {} : { camera: world.camera }),
  };
}

/**
 * Resolve, assemble, compile — the whole semantic path, once.
 *
 * Throws nothing of its own: every decision is a returned discriminant. A
 * genuine defect is allowed to throw, because a lane that cannot compile the
 * program it is bound to must not quietly ship something else.
 */
export function buildCharacterPromptProgram(input: CharacterPromptProgramInput): CharacterPromptProgramResult {
  const { lane, profile, sink } = input;
  const profileKey = input.bindingProfileKey;

  // --- 1. The binding, on the lane's own FINAL resolved model ---------------
  // The BASE slug, not the row's own. Three seeded character models are
  // community checkpoints whose registry rows carry a `:version` pin
  // (LikeReality Pony, NSFW FLUX Dev, SDXL PuLID), and so does the LoRA-capable
  // Qwen edit wrapper an admin can still address by hand — so resolving on the
  // raw slug would answer `unbound` for four endpoints that ARE bound, and each
  // would fail every render with nothing in the binding table showing why.
  // Pinning a binding to one provider version is what `versionId` is for, and it
  // is a separate decision from which endpoint a row is about.
  const modelSlug = baseImageModelSlug(profile.model.slug);
  const binding = activeImagePromptBinding({
    modelSlug,
    task: input.task,
    ...(profileKey === undefined ? {} : { profileKey }),
    ...(input.bindingStrategy === undefined ? {} : { promptStrategy: input.bindingStrategy }),
  });
  if (binding === null) {
    return { kind: "unbound", modelSlug, task: input.task, profileKey: profileKey ?? null };
  }

  const positivePack = imagePositivePack(binding.positivePackVersionId);
  const negativePack = imageNegativePack(binding.negativePackVersionId);
  if (positivePack === null || negativePack === null) {
    const context = {
      binding: binding.id,
      positive: binding.positivePackVersionId,
      negative: binding.negativePackVersionId,
    };
    sink?.push(
      diag("warn", IMAGE_CHARACTER_PROMPT_PACK_MISSING, "a bound prompt pack version is not registered", {
        path: PATH,
        context: { lane, ...context },
      }),
    );
    return {
      kind: "refused",
      code: IMAGE_CHARACTER_PROMPT_PACK_MISSING,
      refusal: `prompt pack versions bound by ${binding.id} are not registered`,
      context,
    };
  }

  // --- 2. Plan the references before anything describes them ----------------
  // Planning runs over the bare transport shapes and returns THE SAME OBJECTS,
  // so who each identity image shows is recovered by object identity rather
  // than by re-deriving it from a role and a position — which on an ensemble
  // render is exactly the guess that binds the wrong face to the wrong person.
  const subjectByReference = new Map<ImageRenderReference, string>();
  const descriptionByReference = new Map<ImageRenderReference, string>();
  for (const entry of input.references) {
    if (entry.subjectId !== undefined) subjectByReference.set(entry.reference, entry.subjectId);
    if (entry.description !== undefined) descriptionByReference.set(entry.reference, entry.description);
  }
  const subjectOf = (reference: ImageRenderReference): string | undefined => subjectByReference.get(reference);
  // Recovered by object identity for the same reason the subject is: planning
  // returns the same objects, so nothing has to re-derive which slot was which.
  const describe = (reference: ImageRenderReference): string | undefined => descriptionByReference.get(reference);
  const supplied = input.references.map((entry) => entry.reference);
  const planned = planIntentReferences(profile.model, profile.profile.referencePolicy, supplied);
  const sentReferences = [...planned.primary, ...planned.dedicated.flatMap((field) => field.references)];
  const numbersSlots = imagePromptDialectForBinding(binding)?.referenceSyntax === "numbered_images";
  if (numbersSlots && planned.renumbered) {
    const context = {
      binding: binding.id,
      supplied: supplied.map((reference) => reference.role),
      sent: planned.primary.map((reference) => reference.role),
    };
    sink?.push(
      diag("warn", IMAGE_CHARACTER_PROMPT_REFERENCES_RENUMBERED, "reference planning renumbered a numbered-slot prompt", {
        path: PATH,
        context: { lane, ...context },
      }),
    );
    return {
      kind: "refused",
      code: IMAGE_CHARACTER_PROMPT_REFERENCES_RENUMBERED,
      refusal: "reference planning moves a reference out of the slot this prompt numbers it as",
      context,
    };
  }

  // --- 3. Assemble the world digest over the lane's own cast ----------------
  // The reference facts are derived BEFORE the cast, because whether a subject is
  // named depends on whether the payload carries an image of them — a question
  // only the planned send list can answer.
  const references = referenceFacts(lane, subjectOf, sentReferences);
  const cast = castAssembly(
    input.cuts,
    input.read,
    {
      ...(input.scene === undefined ? {} : { scene: input.scene }),
      ...(input.location === undefined ? {} : { location: input.location }),
      ...(input.camera === undefined ? {} : { camera: input.camera }),
    },
    input.intimateReveal === true,
    CHARACTER_LANE_SUBJECT_NAMING[lane],
    referenceAnchoredSubjects(references),
  );
  if ("code" in cast) {
    sink?.push(
      diag("warn", cast.code, "a character cast could not be folded into one digest", {
        path: PATH,
        context: { lane, detail: cast.detail },
      }),
    );
    return {
      kind: "refused",
      code: cast.code,
      refusal: `the cast for this render could not be assembled: ${cast.detail}`,
      context: { detail: cast.detail, subjects: input.cuts.map((cut) => cut.subjectId) },
    };
  }
  // Assembled twice on purpose. The change contract derives its preserve set
  // from the REAL subject slices, which do not exist until the assembly has
  // run, so the first pass carries a placeholder operation the slices do not
  // depend on and the second replaces it wholesale.
  const assembly = {
    ...cast,
    // The lane's own age policy, decided by the table above and never by input.
    apparentAge: CHARACTER_LANE_APPARENT_AGE[lane],
    references,
  };
  const preview = assembleCharacterWorldDigest({ ...assembly, operation: characterPortraitImageOperation() });
  const subjects = preview.input.subjects ?? [];
  const built = buildImageWorldDigest({ ...preview.input, operation: input.operation(subjects) });
  for (const issue of built.issues) {
    sink?.push(
      diag("info", issue.code, "a character world digest dropped a fact it could not carry", {
        path: PATH,
        context: { lane, detail: issue.detail },
      }),
    );
  }

  // --- 4. Compile -----------------------------------------------------------
  const compiled = compileImagePromptProgram({
    digest: built.digest,
    binding,
    positivePack,
    negativePack,
    references: dialectReferences(subjectOf, describe, planned.primary),
    ...(input.register === undefined ? {} : { register: input.register }),
    budget: imagePromptBudgetFromBinding(profile.model.advancedCapabilities.prompt),
    // The probed negative binding is the only honest source for whether this
    // version has a field at all. An empty `advancedCapabilities` means nobody
    // has looked, which is not the same as "yes".
    negativeFieldAvailable: profile.model.advancedCapabilities.controls.negativePrompt !== undefined,
    expectedSubjectRefs: input.cuts.map((cut) => `subject.${cut.subjectId}`),
    refuseOnMissingRequired: input.refuseOnMissingRequired,
    ...(sink === undefined ? {} : { sink }),
  });
  if (!compiled.ok) {
    sink?.push(
      diag("warn", compiled.refusal.code, compiled.refusal.message, {
        path: PATH,
        context: { lane, ...compiled.refusal.context },
      }),
    );
    return {
      kind: "refused",
      code: compiled.refusal.code,
      refusal: compiled.refusal.message,
      context: compiled.refusal.context,
    };
  }

  return {
    kind: "compiled",
    prompt: compiled.compiled.positiveText,
    negativePrompt: compiled.compiled.negativeText,
    meta: {
      [IMAGE_PROMPT_PROGRAM_META_KEY]: compiled.compiled.promptProgramProvenance,
      [IMAGE_WORLD_STATE_META_KEY]: compiled.compiled.worldStateProvenance,
    },
    binding,
    sentReferences,
    numberedReferences: planned.primary,
    missingRequired: preview.missingRequired,
    subjects,
    keptClaimIds: compiled.compiled.promptProgramProvenance.positiveClaimIds,
  };
}

// ---------------------------------------------------------------------------
// The transport every character lane sends on
// ---------------------------------------------------------------------------

/** The prompt channels one character render sets on its intent. */
export interface CharacterPromptTransport {
  readonly prompt: string;
  /** The compiled exclusions, normalized — absent when the program compiled none. */
  readonly controls?: { readonly negativePrompt: string };
}

/**
 * The prompt channels a compiled render sends, decided in ONE place because
 * they must move together: the positive text as the intent's `prompt` — the
 * intent's only prompt channel — and the compiled exclusions as the normalized
 * control, never as a second prompt. A character render has nothing but the
 * program to send.
 *
 * The compiled exclusions ride the normalized control so they reach a provider
 * only through the version's own probed `negative_prompt` binding, and are
 * recorded as a dropped control otherwise. Null or empty means this endpoint
 * compiled no exclusions — every character endpoint today, since none has a
 * negative block enabled that its dialect can transport — and no key is
 * invented.
 */
export function characterPromptTransport(compiled: {
  readonly prompt: string;
  readonly negativePrompt: string | null;
}): CharacterPromptTransport {
  const negative = compiled.negativePrompt;
  return {
    prompt: compiled.prompt,
    ...(negative === null || negative.length === 0 ? {} : { controls: { negativePrompt: negative } }),
  };
}

// ---------------------------------------------------------------------------
// The variant lane's operation policy
// ---------------------------------------------------------------------------

/**
 * The variant kinds' change concepts — the ONE mapping the variant lane
 * compiles through.
 *
 * The concept is not prose: it never reaches the prompt text. It does exactly
 * two things — it is the sole input to the preserve-set derivation
 * (`characterChangeContract` keeps every required anchor whose concept the
 * change does not name), and it rides as claim metadata into the program
 * fingerprint.
 *
 * Three of these names — `subject.pose`, `subject.expression` and
 * `location.identity` — are registered concepts that no CHARACTER fact is ever
 * projected as: `conceptOfSegmentKind` sends a pose segment to
 * `subject.body_language`, a current-state segment to `subject.current_state`
 * and a setting segment to `location.contents`. They therefore exclude nothing
 * from the preserve set. That is harmless today and correct by accident — the
 * only mandatory sources in the registry are adapted anatomy and species
 * feature groups (`subject.morphology`) and on-body wardrobe
 * (`subject.wardrobe`), so a pose or expression variant preserves morphology
 * and the outfit, which is what it should preserve. It stops being harmless the
 * day a body-language or current-state attribute is marked mandatory: `pose`
 * would then preserve the very body language it was asked to change.
 *
 * Left as it is, deliberately. The three names cost nothing today and fixing
 * them changes what every pose, expression and setting variant preserves, which
 * is a wording decision with output consequences rather than a typo — so it
 * belongs to whichever trial grades those kinds, not to this migration.
 */
export const VARIANT_CHANGE_CONCEPTS: Record<PortraitVariantKind, ImageConceptId> = {
  pose: "subject.pose",
  outfit: "subject.wardrobe",
  expression: "subject.expression",
  setting: "location.identity",
  nsfw_test: "subject.pose",
};

/** The variant lane's operation contract for one kind and instruction. */
export function variantChangeOperation(
  kind: PortraitVariantKind,
  instruction: string,
): (subjects: readonly ImageSubjectDigest[]) => ImageOperationContract {
  return (subjects) =>
    characterVariantImageOperation({
      change: characterChangeContract({ concept: VARIANT_CHANGE_CONCEPTS[kind], value: instruction.trim() }, subjects),
    });
}
