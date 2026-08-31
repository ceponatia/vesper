import { compileImagePromptSegments, orderImagePromptSegments, type ImagePromptSegment } from "@vesper/image-core";
import {
  AFFORDANCE_UNIT_ONE,
  type DiagnosticSink,
  type SceneCameraSpec,
  type VisualStateSuppression,
} from "@/contracts";
import type { CharacterProfile } from "@/contracts/world/profile";
import { intimateAnatomySummary } from "./prompts-appearance";
import { toWornInputs, type AvatarWardrobeItem } from "./prompts-avatar";
import { characterIdentityAnchorLedgerKey } from "@/contracts/images/character-digest";
import { NSFW_TEST_VARIANT_KIND, PORTRAIT_IDENTITY_LOCK, type VariantKind } from "./prompts-variant";
import { buildStandaloneSubjectVisual, type StandaloneSubjectVisual } from "./standalone-subject-visual";

/**
 * THE VARIANT/EDIT LANE'S SEGMENT ASSEMBLY: the requested delta is expressed as
 * an operation/change contract, while identity, morphology, age, and unchanged
 * wardrobe/scene facts remain separate mandatory segments.
 *
 * `generateVariant` calls this once, sets BOTH `prompt` and
 * `intent.promptSegments`, and records `digestMeta` on the row at reserve time.
 * Setting both is safe precisely because this lane's profiles run
 * `instruction_edit`, which returns the base prompt unchanged — so the compiled
 * segments ARE the request, with no strategy rewriting underneath them.
 *
 * ## What the digest adds, and what it deliberately does not (owner ruling)
 *
 * Before this cutover the variant prompt stated a fixed identity lock, an age
 * string the caller computed, the requested change, and nothing else about the
 * person — the pre-migration freeze recorded exactly that gap.
 *
 * The ruling that closes it is narrow: the prompt gains ONLY what the standalone
 * digest naturally projects — species feature groups and anatomy departures (the
 * morphology anchors an image model "corrects" away — a tail becomes a belt, a
 * digitigrade leg becomes a human one) and the cataloged distinctive marks.
 * Hair, eye and skin colour are NOT stated: they come off the reference photo,
 * which is a better source than any sentence, and a text anchor beside them only
 * competes with the picture.
 *
 * Consequently this lane has NO route-owned residual attribute sheet — unlike
 * the avatar lane, which has one and therefore has to omit the cataloged marks
 * from its digest clauses to avoid saying them twice. Here the digest's mark
 * clause is the ONLY statement, so the clause resolver runs with an empty omit
 * set.
 *
 * ## The route-owned segments
 *
 * - `identity` — {@link PORTRAIT_IDENTITY_LOCK}, byte-identical. The Qwen
 *   family's dialect rewrites exactly that sentence into numbered-reference
 *   wording (`packages/image-models/src/families/qwen/shared.ts`); a paraphrase
 *   here would silently stop matching and every Qwen edit would quietly revert
 *   to the generic lock with no error anywhere. Stage 5 replaces the pair with a
 *   compiled identity semantic; until then the bytes are the contract.
 * - `age` — `apparentAgeAnchor`, wording unchanged (owner ruling 2026-07-29:
 *   "preserve apparent age" alone preserves the model's own over-read, so every
 *   generation drifts a step older). Emitted only when the anchor is non-empty:
 *   the minor and unknown bands produce none, and an EMPTY mandatory segment is
 *   worse than an absent one. A missing anchor is deliberately not a missing
 *   REQUIRED fact — it must never refuse a render.
 * - `operation` — the requested delta, the plan's operation/change contract.
 * - `wardrobe` — the outfit-keep line, for the kinds that keep an outfit.
 *   `outfit` and `nsfw_test` emit NONE: there the wardrobe is the operation's
 *   target, an authoritative wardrobe line would contradict the instruction, and
 *   mandatory segments cannot be dropped by fitting — so the contradiction would
 *   travel all the way to the provider.
 * - `morphology` — the bench kind's anatomy line from `intimateAnatomySummary`,
 *   kept ROUTE-owned with {@link VARIANT_SEGMENT_POLICY}'s `intimate: "never"`
 *   beside it. That bench render exists to state the sheet's intimate anatomy
 *   with no exposure state at all; routing it through the digest's coverage gate
 *   would silently delete it the moment the character owns a wardrobe.
 * - `quality` — the shared tail, wording unchanged.
 *
 * ## Failure behavior
 *
 * Non-empty `missingRequired` means a required digest fact resolved no clause:
 * `generateVariant` refuses through `failedPrecondition`, BEFORE any provider
 * spend and without pushing a generation-failure diagnostic — a render that
 * never ran did not fail to generate.
 *
 * Pure: no IO, no env, no clock.
 */

// ---------------------------------------------------------------------------
// Lane policy
// ---------------------------------------------------------------------------

/**
 * The variant task's segment policy.
 *
 * - `age: "state"` — the avatar and variant lanes are the two that anchor age,
 *   because they are the two an edit model drifts (narrative/visual age split).
 * - `frame: "full_figure"` — a pose, setting or bench restage is not a waist-up
 *   portrait, and below-waist morphology (a tail, digitigrade legs) is exactly
 *   the anchor the edit must not lose. A waist-up frame would cut it.
 * - `intimate: "never"` — the digest adds no intimate anatomy of its own; the
 *   bench kind's anatomy line is route-owned and stated on purpose.
 * - `exposure: "omit"` — coverage belongs to the REFERENCE image, and the
 *   requested change may be exactly the coverage. An authoritative "the torso
 *   is bare" beside the instruction would either restate it or contradict it.
 */
export const VARIANT_SEGMENT_POLICY = {
  age: "state",
  frame: "full_figure",
  intimate: "never",
  exposure: "omit",
} as const;

/**
 * The edit's fixed viewpoint: facing the camera at full-figure distance, which
 * `visualCameraReadsOfSceneCamera` maps to the `full_figure` framing band —
 * the same whole-body read {@link VARIANT_SEGMENT_POLICY} applies, so the
 * selection and the segment policy cannot disagree about what is in frame.
 */
export const VARIANT_EDIT_CAMERA: SceneCameraSpec = {
  orientation: "toward_viewer",
  distance: "full_figure",
  height: "eye_level",
};

/** The camera id the selection fingerprints — this lane's fixed viewpoint, not a committed scene camera. */
export const VARIANT_EDIT_CAMERA_ID = "variant_edit";

// ---------------------------------------------------------------------------
// Route-owned wording
// ---------------------------------------------------------------------------

/**
 * The change verb per kind. Restates `prompts-variant.ts`'s private
 * `VARIANT_FRAMING`; both copies retire together when Stage 6 deletes
 * `buildVariantInstruction`. The WORDING is preserved behavior — the bench
 * kind's verb stays deliberately open, because it exists to render whatever the
 * owner types and a narrower verb would fight an instruction that restages the
 * whole shot.
 */
const VARIANT_OPERATION_VERB: Record<VariantKind, string> = {
  pose: "Change the pose",
  outfit: "Change the outfit",
  expression: "Change the facial expression",
  setting: "Change the background and setting",
  nsfw_test: "Restage the subject",
};

/**
 * The kinds whose operation TARGETS the wardrobe, and which therefore emit no
 * wardrobe segment at all. Restates `prompts-variant.ts`'s private
 * `KINDS_WITHOUT_OUTFIT_LOCK`; both copies retire at Stage 6.
 */
const KINDS_WITHOUT_OUTFIT_LOCK: ReadonlySet<VariantKind> = new Set<VariantKind>(["outfit", NSFW_TEST_VARIANT_KIND]);

/** The outfit-keep line, verbatim from the legacy builder. */
const VARIANT_OUTFIT_KEEP = "Keep the same outfit as the reference image.";

/** The quality tail, verbatim from the legacy builder. */
const VARIANT_QUALITY_TAIL = "Soft flattering lighting, high quality, no text, no watermark.";

function segment(
  kind: ImagePromptSegment["kind"],
  text: string,
  mandatory: boolean,
  priority: number,
): ImagePromptSegment {
  return { kind, text, mandatory, priority, source: "images.variant" };
}

// ---------------------------------------------------------------------------
// The assembly
// ---------------------------------------------------------------------------

export interface VariantSegmentAssemblyInput {
  readonly characterId: string;
  readonly name: string;
  readonly profile: CharacterProfile;
  readonly kind: VariantKind;
  /** The owner's typed change — the operation contract's payload. */
  readonly instruction: string;
  /**
   * The character's default outfit. The variant lane states no garment names
   * (the reference image shows them), but coverage still drives the camera's
   * perception and the exposure the intimate gate reads — so an honest load
   * beats an assumed-bare body.
   */
  readonly wardrobe: ReadonlyArray<AvatarWardrobeItem>;
  /** The wardrobe lookup FAILED — coverage is unknown state, never a bare body. */
  readonly wardrobeUnavailable?: boolean;
  /** ≥1 loaded garment's coverage column was unreadable — same degrade. */
  readonly coverageUnreliable?: boolean;
  /** The standalone read token — this render's committed-cut stand-in. */
  readonly readToken: string;
  readonly sink?: DiagnosticSink;
}

export interface VariantSegmentAssembly {
  /** The full ordered segment list a render intent carries. */
  readonly segments: readonly ImagePromptSegment[];
  /** The same segments compiled — the row's stored prompt and the intent's fallback string. */
  readonly prompt: string;
  /** The `meta.visualState` fragment the row records at reserve time. */
  readonly digestMeta: Record<string, unknown>;
  /** Required digest facts with nothing to say. Non-empty ⇒ refuse before provider spend. */
  readonly missingRequired: readonly string[];
  /** Every fact a policy or the resolver excluded, and why. */
  readonly suppressions: readonly VisualStateSuppression[];
  /**
   * The digest fact keys this build ACTUALLY emitted as segment text — the
   * builder's emission ledger, recorded fact by fact as each clause landed
   * (owner correction 2026-08-29 #3). This lane appends every builder segment
   * to the render intent, so the ledger is the whole of `subject.emitted`.
   * The shadow's legacy fact coverage reads THIS, never digest-minus-
   * suppressions: a builder bug that silently dropped a fact must read as a
   * divergence, not as false parity.
   */
  readonly emittedFactKeys: readonly string[];
  /**
   * The standalone visual cut the segments were built from — digest, resolved
   * attributes, realized body and the canonical coverage readout. Read by the
   * Round 2 shadow instrumentation (`character-shadow.ts`) to assemble the
   * compiled-program side over the SAME cut; nothing production sends reads it.
   */
  readonly visual: StandaloneSubjectVisual;
}

/**
 * Build a portrait variant's render segments: the operation contract and the
 * preserved identity/age/wardrobe wording, plus the standalone visual cut's
 * morphology anchors and distinctive marks.
 */
export function buildVariantSegments(input: VariantSegmentAssemblyInput): VariantSegmentAssembly {
  const { kind, profile, sink } = input;
  const visual = buildStandaloneSubjectVisual({
    characterId: input.characterId,
    name: input.name,
    profile,
    readToken: input.readToken,
    worn: toWornInputs(input.wardrobe),
    ...(input.wardrobeUnavailable === undefined ? {} : { wardrobeUnavailable: input.wardrobeUnavailable }),
    ...(input.coverageUnreliable === undefined ? {} : { coverageUnreliable: input.coverageUnreliable }),
    camera: VARIANT_EDIT_CAMERA,
    cameraId: VARIANT_EDIT_CAMERA_ID,
    policy: VARIANT_SEGMENT_POLICY,
    // No omit set: this lane has no residual attribute sheet, so a cataloged
    // mark's digest clause is the only place the fact is ever stated.
    intimateAllowed: false,
    ...(sink === undefined ? {} : { sink }),
  });

  // The bench kind's anatomy sentence rides as its own segment rather than
  // inside the instruction, so the weights describe the SHEET's body while the
  // owner's words describe the shot — the same division the chat scene lane
  // uses between its reveal line and its staging sentence.
  const anatomy = kind === NSFW_TEST_VARIANT_KIND ? intimateAnatomySummary(visual.resolved, profile) : "";
  const change = `${VARIANT_OPERATION_VERB[kind]}: ${input.instruction.trim().replace(/\.+$/, "")}.`;

  const route: ImagePromptSegment[] = [
    segment("operation", change, true, AFFORDANCE_UNIT_ONE),
    segment("identity", PORTRAIT_IDENTITY_LOCK, true, AFFORDANCE_UNIT_ONE),
    ...(anatomy ? [segment("morphology", `Anatomy: ${anatomy}.`, true, AFFORDANCE_UNIT_ONE)] : []),
    ...(visual.ageAnchor ? [segment("age", visual.ageAnchor, true, AFFORDANCE_UNIT_ONE)] : []),
    ...(KINDS_WITHOUT_OUTFIT_LOCK.has(kind)
      ? []
      : [segment("wardrobe", VARIANT_OUTFIT_KEEP, true, AFFORDANCE_UNIT_ONE)]),
    segment("quality", VARIANT_QUALITY_TAIL, false, AFFORDANCE_UNIT_ONE),
  ];

  // Route segments first, so a priority tie inside a kind keeps the identity
  // lock ahead of digest detail; the canonical kind order does the rest.
  const segments = orderImagePromptSegments([...route, ...visual.subject.segments]);

  return {
    segments,
    // Budgets resolve empty for every seeded model, so the kernel's own compile
    // of these segments produces this exact string. No sink here: the planner
    // reports fitting when the render actually runs.
    prompt: compileImagePromptSegments(segments),
    digestMeta: visual.digestMeta,
    missingRequired: visual.subject.missingRequired,
    suppressions: visual.subject.suppressions,
    // The ledger records what this build EMITTED, and two of the sentences
    // above are route-owned rather than digest-derived: the identity lock and,
    // when the sheet resolved one, the age anchor. Both state a fact the
    // compiled program synthesizes too, so a ledger that omitted them would
    // report the compiled side leaking facts this prompt plainly states.
    emittedFactKeys: [
      characterIdentityAnchorLedgerKey(input.characterId),
      ...(visual.ageAnchor ? [`${input.characterId}/apparent_age`] : []),
      ...visual.subject.emitted.map((emission) => emission.key),
    ],
    visual,
  };
}
