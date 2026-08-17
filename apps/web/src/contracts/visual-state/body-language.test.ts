import { describe, expect, it } from "vitest";
import { expectDiagnostic, expectDiagnostics, codes } from "@/test/diagnostics";
import { DiagnosticCollector } from "../diagnostics";
import { bodyLanguageUnavailableFacts, projectBodyLanguageFeatures } from "./body-language";
import { VISUAL_STATE_BODY_LANGUAGE_UNAVAILABLE } from "./diagnostics";
import {
  visualStateContactFixture,
  visualStateContactState,
  visualStateSceneFixture,
  visualStateSceneSubjects,
  VISUAL_STATE_SCENE_NPC,
  VISUAL_STATE_SCENE_NPC_SUBJECT,
  VISUAL_STATE_SCENE_PLAYER,
  VISUAL_STATE_SCENE_PLAYER_SUBJECT,
} from "./fixtures";
import {
  VISUAL_STATE_BODY_LANGUAGE_FACING_KIND_ID,
  VISUAL_STATE_BODY_LANGUAGE_HAND_OCCUPATION_KIND_ID,
  VISUAL_STATE_BODY_LANGUAGE_MOTION_KIND_ID,
  VISUAL_STATE_BODY_LANGUAGE_POSTURE_KIND_ID,
  VISUAL_STATE_BODY_LANGUAGE_SUPPORT_KIND_ID,
} from "./kinds";
import { buildVisualStateSnapshot } from "./snapshot";
import type { VisualStateFeature } from "./feature";

/**
 * Fixture VS-10 — the body-language slice: proved posture, support, facing,
 * hand occupation and committed motion, and NOTHING else. The scene owner's
 * absences stay absent, and the three ownerless facts (gaze, fine joint pose,
 * microexpression) surface as suppressions rather than guesses.
 */

function project(options: Parameters<typeof visualStateSceneFixture>[0] = {}, sink?: DiagnosticCollector) {
  return projectBodyLanguageFeatures({
    scene: visualStateSceneFixture(options),
    subjectsByParticipant: visualStateSceneSubjects(),
    sink,
  });
}

function byKind(features: readonly VisualStateFeature[], kindId: string): readonly VisualStateFeature[] {
  return features.filter((feature) => feature.kindId === kindId);
}

describe("projectBodyLanguageFeatures", () => {
  it("projects each stated posture under its mapped subject", () => {
    const postures = byKind(project().features, VISUAL_STATE_BODY_LANGUAGE_POSTURE_KIND_ID);
    expect(postures.map((feature) => [feature.subjectId, feature.value])).toEqual([
      [VISUAL_STATE_SCENE_NPC_SUBJECT, { posture: "sitting" }],
      [VISUAL_STATE_SCENE_PLAYER_SUBJECT, { posture: "standing" }],
    ]);
  });

  it("keys posture at the subject locus with the kind id as the aspect", () => {
    const [npc] = byKind(project().features, VISUAL_STATE_BODY_LANGUAGE_POSTURE_KIND_ID);
    expect(npc?.key).toBe(
      `${VISUAL_STATE_SCENE_NPC_SUBJECT}/subject:${VISUAL_STATE_SCENE_NPC_SUBJECT}/body_language.posture`,
    );
    expect(npc?.layer).toBe("body_language");
    expect(npc?.stability).toBe("instantaneous");
  });

  it("carries the owner's own provenance stamp as changedAtMinutes", () => {
    const [npc] = byKind(project({ atMinutes: 137 }).features, VISUAL_STATE_BODY_LANGUAGE_POSTURE_KIND_ID);
    expect(npc?.changedAtMinutes).toBe(137);
    expect(npc?.sourceRef).toEqual({
      kind: "scene_relation",
      relationId: `posture:${VISUAL_STATE_SCENE_NPC}`,
    });
  });

  it("stays silent, without a diagnostic, for a posture nobody stated", () => {
    const sink = new DiagnosticCollector();
    const build = project({ playerPosture: null }, sink);
    const postures = byKind(build.features, VISUAL_STATE_BODY_LANGUAGE_POSTURE_KIND_ID);
    expect(postures.map((feature) => feature.subjectId)).toEqual([VISUAL_STATE_SCENE_NPC_SUBJECT]);
    // The only diagnostics are the two designed missing-owner reports.
    expectDiagnostics(sink, [VISUAL_STATE_BODY_LANGUAGE_UNAVAILABLE, VISUAL_STATE_BODY_LANGUAGE_UNAVAILABLE]);
  });

  it("projects the support set as one value, with the surface kind resolved", () => {
    const supports = byKind(project().features, VISUAL_STATE_BODY_LANGUAGE_SUPPORT_KIND_ID);
    const npc = supports.find((feature) => feature.subjectId === VISUAL_STATE_SCENE_NPC_SUBJECT);
    expect(npc?.value).toEqual({
      relations: [
        {
          role: "borne_by",
          anchor: { kind: "surface", supportId: "vs_scene_bed", surfaceKind: "bed" },
          loadZones: ["pelvis", "legs"],
        },
      ],
    });
    expect(npc?.semanticTags).toEqual(["bed", "borne_by"]);
  });

  it("treats a stated-empty support set exactly like an unstated one: silence", () => {
    const build = project({ npcSupport: [] });
    const supports = byKind(build.features, VISUAL_STATE_BODY_LANGUAGE_SUPPORT_KIND_ID);
    expect(supports.map((feature) => feature.subjectId)).toEqual([VISUAL_STATE_SCENE_PLAYER_SUBJECT]);
  });

  it("projects each directional facing with the scene-side toward id verbatim", () => {
    const facings = byKind(project().features, VISUAL_STATE_BODY_LANGUAGE_FACING_KIND_ID);
    expect(facings).toHaveLength(2);
    const player = facings.find((feature) => feature.subjectId === VISUAL_STATE_SCENE_PLAYER_SUBJECT);
    expect(player?.value).toEqual({ facing: "toward", towardSubjectId: VISUAL_STATE_SCENE_NPC });
    // Relation ids are the owner's row identity, escaped inside the key.
    expect(player?.key).toBe(
      `${VISUAL_STATE_SCENE_PLAYER_SUBJECT}/relation:facing%3A${VISUAL_STATE_SCENE_PLAYER}%3A${VISUAL_STATE_SCENE_NPC}/body_language.facing`,
    );
  });

  it("projects one facing side alone when only one was stated", () => {
    const facings = byKind(project({ npcFacing: null }).features, VISUAL_STATE_BODY_LANGUAGE_FACING_KIND_ID);
    expect(facings.map((feature) => feature.subjectId)).toEqual([VISUAL_STATE_SCENE_PLAYER_SUBJECT]);
  });

  it("derives hand occupation from a contact sourced inside the hand subtree", () => {
    const contact = visualStateContactFixture({ sourceLocationId: "fingers", sourceSide: "left" });
    const build = project({ contacts: visualStateContactState([contact]) });
    const hands = byKind(build.features, VISUAL_STATE_BODY_LANGUAGE_HAND_OCCUPATION_KIND_ID);
    expect(hands).toHaveLength(1);
    const [hand] = hands;
    expect(hand?.subjectId).toBe(VISUAL_STATE_SCENE_PLAYER_SUBJECT);
    expect(hand?.key).toBe(`${VISUAL_STATE_SCENE_PLAYER_SUBJECT}/hands:left/body_language.hand_occupation`);
    expect(hand?.value).toEqual({ side: "left" });
    expect(hand?.semanticTags).toEqual(["left", "affectionate"]);
    expect(hand?.sourceRef).toEqual({ kind: "contact", contactId: contact.contactId });
    expect(hand?.changedAtMinutes).toBe(contact.startedAt);
  });

  it("does not derive a hand from a contact sourced elsewhere on the body", () => {
    const contact = visualStateContactFixture({ sourceLocationId: "lips" });
    const build = project({ contacts: visualStateContactState([contact]) });
    expect(byKind(build.features, VISUAL_STATE_BODY_LANGUAGE_HAND_OCCUPATION_KIND_ID)).toEqual([]);
    // The committed motion still projects — the actor is mapped.
    expect(byKind(build.features, VISUAL_STATE_BODY_LANGUAGE_MOTION_KIND_ID)).toHaveLength(1);
  });

  it("aggregates two contacts on one hand into one feature and omits the ambiguous stamp", () => {
    const first = visualStateContactFixture({ sourceLocationId: "fingers", sourceSide: "left" });
    const second = visualStateContactFixture({
      sourceLocationId: "hands",
      sourceSide: "left",
      targetLocationId: "waist",
      actionKind: "casual",
      eventRef: "vs_contact_event_2",
    });
    const build = project({ contacts: visualStateContactState([first, second]) });
    const hands = byKind(build.features, VISUAL_STATE_BODY_LANGUAGE_HAND_OCCUPATION_KIND_ID);
    expect(hands).toHaveLength(1);
    const [hand] = hands;
    expect(hand?.semanticTags).toEqual(["left", "affectionate", "casual"]);
    expect(hand?.changedAtMinutes).toBeUndefined();
    // Every occupying contact is in the evidence, whatever the named source.
    expect(hand?.evidence.filter((entry) => entry.kind === "contact")).toHaveLength(2);
  });

  it("degrades a center or unstated contact side to the unsided hands locus", () => {
    const contact = visualStateContactFixture({ sourceLocationId: "hands", sourceSide: "center" });
    const build = project({ contacts: visualStateContactState([contact]) });
    const [hand] = byKind(build.features, VISUAL_STATE_BODY_LANGUAGE_HAND_OCCUPATION_KIND_ID);
    expect(hand?.key).toBe(`${VISUAL_STATE_SCENE_PLAYER_SUBJECT}/hands/body_language.hand_occupation`);
    expect(hand?.value).toEqual({ side: "unspecified" });
  });

  it("projects a committed motion at the contact's relation locus", () => {
    const contact = visualStateContactFixture({ pathDetailIds: ["arch", "heel_pad"] });
    const build = project({ contacts: visualStateContactState([contact]) });
    const motions = byKind(build.features, VISUAL_STATE_BODY_LANGUAGE_MOTION_KIND_ID);
    expect(motions).toHaveLength(1);
    const [motion] = motions;
    expect(motion?.value).toEqual({ band: "sliding", pathDetailIds: ["arch", "heel_pad"] });
    expect(motion?.sourceRef).toEqual({ kind: "contact", contactId: contact.contactId });
    expect(motion?.changedAtMinutes).toBe(contact.lastUpdatedAt);
    expect(motion?.locus).toEqual({ kind: "relation", relationId: contact.contactId });
  });

  it("projects no motion for a contact that carries no motion read", () => {
    const contact = visualStateContactFixture({ motionBand: null });
    const build = project({ contacts: visualStateContactState([contact]) });
    expect(byKind(build.features, VISUAL_STATE_BODY_LANGUAGE_MOTION_KIND_ID)).toEqual([]);
    // The occupied hand is still a fact.
    expect(byKind(build.features, VISUAL_STATE_BODY_LANGUAGE_HAND_OCCUPATION_KIND_ID)).toHaveLength(1);
  });

  it("suppresses gaze, fine joint pose and microexpression per subject, with an info diagnostic", () => {
    const sink = new DiagnosticCollector();
    const build = project({}, sink);
    expect(build.suppressions).toHaveLength(2 * bodyLanguageUnavailableFacts.length);
    for (const suppression of build.suppressions) {
      expect(suppression.code).toBe(VISUAL_STATE_BODY_LANGUAGE_UNAVAILABLE);
    }
    expect(build.suppressions.map((suppression) => suppression.detail)).toEqual([
      "gaze",
      "fine_joint_pose",
      "microexpression",
      "gaze",
      "fine_joint_pose",
      "microexpression",
    ]);
    expectDiagnostic(sink, VISUAL_STATE_BODY_LANGUAGE_UNAVAILABLE, { times: 2 });
    expect(sink.items.every((item) => item.severity === "info")).toBe(true);
  });

  it("ignores participants outside the subject map, silently", () => {
    const sink = new DiagnosticCollector();
    const build = projectBodyLanguageFeatures({
      scene: visualStateSceneFixture({ contacts: visualStateContactState([visualStateContactFixture()]) }),
      subjectsByParticipant: new Map([[VISUAL_STATE_SCENE_NPC as string, VISUAL_STATE_SCENE_NPC_SUBJECT]]),
      sink,
    });
    expect(build.features.every((feature) => feature.subjectId === VISUAL_STATE_SCENE_NPC_SUBJECT)).toBe(true);
    // The player's contact-derived facts are gone with the player.
    expect(byKind(build.features, VISUAL_STATE_BODY_LANGUAGE_HAND_OCCUPATION_KIND_ID)).toEqual([]);
    expect(byKind(build.features, VISUAL_STATE_BODY_LANGUAGE_MOTION_KIND_ID)).toEqual([]);
    expect(build.suppressions).toHaveLength(bodyLanguageUnavailableFacts.length);
    expect(codes(sink)).toEqual([VISUAL_STATE_BODY_LANGUAGE_UNAVAILABLE]);
  });

  it("produces byte-equal output from the same committed scene", () => {
    const options = { contacts: visualStateContactState([visualStateContactFixture()]) };
    expect(JSON.stringify(project(options))).toBe(JSON.stringify(project(options)));
  });

  it("assembles into a snapshot without duplicate keys, sorted onto the body_language layer last", () => {
    const sink = new DiagnosticCollector();
    const build = project({ contacts: visualStateContactState([visualStateContactFixture()]) });
    const snapshot = buildVisualStateSnapshot({
      scope: { kind: "chat", memoryGroupId: "group_fixture" },
      atMinutes: 120,
      cutId: "cut_fixture",
      contributions: [{ adapterId: "scene_relation", features: build.features }],
      sink,
    });
    expect(snapshot.features).toHaveLength(build.features.length);
    expect(snapshot.features.every((feature) => feature.layer === "body_language")).toBe(true);
    expect(snapshot.suppressions).toEqual([]);
    expect(codes(sink)).toEqual([]);
  });
});
