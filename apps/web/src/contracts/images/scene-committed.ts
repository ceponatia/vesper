import type { AffordanceSubjectId } from "../affordances/core";
import {
  sceneFacingFact,
  sceneParticipant,
  sceneProximityFact,
  type SceneState,
} from "../affordances/scene/state";
import type { SceneFacing, ScenePosture, SceneProximityBand } from "../affordances/scene/vocabulary";
import type { SceneCameraSpec } from "./scene-camera";
import type { SceneContactPairRead } from "./scene-staging";

/**
 * **Committed scene facts beat guesswork.**
 *
 * The shot planner reads the transcript, which is the only source most chats have. But a
 * chat whose typed movements have committed facing, posture, distance, or touch already
 * KNOWS which way she is turned, and a prose quote is a weaker claim than a
 * provenance-carrying fact. So the facts are handed to the planner as authoritative context
 * and its proposal is clamped to match — the proposal and the clamp agree instead of
 * fighting.
 *
 * Three properties this module has to keep:
 *
 * - **Read-only, and through the scene owner's own accessors.** The scene module is the
 *   authority on what it holds; a second traversal of `state.facing` here would be a second
 *   answer to a question that already has one, and would miss every healing law
 *   `parseSceneState` applies.
 * - **Absence stays absence.** The scene vocabulary has no `unknown` member on purpose: a
 *   fact nobody stated is missing, not neutral. A missing fact must therefore produce a
 *   missing camera field — never `toward_viewer`, which is a claim — so the composer's own
 *   proposal survives wherever state is silent. Coverage is expected to be sparse while the
 *   typed-movement lane gathers data, and sparse must degrade to exactly today's behavior.
 * - **Nothing is written back.** The resolved camera lives and dies inside one render job.
 *   Narration never becomes physical authority, and neither does a render.
 *
 * PURE, and deliberately small: `contracts/visual-state` owns the lane-neutral projection
 * of what a character looks like right now, and this read migrates onto its image digest
 * when that ships. Keeping the surface to four facts is what makes that migration a swap.
 */

/** The facts this lane can spend, for one focal character and the player. Every member optional — absence is the common case. */
export interface CommittedSceneFacts {
  /** How the FOCAL character is oriented toward the player. Directional: the mirror is a different fact. */
  facing?: SceneFacing;
  focalPosture?: ScenePosture;
  viewerPosture?: ScenePosture;
  /** The pair's distance band. Symmetric, so there is one of these however it is asked. */
  proximity?: SceneProximityBand;
  /** Active body-to-body contacts on this exact pair — the staging evidence table's input. Omitted when there are none. */
  contacts?: readonly SceneContactPairRead[];
}

/**
 * Project the committed scene onto the two subjects a chat scene image is about.
 *
 * The subject ids are the caller's problem: the chat lane resolves them the way its contact
 * adapter does, and the successor lane will resolve them from the engine. This function
 * takes them already resolved so it never has to know which lane it is serving.
 */
export function committedSceneFactsFor(
  scene: SceneState,
  focalSubjectId: AffordanceSubjectId,
  playerSubjectId: AffordanceSubjectId,
): CommittedSceneFacts {
  const facing = sceneFacingFact(scene, focalSubjectId, playerSubjectId)?.value;
  const focalPosture = sceneParticipant(scene, focalSubjectId)?.posture?.value;
  const viewerPosture = sceneParticipant(scene, playerSubjectId)?.posture?.value;
  const proximity = sceneProximityFact(scene, focalSubjectId, playerSubjectId)?.value;
  const contacts = pairContacts(scene, focalSubjectId, playerSubjectId);
  return {
    ...(facing ? { facing } : {}),
    ...(focalPosture ? { focalPosture } : {}),
    ...(viewerPosture ? { viewerPosture } : {}),
    ...(proximity ? { proximity } : {}),
    ...(contacts.length > 0 ? { contacts } : {}),
  };
}

/** Active contacts whose two ends are exactly this pair of bodies, flattened to what the staging table reads. */
function pairContacts(
  scene: SceneState,
  focalSubjectId: AffordanceSubjectId,
  playerSubjectId: AffordanceSubjectId,
): readonly SceneContactPairRead[] {
  const out: SceneContactPairRead[] = [];
  for (const contact of scene.contacts.contacts) {
    const target = contact.target;
    // A contact against furniture is not a fact about how two bodies are arranged.
    if (target.kind !== "body") continue;
    const source = contact.source;
    const ends = [source.subjectId, target.subjectId];
    if (!ends.includes(focalSubjectId) || !ends.includes(playerSubjectId)) continue;
    out.push({
      sourceLocationId: source.locationId,
      targetLocationId: target.locationId,
      sourceIsPlayer: source.subjectId === playerSubjectId,
    });
  }
  return out;
}

/**
 * The postures that put a body below a standing one. Spelled out rather than written as
 * "anything but standing", so adding a sixth posture to the vocabulary forces a decision
 * here instead of silently joining the set.
 */
const LOWERED_POSTURES: readonly ScenePosture[] = ["sitting", "kneeling", "crouching", "lying"];

/**
 * Committed facts → the camera fields they entail.
 *
 * A `Partial`, and that is the entire contract: a field this returns is a fact the composer
 * may not contradict, and a field it omits is one the composer still owns. Nothing here
 * invents a default — `DEFAULT_SCENE_CAMERA` is a fallback for a failed proposal, never an
 * answer to silence.
 *
 * **A committed facing never produces the glance** (owner ruling 2026-08-10). `away` maps to
 * `away`, full back-to-camera. The glance back is a separate physical claim that only
 * narration passing `GLANCE_WORDS` can make, and it may then upgrade this `away` — but state
 * alone may not, because the state says which way she is turned and says nothing about
 * whether she looked back.
 */
export function cameraFromCommittedFacts(facts: CommittedSceneFacts): Partial<SceneCameraSpec> {
  const out: Partial<SceneCameraSpec> = {};

  if (facts.facing !== undefined) {
    switch (facts.facing) {
      case "toward":
        out.orientation = "toward_viewer";
        break;
      case "side_on":
        out.orientation = "profile";
        break;
      case "away":
        out.orientation = "away";
        break;
    }
  }

  if (facts.proximity !== undefined) {
    switch (facts.proximity) {
      case "touching":
      case "close":
        out.distance = "close";
        break;
      case "near":
        out.distance = "medium";
        break;
      case "distant":
        out.distance = "full_figure";
        break;
    }
  }

  // Height needs BOTH postures: one body low tells you nothing about the eye line between
  // them, and two bodies at the same level is a claim that the camera did NOT move.
  const { focalPosture, viewerPosture } = facts;
  if (focalPosture !== undefined && viewerPosture !== undefined) {
    if (viewerPosture === "standing" && LOWERED_POSTURES.includes(focalPosture)) out.height = "high";
    else if (focalPosture === "standing" && LOWERED_POSTURES.includes(viewerPosture)) out.height = "low";
  }

  return out;
}

/**
 * The authoritative-context line the composer prompt states verbatim.
 *
 * Plain English rather than ids, because the composer is a language model reading a prompt,
 * not a consumer of this type — and because a fact it can restate is a fact it will propose
 * consistently with. "" when nothing is committed, so the caller adds no line at all rather
 * than an empty header announcing that nothing is known.
 */
export function describeCommittedFacts(name: string, facts: CommittedSceneFacts): string {
  const subject = name.trim() || "the character";
  const clauses: string[] = [];

  if (facts.facing !== undefined) {
    switch (facts.facing) {
      case "toward":
        clauses.push(`${subject} faces the player`);
        break;
      case "side_on":
        clauses.push(`${subject} is side-on to the player`);
        break;
      case "away":
        clauses.push(`${subject} faces away from the player`);
        break;
    }
  }
  if (facts.focalPosture !== undefined) clauses.push(`${subject} is ${facts.focalPosture}`);
  if (facts.viewerPosture !== undefined) clauses.push(`the player is ${facts.viewerPosture}`);
  if (facts.proximity !== undefined) {
    switch (facts.proximity) {
      case "touching":
        clauses.push("they are touching");
        break;
      case "close":
        clauses.push("they are within arm's reach");
        break;
      case "near":
        clauses.push("they are a step apart");
        break;
      case "distant":
        clauses.push("they are across the room from each other");
        break;
    }
  }

  return clauses.length > 0 ? `${clauses.join("; ")}.` : "";
}
