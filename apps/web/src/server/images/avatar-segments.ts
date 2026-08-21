import { compileImagePromptSegments, orderImagePromptSegments, type ImagePromptSegment } from "@vesper/image-core";
import {
  AFFORDANCE_UNIT_ONE,
  affordancePerceptionView,
  attributeRegistry,
  bodyLocationRegistry,
  exposedRegions,
  FULLY_COVERED,
  isBelowWaist,
  isFeatureAttributeCategory,
  resolveVisualViewingConditions,
  selectVisualImageFacts,
  speciesLabelPhrase,
  visualCameraReadsOfSceneCamera,
  type AffordanceExposure,
  type AffordancePerceptionView,
  type AttributeValue,
  type DiagnosticSink,
  type RealizedBody,
  type RegionExposure,
  type SceneCameraSpec,
  type VisualAttentionContext,
  type VisualStateSuppression,
  type WornItemInput,
} from "@/contracts";
import { buildVisualSubjectSegments } from "@/contracts/images/visual-segments";
import type { CharacterProfile } from "@/contracts/world/profile";
import { assembleVisualStateSnapshot, buildVisualStateImageDigest } from "@/server/visual-state";
import { apparentAgeAnchor } from "./prompts-appearance";
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
import { RECOGNITION_RESIDUE_ATTRIBUTE_IDS, visualFactClauseResolver } from "./visual-fact-clauses";

/**
 * THE AVATAR LANE'S SEGMENT ASSEMBLY (image-lane-consolidation.plan.md Stage 3;
 * spec.prompts.md §Lane migration order → Avatar) — the pure half of the
 * cutover from `buildAvatarPrompt`'s direct traversal to the visual image
 * digest plus semantic prompt segments. `generateAvatar` calls this once, hands
 * the segments to `renderImageIntent`, and records `digestMeta` on the row at
 * reserve time; `prompt` is the same segments compiled to the display/storage
 * string (the kernel's own compile of these segments is identical while every
 * seeded model's prompt budget resolves empty).
 *
 * ## What the digest owns here, and what the route still owns
 *
 * The standalone snapshot is assembled from the character sheet alone — scope
 * `standalone_character`, the read token as its committed cut, attributes and
 * the realized body — so it carries what visual state PROJECTS today: species
 * feature groups (the morphology anchors an image model "corrects" away) and
 * the cataloged distinctive marks. Those flow through
 * `buildVisualSubjectSegments` under the avatar policy (state age, waist-up
 * frame, intimate never), phrased by the shared `visual-fact-clauses` table,
 * with the canonical exposure readout stated as the `exposure` segment.
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
 * the caller must refuse before provider spend (spec.prompts.md §Failure
 * behavior) rather than render a character whose anchors quietly vanished.
 *
 * Pure: no IO, no env, no clock — which is what lets the lane characterization
 * freeze re-run the production assembly without a database.
 */

// ---------------------------------------------------------------------------
// Lane policy
// ---------------------------------------------------------------------------

/** The avatar's task policy: state age, waist-up frame, never intimate anatomy. */
export const AVATAR_SEGMENT_POLICY = { age: "state", frame: "waist_up", intimate: "never" } as const;

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
// Standalone selection inputs
// ---------------------------------------------------------------------------

/**
 * Per-body-location exposure from the worn coverage — the camera's perception
 * view. The optional selection lane fails closed on an unlisted location, so a
 * studio portrait must positively answer for the whole body: an opaque garment
 * hides what it covers, a sheer one hints it, and everything else is in plain
 * view of the camera. Same coverage expansion as `exposedRegions`, read per
 * location instead of per region.
 */
function portraitPerception(worn: readonly WornItemInput[]): AffordancePerceptionView {
  const opaque = new Set<string>();
  const sheer = new Set<string>();
  for (const item of worn) {
    const into = item.opacity === "sheer" ? sheer : opaque;
    for (const cover of item.coverage) {
      if (bodyLocationRegistry.byId(cover) === undefined) continue;
      for (const location of bodyLocationRegistry.expand(cover)) into.add(location);
    }
  }
  const exposure: Record<string, AffordanceExposure> = {};
  for (const location of bodyLocationRegistry.all) {
    exposure[location.id] = opaque.has(location.id) ? "hidden" : sheer.has(location.id) ? "hinted" : "visible";
  }
  return affordancePerceptionView({ exposure });
}

/**
 * The one attention context the selection AND the digest run under. Lighting
 * and motion are the release's declared bases (nothing owns a studio lamp as
 * typed data); distance, angle and framing are the portrait camera's own reads.
 */
function portraitContext(perception: AffordancePerceptionView): VisualAttentionContext {
  const camera = visualCameraReadsOfSceneCamera(AVATAR_PORTRAIT_CAMERA);
  return {
    viewpoint: { kind: "camera", cameraId: AVATAR_PORTRAIT_CAMERA_ID },
    perception,
    ...resolveVisualViewingConditions(),
    distance: camera.distance,
    angle: camera.angle,
    framing: camera.framing,
    intimateAllowed: false,
    consumer: "image",
  };
}

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
}

/**
 * Build the avatar's render segments from the character sheet, through the
 * standalone visual digest. One snapshot, ONE camera-bound selection pass, one
 * digest realized from that exact selection — never a re-select.
 */
export function buildAvatarSegments(input: AvatarSegmentAssemblyInput): AvatarSegmentAssembly {
  const { profile, sink } = input;
  const worn = toWornInputs(input.wardrobe);
  // The canonical exposure readout, computed ONCE over the FULL wardrobe
  // (before the waist-up garment filter): a covering garment still hides its
  // region even when it is dropped from the visible outfit. A FAILED wardrobe
  // load is unknown state, not a bare body: coverage degrades to fully covered
  // so the prompt stays silent about exposure (silence IS covered in the
  // builder's contract) instead of asserting a nudity the saved outfit denies.
  const exposure = input.wardrobeUnavailable === true ? FULLY_COVERED : exposedRegions(worn);

  const assembly = assembleVisualStateSnapshot({
    scope: { kind: "standalone_character", characterId: input.characterId },
    cutId: input.readToken,
    // A standalone portrait has no story clock; zero is the fixed, honest
    // "no elapsed time" answer and keeps the token the only variance source.
    atMinutes: 0,
    subjectId: input.characterId,
    attributes: profile.attributes,
    realize: {
      speciesId: profile.speciesId,
      heritageId: profile.heritageId,
      bodyPlanId: profile.bodyPlanId,
      intimateRegions: profile.intimateRegions,
      bodyFeatures: profile.bodyFeatures,
    },
    ...(sink === undefined ? {} : { sink }),
  });

  const context = portraitContext(portraitPerception(worn));
  const selection = selectVisualImageFacts({
    snapshot: assembly.snapshot,
    context,
    ...(sink === undefined ? {} : { sink }),
  });
  const digestBuild = buildVisualStateImageDigest({
    snapshot: assembly.snapshot,
    context,
    selection,
    forCutId: input.readToken,
    ...(sink === undefined ? {} : { sink }),
  });

  const resolved = assembly.stableResolved;
  const subject = buildVisualSubjectSegments({
    digest: digestBuild.digest,
    subjectId: input.characterId,
    exposure,
    policy: AVATAR_SEGMENT_POLICY,
    clause: visualFactClauseResolver({
      attributes: resolved,
      realizedBody: assembly.realizedBody,
      omitAttributeIds: AVATAR_CLAUSE_OMIT_ATTRIBUTE_IDS,
    }),
    ...(sink === undefined ? {} : { sink }),
  });

  // Route-owned segments, today's avatar wording preserved. The subject line
  // leads the identity kind (highest priority, first at ties); the residual
  // sheet trails any digest identity marks.
  const subjectName = input.name.trim() || "an unnamed character";
  const descriptor = subjectDescriptor(
    undefined,
    identityToken(resolved, "identity.gender"),
    speciesLabelPhrase(profile.speciesId, profile.heritageId),
    identityToken(resolved, "identity.heritage"),
  );
  const ageAnchor = apparentAgeAnchor(input.name, resolved);
  const sheet = residualSheetClauses(resolved, assembly.realizedBody, exposure).join("; ");
  const wearing = visibleAvatarOutfit(input.wardrobe).map(formatGarment).join("; ");

  const route: ImagePromptSegment[] = [
    segment("identity", descriptor ? `Subject: ${subjectName} — ${descriptor}.` : `Subject: ${subjectName}.`, true, AFFORDANCE_UNIT_ONE),
    ...(ageAnchor ? [segment("age", ageAnchor, true, AFFORDANCE_UNIT_ONE)] : []),
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
  const segments = orderImagePromptSegments([...route, ...subject.segments]);

  return {
    segments,
    // Budgets resolve empty for every seeded model, so the kernel's own compile
    // of these segments produces this exact string. No sink here: the planner
    // reports fitting when the render actually runs.
    prompt: compileImagePromptSegments(segments),
    digestMeta: digestBuild.meta,
    missingRequired: subject.missingRequired,
    suppressions: subject.suppressions,
  };
}
