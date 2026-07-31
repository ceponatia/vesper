import { deepFreeze, type AffordanceSubjectId } from "../core";
import { emptyContactLifecycleState, type ContactLifecycleState } from "../contact";
import type { SceneFact, SceneSupportId } from "./provenance";
import type {
  SceneBodyZone,
  SceneControlMode,
  SceneFacing,
  SceneHeightRung,
  ScenePosture,
  SceneProximityBand,
  SceneSupportKind,
  SceneSupportRole,
} from "./vocabulary";

/**
 * The scene state container — the whole of what this module owns
 * (romantic-contact-affordances.spec.scene.md §"State").
 *
 * Five collections and a version. Each collection exists because its facts have
 * a different ARITY, and collapsing them would force one of them to lie:
 *
 * - **participants** — per body: who controls it, how it is configured, what
 *   holds it up.
 * - **supports** — per surface: what it is and how high it sits.
 * - **proximity** — per unordered PAIR: how far apart two bodies are. Symmetric,
 *   so it is stored once; a per-participant distance could contradict itself.
 * - **facing** — per ordered pair: orientation is not symmetric, and "she has
 *   her back to him" is a fact about her.
 * - **contacts** — the contact core's own versioned active-contact projection,
 *   HOUSED here rather than re-implemented. The owner ruled contact into the
 *   chat's retake snapshot; this container is what that snapshot holds, so the
 *   projection travels with the placement facts that make it possible instead
 *   of being captured separately and drifting.
 *
 * Everything is plain readonly data in a canonical order, so **the state IS the
 * snapshot**: there is no second serialization shape to keep in step, and
 * restoring is `parseSceneState` on the same bytes. Every function that builds
 * a state deep-freezes it, so a consumer that tries to cache into a placement
 * fails loudly in test rather than corrupting the next turn's fold.
 */

/** Version 1 of the persisted shape. Bumping it is a healing decision, not a rename. */
export const SCENE_STATE_VERSION = 1;

/** Bounds. A scene past any of these is an adapter that stopped ending things, not a busy room. */
export const SCENE_MAX_PARTICIPANTS = 8;
export const SCENE_MAX_SUPPORTS = 16;
export const SCENE_MAX_RELATIONS = 32;
/** Per participant. Standing on the floor while leaning on a wall is two; four is already generous. */
export const SCENE_MAX_SUPPORT_RELATIONS = 4;

/** Field separator inside a composite key — a character that cannot occur inside an id. */
export const SCENE_KEY_SEPARATOR = "\u001F";

// ---------------------------------------------------------------------------
// Facts
// ---------------------------------------------------------------------------

/** What bears the weight: a surface in the room, or another participant. */
export type SceneSupportAnchor =
  | { readonly kind: "surface"; readonly supportId: SceneSupportId }
  | { readonly kind: "participant"; readonly subjectId: AffordanceSubjectId };

/**
 * One support relation. `loadZones` names the coarse zones actually carrying
 * the load — a hand on the wall loads `arms`, sitting loads `pelvis` and
 * `legs` — which is what makes "that hand is not free to act" answerable
 * without a joint model.
 */
export interface SceneSupportRelation {
  readonly role: SceneSupportRole;
  readonly anchor: SceneSupportAnchor;
  readonly loadZones: readonly SceneBodyZone[];
}

/**
 * One body in the scene.
 *
 * `control` and `posture` are OPTIONAL and their absence is load-bearing: a
 * participant whose posture nobody stated is not standing, and a participant
 * whose control nobody stated is not the player's. Both make the reads that
 * depend on them answer `unresolved`.
 */
export interface SceneParticipant {
  readonly subjectId: AffordanceSubjectId;
  readonly control?: SceneFact<SceneControlMode>;
  readonly posture?: SceneFact<ScenePosture>;
  /** Empty means nobody said what holds this body up — an unknown elevation, not a floor. */
  readonly support: readonly SceneFact<SceneSupportRelation>[];
}

/** One thing in the room a body can be on, against, or under. */
export interface SceneSupportSurface {
  readonly supportId: SceneSupportId;
  readonly kind: SceneSupportKind;
  readonly height: SceneFact<SceneHeightRung>;
}

/** How far apart two bodies are. `subjectId <= otherId` by construction, so the pair has one entry. */
export interface SceneProximityRelation {
  readonly subjectId: AffordanceSubjectId;
  readonly otherId: AffordanceSubjectId;
  readonly band: SceneFact<SceneProximityBand>;
}

/** How `subjectId` is oriented toward `towardId`. Directional: the mirror entry is a separate fact. */
export interface SceneFacingRelation {
  readonly subjectId: AffordanceSubjectId;
  readonly towardId: AffordanceSubjectId;
  readonly facing: SceneFact<SceneFacing>;
}

export interface SceneState {
  readonly version: typeof SCENE_STATE_VERSION;
  readonly participants: readonly SceneParticipant[];
  readonly supports: readonly SceneSupportSurface[];
  readonly proximity: readonly SceneProximityRelation[];
  readonly facing: readonly SceneFacingRelation[];
  /** The contact core's projection, carried verbatim. This module never edits a contact. */
  readonly contacts: ContactLifecycleState;
}

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

/** The order-independent key for a pair of participants. */
export function scenePairKey(left: AffordanceSubjectId, right: AffordanceSubjectId): string {
  return left <= right ? `${left}${SCENE_KEY_SEPARATOR}${right}` : `${right}${SCENE_KEY_SEPARATOR}${left}`;
}

/** The directional key for one participant's orientation toward another. */
export function sceneFacingKey(subjectId: AffordanceSubjectId, towardId: AffordanceSubjectId): string {
  return `${subjectId}${SCENE_KEY_SEPARATOR}${towardId}`;
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

/**
 * An empty scene — nobody placed, nothing touching.
 *
 * The seed value and the degraded default at every boundary. It is safe as a
 * fallback precisely because it answers `unresolved` to every question: an
 * empty scene makes no claim about anybody's posture, so nothing downstream can
 * spend it as one.
 */
export function emptySceneState(): SceneState {
  const state: SceneState = {
    version: SCENE_STATE_VERSION,
    participants: [],
    supports: [],
    proximity: [],
    facing: [],
    contacts: emptyContactLifecycleState(),
  };
  return deepFreeze(state);
}

interface SceneStateParts {
  readonly participants?: readonly SceneParticipant[];
  readonly supports?: readonly SceneSupportSurface[];
  readonly proximity?: readonly SceneProximityRelation[];
  readonly facing?: readonly SceneFacingRelation[];
  readonly contacts?: ContactLifecycleState;
}

/** Canonical order + last-write-wins dedupe by key. Sorting is what makes the snapshot byte-stable across a retake. */
function canonical<TEntry>(
  entries: readonly TEntry[],
  keyOf: (entry: TEntry) => string,
  limit: number,
): readonly TEntry[] {
  const byKey = new Map<string, TEntry>();
  for (const entry of entries) byKey.set(keyOf(entry), entry);
  return [...byKey.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .slice(0, limit)
    .map(([, entry]) => entry);
}

/** Proximity is symmetric; store it one way round so a pair can never hold two contradicting distances. */
function orientProximity(relation: SceneProximityRelation): SceneProximityRelation {
  return relation.subjectId <= relation.otherId
    ? relation
    : { subjectId: relation.otherId, otherId: relation.subjectId, band: relation.band };
}

/**
 * Build a scene state from parts, canonicalized and frozen.
 *
 * The only constructor. Every mutation below routes through it, so no code path
 * can produce a state whose ordering, bounds, or symmetry differ from a parsed
 * one — which is the property a retake fingerprint rests on.
 */
export function sceneStateOf(parts: SceneStateParts): SceneState {
  const state: SceneState = {
    version: SCENE_STATE_VERSION,
    participants: canonical(parts.participants ?? [], (entry) => entry.subjectId, SCENE_MAX_PARTICIPANTS),
    supports: canonical(parts.supports ?? [], (entry) => entry.supportId, SCENE_MAX_SUPPORTS),
    proximity: canonical(
      (parts.proximity ?? []).map(orientProximity),
      (entry) => scenePairKey(entry.subjectId, entry.otherId),
      SCENE_MAX_RELATIONS,
    ),
    facing: canonical(
      parts.facing ?? [],
      (entry) => sceneFacingKey(entry.subjectId, entry.towardId),
      SCENE_MAX_RELATIONS,
    ),
    contacts: parts.contacts ?? emptyContactLifecycleState(),
  };
  return deepFreeze(state);
}

function partsOf(state: SceneState): SceneStateParts {
  return {
    participants: state.participants,
    supports: state.supports,
    proximity: state.proximity,
    facing: state.facing,
    contacts: state.contacts,
  };
}

/** Add or replace one participant. */
export function withSceneParticipant(state: SceneState, participant: SceneParticipant): SceneState {
  return sceneStateOf({ ...partsOf(state), participants: [...state.participants, participant] });
}

/** Add or replace one support surface. */
export function withSceneSupportSurface(state: SceneState, surface: SceneSupportSurface): SceneState {
  return sceneStateOf({ ...partsOf(state), supports: [...state.supports, surface] });
}

/** Add or replace one pair's proximity. */
export function withSceneProximity(state: SceneState, relation: SceneProximityRelation): SceneState {
  return sceneStateOf({ ...partsOf(state), proximity: [...state.proximity, relation] });
}

/** Add or replace one participant's orientation toward another. */
export function withSceneFacing(state: SceneState, relation: SceneFacingRelation): SceneState {
  return sceneStateOf({ ...partsOf(state), facing: [...state.facing, relation] });
}

/**
 * Swap in a contact projection the contact core produced.
 *
 * The one door between the two modules' state. This module never constructs,
 * patches, or ends a contact — it hands `ContactLifecycleState` back and forth
 * verbatim, so the contact core stays the only authority on what is touching.
 */
export function withSceneContacts(state: SceneState, contacts: ContactLifecycleState): SceneState {
  return sceneStateOf({ ...partsOf(state), contacts });
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export function sceneParticipant(state: SceneState, subjectId: AffordanceSubjectId): SceneParticipant | undefined {
  return state.participants.find((entry) => entry.subjectId === subjectId);
}

export function sceneSupportSurface(state: SceneState, supportId: SceneSupportId): SceneSupportSurface | undefined {
  return state.supports.find((entry) => entry.supportId === supportId);
}

/** The pair's distance, whichever way round it is asked. */
export function sceneProximityFact(
  state: SceneState,
  left: AffordanceSubjectId,
  right: AffordanceSubjectId,
): SceneFact<SceneProximityBand> | undefined {
  const key = scenePairKey(left, right);
  return state.proximity.find((entry) => scenePairKey(entry.subjectId, entry.otherId) === key)?.band;
}

/** How `subjectId` is oriented toward `towardId`. Asking the other way round is a different question. */
export function sceneFacingFact(
  state: SceneState,
  subjectId: AffordanceSubjectId,
  towardId: AffordanceSubjectId,
): SceneFact<SceneFacing> | undefined {
  return state.facing.find((entry) => entry.subjectId === subjectId && entry.towardId === towardId)?.facing;
}
