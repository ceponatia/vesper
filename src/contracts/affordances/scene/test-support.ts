import { affordanceEvidence, affordanceSubjectId, type AffordanceSubjectId } from "../core";
import {
  sceneEventRef,
  sceneFact,
  sceneProvenance,
  sceneSupportId,
  type SceneEventRef,
  type SceneFact,
  type SceneProvenance,
} from "./provenance";
import {
  sceneStateOf,
  type SceneParticipant,
  type SceneProximityRelation,
  type SceneState,
  type SceneSupportRelation,
  type SceneSupportSurface,
} from "./state";
import type { SceneMovementChange, SceneMovementIntent } from "./intents";
import type {
  SceneBodyZone,
  SceneControlMode,
  SceneFacing,
  SceneHeightRung,
  SceneIntentOrigin,
  ScenePosture,
  SceneProximityBand,
  SceneSupportKind,
  SceneSupportRole,
} from "./vocabulary";

/**
 * Fixture builders for the scene owner's own tests.
 *
 * Deliberately **not** in the barrel, for the reason the contact and guidance
 * layers keep theirs out: a probe builder that reaches production is a way for
 * a default nobody chose to become a physical claim, and this module's whole
 * argument is that such a default must not exist.
 *
 * Every builder's default is the FULLY STATED case — both bodies placed,
 * standing on a named floor, at a stated distance, facing each other, control
 * declared on both sides. A test that wants a gap removes the one fact it is
 * about, so each case reads as exactly its own hypothesis.
 */

export const PROBE_PLAYER = affordanceSubjectId("scene_probe_player");
export const PROBE_NPC = affordanceSubjectId("scene_probe_npc");
export const PROBE_FLOOR = sceneSupportId("scene_probe_floor");
export const PROBE_BED = sceneSupportId("scene_probe_bed");
export const PROBE_REF = sceneEventRef("scene_probe_event");

export function probeProvenance(
  source: SceneProvenance["source"] = "authored",
  ref: SceneEventRef = PROBE_REF,
): SceneProvenance {
  return sceneProvenance({
    source,
    ref,
    storyTime: 100,
    evidence: [affordanceEvidence("state", `probe.${source}`)],
  });
}

export function probeFact<TValue>(value: TValue, source: SceneProvenance["source"] = "authored"): SceneFact<TValue> {
  return sceneFact(value, probeProvenance(source));
}

export function probeSupportRelation(overrides: Partial<SceneSupportRelation> = {}): SceneSupportRelation {
  return {
    role: "borne_by",
    anchor: { kind: "surface", supportId: PROBE_FLOOR },
    loadZones: ["legs"],
    ...overrides,
  };
}

export function probeParticipant(
  subjectId: AffordanceSubjectId,
  overrides: {
    control?: SceneControlMode | null;
    posture?: ScenePosture | null;
    support?: readonly SceneSupportRelation[];
  } = {},
): SceneParticipant {
  const control = overrides.control === undefined ? defaultControl(subjectId) : overrides.control;
  const posture = overrides.posture === undefined ? "standing" : overrides.posture;
  const support = overrides.support ?? [probeSupportRelation()];
  return {
    subjectId,
    ...(control === null ? {} : { control: probeFact(control) }),
    ...(posture === null ? {} : { posture: probeFact(posture) }),
    support: support.map((relation) => probeFact(relation)),
  };
}

function defaultControl(subjectId: AffordanceSubjectId): SceneControlMode {
  return subjectId === PROBE_PLAYER ? "player_controlled" : "npc_controlled";
}

export function probeSurface(
  supportId = PROBE_FLOOR,
  height: SceneHeightRung = "ground",
  kind: SceneSupportKind = "ground",
): SceneSupportSurface {
  return { supportId, kind, height: probeFact(height) };
}

export function probeProximity(band: SceneProximityBand = "close"): SceneProximityRelation {
  return { subjectId: PROBE_PLAYER, otherId: PROBE_NPC, band: probeFact(band) };
}

/**
 * The default scene: two bodies standing on the same floor, an arm's length
 * apart, each facing the other, each with a declared controller.
 */
export function probeScene(overrides: {
  player?: SceneParticipant;
  npc?: SceneParticipant;
  supports?: readonly SceneSupportSurface[];
  proximity?: SceneProximityBand | null;
  facing?: SceneFacing | null;
} = {}): SceneState {
  const facing = overrides.facing === undefined ? "toward" : overrides.facing;
  const proximity = overrides.proximity === undefined ? "close" : overrides.proximity;
  return sceneStateOf({
    participants: [overrides.player ?? probeParticipant(PROBE_PLAYER), overrides.npc ?? probeParticipant(PROBE_NPC)],
    supports: overrides.supports ?? [probeSurface()],
    proximity: proximity === null ? [] : [probeProximity(proximity)],
    facing:
      facing === null
        ? []
        : [
            { subjectId: PROBE_PLAYER, towardId: PROBE_NPC, facing: probeFact(facing) },
            { subjectId: PROBE_NPC, towardId: PROBE_PLAYER, facing: probeFact(facing) },
          ],
  });
}

export function probeMovement(overrides: {
  subjectId?: AffordanceSubjectId;
  origin?: SceneIntentOrigin;
  change?: SceneMovementChange;
  intentId?: string;
  storyTime?: number;
} = {}): SceneMovementIntent {
  return {
    intentId: overrides.intentId ?? "scene_probe_intent",
    subjectId: overrides.subjectId ?? PROBE_PLAYER,
    origin: overrides.origin ?? "player",
    change: overrides.change ?? { kind: "set_posture", posture: "kneeling" },
    ref: PROBE_REF,
    storyTime: overrides.storyTime ?? 101,
    evidence: [affordanceEvidence("adapter", "probe.intent")],
  };
}

/** A load-bearing relation for a zone other than the default legs — the "that hand is busy" fixture. */
export function probeLeaning(loadZones: readonly SceneBodyZone[] = ["arms"], role: SceneSupportRole = "leaning_on"): SceneSupportRelation {
  return { role, anchor: { kind: "surface", supportId: PROBE_FLOOR }, loadZones };
}
