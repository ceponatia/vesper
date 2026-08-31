import {
  activeImagePromptBinding,
  buildImageWorldDigest,
  compileImagePromptProgram,
  imageNegativePack,
  imagePositivePack,
  imagePromptBindingForShadow,
  imagePromptBudgetFromBinding,
  planIntentReferences,
  IMAGE_PROMPT_PROGRAM_META_KEY,
  IMAGE_WORLD_STATE_META_KEY,
  type ImageConceptId,
  type ImageDialectReference,
  type ImageOperationContract,
  type ImagePromptProfileBinding,
  type ImageReferenceFact,
  type ImageRenderReference,
  type ImageSubjectDigest,
  type ResolvedImageProfile,
} from "@vesper/image-core";
import type { AttributeValue, RealizedBody, RegionExposure, VisualImageDigest } from "@/contracts";
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
 * `unbound` is deliberately a THIRD result rather than a refusal. Null from the
 * active resolver is the ordinary answer during a staged rollout — "this lane
 * has not been cut over" — and five seeded profiles share the `variant-standard`
 * key on models with no dialect, so treating it as an error would fail every
 * Seedream, Wan and PuLID variant the picker offers. A refusal, by contrast, is
 * a real configuration or compile fault on a lane that HAS been cut over, and
 * falling back to the legacy paragraph there would hide it behind
 * acceptable-looking images.
 *
 * ## Reference planning belongs here
 *
 * The dialect numbers its slots — `Image 1: …` — and picks the single- versus
 * multi-reference identity lock by reference COUNT. Both must describe the
 * payload, and the payload is `planIntentReferences`'s output, not the lane's
 * own list: planning drops roles the profile disallows, binds control roles to
 * their own provider fields, and reorders required references ahead of optional
 * ones. A program numbered from the caller's list is exactly the state
 * `PlannedImageReferences.renumbered` exists to flag — the prompt calling the
 * room "image two" while the payload sends the person there. So this module
 * plans first and compiles against the result, and hands back the planned list
 * so the caller sends the same one it just described.
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
  /** Which status set resolution may see. Production is always `"active"`. */
  readonly resolver: "active" | "shadow";
  readonly cut: CharacterPromptSubjectCut;
  readonly read: CharacterWorldReadInput;
  /**
   * The references the lane would hand `renderImageIntent`, in the lane's own
   * order. This module plans them and compiles against the plan.
   */
  readonly references: readonly ImageRenderReference[];
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
  subjectId: string,
  references: readonly ImageRenderReference[],
): ImageReferenceFact[] {
  return references.map((reference, index) => ({
    role: reference.role,
    ...(reference.role === "identity" ? { subjectRef: `subject.${subjectId}` } : {}),
    required: reference.role === "identity",
    source: { owner: PATH, key: `${lane}.reference.${index}` },
  }));
}

/** The dialect's numbered slots, over the PRIMARY field's images in send order. */
function dialectReferences(
  subjectId: string,
  references: readonly ImageRenderReference[],
): ImageDialectReference[] {
  return references.map((reference, index) => ({
    position: index + 1,
    role: reference.role,
    ...(reference.role === "identity" ? { subjectRef: `subject.${subjectId}` } : {}),
  }));
}

/** One subject's cut as the assembly's inputs, minus the operation and references. */
function cutAssembly(
  cut: CharacterPromptSubjectCut,
  read: CharacterWorldReadInput,
): Omit<CharacterWorldDigestAssemblyInput, "operation" | "references"> {
  return {
    digest: cut.digest,
    ...(cut.name === undefined ? {} : { labels: { [cut.subjectId]: cut.name } }),
    sources: {
      [cut.subjectId]: {
        attributes: cut.attributes,
        exposure: cut.exposure,
        realizedBody: cut.realizedBody,
      },
    },
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
  const binding = resolve({
    modelSlug: profile.model.slug,
    task: input.task,
    ...(profileKey === undefined ? {} : { profileKey }),
  });
  if (binding === null) {
    return { kind: "unbound", modelSlug: profile.model.slug, task: input.task, profileKey: profileKey ?? null };
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
  const planned = planIntentReferences(profile.model, profile.profile.referencePolicy, input.references);
  const sentReferences = [...planned.primary, ...planned.dedicated.flatMap((field) => field.references)];

  // --- 3. Assemble the world digest over the lane's own cut -----------------
  // Assembled twice on purpose. The change contract derives its preserve set
  // from the REAL subject slices, which do not exist until the assembly has
  // run, so the first pass carries a placeholder operation the slices do not
  // depend on and the second replaces it wholesale.
  const assembly = {
    ...cutAssembly(input.cut, input.read),
    references: referenceFacts(lane, input.cut.subjectId, sentReferences),
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
    references: dialectReferences(input.cut.subjectId, planned.primary),
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
 * It is left exactly as the shadow has been measuring it, deliberately. The
 * production candidate must match the measured one or the accumulated evidence
 * describes a different program; correcting the three names is an owner ruling
 * recorded on #256, and it re-opens the shadow round for those kinds.
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
