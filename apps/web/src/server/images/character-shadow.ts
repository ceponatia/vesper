import {
  IMAGE_TARGET_ASPECT,
  type ImageOperationContract,
  type ImageProfileOperation,
  type ImagePromptSegment,
  type ImageRenderReference,
  type ImageSourceRevision,
  type ImageSubjectDigest,
  type ResolvedImageProfile,
  type SceneAttemptId,
} from "@vesper/image-core";
import { VISUAL_STATE_SPECIES_FEATURE_GROUP_KIND_ID } from "@/contracts";
import { diag, type DiagnosticSink } from "@/contracts/diagnostics";
import {
  characterChangeContract,
  characterChatLookImageOperation,
  characterPortraitImageOperation,
  characterSceneImageOperation,
  type CharacterWorldReadInput,
} from "@/contracts/images/character-digest";
import type { AvatarSegmentAssembly } from "./avatar-segments";
import {
  buildCharacterPromptProgram,
  variantChangeOperation,
  IMAGE_CHARACTER_PROMPT_PACK_MISSING,
  type CharacterPromptSubjectCut,
} from "./character-prompt-program";
import type { ChatLookSegmentAssembly } from "./chat-look-segments";
import { imageRenderRuntimeFacts } from "./model-adapters";
import type { VariantKind } from "./prompts-variant";
import { captureRenderIntent, type RenderIntentCapture } from "./render-intent-capture";
import type { SceneSubjectVisualSlice } from "./scene-subject-visual";
import {
  compareShadowRender,
  shadowComparisonMeta,
  shadowErrorComparison,
  shadowUnmeasuredComparison,
  type ShadowCoverageAllowlist,
} from "./shadow-comparison";
import type { VariantSegmentAssembly } from "./variant-segments";

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
 * 1. Build the prompt program through `buildCharacterPromptProgram` — the
 *    SHARED seam (`character-prompt-program.ts`), which owns the assembly, the
 *    operation contract, the binding, the packs, reference planning, the budget
 *    and the compile. This module owns none of that any more, deliberately: the
 *    prompt a cutover ships must come from the same path the shadow measured,
 *    and two implementations would let this verdict describe a prompt nobody
 *    sends. The shadow's only two arguments to that seam are its own:
 *    `resolver: "shadow"`, which widens resolution to the `candidate` rows
 *    production cannot see, and `refuseOnMissingRequired: false`, because the
 *    shadow's job is to MEASURE a lost anchor (as `mandatory_lost`), not to
 *    refuse over it. `unbound` is a recorded refusal, not an error — null is
 *    the ordinary answer during a staged rollout.
 * 2. Capture both transports (`captureRenderIntent`) over the same profile,
 *    references and target — only the prompt differs, which is the migration.
 *    The compiled side's intent additionally carries the program's compiled
 *    NEGATIVE through the intent's controls seam when the dialect produced
 *    one (owner correction 2026-08-29 #5), so `negativeHash` compares the
 *    program's negative rather than the legacy profile's resolution; on the
 *    Qwen endpoints the program compiles none and the seam is inert.
 * 3. Compare (`compareShadowRender`) with STRUCTURAL fact lists: the legacy
 *    side is the segment build's EMISSION LEDGER — the fact keys recorded at
 *    the moment each clause landed in a sent segment (owner correction
 *    2026-08-29 #3), never digest-minus-suppressions, which would count a
 *    fact a buggy builder silently dropped and report false parity — and the
 *    compiled side is the program's kept subject-fact claims, both under
 *    canonical shadow fact names. The route-owned prose residue (a scene's
 *    residual attribute sheet) is outside this fact space on BOTH sides; the
 *    fixture suites own that space. A lane input that genuinely lacks a
 *    ledger keeps the unmeasured path: coverage reads null, never invented.
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

/** No candidate or active binding for this model slug and task — nothing to shadow here. */
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
/**
 * A fallback rung won the scene chain and no shadow could be recomputed for
 * it — the primary rung's verdict was DISCARDED rather than left beside the
 * winning rung's prompt and model, because a row pairing one rung's provenance
 * with another rung's comparison corrupts the shadow dataset.
 */
export const IMAGE_SHADOW_RUNG_FALLBACK = "image_shadow.rung_fallback";
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
 * The legacy side's structural fact list: the segment build's EMISSION LEDGER
 * under canonical shadow names. The ledger is recorded at the moment each fact
 * became a sent segment (`VisualSubjectSegmentsBuild.emitted`, restricted by
 * the scene lane to what its transport actually states), so it is evidence of
 * what the builder actually emitted — never a derivation from the digest minus
 * the recorded exclusions, which would count a fact a buggy builder silently
 * dropped (no suppression, no missing-required entry) and, with the compiled
 * side built from the same digest, report FALSE PARITY on the exact defect the
 * shadow exists to catch (owner correction 2026-08-29 #3).
 *
 * Exposure rides the ledger under `<subjectId>/exposure.<region>`, which this
 * canonicalization reduces to the same `exposure.<region>` the adapter's
 * synthesized `subject.exposure` facts reduce to — so a bare in-frame region
 * both prompts state reads as agreement, and a compiled exposure key the
 * legacy build never emitted stays a real, reported divergence.
 */
export function ledgerShadowFactNames(emittedFactKeys: readonly string[], subjectId: string): string[] {
  return [...new Set(emittedFactKeys.map((key) => shadowFactName(key, subjectId)))];
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
// One subject's cut, adapted for the core
// ---------------------------------------------------------------------------

/**
 * The realized cut every lane hands over: the shared seam's production-neutral
 * cut, plus the one field only a comparison has any use for.
 */
interface SubjectShadowCut extends CharacterPromptSubjectCut {
  /**
   * The lane's emission ledger, or null for an input that genuinely lacks one
   * — coverage then reads unmeasured rather than being derived.
   */
  readonly emittedFactKeys: readonly string[] | null;
}

/**
 * The cut's two halves, split at the line the shared seam draws: the structural
 * legacy fact list stays here, and the cut itself goes to the program builder
 * with the ledger stripped off. Reference FACTS are no longer built here at all
 * — the seam derives them from the PLANNED send list, so the facts and the
 * prompt's slot numbers describe the same payload.
 */
function cutShadowInputs(
  cut: SubjectShadowCut,
  read: CharacterWorldReadInput,
): Pick<CharacterShadowCoreInput, "legacyFactNames" | "cut" | "read"> {
  const { emittedFactKeys, ...promptCut } = cut;
  return {
    legacyFactNames: emittedFactKeys === null ? null : ledgerShadowFactNames(emittedFactKeys, cut.subjectId),
    cut: promptCut,
    read,
  };
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
  /** The realized cut the shared seam compiles from, ledger stripped. */
  readonly cut: CharacterPromptSubjectCut;
  readonly read: CharacterWorldReadInput;
  /** Built over the assembled subjects so a change contract can derive its preserve set. */
  readonly operation: (subjects: readonly ImageSubjectDigest[]) => ImageOperationContract;
  readonly allowlist: ShadowCoverageAllowlist;
  readonly sink?: DiagnosticSink;
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

  // --- 1. Build the program through the SHARED seam -------------------------
  // Same path production compiles, with the shadow's two arguments: the widened
  // resolver, and tolerance of a lost anchor so the loss can be MEASURED rather
  // than ending the comparison. Every outcome the seam distinguishes maps onto
  // this lane's own recorded refusal codes; none of them fails a render.
  const program = buildCharacterPromptProgram({
    lane,
    task: input.task,
    profile,
    ...(input.bindingProfileKey === undefined ? {} : { bindingProfileKey: input.bindingProfileKey }),
    resolver: "shadow",
    // A cast of one: every lane this module observes renders a single subject,
    // and the multi-subject scene records its own designed `unmeasured` verdict
    // before reaching here.
    cuts: [input.cut],
    read: input.read,
    references: input.references.map((reference) => ({ reference, subjectId: input.subjectId })),
    operation: input.operation,
    refuseOnMissingRequired: false,
    ...(sink === undefined ? {} : { sink }),
  });
  if (program.kind === "unbound") {
    return unmeasured(IMAGE_SHADOW_BINDING_MISSING, "no prompt program is bound to this model for this lane", {
      slug: program.modelSlug,
      task: program.task,
      ...(program.profileKey === null ? {} : { profileKey: program.profileKey }),
    });
  }
  if (program.kind === "refused") {
    return program.code === IMAGE_CHARACTER_PROMPT_PACK_MISSING
      ? unmeasured(IMAGE_SHADOW_PACK_MISSING, "a bound prompt pack version is not registered", program.context)
      : unmeasured(IMAGE_SHADOW_COMPILE_REFUSED, "the shadow's prompt program refused to compile", {
          refusal: program.code,
          message: program.refusal,
        });
  }
  const compiledText = program.prompt;

  // --- 4. Capture both transports -------------------------------------------
  const runtime = imageRenderRuntimeFacts(profile.model);
  const capture = (
    side: "legacy" | "compiled",
    prompt: string,
    options?: {
      readonly segments?: readonly ImagePromptSegment[] | undefined;
      readonly negative?: string | null | undefined;
    },
  ): RenderIntentCapture | null => {
    const segments = options?.segments;
    const negative = options?.negative ?? null;
    const result = captureRenderIntent({
      intent: {
        profile,
        prompt,
        ...(segments === undefined ? {} : { promptSegments: segments }),
        // The compiled side's intent carries the PROGRAM's negative channel
        // through the intent's own controls seam (owner correction 2026-08-29
        // #5): `planImageRender` resolves a requested negative over the
        // profile's default exactly as a cutover render would, so this side's
        // `negativeHash` hashes what the program actually compiled — not
        // whatever the legacy profile happens to resolve. On the Qwen
        // endpoints the program compiles NO negative (2511 exposes no field;
        // 2512's is ignored and the dialect declares unsupported), nothing is
        // passed, and the constructed intent is byte-identical to before —
        // the seam is armed for the first endpoint whose field works.
        ...(negative === null || negative.length === 0 ? {} : { controls: { negativePrompt: negative } }),
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
  const legacyCapture = capture("legacy", input.legacyPrompt, { segments: input.legacySegments });
  const compiledCapture = capture("compiled", compiledText, { negative: program.negativePrompt });

  // --- 5. Structural fact lists and the live allowlist ----------------------
  const keptIds = new Set(program.keptClaimIds);
  const compiledFactNames = program.subjects
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
    compiled: { prompt: compiledText, capture: compiledCapture, missingRequired: program.missingRequired },
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
      ...cutShadowInputs(
        {
          subjectId: characterId,
          name: input.characterName,
          digest: visual.digest,
          attributes: visual.resolved,
          exposure: visual.exposure,
          realizedBody: visual.realizedBody,
          emittedFactKeys: assembly.emittedFactKeys,
        },
        standaloneRead(characterId, input.revision, input.extraRevisions),
      ),
      // The SHARED operation builder — production compiles the same change
      // contract from the same concept mapping, so the verdict this run records
      // describes the program a cutover would actually ship.
      operation: variantChangeOperation(input.kind, input.instruction),
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
      ...cutShadowInputs(
        {
          subjectId: characterId,
          name: input.characterName,
          digest: visual.digest,
          attributes: visual.resolved,
          exposure: visual.exposure,
          realizedBody: visual.realizedBody,
          emittedFactKeys: assembly.emittedFactKeys,
        },
        standaloneRead(characterId, input.revision, input.extraRevisions),
      ),
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
      ...cutShadowInputs(
        {
          subjectId: characterId,
          ...(input.characterName === undefined ? {} : { name: input.characterName }),
          digest: visual.digest,
          attributes: visual.attributes,
          exposure: visual.exposure,
          realizedBody: visual.realizedBody,
          // Present whenever the mint realized a cut; `?? null` keeps the
          // unmeasured degradation for a hostile or pre-ledger assembly value.
          emittedFactKeys: assembly.emittedFactKeys ?? null,
        },
        { kind: "committed_cut", token: input.cutId },
      ),
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
  /**
   * The rung the stored row describes — the chain's primary at reserve time,
   * or the WINNING rung when a fallback correction recomputes the shadow
   * ({@link sceneFallbackShadowMeta}).
   */
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
      ...cutShadowInputs(slice, { kind: "committed_cut", token: slice.cutId }),
      operation: () => characterSceneImageOperation({ subjectCount: 1, kind }),
      allowlist: kind === "generate" ? SCENE_T2I_DRESSED_SHADOW_DELTA : SCENE_REFERENCE_SHADOW_DELTA,
      ...(sink === undefined ? {} : { sink }),
    });
  });
}

/**
 * The shadow for the WINNING rung, when a later rung of the scene chain won
 * after the primary failed. The reserve-time record compared the primary
 * rung's request, and the fallback correction rewrites the row's prompt,
 * model and identity provenance to the winning rung — leaving the old record
 * in place would pair that rung's provenance with a verdict measured over a
 * DIFFERENT prompt, model shape and reference set, corrupting the shadow
 * dataset. The recompute runs over the winning rung's own prompt and send
 * list (all in scope at correction time), so the stored record describes the
 * render the row actually kept; in the degenerate case where the winning rung
 * yields no shadow at all, the stale record is REPLACED by an explicit
 * unmeasured verdict under {@link IMAGE_SHADOW_RUNG_FALLBACK} — a row must
 * never present one rung's request beside another rung's comparison.
 */
export function sceneFallbackShadowMeta(input: SceneShadowInput): Record<string, unknown> {
  return (
    sceneShadowMeta(input) ??
    shadowComparisonMeta(
      shadowUnmeasuredComparison({
        lane: "scene",
        code: IMAGE_SHADOW_RUNG_FALLBACK,
        message: "a fallback rung won and no shadow could be recomputed for it — the primary rung's verdict is discarded",
        context: { attempt: input.primaryAttempt ?? null },
        payload: { legacyChars: input.legacyPrompt.length, compiledChars: 0 },
        ...(input.sink === undefined ? {} : { sink: input.sink }),
      }),
    )
  );
}
