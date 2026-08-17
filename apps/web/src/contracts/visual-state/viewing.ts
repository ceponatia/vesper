import { affordanceSubjectIdSchema, type AffordanceSubjectId } from "../affordances/core";
import {
  sceneFacingFact,
  sceneProximityFact,
  type SceneState,
} from "../affordances/scene";
import {
  visualComponentDeclared,
  visualComponentKnown,
  type VisualAngleBand,
  type VisualComponentRead,
  type VisualDistanceBand,
  type VisualLightingBand,
  type VisualMotionBand,
} from "./visibility";

/**
 * WHERE THE NARRATOR'S VIEWING CONDITIONS COME FROM (visual-state.plan.md
 * §Open questions → "how the narrator lane obtains usable viewing conditions";
 * spec §Visibility).
 *
 * Slice 4 built a visibility read that fails the WHOLE feature list closed on
 * any unknown component, and slices 4–6 then supplied all four components as
 * unknown — so the production narrator selection had zero candidates under
 * every ordinary condition, and the inspector only looked alive because its
 * staircase substitutes ideal conditions. This module is the answer, and it
 * splits the four components into two honest halves:
 *
 * - **Owned when stated.** Distance IS the scene owner's proximity between the
 *   observer and the subject, and angle IS the scene owner's facing of the
 *   subject toward the observer — the same two vocabularies, not a second
 *   ladder, and the same mapping the image digest already performs on a
 *   committed scene camera (`visualCameraReadsOfSceneCamera`). When the scene
 *   states the fact, the read is a plain `known` with the owner behind it.
 * - **Declared when nothing owns them.** No system anywhere records how bright
 *   a chat's scene is or whether a body is moving relative to the viewer
 *   (visual-state.audit.md finding 14). The owner's ruling (2026-08-17) is a
 *   BASE VALUE placeholder rather than a new simulation owner: the release
 *   states the value, marks it `declared`, and measures it. That is the plan's
 *   permitted "explicit degraded first-release policy … stated as such"; the
 *   thing it forbids — silently reading unknown as bright and still — is
 *   exactly what `visualComponentDeclared` makes impossible to do quietly,
 *   since the marker rides the fingerprint, the evidence, one info diagnostic,
 *   and the inspector payload.
 *
 * Every constant here is a calibration default, not product law. Replacing the
 * lighting placeholder with a real owner later is a change to ONE line plus its
 * caller — the marker is what makes that swap visible when it happens.
 *
 * Pure: no clock, no IO, and no read of anything but the committed scene.
 */

// ---------------------------------------------------------------------------
// The declared base values
// ---------------------------------------------------------------------------

/**
 * Base light. An ordinary lit room is what these conversations happen in, and
 * the alternative — failing closed — silences the entire narrator lane, which
 * is the blocker this resolves. `silhouette` stays camera-only: it describes a
 * viewpoint's relationship to a light source, which is a shot decision rather
 * than an ambient fact, and only the image lane can assert one.
 */
export const VISUAL_VIEWING_BASE_LIGHTING: VisualLightingBand = "bright";

/** Base whole-subject motion. A conversation is a still scene until something owns otherwise. */
export const VISUAL_VIEWING_BASE_MOTION: VisualMotionBand = "still";

/**
 * Base distance, used only when the scene states no proximity for the pair.
 * Two people in a conversation are within arm's length; `touching` would claim
 * contact the contact owner never committed.
 */
export const VISUAL_VIEWING_BASE_DISTANCE: VisualDistanceBand = "close";

/** Base angle, used only when the scene states no facing. People talking face each other. */
export const VISUAL_VIEWING_BASE_ANGLE: VisualAngleBand = "toward";

// ---------------------------------------------------------------------------
// Input and result
// ---------------------------------------------------------------------------

export interface VisualViewingConditionsInput {
  /** The committed scene, when the lane has one. Absent ⇒ distance and angle are declared. */
  readonly scene?: SceneState;
  /** The scene participant doing the looking (the player's subject id in chat). */
  readonly observerParticipantId?: string;
  /** The scene participant being looked at. */
  readonly subjectParticipantId?: string;
}

/** The four component reads a narrator viewpoint asserts. Framing is deliberately absent: an eye is unframed. */
export interface VisualViewingConditions {
  readonly lighting: VisualComponentRead<VisualLightingBand>;
  readonly distance: VisualComponentRead<VisualDistanceBand>;
  readonly angle: VisualComponentRead<VisualAngleBand>;
  readonly motion: VisualComponentRead<VisualMotionBand>;
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/**
 * The two branded participant ids, or `null` when this lane cannot name both.
 *
 * `safeParse` rather than the throwing constructor: an id this module cannot
 * use is a lane that did not supply one, and the answer to that is the declared
 * base — not an exception on a read path (docs/resilience.md).
 */
function participantPair(
  input: VisualViewingConditionsInput,
): { observer: AffordanceSubjectId; subject: AffordanceSubjectId } | null {
  if (input.observerParticipantId === undefined || input.subjectParticipantId === undefined) return null;
  const observer = affordanceSubjectIdSchema.safeParse(input.observerParticipantId);
  const subject = affordanceSubjectIdSchema.safeParse(input.subjectParticipantId);
  if (!observer.success || !subject.success) return null;
  return { observer: observer.data, subject: subject.data };
}

/**
 * Distance from the scene owner's proximity between the two participants.
 *
 * Proximity is symmetric and `SceneProximityBand` IS `VisualDistanceBand`, so
 * this is a lookup rather than a mapping — the vocabularies were deliberately
 * made one in slice 4. A pair the scene never placed falls back to the declared
 * base: absent is not `distant`, and treating it as distant would suppress
 * every fine detail in an ordinary conversation.
 */
function distanceRead(input: VisualViewingConditionsInput): VisualComponentRead<VisualDistanceBand> {
  const pair = input.scene === undefined ? null : participantPair(input);
  const fact = pair === null || input.scene === undefined ? undefined : sceneProximityFact(input.scene, pair.observer, pair.subject);
  return fact === undefined
    ? visualComponentDeclared(VISUAL_VIEWING_BASE_DISTANCE)
    : visualComponentKnown(fact.value);
}

/**
 * Angle from the scene owner's facing — how the SUBJECT is oriented toward the
 * observer, which is the directional question the visibility read asks, not the
 * mirror one. `SceneFacing` IS `VisualAngleBand`, again by construction.
 */
function angleRead(input: VisualViewingConditionsInput): VisualComponentRead<VisualAngleBand> {
  const pair = input.scene === undefined ? null : participantPair(input);
  const fact = pair === null || input.scene === undefined ? undefined : sceneFacingFact(input.scene, pair.subject, pair.observer);
  return fact === undefined ? visualComponentDeclared(VISUAL_VIEWING_BASE_ANGLE) : visualComponentKnown(fact.value);
}

/**
 * What one observer can honestly assert about the conditions they are looking
 * under: the scene's own facts where it has them, the release's declared base
 * values where nothing does.
 *
 * Deterministic over the committed scene alone, so a retake that restores the
 * same scene resolves byte-identical conditions.
 */
export function resolveVisualViewingConditions(
  input: VisualViewingConditionsInput = {},
): VisualViewingConditions {
  return {
    lighting: visualComponentDeclared(VISUAL_VIEWING_BASE_LIGHTING),
    distance: distanceRead(input),
    angle: angleRead(input),
    motion: visualComponentDeclared(VISUAL_VIEWING_BASE_MOTION),
  };
}
