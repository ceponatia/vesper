import { describe, expect, it } from "vitest";
import { affordanceSubjectId } from "../affordances/core";
import { sceneEventRef, sceneFact, sceneProvenance, type SceneFact } from "../affordances/scene/provenance";
import {
  emptySceneState,
  sceneStateOf,
  withSceneFacing,
  withSceneParticipant,
  withSceneProximity,
  type SceneState,
} from "../affordances/scene/state";
import type { SceneFacing, ScenePosture, SceneProximityBand } from "../affordances/scene/vocabulary";
import {
  cameraFromCommittedFacts,
  committedSceneFactsFor,
  describeCommittedFacts,
  type CommittedSceneFacts,
} from "./scene-committed";

const MIRA = affordanceSubjectId("scene_camera_probe_npc");
const PLAYER = affordanceSubjectId("scene_camera_probe_player");

/** Provenance is the scene owner's concern, not this module's — one authored stamp for every fixture fact. */
function fact<TValue>(value: TValue): SceneFact<TValue> {
  return sceneFact(value, sceneProvenance({ source: "authored", ref: sceneEventRef("scene_camera_probe"), storyTime: 0 }));
}

function scene(parts: {
  facing?: SceneFacing;
  focalPosture?: ScenePosture;
  viewerPosture?: ScenePosture;
  proximity?: SceneProximityBand;
}): SceneState {
  let state = emptySceneState();
  if (parts.focalPosture) state = withSceneParticipant(state, { subjectId: MIRA, posture: fact(parts.focalPosture) });
  if (parts.viewerPosture) state = withSceneParticipant(state, { subjectId: PLAYER, posture: fact(parts.viewerPosture) });
  if (parts.facing) {
    state = withSceneFacing(state, { subjectId: MIRA, towardId: PLAYER, facing: fact(parts.facing) });
  }
  if (parts.proximity) {
    state = withSceneProximity(state, { subjectId: MIRA, otherId: PLAYER, band: fact(parts.proximity) });
  }
  return state;
}

const factsFor = (parts: Parameters<typeof scene>[0]): CommittedSceneFacts =>
  committedSceneFactsFor(scene(parts), MIRA, PLAYER);

describe("committedSceneFactsFor", () => {
  // The whole point of the read: sparse coverage is the normal case while the typed-movement
  // lane gathers data, and sparse must degrade to exactly today's behavior.
  it("reports nothing at all for an empty scene", () => {
    expect(committedSceneFactsFor(emptySceneState(), MIRA, PLAYER)).toEqual({});
    expect(cameraFromCommittedFacts(committedSceneFactsFor(emptySceneState(), MIRA, PLAYER))).toEqual({});
  });

  it("reads each fact through the scene owner's own accessors", () => {
    expect(factsFor({ facing: "away", focalPosture: "kneeling", viewerPosture: "standing", proximity: "close" })).toEqual(
      { facing: "away", focalPosture: "kneeling", viewerPosture: "standing", proximity: "close" },
    );
  });

  // Facing is directional. "She has her back to him" is a fact about her, and the mirror
  // entry is a different fact this read must not substitute.
  it("reads facing focal → player, never the mirror", () => {
    const mirrored = withSceneFacing(emptySceneState(), {
      subjectId: PLAYER,
      towardId: MIRA,
      facing: fact<SceneFacing>("away"),
    });
    expect(committedSceneFactsFor(mirrored, MIRA, PLAYER).facing).toBeUndefined();
  });

  it("omits a fact nobody stated rather than neutralizing it", () => {
    const facts = factsFor({ proximity: "near" });
    expect(facts).toEqual({ proximity: "near" });
    expect(facts.facing).toBeUndefined();
    expect(facts.focalPosture).toBeUndefined();
  });

  // A contact against furniture is a real contact and says nothing about how two bodies are
  // arranged; a contact between two people who are not this pair is somebody else's shot.
  it("carries no contacts when the projection is empty", () => {
    expect(committedSceneFactsFor(sceneStateOf({}), MIRA, PLAYER).contacts).toBeUndefined();
  });
});

describe("cameraFromCommittedFacts", () => {
  it("maps every facing value", () => {
    expect(cameraFromCommittedFacts({ facing: "toward" }).orientation).toBe("toward_viewer");
    expect(cameraFromCommittedFacts({ facing: "side_on" }).orientation).toBe("profile");
    expect(cameraFromCommittedFacts({ facing: "away" }).orientation).toBe("away");
  });

  // Owner ruling 2026-08-10: away means fully away. State says which way she is turned and
  // says nothing about whether she looked back, so it may never mint the glance — only
  // narration passing GLANCE_WORDS can, and it may then upgrade this `away`.
  it("never produces the glance from state alone", () => {
    expect(cameraFromCommittedFacts({ facing: "away" }).orientation).not.toBe("away_glance_back");
  });

  it("maps every proximity band", () => {
    expect(cameraFromCommittedFacts({ proximity: "touching" }).distance).toBe("close");
    expect(cameraFromCommittedFacts({ proximity: "close" }).distance).toBe("close");
    expect(cameraFromCommittedFacts({ proximity: "near" }).distance).toBe("medium");
    expect(cameraFromCommittedFacts({ proximity: "distant" }).distance).toBe("full_figure");
  });

  it("looks down when the viewer stands over a lowered focal", () => {
    for (const focalPosture of ["kneeling", "sitting", "crouching", "lying"] as const) {
      expect(cameraFromCommittedFacts({ focalPosture, viewerPosture: "standing" }).height, focalPosture).toBe("high");
    }
  });

  it("looks up when the focal stands over a lowered viewer", () => {
    for (const viewerPosture of ["kneeling", "sitting", "crouching", "lying"] as const) {
      expect(cameraFromCommittedFacts({ focalPosture: "standing", viewerPosture }).height, viewerPosture).toBe("low");
    }
  });

  // One body low tells you nothing about the eye line between two, and two bodies at the
  // same level is a claim the camera did NOT move — either way, no height claim.
  it("claims no height when the postures are equal or one is missing", () => {
    expect(cameraFromCommittedFacts({ focalPosture: "standing", viewerPosture: "standing" }).height).toBeUndefined();
    expect(cameraFromCommittedFacts({ focalPosture: "kneeling", viewerPosture: "kneeling" }).height).toBeUndefined();
    expect(cameraFromCommittedFacts({ focalPosture: "lying", viewerPosture: "sitting" }).height).toBeUndefined();
    expect(cameraFromCommittedFacts({ focalPosture: "kneeling" }).height).toBeUndefined();
    expect(cameraFromCommittedFacts({ viewerPosture: "standing" }).height).toBeUndefined();
  });

  it("returns a partial with only the fields state actually claimed", () => {
    expect(cameraFromCommittedFacts({ facing: "side_on" })).toEqual({ orientation: "profile" });
    expect(
      cameraFromCommittedFacts({ facing: "away", proximity: "touching", focalPosture: "kneeling", viewerPosture: "standing" }),
    ).toEqual({ orientation: "away", distance: "close", height: "high" });
  });
});

describe("describeCommittedFacts", () => {
  it("renders the authoritative context line in the composer's own language", () => {
    expect(
      describeCommittedFacts("Mira", {
        facing: "away",
        focalPosture: "kneeling",
        viewerPosture: "standing",
        proximity: "touching",
      }),
    ).toBe("Mira faces away from the player; Mira is kneeling; the player is standing; they are touching.");
  });

  it("renders only what is committed", () => {
    expect(describeCommittedFacts("Mira", { facing: "toward" })).toBe("Mira faces the player.");
    expect(describeCommittedFacts("Mira", { facing: "side_on" })).toBe("Mira is side-on to the player.");
    expect(describeCommittedFacts("Mira", { proximity: "distant" })).toBe("they are across the room from each other.");
    expect(describeCommittedFacts("Mira", { proximity: "near" })).toBe("they are a step apart.");
    expect(describeCommittedFacts("Mira", { proximity: "close" })).toBe("they are within arm's reach.");
  });

  // No line at all beats an empty header announcing that nothing is known.
  it("is empty when nothing is committed", () => {
    expect(describeCommittedFacts("Mira", {})).toBe("");
    expect(describeCommittedFacts("", {})).toBe("");
  });
});
