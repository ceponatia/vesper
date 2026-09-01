import {
  activeImagePromptBinding,
  baseImageModelSlug,
  buildImageWorldDigest,
  compileImagePromptProgram,
  imageNegativePack,
  imagePositivePack,
  imagePromptBindingForShadow,
  imagePromptBudgetFromBinding,
  imagePromptDialectForBinding,
  planIntentReferences,
  IMAGE_PROMPT_PROGRAM_META_KEY,
  IMAGE_WORLD_STATE_META_KEY,
  type ImageConceptId,
  type ImageDialectReference,
  type ImageOperationContract,
  type ImagePromptProfileBinding,
  type ImagePromptSegment,
  type ImagePromptStrategy,
  type ImageReferenceFact,
  type ImageRenderReference,
  type ImageSubjectDigest,
  type ResolvedImageProfile,
} from "@vesper/image-core";
import type { AttributeValue, RealizedBody, RegionExposure, VisualImageDigest } from "@/contracts";
import {
  mergeVisualImageCastDigests,
  type VisualImageCastMergeRefusal,
} from "@/contracts/images/visual-digest";
import type { CharacterSubjectSources } from "@/contracts/images/character-adapter";
import { diag, type DiagnosticSink } from "@/contracts/diagnostics";
import {
  assembleCharacterWorldDigest,
  characterChangeContract,
  characterPortraitImageOperation,
  characterVariantImageOperation,
  type CharacterWorldDigestAssemblyInput,
  type CharacterWorldReadInput,
} from "@/contracts/images/character-digest";
import type { VariantKind } from "./prompts-variant";
// The character pack seeds register their packs and bindings at import time, and
// this module is the one place both the shadow and production resolve a binding
// — so the registration import belongs here rather than being duplicated at
// every caller. A module that imported this one alone and skipped the seeds
// would silently resolve null and read as "this lane is not cut over".
// All three files together are the whole character surface: the two Qwen
// endpoints, and every other model the profile picker still offers (#256).
import "./packs-character-endpoints";
import "./packs-qwen-2511";
import "./packs-qwen-2512-portrait";

/**
 * THE CHARACTER PROMPT-PROGRAM SEAM (issue #256) — the one path that turns a
 * lane's realized visual cut into a compiled prompt program, shared verbatim by
 * the shadow that MEASURES a cutover and the production render that PERFORMS
 * one.
 *
 * It exists because of a single invariant: the prompt production sends after a
 * lane is cut over must be produced by the same semantic program-building path
 * the shadow measured. Two independent implementations — one to observe, one to
 * ship — would let the evidence describe a prompt nobody sends, which is the
 * one failure mode that makes the whole staged rollout worthless. So the
 * assembly, the operation contract, the binding, the packs, the reference
 * planning, the budget and the compile all live here exactly once, and the two
 * callers differ only where their PURPOSES genuinely differ:
 *
 * | | shadow | production |
 * |---|---|---|
 * | resolver | `imagePromptBindingForShadow` — `candidate` rows included | `activeImagePromptBinding` — `active` only |
 * | no binding | a recorded `unmeasured` verdict | this lane keeps its legacy prompt path |
 * | refusal | a recorded verdict; the render is untouched | the row fails BEFORE provider spend |
 * | `refuseOnMissingRequired` | `false` — the loss must be measurable, not fatal | the lane's own task decision |
 *
 * `unbound` is deliberately a THIRD result rather than a refusal. It is the
 * honest "no row for this (model, task, profile key)", and it stays a real
 * answer even now that every character profile the picker offers is bound
 * (#256): a lane whose profile key gains a row later, an operator-added
 * model with no dialect, and `chat_place` — the one identity-free chat lane,
 * deliberately unbound — all land here, and each must keep the prompt path it
 * already had rather than failing. A refusal, by contrast, is a real
 * configuration or compile fault on a lane that IS bound, and falling back to
 * the legacy paragraph there would hide it behind acceptable-looking images.
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
 * One subject's realized cut, in the vocabulary every lane already exposes
 * (`StandaloneSubjectVisual`, `ChatLookSegmentAssembly.visual`,
 * `SceneSubjectVisualSlice`).
 *
 * Deliberately WITHOUT the segment build's emission ledger: that is evidence
 * about what the LEGACY builder emitted, which only the comparison half has any
 * use for. A production compile that could see it would be a compile that could
 * be influenced by the string it is replacing.
 */
export interface CharacterPromptSubjectCut {
  readonly subjectId: string;
  readonly name?: string;
  readonly digest: VisualImageDigest;
  readonly attributes: readonly AttributeValue[];
  readonly exposure: RegionExposure;
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
}

export interface CharacterPromptProgramInput {
  readonly lane: CharacterPromptLane;
  readonly task: CharacterPromptTask;
  /**
   * The lane's FINAL resolved profile — after any model swap. The variant
   * lane's `nsfw_test` kind pairs the picked profile with a LoRA WRAPPER model,
   * and resolving a binding from the pre-swap profile would bind a program to a
   * model the render will not run on.
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
  /** Which status set resolution may see. Production is always `"active"`. */
  readonly resolver: "active" | "shadow";
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
   * worthless without her identity anchors, while the shadow must compile
   * THROUGH the loss to be able to report it.
   */
  readonly refuseOnMissingRequired: boolean;
  readonly sink?: DiagnosticSink;
}

/** A compiled program, plus what the comparison half still needs from the compile. */
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
  /** The assembled subject slices, pre-build: the compiled side's fact source. */
  readonly subjects: readonly ImageSubjectDigest[];
  /** The claims that survived to the prompt, by id. */
  readonly keptClaimIds: readonly string[];
}

/**
 * No binding for this (model, task[, profileKey]). The ORDINARY staged-rollout
 * answer, never an error: this lane keeps the prompt path it already had.
 */
export interface CharacterPromptProgramUnbound {
  readonly kind: "unbound";
  readonly modelSlug: string;
  readonly task: CharacterPromptTask;
  readonly profileKey: string | null;
}

/**
 * A configuration gap or a compile refusal on a lane that IS bound. Production
 * fails the row on it; it never falls back to the legacy prompt, because a
 * binding that resolved and then could not compile is a fault to surface rather
 * than to paper over.
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
 * is about to send (#256) — a cutover failure, refused before provider spend.
 *
 * ## It is a tripwire, not a bug detector
 *
 * Nothing here is currently wrong, and that is the point. This module numbers
 * from `planned.primary`, and every lane hands `renderImageIntent` a list the
 * same planner reduces to that same `primary` — so the slot the prompt calls N
 * IS the image the provider receives at N, by construction. The invariant holds
 * because two independent call sites happen to agree.
 *
 * `renumbered` is the exact condition under which that agreement becomes
 * load-bearing: it means the order a LANE thinks in and the order its profile's
 * policy imposes have diverged. No production lane diverges today — every one
 * orders identity first, which is what the policies rank first, and capacity
 * trims from the tail. So this refusal fires only when somebody changes that,
 * and it fires before provider spend instead of after a plausible-looking image
 * of the wrong composition has been saved. #256 asks for exactly this until
 * #250 moves final numbering downstream and removes the coupling.
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

/** The dialect's slots, over the PRIMARY field's images in send order. */
function dialectReferences(
  subjectOf: (reference: ImageRenderReference) => string | undefined,
  references: readonly ImageRenderReference[],
): ImageDialectReference[] {
  return references.map((reference, index) => {
    const subjectId = reference.role === "identity" ? subjectOf(reference) : undefined;
    return {
      position: index + 1,
      role: reference.role,
      ...(subjectId === undefined ? {} : { subjectRef: `subject.${subjectId}` }),
    };
  });
}

/**
 * The cast's cuts as the assembly's inputs, minus the operation and references.
 *
 * One merged digest, one `sources` entry per person and one label per person
 * who has a name. The merge is what turns N committed cuts into the single
 * multi-subject digest `assembleCharacterWorldDigest` takes; everything else
 * here is a keyed fold, so a cast of one produces byte-identically what the
 * single-cut spelling produced before this function took a list.
 */
function castAssembly(
  cuts: readonly CharacterPromptSubjectCut[],
  read: CharacterWorldReadInput,
): Omit<CharacterWorldDigestAssemblyInput, "operation" | "references"> | VisualImageCastMergeRefusal {
  const merged = mergeVisualImageCastDigests(cuts.map((cut) => cut.digest));
  if (!merged.ok) return merged.refusal;
  const labels: Record<string, string> = {};
  const sources: Record<string, CharacterSubjectSources> = {};
  for (const cut of cuts) {
    if (cut.name !== undefined) labels[cut.subjectId] = cut.name;
    sources[cut.subjectId] = {
      attributes: cut.attributes,
      exposure: cut.exposure,
      realizedBody: cut.realizedBody,
    };
  }
  return {
    digest: merged.digest,
    ...(Object.keys(labels).length === 0 ? {} : { labels }),
    sources,
    read,
  };
}

/**
 * Resolve, assemble, compile — the whole semantic path, once.
 *
 * Throws nothing of its own: every decision is a returned discriminant. The
 * shadow wraps this in its own total container because an observation must never
 * fail a render; production lets a genuine defect throw, because a lane that
 * cannot compile the program it is bound to must not quietly ship something else.
 */
export function buildCharacterPromptProgram(input: CharacterPromptProgramInput): CharacterPromptProgramResult {
  const { lane, profile, sink } = input;
  const profileKey = input.bindingProfileKey;

  // --- 1. The binding, on the lane's own FINAL resolved model ---------------
  const resolve = input.resolver === "shadow" ? imagePromptBindingForShadow : activeImagePromptBinding;
  // The BASE slug, not the row's own. Three seeded character models are
  // community checkpoints whose registry rows carry a `:version` pin
  // (LikeReality Pony, NSFW FLUX Dev, SDXL PuLID), and so does the LoRA wrapper
  // the intimate and bench routes swap onto — so resolving on the raw slug
  // would answer `unbound` for four endpoints that ARE bound, and each would
  // silently keep its legacy prompt with nothing in the binding table showing
  // it. Pinning a binding to one provider version is what `versionId` is for,
  // and it is a separate decision from which endpoint a row is about.
  const modelSlug = baseImageModelSlug(profile.model.slug);
  const binding = resolve({
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
  for (const entry of input.references) {
    if (entry.subjectId !== undefined) subjectByReference.set(entry.reference, entry.subjectId);
  }
  const subjectOf = (reference: ImageRenderReference): string | undefined => subjectByReference.get(reference);
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
  const cast = castAssembly(input.cuts, input.read);
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
    references: referenceFacts(lane, subjectOf, sentReferences),
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
    references: dialectReferences(subjectOf, planned.primary),
    budget: imagePromptBudgetFromBinding(profile.model.advancedCapabilities.prompt),
    // The probed negative binding is the only honest source for whether this
    // version has a field at all. An empty `advancedCapabilities` means nobody
    // has looked, which is not the same as "yes".
    negativeFieldAvailable: profile.model.advancedCapabilities.controls.negativePrompt !== undefined,
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
// The transport every cut-over lane sends on
// ---------------------------------------------------------------------------

/** The prompt channels one character render sets on its intent. */
export interface CharacterPromptTransport {
  readonly prompt: string;
  /** The semantic segments, on a LEGACY render only. */
  readonly promptSegments?: readonly ImagePromptSegment[];
  /** The compiled exclusions, normalized — absent when the program compiled none. */
  readonly controls?: { readonly negativePrompt: string };
}

/**
 * The prompt channels a cut-over render sends, decided in ONE place because they
 * must move together.
 *
 * `resolveIntentPrompt` prefers `promptSegments` over `prompt` whenever the list
 * is non-empty, so a compiled render that still carried the legacy segments
 * would send the legacy prose while its row stored the compiled program — a
 * provider seeing one prompt and an operator reading another, with nothing
 * anywhere reporting a disagreement. Deciding the three channels separately at
 * each call site is exactly how that ships; deciding them here makes the
 * coupling structural for every lane at once.
 *
 * The compiled exclusions ride the normalized control so they reach a provider
 * only through the version's own probed `negative_prompt` binding, and are
 * recorded as a dropped control otherwise. Null or empty means this endpoint
 * compiled no exclusions — every character endpoint today, since none has a
 * negative block enabled that its dialect can transport — and no key is
 * invented.
 */
export function characterPromptTransport(
  legacyPrompt: string,
  segments: readonly ImagePromptSegment[] | undefined,
  compiled: { readonly prompt: string; readonly negativePrompt: string | null } | null,
): CharacterPromptTransport {
  if (compiled === null) {
    return { prompt: legacyPrompt, ...(segments === undefined ? {} : { promptSegments: segments }) };
  }
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
 * The variant kinds' change concepts — the ONE mapping, shared by the shadow
 * that measured this lane and the production compile that will ship it.
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
export const VARIANT_CHANGE_CONCEPTS: Record<VariantKind, ImageConceptId> = {
  pose: "subject.pose",
  outfit: "subject.wardrobe",
  expression: "subject.expression",
  setting: "location.identity",
  nsfw_test: "subject.pose",
};

/** The variant lane's operation contract for one kind and instruction. */
export function variantChangeOperation(
  kind: VariantKind,
  instruction: string,
): (subjects: readonly ImageSubjectDigest[]) => ImageOperationContract {
  return (subjects) =>
    characterVariantImageOperation({
      change: characterChangeContract({ concept: VARIANT_CHANGE_CONCEPTS[kind], value: instruction.trim() }, subjects),
    });
}
