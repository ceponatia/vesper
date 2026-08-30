import { compileImagePromptSegments, orderImagePromptSegments, type ImagePromptSegment } from "@vesper/image-core";
import {
  AFFORDANCE_UNIT_ONE,
  attributeRegistry,
  isBelowWaist,
  isFeatureAttributeCategory,
  speciesLabelPhrase,
  type AttributeValue,
  type DiagnosticSink,
  type RealizedBody,
  type RegionExposure,
  type SceneCameraSpec,
  type VisualStateSuppression,
} from "@/contracts";
import type { CharacterProfile } from "@/contracts/world/profile";
import { toWornInputs, visibleAvatarOutfit, type AvatarStyle, type AvatarWardrobeItem } from "./prompts-avatar";
import {
  clause,
  formatAttributeValue,
  formatGarment,
  isIntimateAttribute,
  isNonVisualAttribute,
  orderedAppearanceClauses,
  subjectDescriptor,
} from "./prompts-format";
import { buildStandaloneSubjectVisual, type StandaloneSubjectVisual } from "./standalone-subject-visual";
import { RECOGNITION_RESIDUE_ATTRIBUTE_IDS } from "./visual-fact-clauses";

/**
 * THE AVATAR LANE'S SEGMENT ASSEMBLY — the pure half of the
 * cutover from `buildAvatarPrompt`'s direct traversal to the visual image
 * digest plus semantic prompt segments. `generateAvatar` calls this once, hands
 * the segments to `renderImageIntent`, and records `digestMeta` on the row at
 * reserve time; `prompt` is the same segments compiled to the display/storage
 * string (the kernel's own compile of these segments is identical while every
 * seeded model's prompt budget resolves empty).
 *
 * ## What the digest owns here, and what the route still owns
 *
 * The standalone cut — snapshot, portrait camera, selection, digest, subject
 * segments — is assembled by the shared `standalone-subject-visual.ts`, which
 * the variant lane and the Image Lab's staged bench call with their own camera
 * and policy. It carries what visual state PROJECTS today: species feature
 * groups (the morphology anchors an image model "corrects" away) and the
 * cataloged distinctive marks, phrased by the shared `visual-fact-clauses`
 * table under the avatar policy (state age, waist-up frame, intimate never,
 * exposure stated as its own segment).
 *
 * Everything visual state does not yet project stays ROUTE-OWNED, emitted as
 * segments beside the builder's output with today's avatar wording preserved:
 *
 * - the subject line (name, gender, species label, heritage);
 * - the apparent-age anchor (`age` segment — the avatar and variant lanes are
 *   the two that state age; wording per `apparentAgeAnchor`, minor/unknown
 *   bands stay silent);
 * - the residual attribute sheet ("Appearance: …"), MINUS the feature-group
 *   categories the digest's morphology segment now owns — stating them twice
 *   would read as emphasis and spend the budget twice;
 * - the authoritative wardrobe line (waist-up filtered, occlusion-aware);
 * - the framing and style/quality sentences.
 *
 * As the visual-state projection grows owners for more of the sheet, facts move
 * from the residual segment into the digest — a deletion here, not a rewrite.
 *
 * ## Failure behavior
 *
 * Non-empty `missingRequired` means a required digest fact resolved no clause:
 * the caller must refuse before provider spend rather than render a character
 * whose anchors quietly vanished.
 *
 * Pure: no IO, no env, no clock — which is what lets the lane characterization
 * freeze re-run the production assembly without a database.
 */

/**
 * The degraded-coverage perception, re-exported from its new shared home.
 *
 * It moved to `standalone-subject-visual.ts` with the variant cutover because
 * every standalone lane needs the same fully-covered degrade; the export stays
 * here because that is where the pin importing it has always looked, and a
 * moved test import would have hidden whether the degrade itself still held.
 */
export { portraitPerception } from "./standalone-subject-visual";

// ---------------------------------------------------------------------------
// Lane policy
// ---------------------------------------------------------------------------

/** The avatar's task policy: state age, waist-up frame, never intimate anatomy. */
export const AVATAR_SEGMENT_POLICY = {
  age: "state",
  frame: "waist_up",
  intimate: "never",
  exposure: "state",
} as const;

/**
 * The portrait studio's fixed viewpoint: facing the camera at medium distance,
 * which `visualCameraReadsOfSceneCamera` maps to the `waist_up` framing band —
 * the same waist-up rule the garment filter and the attribute cut apply.
 */
export const AVATAR_PORTRAIT_CAMERA: SceneCameraSpec = {
  orientation: "toward_viewer",
  distance: "medium",
  height: "eye_level",
};

/** The camera id the selection fingerprints — a fixed studio viewpoint, not a committed scene camera. */
export const AVATAR_PORTRAIT_CAMERA_ID = "portrait_studio";

/**
 * Attributes the avatar's curated waist-up cut withholds (scene-images "D") —
 * low-value in a head-and-shoulders still. Restates `prompts-avatar.ts`'s
 * `AVATAR_OMIT_ATTRIBUTES` (kept private there; the legacy builder and this
 * copy retire together at Stage 6). Routed through the shared clause resolver
 * as `{ omit }`, so a cut fact reads as lane policy, never as degradation.
 */
const AVATAR_OMIT_ATTRIBUTE_IDS: ReadonlySet<string> = new Set([
  "movement.gait",
  "movement.posture_default",
  "build.height",
  "skin.undertone",
  "skin.texture",
  "shoulders.slope",
  "neck.length",
  "neck.throat_prominence",
  "arms.hair",
  "hands.size",
  "hands.texture",
  "hands.nails",
  "brows.shape",
  "brows.thickness",
  "teeth.shape",
  "teeth.condition",
  "lips.shape",
  "horns.texture",
]);

/**
 * What the DIGEST's clause resolver withholds: the curated waist-up cut above,
 * plus the catalog-derived residue set — a recognition-catalog attribute with a
 * distinctive value (a crooked nose, prominent freckling) projects into the
 * digest as a mark AND survives {@link residualSheetClauses}, and letting both
 * speak states the fact twice (the WP-C duplication finding; same resolution as
 * the scene lane's `visualFactClauseResolverForScene`). The residual sheet
 * keeps the only statement; the resolver's `{ omit }` records lane policy,
 * never degradation.
 *
 * The variant lane deliberately passes NO omit set: it has no residual sheet,
 * so the digest's mark clause is that lane's only statement of the fact.
 */
const AVATAR_CLAUSE_OMIT_ATTRIBUTE_IDS: ReadonlySet<string> = new Set([
  ...AVATAR_OMIT_ATTRIBUTE_IDS,
  ...RECOGNITION_RESIDUE_ATTRIBUTE_IDS,
]);

/**
 * Style wording, restated from `prompts-avatar.ts`'s `STYLE_PREFIX` /
 * `STYLE_SUFFIX` (private there; both copies retire with the legacy builder at
 * Stage 6). The WORDING is the preserved avatar behavior the spec names —
 * framing, background, and photographic style stay exactly today's sentences.
 */
const AVATAR_STYLE_FRAMING: Record<AvatarStyle, string> = {
  realistic: "Ultra-realistic professional portrait photograph",
  stylized: "High-quality stylized character illustration, painterly detail, clean linework",
};

const AVATAR_STYLE_QUALITY: Record<AvatarStyle, string> = {
  realistic:
    "Professional beauty portrait, flattering soft studio lighting, photogenic composition, luminous skin rendering, shallow depth of field, 85mm lens bokeh, magazine-quality, no text, no watermark.",
  stylized:
    "Beautiful stylized portrait, flattering soft lighting, photogenic composition, vibrant colors, shallow depth of field, magazine-quality illustration, no text, no watermark.",
};

// ---------------------------------------------------------------------------
// Route-owned segments
// ---------------------------------------------------------------------------

function segment(
  kind: ImagePromptSegment["kind"],
  text: string,
  mandatory: boolean,
  priority: number,
): ImagePromptSegment {
  return { kind, text, mandatory, priority, source: "images.avatar" };
}

/** A single resolved identity-attribute token ("female", "Latina"), or undefined. */
function identityToken(resolved: readonly AttributeValue[], attributeId: string): string | undefined {
  const value = resolved.find((entry) => entry.id === attributeId)?.value;
  if (value === undefined) return undefined;
  const def = attributeRegistry.byId(attributeId);
  return (def && formatAttributeValue(def, value)) || undefined;
}

/**
 * The residual attribute sheet: every visual attribute the digest does not yet
 * carry, grouped by category exactly as the legacy prompt grouped them — minus
 * the feature-group categories, whose facts now arrive through the digest's
 * morphology segment (stating them here too would duplicate the fact).
 */
function residualSheetClauses(
  resolved: readonly AttributeValue[],
  realizedBody: RealizedBody,
  exposure: RegionExposure,
): string[] {
  const byCategory = new Map<string, string[]>();
  for (const value of resolved) {
    const def = attributeRegistry.byId(value.id);
    if (def === undefined || def.excludeFromPrompts === true) continue;
    if (!realizedBody.isAttributeApplicable(def)) continue;
    if (def.category === "identity") continue; // gender/heritage ride the subject line; age is its own segment
    if (isFeatureAttributeCategory(def.category)) continue; // the digest's morphology segment owns these now
    if (def.bodyLocationId !== undefined && isBelowWaist(def.bodyLocationId)) continue; // waist-up frame
    if (AVATAR_OMIT_ATTRIBUTE_IDS.has(def.id)) continue;
    if (isNonVisualAttribute(def) || isIntimateAttribute(def)) continue; // portrait studio is intimate-free by rule
    if (def.id === "chest.hair" && exposure.torso === "covered") continue; // hidden under clothing
    const token = formatAttributeValue(def, value.value);
    if (!token) continue;
    byCategory.set(def.category, [...(byCategory.get(def.category) ?? []), token]);
  }
  return orderedAppearanceClauses(byCategory);
}

// ---------------------------------------------------------------------------
// The assembly
// ---------------------------------------------------------------------------

export interface AvatarSegmentAssemblyInput {
  readonly characterId: string;
  readonly name: string;
  readonly profile: CharacterProfile;
  readonly style: AvatarStyle;
  readonly wardrobe: ReadonlyArray<AvatarWardrobeItem>;
  /**
   * The standalone read token (`standaloneCharacterReadToken`) — the character
   * row's revision plus the wardrobe rows'. Stands in for a committed cut: it
   * is the snapshot's `cutId`, the digest's `forCutId`, and the provenance's
   * committed-cut name.
   */
  readonly readToken: string;
  /**
   * The wardrobe lookup FAILED — `wardrobe` is unknown state, not a confirmed
   * undressed character. The assembly then treats coverage as unreadable:
   * no exposure claims, no coverage-gated reveals, no wardrobe line — the
   * attributes-only degradation the lane has always promised on this failure
   * (`images.avatar.outfit_load_failed` fires at the load site).
   */
  readonly wardrobeUnavailable?: boolean;
  /**
   * ≥1 loaded garment's coverage column was unreadable
   * (`AvatarWardrobeLoad.coverageUnreliableIds`) — the wardrobe LIST is real
   * (the outfit line still renders its names) but its coverage is unknown
   * state. Exposure and the camera's perception degrade exactly as
   * `wardrobeUnavailable`'s do: fully covered, no reveals — a malformed row
   * must not undress the body it dresses.
   */
  readonly coverageUnreliable?: boolean;
  readonly sink?: DiagnosticSink;
}

export interface AvatarSegmentAssembly {
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
 * Build the avatar's render segments from the character sheet, through the
 * shared standalone visual cut under the portrait studio's camera and policy.
 */
export function buildAvatarSegments(input: AvatarSegmentAssemblyInput): AvatarSegmentAssembly {
  const { profile, sink } = input;
  const visual = buildStandaloneSubjectVisual({
    characterId: input.characterId,
    name: input.name,
    profile,
    readToken: input.readToken,
    worn: toWornInputs(input.wardrobe),
    ...(input.wardrobeUnavailable === undefined ? {} : { wardrobeUnavailable: input.wardrobeUnavailable }),
    ...(input.coverageUnreliable === undefined ? {} : { coverageUnreliable: input.coverageUnreliable }),
    camera: AVATAR_PORTRAIT_CAMERA,
    cameraId: AVATAR_PORTRAIT_CAMERA_ID,
    policy: AVATAR_SEGMENT_POLICY,
    omitAttributeIds: AVATAR_CLAUSE_OMIT_ATTRIBUTE_IDS,
    // The portrait studio is intimate-free by rule, and states no intimate
    // anatomy from any source — so the digest never carries it either.
    intimateAllowed: false,
    ...(sink === undefined ? {} : { sink }),
  });

  // Route-owned segments, today's avatar wording preserved. The subject line
  // leads the identity kind (highest priority, first at ties); the residual
  // sheet trails any digest identity marks.
  const resolved = visual.resolved;
  const subjectName = input.name.trim() || "an unnamed character";
  const descriptor = subjectDescriptor(
    undefined,
    identityToken(resolved, "identity.gender"),
    speciesLabelPhrase(profile.speciesId, profile.heritageId),
    identityToken(resolved, "identity.heritage"),
  );
  const sheet = residualSheetClauses(resolved, visual.realizedBody, visual.exposure).join("; ");
  const wearing = visibleAvatarOutfit(input.wardrobe).map(formatGarment).join("; ");

  const route: ImagePromptSegment[] = [
    segment("identity", descriptor ? `Subject: ${subjectName} — ${descriptor}.` : `Subject: ${subjectName}.`, true, AFFORDANCE_UNIT_ONE),
    ...(visual.ageAnchor ? [segment("age", visual.ageAnchor, true, AFFORDANCE_UNIT_ONE)] : []),
    ...(sheet ? [segment("identity", `Appearance: ${clause(sheet)}.`, true, 0)] : []),
    ...(wearing
      ? [segment("wardrobe", `Wearing (authoritative — depict exactly this clothing): ${clause(wearing)}.`, true, AFFORDANCE_UNIT_ONE)]
      : []),
    segment(
      "framing",
      `${AVATAR_STYLE_FRAMING[input.style]}, waist-up portrait, facing camera, soft studio lighting, neutral background.`,
      true,
      AFFORDANCE_UNIT_ONE,
    ),
    segment("quality", AVATAR_STYLE_QUALITY[input.style], false, AFFORDANCE_UNIT_ONE),
  ];

  // Route segments first, so a priority tie inside a kind keeps the subject
  // line ahead of digest detail; the canonical kind order does the rest.
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
    emittedFactKeys: visual.subject.emitted.map((emission) => emission.key),
    visual,
  };
}
