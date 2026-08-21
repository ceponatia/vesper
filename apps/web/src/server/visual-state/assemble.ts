import {
  adaptProjectedAppearanceTruth,
  buildVisualAttentionCandidates,
  buildVisualStateSnapshot,
  conditionAttributeOverlays,
  diag,
  emptyVisualCueState,
  emptyVisualMemoryState,
  garmentBlueprintFor,
  GARMENT_PLAYER_ACTOR,
  projectActiveConditionFeatures,
  projectAppearanceTruth,
  projectBodyLanguageFeatures,
  projectBodySurfaceFeatures,
  projectGarmentCurrentState,
  projectObservationFeatures,
  projectPresentationFeatures,
  projectSpeciesFeatureGroups,
  projectWardrobeFeatures,
  realizeBody,
  resolveAttributes,
  resolveVisualViewingConditions,
  selectVisualImageFacts,
  selectVisualNarratorCues,
  unsupportedCurrentStateSuppressions,
  visualCameraReadsOfSceneCamera,
  visualComponentKnown,
  visualStateFeatureKey,
  VISUAL_STATE_SOURCE_UNAVAILABLE,
  type ActiveCondition,
  type AffordanceObservation,
  type AffordancePerceptionView,
  type AttributeValue,
  type BodySurfaceState,
  type CharacterPresentationState,
  type ChatEnvironment,
  type ChatGarmentStore,
  type DiagnosticSink,
  type EffectiveCoverageRead,
  type RealizeBodyInput,
  type RealizedBody,
  type SceneCameraSpec,
  type SceneState,
  type VisualAttentionBuild,
  type VisualAttentionContext,
  type VisualCueState,
  type VisualImageSelection,
  type VisualMemoryState,
  type VisualNarratorSelection,
  type VisualObserverRef,
  type VisualStateContribution,
  type VisualStateFeature,
  type VisualStateGarmentInput,
  type VisualStateScopeRef,
  type VisualStateSnapshot,
  type VisualStateSuppression,
  type VisualViewingConditions,
} from "@/contracts";

/**
 * LANE ASSEMBLY for the visual-state projection (visual-state.plan.md slice 6;
 * spec §Implementation placement — "lane adapters and source assembly belong
 * under … a focused `apps/web/src/server/visual-state/` barrel").
 *
 * This module is deliberately PURE over passed-in committed state: no IO, no
 * env, no clock, and no import from any other server module. The turn pipelines
 * and the inspector previews (which own the loads) hand it the same cut a live
 * exchange assembles, so a retake or a branch restore that rebuilds the same
 * inputs rebuilds a byte-identical snapshot — the projection-is-pure ruling,
 * held at the assembly seam and asserted by test.
 *
 * Everything here is SHADOW-side (spec §Flags): nothing it returns may reach a
 * prompt, an image, chat state, or observer memory. The narrator selection's
 * notices, post-notice memory and mention commits come back as plain data and
 * are DISCARDED by every slice-6 caller — spending them is slice 7's separately
 * flagged work.
 *
 * ## Missing owners mean silence, and silence is recorded
 *
 * The two lanes can feed very different subsets of the canonical owners
 * (successor chats have no wardrobe store, no body-surface state, no scene
 * relations). An owner the lane cannot hand over is recorded as one
 * `visual_state.source.unavailable` suppression at the subject locus — the
 * inspector's explanation and the missing-owner measurement in one entry —
 * following the standing unsupported-fact table's precedent (info severity:
 * a designed absence is context, not an alarm).
 */

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

/** Which turn pipeline produced this cut. Decides the legacy-summary comparison. */
export type VisualStateLane = "character_chat" | "successor";

/** The wardrobe owner's state, plus the two facts instances cannot carry. */
export interface VisualStateLaneGarments {
  readonly store: ChatGarmentStore;
  /** The subject's garment actor handle (`garmentActorForCharacter(id)`). */
  readonly actorId: string;
  /**
   * Clothing layer per garment instance id, from the lane's resolved worn rows
   * (`ResolvedChatWardrobe.worn`). Absent entries mean "stacks with nothing" —
   * the adapter's own degraded default, never a guessed order.
   */
  readonly layersByGarmentId?: ReadonlyMap<string, number>;
  /**
   * THIS cut's staged effective-coverage capture for the subject (the affordance
   * read's `coverage`), preferred over the store's last-committed capture so the
   * shadow reads the same cut the narrator writes from.
   */
  readonly freshCoverage?: EffectiveCoverageRead | null;
}

/** The scene / body-relations owner, with the lane's participant → subject map. */
export interface VisualStateLaneScene {
  readonly scene: SceneState;
  readonly subjectsByParticipant: ReadonlyMap<string, string>;
}

/**
 * One committed cut, as the lane can actually hand it over. Every optional
 * owner field that is ABSENT is recorded as a lane-unavailable suppression;
 * present-but-empty is the owner answering "nothing", which is silence without
 * a record.
 */
export interface VisualStateAssemblyInput {
  readonly scope: VisualStateScopeRef;
  /** The exchange's rollback guard (chat) or the committed cut id (successor). */
  readonly cutId: string;
  readonly atMinutes: number;
  readonly subjectId: string;
  /** The subject's authored attributes — the base the overlays resolve over. */
  readonly attributes: readonly AttributeValue[];
  readonly attributeOverlays?: readonly AttributeValue[];
  readonly conditions?: readonly ActiveCondition[];
  /** The realized-body inputs (species, heritage, body plan, features). */
  readonly realize?: RealizeBodyInput;
  readonly presentation?: CharacterPresentationState;
  readonly garments?: VisualStateLaneGarments;
  /** The visual subject id player-worn garments and scene facts file under. */
  readonly playerSubjectId?: string;
  /** The subject a garment left in the scene hangs under. Absent ⇒ not projected. */
  readonly sceneSubjectId?: string;
  readonly bodySurface?: BodySurfaceState;
  readonly environment?: ChatEnvironment;
  readonly sceneRelations?: VisualStateLaneScene;
  /** The affordance read's derived observations for this cut. */
  readonly observations?: readonly AffordanceObservation[];
  readonly sink?: DiagnosticSink;
}

export interface VisualStateAssembly {
  readonly snapshot: VisualStateSnapshot;
  /** Base + persisted overlays — what the legacy prompt's stable block resolves. */
  readonly stableResolved: readonly AttributeValue[];
  /** Stable + condition overlays — what the projection was taken over. */
  readonly fullResolved: readonly AttributeValue[];
  readonly realizedBody: RealizedBody;
}

// ---------------------------------------------------------------------------
// Lane-unavailable suppressions
// ---------------------------------------------------------------------------

/** The canonical owners a lane may be unable to hand over. */
export const visualStateLaneOwners = [
  "presentation",
  "wardrobe",
  "body_surface",
  "condition",
  "scene_relation",
  "affordance_observation",
] as const;
export type VisualStateLaneOwner = (typeof visualStateLaneOwners)[number];

/**
 * One owner this lane could not hand over, as a suppression the snapshot
 * carries. The key is the address the owner's facts would have hung under, so
 * the inspector's staircase has somewhere to hang the explanation; `info`
 * severity because a lane's standing gap is context, not a degradation alarm.
 */
function laneUnavailable(
  subjectId: string,
  owner: VisualStateLaneOwner,
  sink: DiagnosticSink | undefined,
): VisualStateSuppression {
  const locus = { kind: "subject", subjectId } as const;
  sink?.push(
    diag("info", VISUAL_STATE_SOURCE_UNAVAILABLE, `This lane cannot hand over the ${owner} owner`, {
      path: "visual_state.assembly",
      context: { subjectId, owner },
    }),
  );
  return {
    key: visualStateFeatureKey(subjectId, locus, `lane.${owner}`),
    code: VISUAL_STATE_SOURCE_UNAVAILABLE,
    detail: `lane:${owner}`,
  };
}

// ---------------------------------------------------------------------------
// Snapshot assembly
// ---------------------------------------------------------------------------

/**
 * Resolve the subject's attributes the way both live prompts do: authored base,
 * then persisted narrative overlays, then this moment's condition overlays —
 * identical composition to `chat-affordances.ts`'s `resolveSubjectAttributes`,
 * so the shadow can never disagree with the read the narrator rides.
 */
function resolveShadowAttributes(input: VisualStateAssemblyInput): {
  stable: readonly AttributeValue[];
  full: readonly AttributeValue[];
} {
  const stable = resolveAttributes(input.attributes, [...(input.attributeOverlays ?? [])]);
  const full = resolveAttributes(input.attributes, [
    ...(input.attributeOverlays ?? []),
    ...conditionAttributeOverlays([...(input.conditions ?? [])]),
  ]);
  return { stable, full };
}

/** The wardrobe adapter's per-garment inputs, from the lane's store. */
function garmentInputsOf(garments: VisualStateLaneGarments): VisualStateGarmentInput[] {
  return garments.store.instances.map((instance) => {
    const layer = garments.layersByGarmentId?.get(instance.id);
    return {
      instance,
      blueprint: garmentBlueprintFor(garments.store, instance),
      // Category and subtype live on the library definition, which this cut does
      // not carry; the adapter's documented degraded default (ordinary clothing)
      // applies. Recorded as a slice-6 measurement caveat, not silently.
      ...(layer === undefined ? {} : { layer }),
    };
  });
}

/** Actor handle → visual subject id, for every actor this snapshot names. */
function wardrobeSubjects(input: VisualStateAssemblyInput): ReadonlyMap<string, string> {
  const map = new Map<string, string>();
  if (input.garments !== undefined) map.set(input.garments.actorId, input.subjectId);
  if (input.playerSubjectId !== undefined) map.set(GARMENT_PLAYER_ACTOR, input.playerSubjectId);
  return map;
}

/** Captured coverage per visual subject, preferring this cut's staged capture. */
function coverageBySubject(input: VisualStateAssemblyInput): ReadonlyMap<string, EffectiveCoverageRead> {
  const map = new Map<string, EffectiveCoverageRead>();
  const garments = input.garments;
  if (garments === undefined) return map;
  for (const [actorId, capture] of Object.entries(garments.store.coverage)) {
    const subject =
      actorId === garments.actorId
        ? input.subjectId
        : actorId === GARMENT_PLAYER_ACTOR
          ? input.playerSubjectId
          : undefined;
    if (subject !== undefined) map.set(subject, capture);
  }
  if (garments.freshCoverage !== null && garments.freshCoverage !== undefined) {
    map.set(input.subjectId, garments.freshCoverage);
  }
  return map;
}

/**
 * One committed cut as a visual-state snapshot.
 *
 * Adapters run in the canonical adapter order, each composing against the
 * features earlier adapters produced, and each absent owner is recorded rather
 * than skipped silently. The standing unsupported-fact table (ownerless
 * current-state facts, audit finding 14) is appended for the subject on every
 * assembly, whichever lane asked.
 */
export function assembleVisualStateSnapshot(input: VisualStateAssemblyInput): VisualStateAssembly {
  const sink = input.sink;
  const { stable, full } = resolveShadowAttributes(input);
  const realizedBody = realizeBody(input.realize ?? {});

  // Appearance truth: attributes (overlays applied), located facts and anatomy.
  // The chat lane authors neither located facts nor evented anatomy yet
  // (chat-recognition-adapter.ts header), so the projection carries attributes.
  const appearance = adaptProjectedAppearanceTruth(
    projectAppearanceTruth({
      subjectId: input.subjectId,
      attributes: full,
      atMinutes: input.atMinutes,
      ...(sink === undefined ? {} : { sink }),
    }),
    sink,
  );

  const species = projectSpeciesFeatureGroups({
    subjectId: input.subjectId,
    realizedBody,
    ...(sink === undefined ? {} : { sink }),
  });

  const composed: VisualStateFeature[] = [...appearance, ...species];
  const contributions: VisualStateContribution[] = [
    { adapterId: "appearance", features: appearance },
    { adapterId: "species", features: species },
  ];

  // Non-item presentation. No lane persists the owner yet, so today this is
  // always the recorded absence — the owner exists as a contract with no writer.
  if (input.presentation !== undefined) {
    const features = projectPresentationFeatures({
      state: input.presentation,
      composeAgainst: composed,
      ...(sink === undefined ? {} : { sink }),
    });
    composed.push(...features);
    contributions.push({ adapterId: "presentation", features });
  } else {
    contributions.push({
      adapterId: "presentation",
      features: [],
      suppressions: [laneUnavailable(input.subjectId, "presentation", sink)],
    });
  }

  // Wardrobe identity (slice 2) + garment current state (slice 3), one owner.
  if (input.garments !== undefined) {
    const garmentInputs = garmentInputsOf(input.garments);
    const subjectsByActor = wardrobeSubjects(input);
    const capturedCoverage = coverageBySubject(input);
    const shared = {
      garments: garmentInputs,
      subjectsByActor,
      ...(input.sceneSubjectId === undefined ? {} : { sceneSubjectId: input.sceneSubjectId }),
      ...(sink === undefined ? {} : { sink }),
    };
    const identity = projectWardrobeFeatures({
      ...shared,
      composeAgainst: composed,
      ...(capturedCoverage.size === 0 ? {} : { capturedCoverage }),
    });
    composed.push(...identity);
    const current = projectGarmentCurrentState({
      ...shared,
      atMinutes: input.atMinutes,
      composeAgainst: composed,
    });
    composed.push(...current);
    contributions.push({ adapterId: "wardrobe", features: [...identity, ...current] });
  } else {
    contributions.push({
      adapterId: "wardrobe",
      features: [],
      suppressions: [laneUnavailable(input.subjectId, "wardrobe", sink)],
    });
  }

  // Current state: body-surface wetness, active conditions, and the standing
  // unsupported-fact table — one contribution, the current-state family.
  const currentFeatures: VisualStateFeature[] = [];
  const currentSuppressions: VisualStateSuppression[] = [];
  if (input.bodySurface !== undefined) {
    const surface = projectBodySurfaceFeatures({
      subjectId: input.subjectId,
      state: input.bodySurface,
      atMinutes: input.atMinutes,
      ...(input.environment === undefined ? {} : { environment: input.environment }),
      composeAgainst: composed,
      ...(sink === undefined ? {} : { sink }),
    });
    currentFeatures.push(...surface.features);
    currentSuppressions.push(...surface.suppressions);
  } else {
    currentSuppressions.push(laneUnavailable(input.subjectId, "body_surface", sink));
  }
  if (input.conditions !== undefined) {
    currentFeatures.push(
      ...projectActiveConditionFeatures({
        subjectId: input.subjectId,
        conditions: input.conditions,
        atMinutes: input.atMinutes,
        ...(sink === undefined ? {} : { sink }),
      }),
    );
  } else {
    currentSuppressions.push(laneUnavailable(input.subjectId, "condition", sink));
  }
  currentSuppressions.push(...unsupportedCurrentStateSuppressions(input.subjectId, sink));
  composed.push(...currentFeatures);
  contributions.push({ adapterId: "condition", features: currentFeatures, suppressions: currentSuppressions });

  // Body language from the scene / body-relations owner.
  if (input.sceneRelations !== undefined) {
    const bodyLanguage = projectBodyLanguageFeatures({
      scene: input.sceneRelations.scene,
      subjectsByParticipant: input.sceneRelations.subjectsByParticipant,
      ...(sink === undefined ? {} : { sink }),
    });
    composed.push(...bodyLanguage.features);
    contributions.push({
      adapterId: "scene_relation",
      features: bodyLanguage.features,
      suppressions: bodyLanguage.suppressions,
    });
  } else {
    contributions.push({
      adapterId: "scene_relation",
      features: [],
      suppressions: [laneUnavailable(input.subjectId, "scene_relation", sink)],
    });
  }

  // Derived physical-affordance observations, from the lane's staged read.
  if (input.observations !== undefined) {
    const features = projectObservationFeatures({
      subjectId: input.subjectId,
      observations: input.observations,
      ...(sink === undefined ? {} : { sink }),
    });
    contributions.push({ adapterId: "affordance", features });
  } else {
    contributions.push({
      adapterId: "affordance",
      features: [],
      suppressions: [laneUnavailable(input.subjectId, "affordance_observation", sink)],
    });
  }

  const snapshot = buildVisualStateSnapshot({
    scope: input.scope,
    atMinutes: input.atMinutes,
    cutId: input.cutId,
    contributions,
    ...(sink === undefined ? {} : { sink }),
  });

  return { snapshot, stableResolved: stable, fullResolved: full, realizedBody };
}

// ---------------------------------------------------------------------------
// Selections
// ---------------------------------------------------------------------------

/**
 * A committed scene camera, bound into the ONE image selection pass
 * (image-lane-consolidation.spec.visual-state.md §Camera). The id names the
 * viewpoint the selection runs under; the spec supplies the distance, angle and
 * framing reads through `visualCameraReadsOfSceneCamera`. Lighting and motion
 * deliberately stay lane-derived — the scene camera proves where the frame is,
 * not what the light does.
 */
export interface VisualStateCameraBinding {
  readonly cameraId: string;
  readonly spec: SceneCameraSpec;
}

export interface VisualStateSelectionsInput {
  readonly snapshot: VisualStateSnapshot;
  /** The lane's observer exposure/channel view (the affordance read's). */
  readonly perception: AffordancePerceptionView;
  /**
   * The subject `perception` actually describes. The lane resolves coverage
   * for the primary character only, so every other subject in the snapshot
   * (the player, other roster members) has no exposure owner — and reading
   * theirs through this view would let one character's clothing answer for
   * another's. They resolve nothing instead.
   */
  readonly perceptionSubjectId: string;
  /** The observing player/actor, as the visibility viewpoint names them. */
  readonly observerId: string;
  /** The same observer, as the memory binding names them. */
  readonly observer: VisualObserverRef;
  /** Loaded read-only; never written back by any slice-6 caller. */
  readonly memory?: VisualMemoryState;
  /**
   * The narrator cue state as of before this cut, loaded read-only. Slice 6
   * discards the selection's cue outputs exactly as it discards its memory
   * outputs; committing them is the narration flag's work.
   */
  readonly cues?: VisualCueState;
  /** The committed scene, for the distance and angle reads. */
  readonly scene?: SceneState;
  /** The scene participant doing the looking. */
  readonly observerParticipantId?: string;
  /** The scene participant being looked at. */
  readonly subjectParticipantId?: string;
  /**
   * The render's committed camera, when a route has one. Present, it replaces
   * the shadow placeholder viewpoint and overrides the image context's
   * distance, angle and framing with the camera's own reads — inside this one
   * selection pass, never re-selected downstream. Absent, the image selection
   * is byte-identical to the camera-less shadow build.
   */
  readonly camera?: VisualStateCameraBinding;
  readonly sink?: DiagnosticSink;
}

export interface VisualStateSelections {
  readonly narrator: VisualNarratorSelection;
  readonly image: VisualImageSelection;
  /**
   * The camera context `image` was selected under, carried out rather than
   * discarded. Realizing the image digest needs the SAME snapshot, selection
   * and context that produced the selection — rebuilding a look-alike context
   * downstream is how a digest ends up fingerprinting one camera while
   * describing another, and the digest's own consistency gate would only catch
   * the subject/key half of that mistake.
   */
  readonly imageContext: VisualAttentionContext;
  /**
   * The inspector's staircase: every feature scored under a debug viewpoint
   * with ideal viewing conditions, so the panel can show what the projection
   * HOLDS independently of where the scene put the subject.
   */
  readonly staircase: VisualAttentionBuild;
  /**
   * The conditions the production reads actually ran under, carried so the
   * inspector and the trial can see which components an owner answered and
   * which came from the declared base. A policy nobody can read is not a
   * stated policy.
   */
  readonly viewing: VisualViewingConditions;
}

/**
 * The lane's viewing conditions (plan §Open questions → "how the narrator lane
 * obtains usable viewing conditions", resolved 2026-08-17).
 *
 * Until this, every component was passed as `unknown`, the slice-4 read failed
 * the whole feature list closed, and the production narrator selection had zero
 * candidates under every ordinary condition — the second of the two blockers
 * slice 7 could not absorb. `resolveVisualViewingConditions` supplies distance
 * and angle from the scene owner where it states them, and the release's
 * declared base values where nothing owns them. Declared reads are marked, so
 * the trial can separate a grounded read from a stated policy; nothing here
 * substitutes an unmarked default.
 */
function laneComponents(input: VisualStateSelectionsInput) {
  return resolveVisualViewingConditions({
    ...(input.scene === undefined ? {} : { scene: input.scene }),
    ...(input.observerParticipantId === undefined ? {} : { observerParticipantId: input.observerParticipantId }),
    ...(input.subjectParticipantId === undefined ? {} : { subjectParticipantId: input.subjectParticipantId }),
  });
}

/**
 * Ideal viewing conditions for the inspector's debug staircase only.
 *
 * Still worth keeping now that the production reads are open: the staircase's
 * job is to show what the projection HOLDS, so it must not move when the scene
 * places the subject across the room. These are asserted as `known` rather than
 * declared because the debug viewpoint is not a claim about the world at all.
 */
function staircaseComponents() {
  return {
    lighting: visualComponentKnown("bright" as const),
    distance: visualComponentKnown("close" as const),
    angle: visualComponentKnown("toward" as const),
    motion: visualComponentKnown("still" as const),
  } as const;
}

/**
 * The three consumer reads over one snapshot. The narrator selection consults
 * observer memory (loaded read-only); the image selection is structurally
 * memoryless; the staircase runs as the inspector consumer, which also never
 * reads memory. The intimate gate stays SHUT everywhere: this lane has no
 * consent owner, and "no owner" is not "allowed" — the recognition adapter's
 * own ruling, kept.
 */
export function buildVisualStateSelections(input: VisualStateSelectionsInput): VisualStateSelections {
  const sink = input.sink;
  // Exposure is owned per subject. Only the primary has a coverage read in
  // either lane today, so it is the only entry — an unlisted subject resolves
  // nothing rather than borrowing this one.
  const perceptionBySubject = new Map([[input.perceptionSubjectId, input.perception]]);
  const components = laneComponents(input);
  const narratorContext: VisualAttentionContext = {
    viewpoint: { kind: "observer", observerId: input.observerId },
    perception: input.perception,
    perceptionBySubject,
    ...components,
    intimateAllowed: false,
    consumer: "narrator",
  };
  const narrator = selectVisualNarratorCues({
    snapshot: input.snapshot,
    context: narratorContext,
    binding: { scope: input.snapshot.scope, observer: input.observer },
    memory: input.memory ?? emptyVisualMemoryState(),
    cues: input.cues ?? emptyVisualCueState(),
    ...(sink === undefined ? {} : { sink }),
  });

  // The image camera. A route that holds a committed scene camera binds it
  // here — the real viewpoint id, plus the camera's own distance, angle and
  // framing reads over the lane's lighting and motion — so the camera enters
  // the ONE selection pass and the digest fingerprints the camera the facts
  // were actually selected under. Without a binding, the shadow placeholder
  // takes the lane reads unchanged: leaving them unknown would keep slice 6's
  // image measurement at a permanent zero, which measures the placeholder
  // rather than the projection.
  const cameraReads = input.camera === undefined ? undefined : visualCameraReadsOfSceneCamera(input.camera.spec);
  const imageContext: VisualAttentionContext = {
    viewpoint: { kind: "camera", cameraId: input.camera?.cameraId ?? "visual_state_shadow" },
    perception: input.perception,
    perceptionBySubject,
    ...components,
    ...(cameraReads === undefined
      ? {}
      : { distance: cameraReads.distance, angle: cameraReads.angle, framing: cameraReads.framing }),
    intimateAllowed: false,
    consumer: "image",
  };
  const image = selectVisualImageFacts({
    snapshot: input.snapshot,
    context: imageContext,
    ...(sink === undefined ? {} : { sink }),
  });

  const staircaseContext: VisualAttentionContext = {
    viewpoint: { kind: "debug" },
    perception: input.perception,
    perceptionBySubject,
    ...staircaseComponents(),
    intimateAllowed: false,
    consumer: "inspector",
  };
  const staircase = buildVisualAttentionCandidates({
    snapshot: input.snapshot,
    context: staircaseContext,
    ...(sink === undefined ? {} : { sink }),
  });

  return { narrator, image, imageContext, staircase, viewing: components };
}
