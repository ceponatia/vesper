import type { ImagePromptSegment } from "@vesper/image-core";
import {
  appearanceAttributeRecognitionCatalog,
  attributeRegistry,
  conditionAttributeOverlays,
  diag,
  exposedRegions,
  exposureRegionOf,
  FULLY_COVERED,
  isFeatureAttributeCategory,
  resolveAttributes,
  type ActiveCondition,
  type AttributeValue,
  type DiagnosticSink,
  type RegionExposure,
  type RealizedBody,
  type VisualStateSuppression,
} from "@/contracts";
import { buildVisualSubjectSegments } from "@/contracts/images/visual-segments";
import type { CharacterProfile } from "@/contracts/world/profile";
import {
  safeBuildVisualStateShadow,
  visualStateImageDigestOfShadow,
  type VisualStateShadowInput,
} from "@/server/visual-state";
import { identityAnchorSummary, sceneRevealAppearance } from "./prompts-appearance";
import {
  excerpt,
  formatAttribute,
  isIntimateAttribute,
  isNonVisualAttribute,
  realizedBodyForProfile,
} from "./prompts-format";
import type { SceneRenderPlan } from "./prompts-scene-plan";
import { visualFactClauseResolver } from "./visual-fact-clauses";

/**
 * THE SINGLE-CHARACTER SCENE LANE'S VISUAL-DIGEST CUTOVER
 * (image-lane-consolidation.plan.md Stage 3; spec.prompts.md §Lane migration
 * order → Single-character scene) — the pure seam that makes the visual image
 * digest the character-fact source for a cast of ONE, with the plan's committed
 * scene camera bound into the selection.
 *
 * `renderCharacterSceneImage` calls {@link applySceneSubjectVisual} AFTER
 * `composeSceneSpec` → `resolveScenePlan`, because the committed camera is
 * `plan.camera` and the camera must enter the ONE selection pass — never a
 * re-select (`image-digest.ts` §Reuse the selection). The queue prepares the
 * camera-less shadow input through the shared chat factory
 * (`chatVisualStateShadowInput`), so the scene render and the admin inspector
 * assemble one committed cut the same way.
 *
 * ## What the digest owns here, and what the route still owns
 *
 * Exactly the avatar lane's split (`avatar-segments.ts`), applied to the scene
 * fields. The digest — through `buildVisualSubjectSegments` under the scene
 * policy and the SHARED clause resolver — owns what visual state projects
 * today: species feature groups and anatomy departures (the morphology anchors
 * an image model "corrects" away), cataloged distinctive marks, and the
 * current-state owners (active conditions, body-surface wetness). Everything
 * the projection does not yet carry stays ROUTE-OWNED with today's wording:
 *
 * - the identity-anchor whitelist (`identityAnchorSummary`) and the residual
 *   attribute sheet — MINUS the feature-group categories the digest's
 *   morphology clauses now own, and MINUS covered `imageReveal: "skin"`
 *   attributes (the coverage-aware selection this cutover exists for: painted
 *   toenails under slippers no longer reach a text-to-image prompt);
 * - the reveal lines (`sceneRevealAppearance`) — shape reads through clothing
 *   and skin only when bare, per-route intimate gating unchanged;
 * - the outfit text and exposure readout, which stay the queue's canonical
 *   resolutions (`characterSpec` consumes them untouched).
 *
 * As the projection grows attribute owners, facts move from the residual sheet
 * into the digest — a deletion here, not a rewrite.
 *
 * ## Transport is untouched (orchestrator scope ruling, Stage 3 WP-C)
 *
 * `buildSceneRenderPrompt`, the 1,500-char budgeter, the identity-lock
 * `replaceAll` adaptation, POV/framing/staging wording, LoRA routing and the
 * attempt chains all stay: this seam changes only WHERE the per-character field
 * strings come from. The transport emits `appearance` for textual subjects and
 * `identityAnchors` for referenced ones — mutually exclusive per subject-mode —
 * so both fields may carry the digest's identity/morphology clauses without a
 * fact ever being stated twice in one prompt. The builder's own `exposure`
 * segment is deliberately NOT consumed: the transport already states coverage
 * once, from the queue's canonical readout (`formatExposure`).
 *
 * ## Failure behavior (spec.prompts.md §Failure behavior)
 *
 * A failed shadow assembly, or a REQUIRED digest fact with no resolvable
 * clause, refuses the render before provider spend — the refusal lands on the
 * scene row via `failedPrecondition`, exactly like an identity-pack refusal.
 * Optional-only unavailability continues with the required facts and records
 * the degradation as suppressions plus the `meta.visualState` provenance.
 *
 * A cast of 2+ never reaches this module: `renderCharacterSceneImage` applies
 * it only when the effective cast is one subject (selfies force that), so the
 * legacy `presentCharacter` production stays byte-identical for multi-character
 * scenes until Stage 4.
 */

// ---------------------------------------------------------------------------
// Lane policy and diagnostics
// ---------------------------------------------------------------------------

/**
 * The scene task's segment policy: never state age (the narrative/visual age
 * split — scene renders inherit visible age from the reference), full-figure
 * frame, and intimate anatomy only where the region actually reads bare. The
 * per-route intimate gate (uncensored edit vs moderated fallback) stays in the
 * transport, which emits `intimateAppearance` per rung.
 */
export const SCENE_SEGMENT_POLICY = { age: "omit", frame: "full_figure", intimate: "when_bare" } as const;

/** The viewpoint id the committed scene camera is selected under. */
export const SCENE_VISUAL_CAMERA_ID = "chat_scene";

/** The shadow assembly failed; the cast-1 render refuses before provider spend. */
export const SCENE_VISUAL_DIGEST_UNAVAILABLE = "images.scene_render.visual_digest_unavailable";
/** A required digest fact resolved no clause; the cast-1 render refuses before spend. */
export const SCENE_VISUAL_REQUIRED_MISSING = "images.scene_render.visual_required_missing";

/**
 * Attribute ids whose facts CAN reach the digest (the appearance recognition
 * catalog's entries, projected only for distinctive values) but whose phrasing
 * the route-owned residue still owns — the sheet and the anchor whitelist state
 * the whole attribute vocabulary, distinctive values included, so a digest
 * clause for one would state it twice. Resolved as `{ omit }` (lane policy,
 * never degradation); retires with the residue when the projection grows real
 * attribute owners.
 */
const SCENE_RESIDUE_ATTRIBUTE_IDS: ReadonlySet<string> = new Set(
  appearanceAttributeRecognitionCatalog.map((entry) => entry.attributeId),
);

// ---------------------------------------------------------------------------
// Meter state note (moved from character-scene.ts with the WP-C cutover;
// re-exported there for the legacy cast ≥2 path)
// ---------------------------------------------------------------------------

/** A compact image-specific description of visible meter state. */
export function visualStateNote(meters: Record<string, number> = {}): string {
  const parts: string[] = [];
  const intoxication = meters.intoxication ?? 0;
  if (intoxication > 0.7) parts.push("visibly unsteady from drink, eyes glassy and unfocused, posture slack");
  else if (intoxication > 0.35) parts.push("loose and warm from a drink or two, gaze a little unfocused");
  const hygiene = meters.hygiene ?? 1;
  if (hygiene < 0.3) parts.push("unwashed — hair gone lank, skin sheened, clothes rumpled");
  else if (hygiene < 0.55) parts.push("a little disheveled, hair loosened and skin damp");
  const energy = meters.energy ?? 1;
  if (energy < 0.2) parts.push("exhausted and heavy-lidded");
  else if (energy < 0.45) parts.push("tired, eyes heavy");
  const arousal = meters.arousal ?? 0;
  if (arousal > 0.55) parts.push("eyes bright and heavy-lidded, lips parted, breath shallow, a faint sheen of sweat");
  return parts.join("; ");
}

// ---------------------------------------------------------------------------
// Route-owned residue
// ---------------------------------------------------------------------------

/** Char cap on the residual sheet — the legacy appearance summary's own budget. */
const SCENE_SHEET_CHARS = 200;

/**
 * The residual attribute sheet for the textual description: every visual
 * attribute the digest does not yet carry, in the legacy summary's flat
 * "value; value; …" form (`characterAppearanceSummary`, which retires with the
 * cast ≥2 path at Stage 6), with the two deltas the cutover earns:
 *
 * - feature-group categories are excluded — the digest's morphology clauses own
 *   them now, and stating them here too would read as emphasis and spend the
 *   budget twice;
 * - a covered `imageReveal: "skin"` attribute is silent — the coverage-aware
 *   selection, closing the recorded text-to-image covered-skin leak. Shape
 *   still reads through clothing; an unmapped region is unknown, and the
 *   answer to unknown is silence, never bare.
 */
function residualSheet(
  resolved: readonly AttributeValue[],
  realizedBody: RealizedBody,
  exposure: RegionExposure,
): string {
  const parts: string[] = [];
  for (const value of resolved) {
    if (value.id === "identity.apparent_age") continue; // scene renders never state age
    const def = attributeRegistry.byId(value.id);
    if (!def || def.excludeFromPrompts) continue;
    if (!realizedBody.isAttributeApplicable(def)) continue;
    if (isNonVisualAttribute(def) || isIntimateAttribute(def)) continue; // intimate rides the reveal line
    if (isFeatureAttributeCategory(def.category)) continue; // the digest's morphology clauses own these
    if (def.imageReveal === "skin") {
      const region = def.bodyLocationId === undefined ? undefined : exposureRegionOf(def.bodyLocationId);
      if (region === undefined || exposure[region] === "covered") continue;
    }
    const formatted = formatAttribute(def, value.value);
    if (formatted) parts.push(formatted);
  }
  return excerpt(parts.join("; "), SCENE_SHEET_CHARS);
}

/** The clauses of the named segment kinds, folded as field prose (no trailing period). */
function segmentText(segments: readonly ImagePromptSegment[], kinds: ReadonlySet<string>): string {
  return segments
    .filter((segment) => kinds.has(segment.kind))
    .map((segment) => segment.text.replace(/\.$/, ""))
    .join("; ");
}

const IDENTITY_SEGMENT_KINDS: ReadonlySet<string> = new Set(["identity", "morphology"]);
const STATE_SEGMENT_KINDS: ReadonlySet<string> = new Set(["current_state", "pose"]);

// ---------------------------------------------------------------------------
// The seam
// ---------------------------------------------------------------------------

/** The per-member facts the cast-1 field production reads (a `SceneCastMember` slice). */
export interface SceneSubjectVisualMember {
  readonly name: string;
  readonly profile: CharacterProfile;
  readonly exposure?: RegionExposure;
  readonly outfitExposed?: boolean;
  readonly meters?: Record<string, number>;
  readonly attributeOverlays?: readonly AttributeValue[];
  readonly conditions?: readonly ActiveCondition[];
}

export interface SceneSubjectVisualInput {
  /** The resolved plan; its committed `camera` binds into the one selection pass. */
  readonly plan: SceneRenderPlan;
  readonly member: SceneSubjectVisualMember;
  /**
   * The subject's committed chat cut as a camera-less shadow input — the queue
   * builds it through `chatVisualStateShadowInput`, so the scene digest and the
   * inspector preview assemble one cut identically.
   */
  readonly shadow: Omit<VisualStateShadowInput, "sink" | "camera">;
  readonly sink?: DiagnosticSink;
}

export interface SceneSubjectVisualBuild {
  /** The plan with the focal spec's character fields produced from the digest. */
  readonly plan: SceneRenderPlan;
  /** The `meta.visualState` fragment the scene row records at reserve time. */
  readonly digestMeta?: Record<string, unknown>;
  /** Non-null refuses the render before provider spend (spec §Failure behavior). */
  readonly refusal: string | null;
  /** Every fact a policy or the resolver excluded, and why — the degradation record. */
  readonly suppressions: readonly VisualStateSuppression[];
}

/**
 * Produce the cast-1 focal spec's character fields from the committed visual
 * digest: one shadow assembly, ONE camera-bound selection, one digest realized
 * from that exact selection, one shared segments-and-clauses pass — then the
 * existing `SceneCharacterSpec` field strings the untouched transport consumes.
 * Pure over its inputs.
 */
export function applySceneSubjectVisual(input: SceneSubjectVisualInput): SceneSubjectVisualBuild {
  const { member, shadow, sink } = input;
  // The same three-layer resolve the legacy production and the shadow assembly
  // both take (base → persisted narrative overlays → condition overlays), so
  // the route-owned residue can never disagree with the projection about a
  // recorded haircut or dye.
  const resolved = resolveAttributes(member.profile.attributes, [
    ...(member.attributeOverlays ?? []),
    ...conditionAttributeOverlays([...(member.conditions ?? [])]),
  ]);
  const realizedBody = realizedBodyForProfile(member.profile);
  const exposure: RegionExposure =
    member.exposure ?? (member.outfitExposed ? exposedRegions([]) : FULLY_COVERED);

  const build = safeBuildVisualStateShadow(
    {
      ...shadow,
      camera: { cameraId: SCENE_VISUAL_CAMERA_ID, spec: input.plan.camera },
      ...(sink === undefined ? {} : { sink }),
    },
    sink,
  );
  if (build === null) {
    // Refuse, never fall back to a stale prose summary: the row is reserved and
    // failed with this text before any provider is called.
    sink?.push(
      diag("error", SCENE_VISUAL_DIGEST_UNAVAILABLE, "the visual digest could not be assembled for this scene", {
        context: { subjectId: shadow.subjectId, cutId: shadow.cutId },
      }),
    );
    return {
      plan: input.plan,
      refusal: `visual digest unavailable for ${member.name}`,
      suppressions: [],
    };
  }

  // This job realizes the cut it just assembled — the inspector precedent — so
  // `forCutId` names the same id and the stale-cut gate stays a seam contract
  // rather than a live branch.
  const digestBuild = visualStateImageDigestOfShadow(build, {
    forCutId: shadow.cutId,
    ...(sink === undefined ? {} : { sink }),
  });
  const subject = buildVisualSubjectSegments({
    digest: digestBuild.digest,
    subjectId: shadow.subjectId,
    exposure,
    policy: SCENE_SEGMENT_POLICY,
    clause: visualFactClauseResolverForScene(resolved, realizedBody),
    ...(sink === undefined ? {} : { sink }),
  });
  if (subject.missingRequired.length > 0) {
    sink?.push(
      diag("error", SCENE_VISUAL_REQUIRED_MISSING, "required visual facts resolved no clause for this scene", {
        context: { subjectId: shadow.subjectId, keys: [...subject.missingRequired] },
      }),
    );
    return {
      plan: input.plan,
      digestMeta: digestBuild.meta,
      refusal: `required visual facts unresolved for ${member.name}: ${subject.missingRequired.join(", ")}`,
      suppressions: subject.suppressions,
    };
  }

  const focal = input.plan.focal;
  if (focal === null) {
    // A cast of one always resolves a focal; a location-only plan has no
    // subject spec to patch, so the fields (and the provenance that would
    // describe them) are dropped rather than filed against nobody.
    sink?.push(
      diag("info", SCENE_VISUAL_DIGEST_UNAVAILABLE, "no focal spec to carry the digest fields — plan unchanged", {
        context: { subjectId: shadow.subjectId },
      }),
    );
    return { plan: input.plan, refusal: null, suppressions: subject.suppressions };
  }

  // Field routing. `identityAnchors` (referenced subject) and `appearance`
  // (textual subject) both carry the digest's identity/morphology clauses; the
  // transport emits exactly one of the two per subject-mode, so no fact lands
  // twice in one prompt. The reveal lines keep their exposure-aware machinery
  // and per-route intimate gating byte-compatible.
  const digestIdentity = segmentText(subject.segments, IDENTITY_SEGMENT_KINDS);
  const digestState = segmentText(subject.segments, STATE_SEGMENT_KINDS);
  const anchors = [identityAnchorSummary(resolved, member.profile), digestIdentity].filter(Boolean).join("; ");
  const appearance = [
    digestIdentity,
    residualSheet(resolved, realizedBody, exposure),
    digestState,
    visualStateNote(member.meters),
  ]
    .filter(Boolean)
    .join(". ");
  const lowerBody = sceneRevealAppearance(resolved, exposure, member.profile, { intimate: false });

  // Rebuild rather than spread-over: an empty digest-era anchor or reveal line
  // must REMOVE the legacy key, mirroring `characterSpec`'s conditional shape.
  const { identityAnchors: legacyAnchors, lowerBody: legacyLowerBody, ...rest } = focal;
  void legacyAnchors;
  void legacyLowerBody;
  return {
    plan: {
      ...input.plan,
      focal: {
        ...rest,
        appearance,
        ...(anchors ? { identityAnchors: anchors } : {}),
        ...(lowerBody ? { lowerBody } : {}),
        // No age field, ever: scene renders inherit visible age from the
        // reference, and the segments policy above omits the digest's age facts.
        intimateAppearance: sceneRevealAppearance(resolved, exposure, member.profile, { intimate: true }),
      },
    },
    digestMeta: digestBuild.meta,
    refusal: null,
    suppressions: subject.suppressions,
  };
}

/** The shared resolver under the scene lane's curated residue cut. */
function visualFactClauseResolverForScene(resolved: readonly AttributeValue[], realizedBody: RealizedBody) {
  return visualFactClauseResolver({
    attributes: resolved,
    realizedBody,
    omitAttributeIds: SCENE_RESIDUE_ATTRIBUTE_IDS,
  });
}
