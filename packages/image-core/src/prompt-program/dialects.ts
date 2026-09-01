import type { DiagnosticSink } from "@vesper/contracts";
import type { ImageReferenceRole } from "../capabilities/image-model-capabilities";
import {
  fitImagePromptSegments,
  joinImagePromptSegments,
  normalizeImagePromptSegments,
  reportImagePromptFitting,
  type ImagePromptBudget,
  type ImagePromptSegment,
} from "../render-intent/prompt-segments";
import type { ImageNegativeBlockId, ImageNegativeConstraint, ImageNegativeGuard } from "./negative-constraints";
import { isMandatoryImagePositiveClaim, type ImagePositiveClaim } from "./positive-claims";
import type { ImageOperationContract } from "./world-digest";

/**
 * The endpoint dialect registry.
 *
 * A dialect is how ONE endpoint wants a job expressed — long concrete prose for
 * Qwen Image 2512, a delta-first numbered instruction for Qwen Image Edit 2511,
 * Compel tags for a Pony wrapper. It is a different axis from `promptStrategy`,
 * which says what the job IS, and keeping them apart is what stops the template
 * matrix: strategy × model × entity fields would otherwise
 * multiply into a file per combination.
 *
 * The registry is CODE and closed. A profile row selects an entry by id; it can
 * never carry a template. That rule has a security edge as
 * well as an engineering one — a malformed or adversarial whole-prompt template
 * must not become production behavior through an admin text field.
 *
 * Two entries may delegate to one implementation without becoming permanently
 * coupled: each still has its own id, its own trial verdict and its own pack
 * binding, so promoting a finding for Seedream 4.5 does not silently change
 * Seedream 5 Lite.
 */

/**
 * Every dialect id Vesper's endpoints may name.
 *
 * The full list, not only the implemented ones. A profile binding referring to an
 * id with no registered compiler REFUSES rather than falling back to a generic
 * prompt, and that refusal is only expressible if the id is a legal value in
 * the first place. It also means the
 * cutover order is visible: the ids are here, the compilers arrive one endpoint
 * at a time behind their own trials.
 */
export const imagePromptDialectIds = [
  "qwen_2512_description",
  "qwen_2511_delta_edit",
  // The LoRA-capable Qwen edit wrapper the intimate-scene and NSFW-bench routes
  // swap onto after profile resolution. Its own id, delegating to the 2511
  // implementation: same instruction-edit family and same numbered-slot
  // convention, but a separate endpoint whose trial verdicts and pack bindings
  // must be able to move without touching 2511's.
  "qwen_edit_plus_lora_delta_edit",
  "seedream_45_prose",
  "seedream_5_lite_prose",
  "wan_27_prose",
  "sd35_large_prose",
  "flux_dev_positive_replacement",
  "pony_compel_tags",
  "sdxl_pulid_tags",
  "p_image_prose",
] as const;
export type ImagePromptDialectId = (typeof imagePromptDialectIds)[number];

/**
 * A prompt channel the PROVIDER contributes without being asked — provider
 * defaults are part of the effective prompt.
 *
 * Vesper cannot claim to manage a prompt separately from a model while an
 * invisible wrapper default keeps altering it. Every one of these is declared per
 * endpoint and recorded in provenance, so "the negative was empty" means the
 * provider sent nothing rather than that Vesper did not look.
 */
export interface HiddenPromptSource {
  readonly kind:
    | "provider_default_negative"
    | "injected_preprompt"
    | "prompt_upsampler"
    | "adetailer"
    | "refiner"
    | "quality_preamble";
  /** The provider field the source lives on, or a stable name when it has none. */
  readonly field: string;
  /** The default text, when the endpoint documents one. Empty string is a real answer. */
  readonly value?: string;
  /** Whether Vesper can override it through a declared input field. */
  readonly overridable: boolean;
}

/** How one exclusion actually travels to this endpoint. */
export type ResolvedNegativeTransport =
  | { readonly kind: "dedicated_field"; readonly text: string }
  | { readonly kind: "inline_instruction"; readonly text: string }
  | { readonly kind: "positive_replacement"; readonly claims: readonly ImagePositiveClaim[] }
  | { readonly kind: "dropped"; readonly reason: string };

/** One constraint and what became of it. */
export interface ImageNegativeTransportOutcome {
  readonly constraintId: ImageNegativeBlockId;
  readonly transport: ResolvedNegativeTransport;
}

/** A reference slot as the prompt will name it, after planning and trimming. */
export interface ImageDialectReference {
  /** 1-based position in the SEND order — never the order a lane supplied. */
  readonly position: number;
  readonly role: ImageReferenceRole;
  /** The entity ref this image depicts, when naming it keeps two slots apart. */
  readonly subjectRef?: string;
}

/** Everything a positive compile may read. Notably NOT the world digest. */
export interface ImageDialectPositiveInput {
  readonly claims: readonly ImagePositiveClaim[];
  readonly operation: ImageOperationContract;
  readonly references: readonly ImageDialectReference[];
  /**
   * What each entity ref may be CALLED in a sentence, keyed by ref.
   *
   * A relation claim carries two refs and no words, so a dialect writing "she
   * holds the red umbrella" needs somewhere to look them up. Passing a flat label
   * map rather than the entities themselves is the same discipline as the guard
   * record on the negative side: the dialect gets exactly the question it needs
   * answered, and cannot start reading facts the claim list did not offer it.
   */
  readonly entityLabels: Readonly<Record<string, string>>;
  readonly budget: ImagePromptBudget;
  readonly sink?: DiagnosticSink;
}

export interface ImageCompiledPositivePrompt {
  readonly text: string;
  /** The rendered units, after fitting — provenance, and the fitter's own record. */
  readonly segments: readonly ImagePromptSegment[];
  /** Claim ids that did not survive the budget. */
  readonly droppedClaimIds: readonly string[];
}

/** Everything a negative compile may read. Again, no digest. */
export interface ImageDialectNegativeInput {
  readonly constraints: readonly ImageNegativeConstraint[];
  readonly guard: ImageNegativeGuard;
  readonly hiddenSources: readonly HiddenPromptSource[];
  readonly budget: ImagePromptBudget;
  readonly sink?: DiagnosticSink;
}

export interface ImageCompiledNegativePrompt {
  /** The dedicated field's value, or null when this endpoint has no field or nothing to say. */
  readonly text: string | null;
  /** Exclusions that became affirmative claims, for merging into the positive list. */
  readonly replacementClaims: readonly ImagePositiveClaim[];
  /** Exclusions phrased inside the main instruction, in emission order. */
  readonly inlineText: readonly string[];
  readonly outcomes: readonly ImageNegativeTransportOutcome[];
}

/** One endpoint's complete prompt behavior. */
export interface ImagePromptDialectDefinition {
  readonly id: ImagePromptDialectId;
  readonly positiveSyntax: "natural_language" | "compact_tags" | "compel_tags";
  readonly negativeSyntax: "natural_language" | "compact_tags" | "compel_tags" | "none";
  readonly negativeTransport: "dedicated_field" | "inline_instruction" | "positive_replacement" | "unsupported";
  readonly referenceSyntax: "none" | "numbered_images" | "role_labels";
  readonly supportsWeights: boolean;
  readonly supportsLiteralQuotes: boolean;
  /** What this endpoint adds on its own. Empty means "probed and there is nothing". */
  readonly hiddenPromptSources: readonly HiddenPromptSource[];
  compilePositive(input: ImageDialectPositiveInput): ImageCompiledPositivePrompt;
  compileNegative(input: ImageDialectNegativeInput): ImageCompiledNegativePrompt;
}

const registry = new Map<ImagePromptDialectId, ImagePromptDialectDefinition>();

/**
 * Register one dialect. Called once per module at import time from the package
 * barrel, which is what keeps the registry a closed set rather than something a
 * caller can extend at runtime.
 */
export function registerImagePromptDialect(definition: ImagePromptDialectDefinition): void {
  registry.set(definition.id, definition);
}

/**
 * The dialect for an id, or null when nothing implements it yet.
 *
 * Null is the refusal path. Every declared id has a registered compiler as of
 * the #256 cutover, so null now means a caller named an id outside the closed
 * list — but the path stays, because the list is where a new endpoint is
 * declared before its compiler is written.
 */
export function imagePromptDialect(id: string): ImagePromptDialectDefinition | null {
  return registry.get(id as ImagePromptDialectId) ?? null;
}

/** Whether an arbitrary string is a declared dialect id, implemented or not. */
export function isImagePromptDialectId(id: string): id is ImagePromptDialectId {
  return (imagePromptDialectIds as readonly string[]).includes(id);
}

/** The ids with a registered compiler, in registration order — for admin surfaces. */
export function implementedImagePromptDialectIds(): readonly ImagePromptDialectId[] {
  return [...registry.keys()];
}

/**
 * Render, fit and join one claim list — the shared half of every prose dialect.
 *
 * Dialects differ in WORDING, not in how a budget squeeze picks what to lose:
 * the mandatory floor, the compress-then-remove order and the over-budget
 * diagnostic are `@vesper/image-core`'s existing, tested behavior, and a second
 * copy per dialect would be a second answer to "what did this render give up".
 * So a dialect supplies `render` — one claim to one segment, or null to say it
 * has no wording for that concept — and this does the rest.
 *
 * A claim a dialect cannot render is REPORTED rather than silently skipped. That
 * is the honest failure for a new concept meeting an old dialect, and the
 * compile step turns a dropped MANDATORY claim into a refusal.
 */
export function compileDialectClaims(input: {
  readonly claims: readonly ImagePositiveClaim[];
  readonly render: (claim: ImagePositiveClaim) => ImagePromptSegment | null;
  readonly budget: ImagePromptBudget;
  readonly sink?: DiagnosticSink;
}): ImageCompiledPositivePrompt {
  const segments: ImagePromptSegment[] = [];
  const droppedClaimIds: string[] = [];
  for (const claim of input.claims) {
    const segment = input.render(claim);
    // A dialect with no wording for a concept says so, and the claim is recorded
    // as dropped. Silently skipping would make a new concept meeting an old
    // dialect look like a render that simply chose not to mention it.
    if (segment === null) droppedClaimIds.push(claim.id);
    // The claim id rides `source`, which is diagnostic-only and never reaches a
    // provider. It is also the most precise provenance available: the claim
    // already carries the owner's own source ref, so naming the claim names the
    // projection too, and fitting can then report exactly which semantic unit a
    // budget squeeze removed instead of only its kind.
    // `mandatory` is decided HERE rather than left to the dialect, and rather
    // than left to `normalizeImagePromptSegments` to promote: the claim already
    // knows whether it is protected — by the projection's disposition and by its
    // segment kind — so re-deriving it downstream would emit a promotion warning
    // on every optional claim that happens to sit in a protected kind.
    else segments.push({ ...segment, mandatory: isMandatoryImagePositiveClaim(claim), source: claim.id });
  }
  const fitted = fitImagePromptSegments(normalizeImagePromptSegments(segments, input.sink), input.budget);
  reportImagePromptFitting(fitted, input.budget, input.sink);
  for (const removed of fitted.removed) {
    if (removed.source !== undefined) droppedClaimIds.push(removed.source);
  }
  return {
    text: joinImagePromptSegments(fitted.segments),
    segments: fitted.segments,
    droppedClaimIds: [...new Set(droppedClaimIds)].sort(),
  };
}
