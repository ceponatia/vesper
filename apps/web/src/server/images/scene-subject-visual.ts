import type { ImagePromptSegment } from "@vesper/image-core";
import {
  attributeRegistry,
  conditionAttributeOverlays,
  diag,
  exposedRegions,
  exposureRegionOf,
  FULLY_COVERED,
  isFeatureAttributeCategory,
  resolveAttributes,
  VISUAL_IMAGE_PROVENANCE_META_KEY,
  type ActiveCondition,
  type AttributeValue,
  type DiagnosticSink,
  type RegionExposure,
  type RealizedBody,
  type VisualImageDigest,
  type VisualImageProvenance,
  type VisualStateSuppression,
} from "@/contracts";
import { buildVisualSubjectSegments, visualExposureReads } from "@/contracts/images/visual-segments";
import type { CharacterProfile } from "@/contracts/world/profile";
import { fnv1aHex } from "@/lib/hash";
import {
  safeBuildVisualStateShadow,
  visualStateImageDigestOfShadow,
  type VisualStateCameraBinding,
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
import { sceneLightingBand } from "./scene-lowering";
import { normalizeName, type SceneCharacterSpec, type SceneRenderPlan } from "./prompts-scene-plan";
import { RECOGNITION_RESIDUE_ATTRIBUTE_IDS, visualFactClauseResolver } from "./visual-fact-clauses";

/**
 * THE CHAT SCENE LANE'S VISUAL-DIGEST CUTOVER — the pure seam
 * that makes the visual image digest the character-fact source for EVERY person
 * a chat scene draws, with the plan's committed scene camera bound into the
 * selection.
 *
 * `renderCharacterSceneImage` calls {@link applySceneCastVisual} AFTER
 * `composeSceneSpec` → `resolveScenePlan`, because the committed camera is
 * `plan.camera` and the camera must enter each selection pass — never a
 * re-select (`image-digest.ts` §Reuse the selection). The queue prepares one
 * camera-less shadow input PER PRESENT MEMBER through the shared chat factory
 * (`chatVisualStateShadowInput`), so the scene render and the admin inspector
 * assemble a committed cut the same way.
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
 * ## A cast of N (Stage 4)
 *
 * ONE field production describes everybody. {@link applySceneCastVisual} runs
 * one shadow assembly, ONE camera-bound selection and one digest realization
 * PER SUBJECT — each person's own committed cut, because one character's
 * clothing, conditions and body surface can never answer what another is
 * showing — and then feeds every one of them through the SAME
 * {@link produceSubjectVisual}. {@link applySceneSubjectVisual} is the
 * one-subject spelling of that call and nothing more.
 *
 * That is the plan's "Reference count does not change character wording" ruling
 * held structurally: a second appearance algorithm for `others` is the failure
 * mode, not the feature. Subjects are matched to their plan spec by
 * `normalizeName`, the same binding the rest of the scene code uses — the
 * composer's roster map, the dedupe, the prompt's reference set — so a subject
 * the plan has no spec for (a location-only shot) contributes no fields rather
 * than being filed against somebody else.
 *
 * Subjects are processed FOCAL FIRST, then in the caller's roster order: the
 * merged provenance takes its identifying fields from the head record, and a
 * refusal names the focal's failure before a bystander's.
 *
 * ## What this seam owns, and what carries the scene
 *
 * This seam changes only WHERE the per-character field strings come from. The
 * scene's own decisions — the setting, the light, the mood, the capture mode,
 * the staged arrangement, what each person is doing — no longer travel as prose
 * at all: `scene-lowering.ts` turns the resolved plan into typed prompt-program
 * inputs, and the endpoint's dialect words them (#388). The Stage 3 WP-C ruling
 * that the prose builder kept POV, framing and staging wording described the
 * pre-cutover lane and no longer does. `buildSceneRenderPrompt` serves no
 * production scene at all — a rung whose model has no active binding is dropped
 * from the chain rather than worded by it — and survives only for the Image
 * Lab's staged bench and the eval script.
 *
 * The one thing the plan still owes this module is its LIGHT: the composer's
 * phrase names a band ({@link sceneLightingBand}), and that band enters the
 * selection so a night scene is not selected as though the room were lit.
 *
 * LoRA routing and the attempt chains are untouched. The transport emits
 * `appearance` for textual subjects and
 * `identityAnchors` for referenced ones — mutually exclusive per subject-mode —
 * so both fields may carry the digest's identity/morphology clauses without a
 * fact ever being stated twice in one prompt. The builder's own `exposure`
 * segment is deliberately NOT consumed: the transport already states coverage
 * once, from the queue's canonical readout (`formatExposure`) — the same
 * `exposure` value this seam reads, over the same region table. That
 * transport-owned statement is why the slice's emission ledger still carries
 * the exposure region keys ({@link SceneSubjectVisualSlice.emittedFactKeys}):
 * the coverage the shadow compares genuinely reaches the sent prompt, just
 * through the transport's line rather than the builder's segment.
 *
 * ## Failure behavior
 *
 * A failed shadow assembly, or a REQUIRED digest fact with no resolvable
 * clause, refuses the WHOLE render before provider spend — for any subject, not
 * just the focal: a scene missing one person's anchors is the same wrong
 * picture as a scene missing the focal's. The refusal lands on the scene row
 * via `failedPrecondition` naming the subject that failed, exactly like an
 * identity-pack refusal. Optional-only unavailability continues with the
 * required facts and records the degradation as suppressions plus the
 * `meta.visualState` provenance.
 *
 * A member the caller supplies NO cut for keeps the legacy `presentCharacter`
 * production for that person (the queue's degradation precedent: a missing
 * participant row warns and falls back rather than refusing a render over a
 * continuity id, and every pre-digest caller — the tests, the lab baseline —
 * supplies no cuts at all).
 *
 * ## One render, N cuts, ONE `meta.visualState` record
 *
 * `renderResolvedScene` merges a single app-owned `meta.visualState` key, and
 * `VisualImageProvenance` is one record with a `subjects[]` array — a shape
 * written for one snapshot covering many subjects, which is not what this lane
 * assembles. {@link mergeVisualImageProvenance} folds the per-subject records
 * into that one shape:
 *
 * - `subjects` and `suppressions` are CONCATENATED in cast order, so the record
 *   carries one entry per person rather than the last write winning. This is
 *   what `render-intent-capture.ts`'s `requiredFactKeysOf` flattens, so the
 *   required-fact key set covers the whole cast.
 * - `snapshotFingerprint` and `selectionFingerprint` become a cast-wide
 *   composite (`fnv1aHex` over the per-cut values in order, the same fixed-width
 *   form a single cut carries), so "same composition, retry it" versus "current
 *   state moved" answers for ANY subject, not only the focal.
 * - `cutId` and `atMinutes` are the render job's own — the queue mints one cut
 *   id and one clock for the whole scene, so the head record's are every
 *   record's.
 * - `cameraFingerprint` is the FOCAL cut's. It fingerprints the whole
 *   visibility context, and lighting/motion are resolved per subject, so a
 *   moving bystander can move theirs; the framing identity of a shot is the
 *   focal's read and that is the question this field answers.
 * - `scopeKey` is the FOCAL cut's, and is the one genuine loss: chat scopes a
 *   memory group per PARTICIPANT, so a second subject's scope key is not
 *   represented. Nothing reads it back (it is identifying, never parsed), and
 *   representing N would mean widening the stored contract rather than merging
 *   into it.
 */

// ---------------------------------------------------------------------------
// Lane policy and diagnostics
// ---------------------------------------------------------------------------

/**
 * The scene task's segment policy: never state age (the narrative/visual age
 * split — scene renders inherit visible age from the reference), full-figure
 * frame, and intimate anatomy only where the region actually reads bare. The
 * selection is made once per cut and every rung compiles the same cut; the
 * per-rung intimate gate is the staged arrangement's (`scene-lowering.ts`).
 */
export const SCENE_SEGMENT_POLICY = {
  age: "omit",
  frame: "full_figure",
  intimate: "when_bare",
  exposure: "state",
} as const;

/** The viewpoint id the committed scene camera is selected under. */
export const SCENE_VISUAL_CAMERA_ID = "chat_scene";

/** The shadow assembly failed; the render refuses before provider spend. */
export const SCENE_VISUAL_DIGEST_UNAVAILABLE = "images.scene_render.visual_digest_unavailable";
/** A required digest fact resolved no clause; the render refuses before spend. */
export const SCENE_VISUAL_REQUIRED_MISSING = "images.scene_render.visual_required_missing";

// ---------------------------------------------------------------------------
// Meter state note (moved from character-scene.ts with the WP-C cutover;
// re-exported there for the legacy no-cut path)
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
 * no-cut path at Stage 6), with the two deltas the cutover earns:
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

/** The per-member facts the field production reads (a `SceneCastMember` slice). */
export interface SceneSubjectVisualMember {
  readonly name: string;
  readonly profile: CharacterProfile;
  readonly exposure?: RegionExposure;
  readonly outfitExposed?: boolean;
  readonly meters?: Record<string, number>;
  readonly attributeOverlays?: readonly AttributeValue[];
  readonly conditions?: readonly ActiveCondition[];
}

/** One subject the render draws, paired with the committed cut it draws them from. */
export interface SceneCastVisualSubject {
  readonly member: SceneSubjectVisualMember;
  /**
   * The subject's committed chat cut as a camera-less shadow input — the queue
   * builds it through `chatVisualStateShadowInput`, so the scene digest and the
   * inspector preview assemble one cut identically.
   */
  readonly shadow: Omit<VisualStateShadowInput, "sink" | "camera">;
}

export interface SceneCastVisualInput {
  /** The resolved plan; its committed `camera` binds into every selection pass. */
  readonly plan: SceneRenderPlan;
  /**
   * Every subject that HAS a committed cut, in roster order. A cast member with
   * no cut is simply absent: their plan spec keeps the legacy field production.
   */
  readonly members: readonly SceneCastVisualSubject[];
  readonly sink?: DiagnosticSink;
}

export interface SceneSubjectVisualInput {
  /** The resolved plan; its committed `camera` binds into the one selection pass. */
  readonly plan: SceneRenderPlan;
  readonly member: SceneSubjectVisualMember;
  /** This subject's committed chat cut as a camera-less shadow input. */
  readonly shadow: Omit<VisualStateShadowInput, "sink" | "camera">;
  readonly sink?: DiagnosticSink;
}

/**
 * One subject's realized cut behind the produced fields — everything the Round 2
 * shadow instrumentation (`character-shadow.ts`) needs to assemble the
 * compiled-program side over the SAME selection. Nothing production sends reads
 * these; a member whose fields were not applied contributes none.
 */
export interface SceneSubjectVisualSlice {
  readonly subjectId: string;
  readonly cutId: string;
  readonly name: string;
  readonly digest: VisualImageDigest;
  /** The three-layer resolve the clause table ran under. */
  readonly attributes: readonly AttributeValue[];
  readonly realizedBody: RealizedBody;
  /** The canonical coverage readout the exposure claims are made over. */
  readonly exposure: RegionExposure;
  /**
   * The statement keys that ACTUALLY reach this subject's sent prompt — the
   * builder's emission ledger, RESTRICTED to what the transport folds (owner
   * correction 2026-08-29 #3). The restriction is the honest half: this lane's
   * field strings consume only the identity/morphology and current-state/pose
   * kinds, so a fact whose clause landed in any other kind was built and then
   * never sent, and counting it "emitted" would be exactly the false parity
   * the ledger exists to end. The one addition past the folded kinds is the
   * exposure region keys — the transport states coverage itself, from the
   * same readout, through `formatExposure` (`wardrobeTracked` is
   * unconditionally true for a chat cast member) — cut to the region reads
   * that line actually words: bare anywhere in its scope, sheer only at the
   * torso and pelvis (it has no sheer wording for legs or feet). The shadow's
   * legacy fact coverage reads this, never digest-minus-suppressions.
   */
  readonly emittedFactKeys: readonly string[];
  /** This subject's own segment-pass exclusions and missing anchors. */
  readonly suppressions: readonly VisualStateSuppression[];
  readonly missingRequired: readonly string[];
}

export interface SceneSubjectVisualBuild {
  /** The plan with every supplied subject's character fields produced from their digest. */
  readonly plan: SceneRenderPlan;
  /** The merged `meta.visualState` fragment the scene row records at reserve time. */
  readonly digestMeta?: Record<string, unknown>;
  /** Non-null refuses the render before provider spend. */
  readonly refusal: string | null;
  /** Every fact a policy or the resolver excluded, and why — the degradation record. */
  readonly suppressions: readonly VisualStateSuppression[];
  /** The realized cuts behind the applied fields, in the processed order — for the shadow. */
  readonly visuals: readonly SceneSubjectVisualSlice[];
}

/**
 * Produce EVERY supplied subject's character fields from their own committed
 * visual digest — one shadow assembly, one camera-bound selection, one digest
 * per subject, all through the one shared field production — and patch them
 * into the focal spec and the matching `others` entries. Pure over its inputs.
 */
export function applySceneCastVisual(input: SceneCastVisualInput): SceneSubjectVisualBuild {
  const { plan, sink } = input;
  const focalKey = plan.focal === null ? null : normalizeName(plan.focal.name);
  const specKeys = new Set<string>([
    ...(plan.focal === null ? [] : [normalizeName(plan.focal.name)]),
    ...plan.others.map((spec) => normalizeName(spec.name)),
  ]);
  // Focal first, then the caller's roster order (stable): the merged provenance
  // takes its identifying fields from the head record, and a refusal reports the
  // person the shot is about before a bystander.
  const ordered =
    focalKey === null
      ? input.members
      : [
          ...input.members.filter((subject) => normalizeName(subject.member.name) === focalKey),
          ...input.members.filter((subject) => normalizeName(subject.member.name) !== focalKey),
        ];

  const fieldsByName = new Map<string, SceneSubjectVisualFields>();
  const provenanceRecords: VisualImageProvenance[] = [];
  const suppressions: VisualStateSuppression[] = [];
  const visuals: SceneSubjectVisualSlice[] = [];
  const viewpoint = sceneViewpoint(plan);
  for (const subject of ordered) {
    const produced = produceSubjectVisual(viewpoint, subject, sink);
    suppressions.push(...produced.suppressions);
    if (!produced.ok) {
      // Refuse, never fall back to a stale prose summary for the rest of the
      // cast: the row is reserved and failed with this text before any provider
      // is called. A digest that WAS built before the refusal still travels, so
      // the failed row records the moment it was asked over.
      if (produced.provenance !== undefined) provenanceRecords.push(produced.provenance);
      return { plan, ...digestMetaOf(provenanceRecords), refusal: produced.refusal, suppressions, visuals: [] };
    }
    if (!specKeys.has(normalizeName(subject.member.name))) {
      // The plan has no spec to carry this subject's fields — a location-only
      // shot, or a cut for somebody the resolved plan does not draw. The fields,
      // and the provenance that would describe them, are dropped rather than
      // filed against nobody.
      sink?.push(
        diag("info", SCENE_VISUAL_DIGEST_UNAVAILABLE, "no scene spec to carry the digest fields — plan unchanged for this subject", {
          context: { subjectId: subject.shadow.subjectId },
        }),
      );
      continue;
    }
    provenanceRecords.push(produced.provenance);
    visuals.push(produced.visual);
    fieldsByName.set(normalizeName(subject.member.name), produced.fields);
  }
  if (fieldsByName.size === 0) {
    return { plan, ...digestMetaOf(provenanceRecords), refusal: null, suppressions, visuals: [] };
  }

  const focalFields = focalKey === null ? undefined : fieldsByName.get(focalKey);
  return {
    plan: {
      ...plan,
      focal:
        plan.focal === null || focalFields === undefined ? plan.focal : withDigestFields(plan.focal, focalFields),
      others: plan.others.map((spec) => {
        const fields = fieldsByName.get(normalizeName(spec.name));
        return fields === undefined ? spec : withDigestFields(spec, fields);
      }),
    },
    ...digestMetaOf(provenanceRecords),
    refusal: null,
    suppressions,
    visuals,
  };
}

/**
 * The one-subject spelling of {@link applySceneCastVisual}, kept because a cast
 * of one is the shape the characterization freeze and the legacy-vs-digest
 * comparison read the lane through.
 */
export function applySceneSubjectVisual(input: SceneSubjectVisualInput): SceneSubjectVisualBuild {
  return applySceneCastVisual({
    plan: input.plan,
    members: [{ member: input.member, shadow: input.shadow }],
    ...(input.sink === undefined ? {} : { sink: input.sink }),
  });
}

// ---------------------------------------------------------------------------
// The one per-subject field production
// ---------------------------------------------------------------------------

/** The `SceneCharacterSpec` fields the digest produces for one subject. */
interface SceneSubjectVisualFields {
  readonly appearance: string;
  /** Empty removes the legacy key, mirroring `characterSpec`'s conditional shape. */
  readonly identityAnchors: string;
  /** Empty removes the legacy key, likewise. */
  readonly lowerBody: string;
  readonly intimateAppearance: string;
}

type SceneSubjectVisualProduction =
  | {
      readonly ok: false;
      readonly refusal: string;
      /** Present when the digest was built and the segments pass is what failed. */
      readonly provenance?: VisualImageProvenance;
      readonly suppressions: readonly VisualStateSuppression[];
    }
  | {
      readonly ok: true;
      readonly fields: SceneSubjectVisualFields;
      readonly provenance: VisualImageProvenance;
      readonly suppressions: readonly VisualStateSuppression[];
      readonly visual: SceneSubjectVisualSlice;
    };

/**
 * ONE subject's committed cut → the field strings the untouched transport
 * consumes: one shadow assembly with the committed camera bound in, ONE
 * camera-bound selection, one digest realized from that exact selection, one
 * shared segments-and-clauses pass.
 *
 * Every subject in a scene goes through here, focal or not. That is the
 * reference-count ruling held in code rather than in a comment: `others` has no
 * appearance algorithm of its own to drift.
 */
/**
 * The viewpoint every subject in this scene is selected under: the plan's
 * committed camera, plus the light the plan's own words name.
 *
 * Built once per plan rather than per subject — two people in one shot stand in
 * one room under one lamp, and a per-subject derivation is how two members of
 * the same cast end up selected at different detail tiers.
 */
function sceneViewpoint(plan: SceneRenderPlan): VisualStateCameraBinding {
  const lighting = sceneLightingBand(plan.lighting);
  return {
    cameraId: SCENE_VISUAL_CAMERA_ID,
    spec: plan.camera,
    ...(lighting === null ? {} : { lighting }),
  };
}

function produceSubjectVisual(
  camera: VisualStateCameraBinding,
  subject: SceneCastVisualSubject,
  sink?: DiagnosticSink,
): SceneSubjectVisualProduction {
  const { member, shadow } = subject;
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
      camera,
      ...(sink === undefined ? {} : { sink }),
    },
    sink,
  );
  if (build === null) {
    sink?.push(
      diag("error", SCENE_VISUAL_DIGEST_UNAVAILABLE, "the visual digest could not be assembled for this scene", {
        context: { subjectId: shadow.subjectId, cutId: shadow.cutId },
      }),
    );
    return { ok: false, refusal: `visual digest unavailable for ${member.name}`, suppressions: [] };
  }

  // This job realizes the cut it just assembled — the inspector precedent — so
  // `forCutId` names the same id and the stale-cut gate stays a seam contract
  // rather than a live branch.
  const digestBuild = visualStateImageDigestOfShadow(build, {
    forCutId: shadow.cutId,
    ...(sink === undefined ? {} : { sink }),
  });
  const segments = buildVisualSubjectSegments({
    digest: digestBuild.digest,
    subjectId: shadow.subjectId,
    exposure,
    policy: SCENE_SEGMENT_POLICY,
    clause: visualFactClauseResolverForScene(resolved, realizedBody),
    ...(sink === undefined ? {} : { sink }),
  });
  if (segments.missingRequired.length > 0) {
    sink?.push(
      diag("error", SCENE_VISUAL_REQUIRED_MISSING, "required visual facts resolved no clause for this scene", {
        context: { subjectId: shadow.subjectId, keys: [...segments.missingRequired] },
      }),
    );
    return {
      ok: false,
      provenance: digestBuild.provenance,
      refusal: `required visual facts unresolved for ${member.name}: ${segments.missingRequired.join(", ")}`,
      suppressions: segments.suppressions,
    };
  }

  // Field routing. `identityAnchors` (referenced subject) and `appearance`
  // (textual subject) both carry the digest's identity/morphology clauses; the
  // transport emits exactly one of the two per subject-mode, so no fact lands
  // twice in one prompt. The reveal lines keep their exposure-aware machinery
  // and per-route intimate gating byte-compatible.
  const digestIdentity = segmentText(segments.segments, IDENTITY_SEGMENT_KINDS);
  const digestState = segmentText(segments.segments, STATE_SEGMENT_KINDS);
  // The slice's ledger is the builder's, cut to what the sent prompt actually
  // states: the two folds above, plus the coverage statement the TRANSPORT
  // makes on its own line (`formatExposure` over this same `exposure` value —
  // see the module doc §Transport is untouched). A fact in any other kind
  // never reached a field string, and the shadow must not be told it did.
  // The exposure rows are kept only where formatExposure actually words the
  // read: every bare region in its torso-through-feet scope, sheer only at
  // the torso and pelvis — it has no sheer wording for legs or feet, and a
  // ledger row for an unworded read would claim a statement the prompt does
  // not make.
  const statedExposureKeys = new Set(
    visualExposureReads(exposure, ["torso", "pelvis", "legs", "feet"])
      .filter((read) => read.coverage === "bare" || read.region === "torso" || read.region === "pelvis")
      .map((read) => `${shadow.subjectId}/exposure.${read.region}`),
  );
  const emittedFactKeys = segments.emitted
    .filter(
      (emission) =>
        IDENTITY_SEGMENT_KINDS.has(emission.segmentKind) ||
        STATE_SEGMENT_KINDS.has(emission.segmentKind) ||
        (emission.segmentKind === "exposure" && statedExposureKeys.has(emission.key)),
    )
    .map((emission) => emission.key);
  return {
    ok: true,
    provenance: digestBuild.provenance,
    suppressions: segments.suppressions,
    visual: {
      subjectId: shadow.subjectId,
      cutId: shadow.cutId,
      name: member.name,
      digest: digestBuild.digest,
      attributes: resolved,
      realizedBody,
      exposure,
      emittedFactKeys,
      suppressions: segments.suppressions,
      missingRequired: segments.missingRequired,
    },
    fields: {
      appearance: [
        digestIdentity,
        residualSheet(resolved, realizedBody, exposure),
        digestState,
        visualStateNote(member.meters),
      ]
        .filter(Boolean)
        .join(". "),
      identityAnchors: [identityAnchorSummary(resolved, member.profile), digestIdentity].filter(Boolean).join("; "),
      lowerBody: sceneRevealAppearance(resolved, exposure, member.profile, { intimate: false }),
      intimateAppearance: sceneRevealAppearance(resolved, exposure, member.profile, { intimate: true }),
    },
  };
}

/** Patch one plan spec — focal or `others` — with the digest-produced fields. */
function withDigestFields(spec: SceneCharacterSpec, fields: SceneSubjectVisualFields): SceneCharacterSpec {
  // Rebuild rather than spread-over: an empty digest-era anchor or reveal line
  // must REMOVE the legacy key, mirroring `characterSpec`'s conditional shape.
  const { identityAnchors: legacyAnchors, lowerBody: legacyLowerBody, ...rest } = spec;
  void legacyAnchors;
  void legacyLowerBody;
  return {
    ...rest,
    appearance: fields.appearance,
    ...(fields.identityAnchors ? { identityAnchors: fields.identityAnchors } : {}),
    ...(fields.lowerBody ? { lowerBody: fields.lowerBody } : {}),
    // No age field, ever: scene renders inherit visible age from the reference,
    // and the segments policy above omits the digest's age facts.
    intimateAppearance: fields.intimateAppearance,
  };
}

/**
 * The shared resolver under the scene lane's residue cut: the catalog-derived
 * set (`RECOGNITION_RESIDUE_ATTRIBUTE_IDS`) — a cataloged distinctive mark's
 * phrasing stays with the sheet and the anchor whitelist, so the digest clause
 * omits rather than stating the fact twice.
 */
function visualFactClauseResolverForScene(resolved: readonly AttributeValue[], realizedBody: RealizedBody) {
  return visualFactClauseResolver({
    attributes: resolved,
    realizedBody,
    omitAttributeIds: RECOGNITION_RESIDUE_ATTRIBUTE_IDS,
  });
}

// ---------------------------------------------------------------------------
// One `meta.visualState` record over N cuts
// ---------------------------------------------------------------------------

/**
 * Control character, so no fingerprint can contain one — two different cast
 * fingerprint lists therefore cannot flatten to the same composite input. The
 * same separator discipline `visualStateFeaturesFingerprint` uses.
 */
const CAST_FINGERPRINT_SEPARATOR = "\u001f";

/** The cast-wide form of a per-cut fingerprint: same fixed width, order included. */
function castFingerprint(parts: readonly string[]): string {
  return fnv1aHex(parts.join(CAST_FINGERPRINT_SEPARATOR));
}

/**
 * Fold the per-subject provenance records into the ONE record the image row
 * files under `meta.visualState`. See the module doc §"One render, N cuts" for
 * why each field takes the value it does; a single record is returned untouched,
 * which is what keeps a cast of one byte-identical to the Stage 3 cutover.
 */
function mergeVisualImageProvenance(records: readonly VisualImageProvenance[]): VisualImageProvenance | undefined {
  const head = records[0];
  if (head === undefined || records.length === 1) return head;
  return {
    ...head,
    snapshotFingerprint: castFingerprint(records.map((record) => record.snapshotFingerprint)),
    selectionFingerprint: castFingerprint(records.map((record) => record.selectionFingerprint)),
    subjects: records.flatMap((record) => record.subjects),
    suppressions: records.flatMap((record) => record.suppressions),
  };
}

/** The `meta.visualState` fragment, or nothing at all when no digest was built. */
function digestMetaOf(records: readonly VisualImageProvenance[]): { digestMeta?: Record<string, unknown> } {
  const merged = mergeVisualImageProvenance(records);
  return merged === undefined ? {} : { digestMeta: { [VISUAL_IMAGE_PROVENANCE_META_KEY]: merged } };
}
