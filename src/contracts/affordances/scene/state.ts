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
 * `control`, `posture`, and `support` are OPTIONAL and their absence is
 * load-bearing: a participant whose posture nobody stated is not standing, a
 * participant whose control nobody stated is not the player's, and a
 * participant whose support nobody stated is not on the floor. All three make
 * the reads that depend on them answer `unresolved`.
 *
 * **`support` is ONE fact whose value is the whole relation list**, not a list
 * of per-relation facts. The set is what an intent replaces
 * (`set_support` swaps the lot, because standing up off a chair changes what
 * bears the weight and what the hands are doing at once), so the set is what
 * has to carry a provenance — including when it is EMPTY. A bare array lost
 * the timestamp the moment it was cleared, and a clearing with no timestamp
 * cannot be ordered against anything, which let an older intent silently
 * un-clear it.
 *
 * A stated-empty set is a clearing, not a claim: it says nobody names anything
 * that carries this body, which is exactly what an absent fact says, and both
 * read `support_unknown` / `elevation_unknown`. The provenance exists to order
 * the clearing, never to make a new physical claim out of it.
 */
export interface SceneParticipant {
  readonly subjectId: AffordanceSubjectId;
  readonly control?: SceneFact<SceneControlMode>;
  readonly posture?: SceneFact<ScenePosture>;
  /** Absent means nobody said what holds this body up; an empty set means somebody said "nothing does". */
  readonly support?: SceneFact<readonly SceneSupportRelation[]>;
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

/**
 * The key for what a support relation hangs on — one surface, or one body.
 *
 * One anchor bears one relationship to one body, so this is also the key a
 * stored support set may not have two claimants for: "borne by the bed" and
 * "leaning on the bed" are two answers to one question, and the boundary drops
 * both rather than picking (`parseSceneState`).
 */
export function sceneSupportAnchorKey(anchor: SceneSupportAnchor): string {
  return anchor.kind === "surface"
    ? `surface${SCENE_KEY_SEPARATOR}${anchor.supportId}`
    : `participant${SCENE_KEY_SEPARATOR}${anchor.subjectId}`;
}

/** Two support sets state the same relations, in the same order. Provenance is not part of the comparison. */
export function sceneSupportSetsEqual(
  left: readonly SceneSupportRelation[],
  right: readonly SceneSupportRelation[],
): boolean {
  return (
    left.length === right.length &&
    left.every((relation, index) => {
      const other = right[index];
      return (
        other !== undefined &&
        relation.role === other.role &&
        sceneSupportAnchorKey(relation.anchor) === sceneSupportAnchorKey(other.anchor) &&
        relation.loadZones.length === other.loadZones.length &&
        relation.loadZones.every((zone, zoneIndex) => zone === other.loadZones[zoneIndex])
      );
    })
  );
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

/**
 * Canonical order + last-write-wins dedupe by key. Sorting is what makes the
 * snapshot byte-stable across a retake.
 *
 * **Last-write-wins is deliberate HERE and forbidden at the boundary.** It is
 * how `withSceneParticipant` and its siblings express replacement: they append
 * the new entry and let the dedupe drop the old one, so "last" means "the entry
 * the caller just wrote" — real ordering information. A stored blob has no such
 * information; its array order is an accident of whatever wrote it, so
 * `parseSceneState` drops every claimant of a contradicted key BEFORE calling
 * this, and by the time construction runs there is nothing left to pick between.
 */
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
 * A body cannot be near itself, oriented toward itself, or held up by itself.
 *
 * These are not degraded data — they are records that could never be true, and
 * the constructor drops them rather than throwing (`src/contracts` answers, it
 * does not raise). A programmatic caller that produces one gets a state without
 * it, which its own tests see; a STORED one never reaches here, because the
 * boundary schemas refuse it first and say so in a diagnostic.
 */
function withoutSelfSupport(participant: SceneParticipant): SceneParticipant {
  const support = participant.support;
  if (support === undefined) return participant;
  const relations = support.value.filter(
    (relation) => relation.anchor.kind !== "participant" || relation.anchor.subjectId !== participant.subjectId,
  );
  return relations.length === support.value.length
    ? participant
    : { ...participant, support: { value: relations, provenance: support.provenance } };
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
    participants: canonical(
      (parts.participants ?? []).map(withoutSelfSupport),
      (entry) => entry.subjectId,
      SCENE_MAX_PARTICIPANTS,
    ),
    supports: canonical(parts.supports ?? [], (entry) => entry.supportId, SCENE_MAX_SUPPORTS),
    proximity: canonical(
      (parts.proximity ?? []).filter((entry) => entry.subjectId !== entry.otherId).map(orientProximity),
      (entry) => scenePairKey(entry.subjectId, entry.otherId),
      SCENE_MAX_RELATIONS,
    ),
    facing: canonical(
      (parts.facing ?? []).filter((entry) => entry.subjectId !== entry.towardId),
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
 * PAIR RELATIONS ARE VALID ONLY DURING CONTINUOUS CO-PRESENCE (owner ruling,
 * 2026-08-04).
 *
 * A proximity band and a facing direction are claims about two bodies sharing
 * one place at one time. Three discontinuities break that continuity — a
 * participant becoming `away`, the place changing, and an explicit story-clock
 * skip — and each of them already ends the active contacts for the same
 * reason. Keeping the distance while ending the touch is internally
 * contradictory: it says the hand is no longer resting there AND that the two
 * bodies are still within arm's reach of each other, with nothing having moved.
 *
 * Cleared means UNKNOWN, never a substituted band. A pair whose relation was
 * dropped reads exactly like a pair nobody ever placed: `proximity_unknown`,
 * and every attempt through it resolves `unresolved` — silence. Inventing
 * `distant` on a departure would be this module deciding how far away the
 * kitchen is.
 *
 * Returning does not restore anything. Re-entry re-establishes a distance only
 * through explicit movement or placement evidence, which is the same bar a
 * first placement has to clear.
 *
 * These two functions are the only REMOVALS this module offers, and the split
 * is the ruling's own: one member leaving clears only the relations that member
 * is party to (`withoutScenePairRelations`), while a whole-chat discontinuity —
 * the place changed, hours passed — clears every pair
 * (`withoutAllScenePairRelations`).
 *
 * **Posture, support, and control are deliberately left alone here, and this
 * module makes no claim that they SHOULD survive a departure.** They plainly
 * raise the same question — a support relation can anchor to furniture, or to
 * another body, in the room that was just left — but answering it is a scene-
 * model decision this narrow repair does not make. Leaving them untouched keeps
 * the repair to the facts whose staleness is demonstrably wrong, rather than
 * establishing a rule nobody has ruled on.
 *
 * Pure and total: a scene with nothing to drop comes back by reference, so a
 * caller can apply either unconditionally without churning the projection.
 */
export function withoutScenePairRelations(state: SceneState, subjectId: AffordanceSubjectId): SceneState {
  const proximity = state.proximity.filter(
    (relation) => relation.subjectId !== subjectId && relation.otherId !== subjectId,
  );
  const facing = state.facing.filter(
    (relation) => relation.subjectId !== subjectId && relation.towardId !== subjectId,
  );
  if (proximity.length === state.proximity.length && facing.length === state.facing.length) return state;
  return sceneStateOf({ ...partsOf(state), proximity, facing });
}

/**
 * Drop EVERY pair relation in the scene — the whole-chat discontinuity: the
 * place changed, or the clock skipped (see `withoutScenePairRelations` for the
 * ruling this implements).
 *
 * Not a loop over participants, because the relations that matter most are
 * exactly the ones a participant list might miss: a row naming a body the
 * current roster no longer carries is still a stale distance, and after the
 * room changed there is no pair left whose band survived.
 */
export function withoutAllScenePairRelations(state: SceneState): SceneState {
  if (state.proximity.length === 0 && state.facing.length === 0) return state;
  return sceneStateOf({ ...partsOf(state), proximity: [], facing: [] });
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
