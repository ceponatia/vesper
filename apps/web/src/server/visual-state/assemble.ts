import {
  adaptProjectedAppearanceTruth,
  buildVisualAttentionCandidates,
  buildVisualStateSnapshot,
  conditionAttributeOverlays,
  diag,
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
  selectVisualImageFacts,
  selectVisualNarratorCues,
  unsupportedCurrentStateSuppressions,
  visualComponentKnown,
  visualStateFeatureKey,
  VISUAL_COMPONENT_UNKNOWN,
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
  type SceneState,
  type VisualAttentionBuild,
  type VisualAttentionContext,
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

export interface VisualStateSelectionsInput {
  readonly snapshot: VisualStateSnapshot;
  /** The lane's observer exposure/channel view (the affordance read's). */
  readonly perception: AffordancePerceptionView;
  /** The observing player/actor, as the visibility viewpoint names them. */
  readonly observerId: string;
  /** The same observer, as the memory binding names them. */
  readonly observer: VisualObserverRef;
  /** Loaded read-only; never written back by any slice-6 caller. */
  readonly memory?: VisualMemoryState;
  readonly sink?: DiagnosticSink;
}

export interface VisualStateSelections {
  readonly narrator: VisualNarratorSelection;
  readonly image: VisualImageSelection;
  /**
   * The inspector's staircase: every feature scored under a debug viewpoint
   * with ideal viewing conditions, so the panel can show what the projection
   * HOLDS even while the production reads keep the real selections closed.
   */
  readonly staircase: VisualAttentionBuild;
}

/**
 * The shadow viewing conditions, stated honestly: no owner anywhere produces a
 * lighting, distance, angle, or motion read for either lane today (audit
 * finding 14), so every component is `unknown` and the visibility read fails
 * closed — nothing claimed visible, one diagnostic, per-feature suppressions.
 * That IS the slice-4 ruling's intended shadow behavior, and the measurement
 * this produces is what the plan's open question on per-component relaxation
 * waits for. Nothing here may substitute a plausible default.
 */
function shadowComponents() {
  return {
    lighting: VISUAL_COMPONENT_UNKNOWN,
    distance: VISUAL_COMPONENT_UNKNOWN,
    angle: VISUAL_COMPONENT_UNKNOWN,
    motion: VISUAL_COMPONENT_UNKNOWN,
  } as const;
}

/** Ideal viewing conditions for the inspector's debug staircase only. */
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
  const narratorContext: VisualAttentionContext = {
    viewpoint: { kind: "observer", observerId: input.observerId },
    perception: input.perception,
    ...shadowComponents(),
    intimateAllowed: false,
    consumer: "narrator",
  };
  const narrator = selectVisualNarratorCues({
    snapshot: input.snapshot,
    context: narratorContext,
    binding: { scope: input.snapshot.scope, observer: input.observer },
    memory: input.memory ?? emptyVisualMemoryState(),
    ...(sink === undefined ? {} : { sink }),
  });

  const imageContext: VisualAttentionContext = {
    viewpoint: { kind: "camera", cameraId: "visual_state_shadow" },
    perception: input.perception,
    ...shadowComponents(),
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
    ...staircaseComponents(),
    intimateAllowed: false,
    consumer: "inspector",
  };
  const staircase = buildVisualAttentionCandidates({
    snapshot: input.snapshot,
    context: staircaseContext,
    ...(sink === undefined ? {} : { sink }),
  });

  return { narrator, image, staircase };
}
