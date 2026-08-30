import {
  activeImagePromptBinding,
  compileImagePromptProgram,
  buildImageWorldDigest,
  IMAGE_TARGET_ASPECT,
  imageNegativePack,
  imagePositivePack,
  imagePromptBudgetFromBinding,
  type ImageConceptId,
  type ImageDialectReference,
  type ImageOperationContract,
  type ImageProfileOperation,
  type ImagePromptSegment,
  type ImageReferenceFact,
  type ImageRenderReference,
  type ImageSourceRevision,
  type ImageSubjectDigest,
  type ResolvedImageProfile,
  type SceneAttemptId,
} from "@vesper/image-core";
import {
  VISUAL_STATE_SPECIES_FEATURE_GROUP_KIND_ID,
  type VisualImageDigest,
  type VisualStateSuppression,
} from "@/contracts";
import { diag, type DiagnosticSink } from "@/contracts/diagnostics";
import {
  assembleCharacterWorldDigest,
  characterChangeContract,
  characterChatLookImageOperation,
  characterPortraitImageOperation,
  characterSceneImageOperation,
  characterVariantImageOperation,
  type CharacterWorldDigestAssemblyInput,
  type CharacterWorldReadInput,
} from "@/contracts/images/character-digest";
import type { AvatarSegmentAssembly } from "./avatar-segments";
import type { ChatLookSegmentAssembly } from "./chat-look-segments";
import { imageRenderRuntimeFacts } from "./model-adapters";
import type { VariantKind } from "./prompts-variant";
import { captureRenderIntent } from "./render-intent-capture";
import type { SceneSubjectVisualSlice } from "./scene-subject-visual";
import {
  compareShadowRender,
  shadowComparisonMeta,
  shadowErrorComparison,
  shadowUnmeasuredComparison,
  type ShadowCoverageAllowlist,
} from "./shadow-comparison";
import type { VariantSegmentAssembly } from "./variant-segments";
// The character pack seeds register their packs and bindings at import time;
// the shadow is Round 2's consumer of that registration (packs-qwen-2511.ts
// §App-side), so the wiring module is where the imports live.
import "./packs-qwen-2511";
import "./packs-qwen-2512-portrait";

/**
 * THE CHARACTER-LANE SHADOW WIRING (issue #256, Round 2) — one module that
 * turns a lane's own materials into the compact stored verdict of
 * `shadow-comparison.ts`, for all four character lanes: avatar, variant,
 * chat-look and scene.
 *
 * Each lane calls its entry AFTER its production prompt, segments and render
 * intent are fully decided, and merges the returned `meta` fragment beside the
 * meta it already records at reserve time. Everything here is OBSERVATION:
 * nothing a lane sends a provider reads anything this module produces, the
 * legacy strings ship untouched (owner ruling 2026-08-29), and every internal
 * failure — assembly, binding, compile, capture, comparison — degrades to a
 * recorded `error` or `unmeasured` verdict, never a failed or altered render.
 *
 * ## What one shadow run does
 *
 * 1. Assemble the character world digest (`assembleCharacterWorldDigest`) from
 *    the SAME realized visual cut the lane's segments were built from — the
 *    lanes expose it for exactly this (`StandaloneSubjectVisual.digest`,
 *    `ChatLookSegmentAssembly.visual`, `SceneSubjectVisualSlice`).
 * 2. Resolve the lane's binding on the lane's OWN resolved model
 *    (`activeImagePromptBinding`; the portrait lane resolves per profile key).
 *    A model with no binding is a recorded refusal, not an error — null is the
 *    ordinary answer during a staged rollout.
 * 3. Compile the prompt program (`compileImagePromptProgram`,
 *    `refuseOnMissingRequired: false` so a degraded assembly still produces a
 *    comparable prompt and the loss is recorded as `mandatory_lost`).
 * 4. Capture both transports (`captureRenderIntent`) over the same profile,
 *    references and target — only the prompt differs, which is the migration.
 * 5. Compare (`compareShadowRender`) with STRUCTURAL fact lists: the legacy
 *    side is what the lane's segment build stated (digest facts minus its own
 *    suppressions and missing anchors), the compiled side is the program's
 *    kept subject-fact claims, both under canonical shadow fact names. The
 *    route-owned prose residue (a scene's residual attribute sheet) is outside
 *    this fact space on BOTH sides; the fixture suites own that space.
 *
 * ## The seeded delta allowlists
 *
 * Seeded verbatim from the cutover comparison's named deltas
 * (`lane-cutover-comparison.test.ts` §Fact-set comparison) as the production
 * data each lane passes. Because those deltas describe the pre-Stage-4 legacy
 * builders while production now ships the digest assemblies, an entry may name
 * a delta this render no longer exhibits — so the live allowlist is the seeded
 * one FILTERED to entries that are real over this render's own fact lists, and
 * every dropped entry is logged (`image_shadow.allowlist_inert`) instead of
 * being reported as stale drift. An entry that names a REAL divergence (a
 * removed fact the compiled side still states) is deliberately not filtered:
 * the leak check keeps its teeth.
 */

// ---------------------------------------------------------------------------
// Refusal and bookkeeping codes
// ---------------------------------------------------------------------------

/** No active binding for this model slug and task — the lane is not cut over here. */
export const IMAGE_SHADOW_BINDING_MISSING = "image_shadow.binding_missing";
/** A bound pack version is not registered — a configuration gap, recorded, never thrown. */
export const IMAGE_SHADOW_PACK_MISSING = "image_shadow.pack_missing";
/** The prompt-program compile refused; the refusal code rides the context. */
export const IMAGE_SHADOW_COMPILE_REFUSED = "image_shadow.compile_refused";
/** A cast of two or more — no frozen row exists for it by design; unmeasured. */
export const IMAGE_SHADOW_MULTI_SUBJECT = "image_shadow.multi_subject";
/** The intimate-LoRA route swapped the model to the wrapper slug (no dialect). */
export const IMAGE_SHADOW_LORA_ROUTE = "image_shadow.lora_route";
/** A capture refused to plan — transport parity reads unmeasured for that side. */
export const IMAGE_SHADOW_CAPTURE_REFUSED = "image_shadow.capture_refused";
/** A seeded allowlist entry that is not a delta over THIS render — dropped, logged. */
export const IMAGE_SHADOW_ALLOWLIST_INERT = "image_shadow.allowlist_inert";

const PATH = "images.character_shadow";

// ---------------------------------------------------------------------------
// Seeded per-lane deltas (lane-cutover-comparison.test.ts §Fact-set comparison)
// ---------------------------------------------------------------------------

/** The avatar cutover promised an unchanged fact set. */
export const AVATAR_SHADOW_DELTA: ShadowCoverageAllowlist = { removed: [], added: [] };
/** The variant lane's gain, and the whole of it: the digest's morphology anchors. */
export const VARIANT_SHADOW_DELTA: ShadowCoverageAllowlist = { removed: [], added: ["horns", "wings", "tail"] };
/** The chat-look mint's gain — the same morphology anchors as its sibling edit lane. */
export const CHAT_LOOK_SHADOW_DELTA: ShadowCoverageAllowlist = { removed: [], added: ["horns", "wings", "tail"] };
/** The scene reference rungs' gain: morphology anchors the reference alone used to hold. */
export const SCENE_REFERENCE_SHADOW_DELTA: ShadowCoverageAllowlist = {
  removed: [],
  added: ["horns", "wings", "tail"],
};
/** The text-to-image scene fix: covered `imageReveal: "skin"` detail stops leaking. */
export const SCENE_T2I_DRESSED_SHADOW_DELTA: ShadowCoverageAllowlist = { removed: ["toenails"], added: [] };

// ---------------------------------------------------------------------------
// Canonical shadow fact names
// ---------------------------------------------------------------------------

/**
 * One fact's canonical shadow name: subject-agnostic (the subject prefix is
 * stripped, in both the visual-digest `<subject>/<locus>/<kind>` spelling and
 * the adapter's `subject.<subject>.…` spelling), with a species feature group
 * named by its GROUP ("horns", "wings", "tail") — the vocabulary the seeded
 * deltas and the cutover comparison already speak. Everything else keeps its
 * stripped fact key, so two sides built from one cut name one fact one way.
 */
export function shadowFactName(key: string, subjectId: string): string {
  let name = key;
  if (name.startsWith(`${subjectId}/`)) name = name.slice(subjectId.length + 1);
  else if (name.startsWith(`subject.${subjectId}.`)) name = name.slice(`subject.${subjectId}.`.length);
  const segments = name.split("/");
  const locus = segments[0];
  if (segments.length === 2 && segments[1] === VISUAL_STATE_SPECIES_FEATURE_GROUP_KIND_ID && locus !== undefined) {
    return locus;
  }
  return name;
}

/**
 * The legacy side's structural fact list: every fact the lane's ONE selection
 * put in the digest, minus what the segment build itself excluded (its
 * suppressions and its missing anchors) — i.e. what the lane's segment builder
 * actually emitted, derived from structure rather than probed from prose.
 */
export function legacyShadowFactNames(input: {
  readonly digest: VisualImageDigest;
  readonly subjectId: string;
  readonly suppressions: readonly VisualStateSuppression[];
  readonly missingRequired: readonly string[];
}): string[] {
  const excluded = new Set<string>([
    ...input.suppressions.map((suppression) => suppression.key),
    ...input.missingRequired,
  ]);
  const names = [...input.digest.mandatoryFacts, ...input.digest.optionalFacts]
    .filter((fact) => fact.subjectId === input.subjectId && !excluded.has(fact.key))
    .map((fact) => shadowFactName(fact.key, input.subjectId));
  return [...new Set(names)];
}

/**
 * The live allowlist: the seeded delta filtered to entries that are REAL over
 * this render's own fact lists. A `removed` entry needs the legacy side to
 * state the fact (otherwise there is nothing to forgive); an `added` entry
 * needs the compiled side to state a fact the legacy side does not. Inert
 * entries are dropped with a log line rather than reported as stale drift,
 * because the seeds describe the pre-Stage-4 deltas and production has since
 * moved — a character without horns must not fabricate a divergence.
 */
function liveShadowAllowlist(
  lane: string,
  seeded: ShadowCoverageAllowlist,
  facts: { legacy: readonly string[]; compiled: readonly string[] },
  sink?: DiagnosticSink,
): ShadowCoverageAllowlist {
  const legacy = new Set(facts.legacy);
  const compiled = new Set(facts.compiled);
  const removed = seeded.removed.filter((name) => legacy.has(name));
  const added = seeded.added.filter((name) => compiled.has(name) && !legacy.has(name));
  const inert = [
    ...seeded.removed.filter((name) => !removed.includes(name)),
    ...seeded.added.filter((name) => !added.includes(name)),
  ];
  if (inert.length > 0) {
    sink?.push(
      diag("info", IMAGE_SHADOW_ALLOWLIST_INERT, "seeded delta entries are not deltas over this render", {
        path: PATH,
        context: { lane, inert },
      }),
    );
  }
  return { removed, added };
}

// ---------------------------------------------------------------------------
// The core run
// ---------------------------------------------------------------------------

interface CharacterShadowCoreInput {
  readonly lane: "avatar" | "variant" | "chat_look" | "scene";
  /**
   * The binding table's task for this lane — the profile-task vocabulary. The
   * avatar lane binds under `portrait`; every other lane's task is its own name.
   */
  readonly task: "portrait" | "variant" | "chat_look" | "scene";
  /** The lane's OWN resolved production profile — the shadow compiles for it. */
  readonly profile: ResolvedImageProfile;
  /** Strict per-profile binding resolution — the portrait lane's four rows. */
  readonly bindingProfileKey?: string;
  readonly requestedOperation: ImageProfileOperation;
  readonly subjectId: string;
  /** The exact prompt production stores and sends. */
  readonly legacyPrompt: string;
  /** The segment channel, exactly when production sets it on the intent. */
  readonly legacySegments?: readonly ImagePromptSegment[];
  /** The references production sends, buffers included, in send order. */
  readonly references: readonly ImageRenderReference[];
  /** The lane's reserve-time `meta.visualState` fragment, when it records one. */
  readonly digestMeta?: Record<string, unknown>;
  /** Structural legacy fact names, or null → coverage reads unmeasured. */
  readonly legacyFactNames: readonly string[] | null;
  readonly assembly: Omit<CharacterWorldDigestAssemblyInput, "operation">;
  /** Built over the assembled subjects so a change contract can derive its preserve set. */
  readonly operation: (subjects: readonly ImageSubjectDigest[]) => ImageOperationContract;
  readonly allowlist: ShadowCoverageAllowlist;
  readonly sink?: DiagnosticSink;
}

/** The identity/location reference FACTS the digest assembly records for the send list. */
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

/** The dialect's numbered reference slots, in the lane's own send order. */
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

function characterShadowCore(input: CharacterShadowCoreInput): Record<string, unknown> {
  const { lane, profile, sink } = input;
  const unmeasured = (code: string, message: string, context: Record<string, unknown>): Record<string, unknown> =>
    shadowComparisonMeta(
      shadowUnmeasuredComparison({
        lane,
        code,
        message,
        context,
        payload: { legacyChars: input.legacyPrompt.length, compiledChars: 0 },
        ...(sink === undefined ? {} : { sink }),
      }),
    );

  // --- 1. The binding, on the lane's own resolved model ---------------------
  const binding = activeImagePromptBinding({
    modelSlug: profile.model.slug,
    task: input.task,
    ...(input.bindingProfileKey === undefined ? {} : { profileKey: input.bindingProfileKey }),
  });
  if (binding === null) {
    return unmeasured(IMAGE_SHADOW_BINDING_MISSING, "no prompt program is bound to this model for this lane", {
      slug: profile.model.slug,
      task: input.task,
      ...(input.bindingProfileKey === undefined ? {} : { profileKey: input.bindingProfileKey }),
    });
  }
  const positivePack = imagePositivePack(binding.positivePackVersionId);
  const negativePack = imageNegativePack(binding.negativePackVersionId);
  if (positivePack === null || negativePack === null) {
    return unmeasured(IMAGE_SHADOW_PACK_MISSING, "a bound prompt pack version is not registered", {
      binding: binding.id,
      positive: binding.positivePackVersionId,
      negative: binding.negativePackVersionId,
    });
  }

  // --- 2. Assemble the world digest over the lane's own cut -----------------
  // Assembled once with a placeholder operation (the slices do not depend on
  // it), so a change contract can derive its preserve set from the REAL
  // subjects, then the final operation replaces the placeholder wholesale.
  const preview = assembleCharacterWorldDigest({ ...input.assembly, operation: characterPortraitImageOperation() });
  const operation = input.operation(preview.input.subjects);
  const built = buildImageWorldDigest({ ...preview.input, operation });
  for (const issue of built.issues) {
    sink?.push(
      diag("info", issue.code, "the shadow's world digest dropped a fact it could not carry", {
        path: PATH,
        context: { lane, detail: issue.detail },
      }),
    );
  }

  // --- 3. Compile the prompt program ----------------------------------------
  const compiled = compileImagePromptProgram({
    digest: built.digest,
    binding,
    positivePack,
    negativePack,
    references: dialectReferences(input.subjectId, input.references),
    budget: imagePromptBudgetFromBinding(profile.model.advancedCapabilities.prompt),
    negativeFieldAvailable: profile.model.advancedCapabilities.controls.negativePrompt !== undefined,
    // The shadow's job is to MEASURE the loss, not to refuse over it: a missing
    // anchor still compiles, and rides the verdict as `mandatory_lost`.
    refuseOnMissingRequired: false,
    ...(sink === undefined ? {} : { sink }),
  });
  if (!compiled.ok) {
    return unmeasured(IMAGE_SHADOW_COMPILE_REFUSED, "the shadow's prompt program refused to compile", {
      refusal: compiled.refusal.code,
      message: compiled.refusal.message,
    });
  }
  const compiledText = compiled.compiled.positiveText;

  // --- 4. Capture both transports -------------------------------------------
  const runtime = imageRenderRuntimeFacts(profile.model);
  const capture = (side: "legacy" | "compiled", prompt: string, segments?: readonly ImagePromptSegment[]) => {
    const result = captureRenderIntent({
      intent: {
        profile,
        prompt,
        ...(segments === undefined ? {} : { promptSegments: segments }),
        references: [...input.references],
        target: { aspectRatio: IMAGE_TARGET_ASPECT },
      },
      runtime,
      requestedOperation: input.requestedOperation,
      subjectIds: [input.subjectId],
      ...(input.digestMeta === undefined ? {} : { digestMeta: input.digestMeta }),
      ...(sink === undefined ? {} : { sink }),
    });
    if (result.ok) return result.capture;
    sink?.push(
      diag("info", IMAGE_SHADOW_CAPTURE_REFUSED, "a shadow transport capture refused to plan", {
        path: PATH,
        context: { lane, side, refusal: result.refusal.code },
      }),
    );
    return null;
  };
  const legacyCapture = capture("legacy", input.legacyPrompt, input.legacySegments);
  const compiledCapture = capture("compiled", compiledText);

  // --- 5. Structural fact lists and the live allowlist ----------------------
  const keptIds = new Set(compiled.compiled.promptProgramProvenance.positiveClaimIds);
  const compiledFactNames = preview.input.subjects
    .flatMap((subject) => subject.facts)
    .filter((fact) => keptIds.has(fact.key))
    .map((fact) => shadowFactName(fact.key, input.subjectId));
  const facts =
    input.legacyFactNames === null ? null : { legacy: input.legacyFactNames, compiled: compiledFactNames };
  const allowlist =
    facts === null ? input.allowlist : liveShadowAllowlist(lane, input.allowlist, facts, sink);

  // --- 6. The verdict --------------------------------------------------------
  const verdict = compareShadowRender({
    lane,
    legacy: { prompt: input.legacyPrompt, capture: legacyCapture },
    compiled: { prompt: compiledText, capture: compiledCapture, missingRequired: preview.missingRequired },
    facts,
    allowlist,
    ...(sink === undefined ? {} : { sink }),
  });
  return shadowComparisonMeta(verdict);
}

/**
 * The total wrapper every lane entry runs through: any failure anywhere in the
 * shadow — the assembly, a hostile profile, the compile, the comparison — is a
 * recorded `error` verdict on the meta fragment, never a thrown render.
 */
function containedShadow(
  lane: CharacterShadowCoreInput["lane"],
  legacyPrompt: string,
  sink: DiagnosticSink | undefined,
  run: () => Record<string, unknown>,
): Record<string, unknown> {
  try {
    return run();
  } catch (error) {
    return shadowComparisonMeta(
      shadowErrorComparison({
        lane,
        error,
        payload: { legacyChars: typeof legacyPrompt === "string" ? legacyPrompt.length : 0, compiledChars: 0 },
        ...(sink === undefined ? {} : { sink }),
      }),
    );
  }
}

// ---------------------------------------------------------------------------
// Lane entries
// ---------------------------------------------------------------------------

/** The standalone read both studio lanes mint — the character row plus every wardrobe row read. */
function standaloneRead(
  characterId: string,
  revision: string,
  extraRevisions: readonly ImageSourceRevision[],
): CharacterWorldReadInput {
  return {
    kind: "standalone_character",
    characters: [{ characterId, revision }],
    extraRevisions: [...extraRevisions],
  };
}

/**
 * The variant kinds' change concepts, for the shadow's operation contract
 * only — production has no change contract yet, and the lane that binds one at
 * cutover owns the final mapping (recorded as an open question on #256). The
 * bench kind restages the whole shot, which is a pose-space change.
 */
const VARIANT_CHANGE_CONCEPTS: Record<VariantKind, ImageConceptId> = {
  pose: "subject.pose",
  outfit: "subject.wardrobe",
  expression: "subject.expression",
  setting: "location.identity",
  nsfw_test: "subject.pose",
};

export interface VariantShadowInput {
  readonly characterId: string;
  readonly characterName: string;
  /** `characters.updatedAt` as ISO — the standalone read's character half. */
  readonly revision: string;
  /** The wardrobe rows the same read touched. */
  readonly extraRevisions: readonly ImageSourceRevision[];
  readonly kind: VariantKind;
  readonly instruction: string;
  readonly assembly: VariantSegmentAssembly;
  readonly profile: ResolvedImageProfile;
  /** The identity references production sends, buffers included. */
  readonly references: readonly ImageRenderReference[];
  readonly sink?: DiagnosticSink;
}

/** The variant lane's shadow: one meta fragment, merged beside the row's reserve-time meta. */
export function variantShadowMeta(input: VariantShadowInput): Record<string, unknown> {
  return containedShadow("variant", input.assembly.prompt, input.sink, () => {
    const { assembly, characterId } = input;
    const visual = assembly.visual;
    return characterShadowCore({
      lane: "variant",
      task: "variant",
      profile: input.profile,
      requestedOperation: "edit",
      subjectId: characterId,
      legacyPrompt: assembly.prompt,
      legacySegments: assembly.segments,
      references: input.references,
      digestMeta: assembly.digestMeta,
      legacyFactNames: legacyShadowFactNames({
        digest: visual.digest,
        subjectId: characterId,
        suppressions: assembly.suppressions,
        missingRequired: assembly.missingRequired,
      }),
      assembly: {
        digest: visual.digest,
        labels: { [characterId]: input.characterName },
        sources: {
          [characterId]: {
            attributes: visual.resolved,
            exposure: visual.exposure,
            realizedBody: visual.realizedBody,
          },
        },
        read: standaloneRead(characterId, input.revision, input.extraRevisions),
        references: referenceFacts("variant", characterId, input.references),
      },
      operation: (subjects) =>
        characterVariantImageOperation({
          change: characterChangeContract(
            { concept: VARIANT_CHANGE_CONCEPTS[input.kind], value: input.instruction.trim() },
            subjects,
          ),
        }),
      allowlist: VARIANT_SHADOW_DELTA,
      ...(input.sink === undefined ? {} : { sink: input.sink }),
    });
  });
}

export interface AvatarShadowInput {
  readonly characterId: string;
  readonly characterName: string;
  readonly revision: string;
  readonly extraRevisions: readonly ImageSourceRevision[];
  readonly assembly: AvatarSegmentAssembly;
  readonly profile: ResolvedImageProfile;
  readonly sink?: DiagnosticSink;
}

/**
 * The avatar lane's shadow. Portrait bindings are PER PROFILE KEY (owner ruling
 * 2026-08-29 #2), so resolution is strict on the lane's own resolved profile
 * key — a key with no row records a binding-missing refusal rather than
 * borrowing a sibling profile's pack pins. The operation states the honest
 * default style (photographic medium, no descriptors); the avatar's
 * realistic/stylized toggle becoming style descriptors is the cutover's own
 * decision, not the shadow's.
 */
export function avatarShadowMeta(input: AvatarShadowInput): Record<string, unknown> {
  return containedShadow("avatar", input.assembly.prompt, input.sink, () => {
    const { assembly, characterId } = input;
    const visual = assembly.visual;
    return characterShadowCore({
      lane: "avatar",
      task: "portrait",
      profile: input.profile,
      bindingProfileKey: input.profile.profile.key,
      requestedOperation: "generate",
      subjectId: characterId,
      legacyPrompt: assembly.prompt,
      legacySegments: assembly.segments,
      references: [],
      digestMeta: assembly.digestMeta,
      legacyFactNames: legacyShadowFactNames({
        digest: visual.digest,
        subjectId: characterId,
        suppressions: assembly.suppressions,
        missingRequired: assembly.missingRequired,
      }),
      assembly: {
        digest: visual.digest,
        labels: { [characterId]: input.characterName },
        sources: {
          [characterId]: {
            attributes: visual.resolved,
            exposure: visual.exposure,
            realizedBody: visual.realizedBody,
          },
        },
        read: standaloneRead(characterId, input.revision, input.extraRevisions),
      },
      operation: () => characterPortraitImageOperation(),
      allowlist: AVATAR_SHADOW_DELTA,
      ...(input.sink === undefined ? {} : { sink: input.sink }),
    });
  });
}

export interface ChatLookShadowInput {
  readonly characterId: string;
  /** The mint has no display name in scope; a label is recorded only when one exists. */
  readonly characterName?: string;
  /** The committed chat cut's id — the read token the shadow records. */
  readonly cutId: string;
  readonly outfit: string;
  readonly outfitExposed: boolean;
  readonly assembly: ChatLookSegmentAssembly;
  readonly profile: ResolvedImageProfile;
  readonly references: readonly ImageRenderReference[];
  readonly sink?: DiagnosticSink;
}

/**
 * The chat-look mint's shadow. Runs only when the assembly realized a cut
 * (`assembly.visual`); the route-only degraded mint has no digest to compile
 * and records nothing. The change contract states the same delta the operation
 * sentence does — the outfit the conversation settled on.
 */
export function chatLookShadowMeta(input: ChatLookShadowInput): Record<string, unknown> | undefined {
  const visual = input.assembly.visual;
  if (visual === undefined) return undefined;
  return containedShadow("chat_look", input.assembly.prompt, input.sink, () => {
    const { assembly, characterId } = input;
    const outfit = input.outfit.trim();
    return characterShadowCore({
      lane: "chat_look",
      task: "chat_look",
      profile: input.profile,
      requestedOperation: "edit",
      subjectId: characterId,
      legacyPrompt: assembly.prompt,
      legacySegments: assembly.segments,
      references: input.references,
      ...(assembly.digestMeta === undefined ? {} : { digestMeta: assembly.digestMeta }),
      legacyFactNames: legacyShadowFactNames({
        digest: visual.digest,
        subjectId: characterId,
        suppressions: assembly.suppressions,
        missingRequired: assembly.missingRequired,
      }),
      assembly: {
        digest: visual.digest,
        ...(input.characterName === undefined ? {} : { labels: { [characterId]: input.characterName } }),
        sources: {
          [characterId]: {
            attributes: visual.attributes,
            exposure: visual.exposure,
            realizedBody: visual.realizedBody,
          },
        },
        read: { kind: "committed_cut", token: input.cutId },
        references: referenceFacts("chat_look", characterId, input.references),
      },
      operation: (subjects) =>
        characterChatLookImageOperation({
          change: characterChangeContract(
            {
              concept: "subject.wardrobe",
              value: outfit || (input.outfitExposed ? "undressed" : "a simple, casual outfit"),
            },
            subjects,
          ),
        }),
      allowlist: CHAT_LOOK_SHADOW_DELTA,
      ...(input.sink === undefined ? {} : { sink: input.sink }),
    });
  });
}

// ---------------------------------------------------------------------------
// The scene lane
// ---------------------------------------------------------------------------

/**
 * What the scene render hands its shadow: the one realized cut when the cast is
 * a single subject with a digest, or the multi-subject marker — a cast of two
 * or more has no frozen row by design and records `unmeasured` instead of a
 * comparison nobody blessed.
 */
export type CharacterSceneShadow =
  | { readonly kind: "single"; readonly slice: SceneSubjectVisualSlice }
  | { readonly kind: "multi_subject"; readonly subjectIds: readonly string[] };

export interface SceneShadowInput {
  readonly shadow: CharacterSceneShadow;
  /** The profile the render actually runs on — the LoRA wrapper when the route swapped it. */
  readonly profile: ResolvedImageProfile | null;
  /** True when the intimate-LoRA route is riding this render. */
  readonly loraRoute: boolean;
  /** The chain's primary rung — the render the reserve-time row describes. */
  readonly primaryAttempt: SceneAttemptId | undefined;
  /** The exact prompt the row stores for that rung. */
  readonly legacyPrompt: string;
  /** The references that rung sends, buffers included, in send order. */
  readonly references: readonly ImageRenderReference[];
  /** The scene row's `meta.visualState` fragment, when the digest built one. */
  readonly digestMeta?: Record<string, unknown>;
  readonly sink?: DiagnosticSink;
}

/**
 * The scene lane's shadow, run where the reserve-time row is written so the
 * legacy side is byte-identical to what the row records. Returns undefined
 * when there is nothing honest to record at all (demo mode, no rung, no cut);
 * a LoRA-route render and a multi-subject cast return recorded refusals.
 */
export function sceneShadowMeta(input: SceneShadowInput): Record<string, unknown> | undefined {
  const { shadow, profile, sink } = input;
  if (shadow.kind === "multi_subject") {
    return shadowComparisonMeta(
      shadowUnmeasuredComparison({
        lane: "scene",
        code: IMAGE_SHADOW_MULTI_SUBJECT,
        message: "a cast of two or more has no frozen comparison row by design",
        context: { subjectIds: [...shadow.subjectIds] },
        payload: { legacyChars: input.legacyPrompt.length, compiledChars: 0 },
        ...(sink === undefined ? {} : { sink }),
      }),
    );
  }
  if (profile === null || input.primaryAttempt === undefined || input.primaryAttempt === "demo") return undefined;
  if (input.loraRoute) {
    return shadowComparisonMeta(
      shadowUnmeasuredComparison({
        lane: "scene",
        code: IMAGE_SHADOW_LORA_ROUTE,
        message: "the intimate-LoRA route swapped this render onto the wrapper slug",
        context: { slug: profile.model.slug },
        payload: { legacyChars: input.legacyPrompt.length, compiledChars: 0 },
        ...(sink === undefined ? {} : { sink }),
      }),
    );
  }
  const kind: ImageProfileOperation = input.primaryAttempt === "generate" ? "generate" : "edit";
  return containedShadow("scene", input.legacyPrompt, sink, () => {
    const slice = shadow.slice;
    return characterShadowCore({
      lane: "scene",
      task: "scene",
      profile,
      requestedOperation: kind,
      subjectId: slice.subjectId,
      legacyPrompt: input.legacyPrompt,
      references: input.references,
      ...(input.digestMeta === undefined ? {} : { digestMeta: input.digestMeta }),
      legacyFactNames: legacyShadowFactNames({
        digest: slice.digest,
        subjectId: slice.subjectId,
        suppressions: slice.suppressions,
        missingRequired: slice.missingRequired,
      }),
      assembly: {
        digest: slice.digest,
        labels: { [slice.subjectId]: slice.name },
        sources: {
          [slice.subjectId]: {
            attributes: slice.attributes,
            exposure: slice.exposure,
            realizedBody: slice.realizedBody,
          },
        },
        read: { kind: "committed_cut", token: slice.cutId },
        references: referenceFacts("scene", slice.subjectId, input.references),
      },
      operation: () => characterSceneImageOperation({ subjectCount: 1, kind }),
      allowlist: kind === "generate" ? SCENE_T2I_DRESSED_SHADOW_DELTA : SCENE_REFERENCE_SHADOW_DELTA,
      ...(sink === undefined ? {} : { sink }),
    });
  });
}
