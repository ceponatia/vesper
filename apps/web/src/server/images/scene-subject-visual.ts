import {
  conditionAttributeOverlays,
  diag,
  exposedRegions,
  FULLY_COVERED,
  resolveAttributes,
  VISUAL_IMAGE_PROVENANCE_META_KEY,
  type ActiveCondition,
  type AttributeValue,
  type DiagnosticSink,
  type RegionExposure,
  type RealizedBody,
  type VisualImageDigest,
  type VisualImageProvenance,
} from "@/contracts";
import { realizeBody } from "@/contracts/species";
import type { CharacterProfile } from "@/contracts/world/profile";
import { fnv1aHex } from "@/lib/hash";
import {
  safeBuildVisualStateShadow,
  visualStateImageDigestOfShadow,
  type VisualStateCameraBinding,
  type VisualStateShadowInput,
} from "@/server/visual-state";
import { normalizeName, type SceneRenderPlan } from "./prompts-scene-plan";
import { sceneLightingBand } from "./scene-lowering";

/**
 * THE CHAT SCENE LANE'S CAST SEAM — one committed visual cut per person the
 * scene draws, realized under the plan's committed camera, in the shape the
 * prompt program compiles.
 *
 * `renderCharacterSceneImage` calls {@link applySceneCastVisual} AFTER
 * `composeSceneSpec` → `resolveScenePlan`, because the committed camera is
 * `plan.camera` and the camera must enter each selection pass — never a
 * re-select (`image-digest.ts` §Reuse the selection). The queue prepares one
 * camera-less shadow input PER PRESENT MEMBER through the shared chat factory
 * (`chatVisualStateShadowInput`), so the scene render and the admin inspector
 * assemble a committed cut the same way.
 *
 * ## What comes out, and where it goes
 *
 * One {@link SceneSubjectVisualSlice} per subject: the realized digest, the
 * three-layer attribute resolve it was selected over, the realized body and the
 * canonical coverage readout. That slice is the program's own cut shape
 * (`CharacterPromptSubjectCut`, plus the cut id the render's staleness check
 * reads), and it is the WHOLE of what the compiled prompt says about the
 * person: `scene.ts` hands every slice to `buildCharacterPromptProgram`, which
 * folds the cast into one world digest and lets the endpoint's dialect word it.
 * Nothing here writes prose, and the plan is not touched — the scene's own
 * decisions (the setting, the light, the mood, the capture mode, the staged
 * arrangement, what each person is doing) reach the program through
 * `scene-lowering.ts`, never through this seam.
 *
 * The one thing the plan owes this module is its LIGHT: the composer's phrase
 * names a band ({@link sceneLightingBand}), and that band enters the selection
 * so a night scene is not selected as though the room were lit.
 *
 * ## A cast of N
 *
 * ONE realization describes everybody. {@link applySceneCastVisual} runs one
 * shadow assembly, ONE camera-bound selection and one digest realization PER
 * SUBJECT — each person's own committed cut, because one character's clothing,
 * conditions and body surface can never answer what another is showing.
 * {@link applySceneSubjectVisual} is the one-subject spelling of that call and
 * nothing more. Subjects are matched to their plan spec by `normalizeName`, the
 * same binding the rest of the scene code uses, so a subject the plan has no
 * spec for (a location-only shot) contributes no cut rather than being filed
 * against somebody else. Focal first, then the caller's roster order: the
 * merged provenance takes its identifying fields from the head record, and a
 * refusal names the focal's failure before a bystander's.
 *
 * ## Failure behavior
 *
 * A shadow assembly that cannot be built refuses the WHOLE render before
 * provider spend — for any subject, not just the focal: a scene missing one
 * person's cut is the same wrong picture as a scene missing the focal's. The
 * refusal lands on the scene row via `failedPrecondition` naming the subject
 * that failed, exactly like an identity-pack refusal. A cut that assembles but
 * loses a REQUIRED anchor on its way to the prompt is the compile's refusal,
 * not this seam's: `scene.ts` compiles every rung with `refuseOnMissingRequired`
 * and drops a rung that refuses, so one policy owns that decision.
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
// Lane constants and diagnostics
// ---------------------------------------------------------------------------

/** The viewpoint id the committed scene camera is selected under. */
export const SCENE_VISUAL_CAMERA_ID = "chat_scene";

/** The shadow assembly failed; the render refuses before provider spend. */
export const SCENE_VISUAL_DIGEST_UNAVAILABLE = "images.scene_render.visual_digest_unavailable";

// ---------------------------------------------------------------------------
// Meter state note
// ---------------------------------------------------------------------------

/**
 * A compact image-specific description of visible meter state.
 *
 * The one stated mapping from a meter level to the physiology a picture can
 * show. Meters are not a visual-state owner, so no committed cut carries this
 * and no compiled scene states it; lowering it as a scene fact is the way it
 * would reach a prompt again.
 */
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
// The seam
// ---------------------------------------------------------------------------

/** The per-member facts the realization reads (a `SceneCastMember` slice). */
export interface SceneSubjectVisualMember {
  readonly name: string;
  readonly profile: CharacterProfile;
  readonly exposure?: RegionExposure;
  readonly outfitExposed?: boolean;
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
  /** The resolved plan: its committed `camera` binds into every selection pass, and its specs say who is drawn. */
  readonly plan: SceneRenderPlan;
  /**
   * Every subject that HAS a committed cut, in roster order. A cast member with
   * no cut is simply absent, and the program then describes nobody it has no
   * cut for.
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
 * One subject's realized cut — the program's own cut shape
 * (`CharacterPromptSubjectCut`) plus the cut id the render's staleness check
 * names. `scene.ts` compiles every rung of a scene from exactly these.
 */
export interface SceneSubjectVisualSlice {
  readonly subjectId: string;
  readonly cutId: string;
  readonly name: string;
  readonly digest: VisualImageDigest;
  /** The three-layer resolve the cut was selected over — the route's reveal reads it. */
  readonly attributes: readonly AttributeValue[];
  readonly realizedBody: RealizedBody;
  /** The canonical coverage readout the exposure claims are made over. */
  readonly exposure: RegionExposure;
}

export interface SceneSubjectVisualBuild {
  /** The merged `meta.visualState` fragment the scene row records at reserve time. */
  readonly digestMeta?: Record<string, unknown>;
  /** Non-null refuses the render before provider spend. */
  readonly refusal: string | null;
  /** The realized cuts, focal first then roster order — what the scene's program compiles from. */
  readonly visuals: readonly SceneSubjectVisualSlice[];
}

/**
 * Realize EVERY supplied subject's committed cut under the plan's camera — one
 * shadow assembly, one camera-bound selection, one digest per subject — and
 * hand back the slices the program compiles. Pure over its inputs.
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

  const provenanceRecords: VisualImageProvenance[] = [];
  const visuals: SceneSubjectVisualSlice[] = [];
  const viewpoint = sceneViewpoint(plan);
  for (const subject of ordered) {
    if (!specKeys.has(normalizeName(subject.member.name))) {
      // The plan draws nobody by this name — a location-only shot, or a cut for
      // somebody the resolved plan does not feature. Nothing is realized for
      // them: a cut the program never compiles would only add a person to the
      // provenance who is not in the picture.
      sink?.push(
        diag("info", SCENE_VISUAL_DIGEST_UNAVAILABLE, "no scene spec draws this subject — no cut realized for them", {
          context: { subjectId: subject.shadow.subjectId },
        }),
      );
      continue;
    }
    const produced = produceSubjectVisual(viewpoint, subject, sink);
    if (!produced.ok) {
      // Refuse, never describe the rest of the cast from somewhere else: the row
      // is reserved and failed with this text before any provider is called. The
      // cuts that WERE realized before the refusal still travel, so the failed
      // row records the moment it was asked over.
      return { ...digestMetaOf(provenanceRecords), refusal: produced.refusal, visuals: [] };
    }
    provenanceRecords.push(produced.provenance);
    visuals.push(produced.visual);
  }
  return { ...digestMetaOf(provenanceRecords), refusal: null, visuals };
}

/**
 * The one-subject spelling of {@link applySceneCastVisual}, kept because a cast
 * of one is the shape the single-subject suites read the lane through.
 */
export function applySceneSubjectVisual(input: SceneSubjectVisualInput): SceneSubjectVisualBuild {
  return applySceneCastVisual({
    plan: input.plan,
    members: [{ member: input.member, shadow: input.shadow }],
    ...(input.sink === undefined ? {} : { sink: input.sink }),
  });
}

// ---------------------------------------------------------------------------
// The one per-subject realization
// ---------------------------------------------------------------------------

type SceneSubjectVisualProduction =
  | { readonly ok: false; readonly refusal: string }
  | { readonly ok: true; readonly provenance: VisualImageProvenance; readonly visual: SceneSubjectVisualSlice };

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

/**
 * ONE subject's committed cut → the slice the program compiles: one shadow
 * assembly with the committed camera bound in, ONE camera-bound selection, one
 * digest realized from that exact selection.
 *
 * Every subject in a scene goes through here, focal or not. That is the
 * reference-count ruling held in code rather than in a comment: `others` has no
 * realization of its own to drift.
 */
function produceSubjectVisual(
  camera: VisualStateCameraBinding,
  subject: SceneCastVisualSubject,
  sink?: DiagnosticSink,
): SceneSubjectVisualProduction {
  const { member, shadow } = subject;
  // Authored base → persisted narrative overlays → this moment's condition
  // overlays: the same three-layer resolve the narrator prompt takes
  // (`character-chat.ts`'s `fullResolved`), the affordance read takes
  // (`chat-affordances.ts`'s `resolveSubjectAttributes`) and the shadow
  // assembly itself takes (`visual-state/assemble.ts`'s
  // `resolveShadowAttributes`), so the route's own reveal can never disagree
  // with the projection about a recorded haircut or dye.
  const resolved = resolveAttributes(member.profile.attributes, [
    ...(member.attributeOverlays ?? []),
    ...conditionAttributeOverlays([...(member.conditions ?? [])]),
  ]);
  const realizedBody = realizeBody({
    speciesId: member.profile.speciesId,
    heritageId: member.profile.heritageId,
    bodyPlanId: member.profile.bodyPlanId,
    intimateRegions: member.profile.intimateRegions,
    bodyFeatures: member.profile.bodyFeatures,
  });
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
    return { ok: false, refusal: `visual digest unavailable for ${member.name}` };
  }

  // This job realizes the cut it just assembled — the inspector precedent — so
  // `forCutId` names the same id and the stale-cut gate stays a seam contract
  // rather than a live branch.
  const digestBuild = visualStateImageDigestOfShadow(build, {
    forCutId: shadow.cutId,
    ...(sink === undefined ? {} : { sink }),
  });
  return {
    ok: true,
    provenance: digestBuild.provenance,
    visual: {
      subjectId: shadow.subjectId,
      cutId: shadow.cutId,
      name: member.name,
      digest: digestBuild.digest,
      attributes: resolved,
      realizedBody,
      exposure,
    },
  };
}

// ---------------------------------------------------------------------------
// One `meta.visualState` record over N cuts
// ---------------------------------------------------------------------------

/**
 * Control character, so no fingerprint can contain one — two different cast
 * fingerprint lists therefore cannot flatten to the same composite input. The
 * same separator discipline `visualStateFeaturesFingerprint` uses.
 */
const CAST_FINGERPRINT_SEPARATOR = "";

/** The cast-wide form of a per-cut fingerprint: same fixed width, order included. */
function castFingerprint(parts: readonly string[]): string {
  return fnv1aHex(parts.join(CAST_FINGERPRINT_SEPARATOR));
}

/**
 * Fold the per-subject provenance records into the ONE record the image row
 * files under `meta.visualState`. See the module doc §"One render, N cuts" for
 * why each field takes the value it does; a single record is returned untouched,
 * which is what keeps a cast of one byte-identical to a single-subject cut.
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
