import { describe, expect, it } from "vitest";
import { visualStateSceneFixture, VISUAL_STATE_SCENE_NPC, VISUAL_STATE_SCENE_PLAYER } from "./fixtures";
import { visualDeclaredComponents, type VisualVisibilityContext } from "./visibility";
import {
  resolveVisualViewingConditions,
  VISUAL_VIEWING_BASE_ANGLE,
  VISUAL_VIEWING_BASE_DISTANCE,
  VISUAL_VIEWING_BASE_LIGHTING,
  VISUAL_VIEWING_BASE_MOTION,
} from "./viewing";

/**
 * Slice-7 viewing-condition tests (visual-state.plan.md §Open questions →
 * "how the narrator lane obtains usable viewing conditions", ruled 2026-08-17).
 *
 * The policy under test is two-sided: what the scene owner states is READ, and
 * what nothing owns is DECLARED and marked as such. Both halves need proving —
 * a declared value that forgot its marker would be exactly the silent default
 * the plan's own rulings forbid, and it would look identical to a grounded read
 * everywhere downstream.
 */

const OBSERVER = String(VISUAL_STATE_SCENE_PLAYER);
const SUBJECT = String(VISUAL_STATE_SCENE_NPC);

describe("resolveVisualViewingConditions", () => {
  it("reads distance and angle from the scene when it states them", () => {
    const conditions = resolveVisualViewingConditions({
      scene: visualStateSceneFixture({ proximity: "near", npcFacing: "side_on" }),
      observerParticipantId: OBSERVER,
      subjectParticipantId: SUBJECT,
    });
    expect(conditions.distance).toEqual({ status: "known", value: "near" });
    expect(conditions.angle).toEqual({ status: "known", value: "side_on" });
  });

  it("asks the scene the DIRECTIONAL facing question — how the subject faces the observer", () => {
    // The fixture states both directions; a mirrored read would return the
    // player's orientation instead of the subject's, which is a different fact.
    const conditions = resolveVisualViewingConditions({
      scene: visualStateSceneFixture({ playerFacing: "away", npcFacing: "toward" }),
      observerParticipantId: OBSERVER,
      subjectParticipantId: SUBJECT,
    });
    expect(conditions.angle).toEqual({ status: "known", value: "toward" });
  });

  it("reads proximity whichever way round the pair is asked — it is symmetric", () => {
    const scene = visualStateSceneFixture({ proximity: "distant" });
    const forward = resolveVisualViewingConditions({
      scene,
      observerParticipantId: OBSERVER,
      subjectParticipantId: SUBJECT,
    });
    const reversed = resolveVisualViewingConditions({
      scene,
      observerParticipantId: SUBJECT,
      subjectParticipantId: OBSERVER,
    });
    expect(forward.distance).toEqual({ status: "known", value: "distant" });
    expect(reversed.distance).toEqual(forward.distance);
  });

  it("declares the base distance and angle when the scene states neither", () => {
    const conditions = resolveVisualViewingConditions({
      scene: visualStateSceneFixture({ proximity: null, playerFacing: null, npcFacing: null }),
      observerParticipantId: OBSERVER,
      subjectParticipantId: SUBJECT,
    });
    expect(conditions.distance).toEqual({ status: "known", value: VISUAL_VIEWING_BASE_DISTANCE, declared: true });
    expect(conditions.angle).toEqual({ status: "known", value: VISUAL_VIEWING_BASE_ANGLE, declared: true });
  });

  it("declares everything when the lane hands over no scene at all", () => {
    const conditions = resolveVisualViewingConditions();
    for (const read of Object.values(conditions)) {
      expect(read).toMatchObject({ status: "known", declared: true });
    }
  });

  it("always declares lighting and motion — nothing in the app owns either", () => {
    const conditions = resolveVisualViewingConditions({
      scene: visualStateSceneFixture(),
      observerParticipantId: OBSERVER,
      subjectParticipantId: SUBJECT,
    });
    expect(conditions.lighting).toEqual({ status: "known", value: VISUAL_VIEWING_BASE_LIGHTING, declared: true });
    expect(conditions.motion).toEqual({ status: "known", value: VISUAL_VIEWING_BASE_MOTION, declared: true });
  });

  it("never produces an unknown read — an unknown would fail the whole visibility read closed", () => {
    // The blocker, stated as an invariant: slices 4–6 supplied unknowns, and a
    // single unknown component suppresses every feature in the snapshot.
    const conditions = resolveVisualViewingConditions({
      scene: visualStateSceneFixture({ proximity: null, playerFacing: null, npcFacing: null }),
    });
    for (const read of Object.values(conditions)) expect(read.status).toBe("known");
  });

  it("names exactly the declared components to the visibility read", () => {
    const conditions = resolveVisualViewingConditions({
      scene: visualStateSceneFixture({ proximity: "close", npcFacing: "toward" }),
      observerParticipantId: OBSERVER,
      subjectParticipantId: SUBJECT,
    });
    const context = { ...conditions, viewpoint: { kind: "debug" } } as unknown as VisualVisibilityContext;
    expect(visualDeclaredComponents(context)).toEqual(["lighting", "motion"]);
  });

  it("is deterministic over one committed scene", () => {
    const scene = visualStateSceneFixture({ proximity: "near", npcFacing: "away" });
    const input = { scene, observerParticipantId: OBSERVER, subjectParticipantId: SUBJECT };
    expect(JSON.stringify(resolveVisualViewingConditions(input))).toBe(
      JSON.stringify(resolveVisualViewingConditions(input)),
    );
  });

  it("declares rather than throwing when a participant id is unusable", () => {
    // A blank id is a lane that did not supply one; a read path answers, it
    // does not raise (docs/resilience.md).
    const conditions = resolveVisualViewingConditions({
      scene: visualStateSceneFixture({ proximity: "distant" }),
      observerParticipantId: "",
      subjectParticipantId: SUBJECT,
    });
    expect(conditions.distance).toEqual({ status: "known", value: VISUAL_VIEWING_BASE_DISTANCE, declared: true });
  });
});
