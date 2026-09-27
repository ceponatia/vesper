import { describe, expect, it } from "vitest";
import {
  affordanceSubjectId,
  contactEventRef,
  contactId,
  contactPairKey,
  directContactTransmission,
  emptySceneState,
  sceneEventRef,
  sceneFact,
  sceneProvenance,
  sceneProximityFact,
  withSceneContacts,
  withSceneProximity,
  type AffordanceSubjectId,
  type CommittedContactRead,
  type ContactBodySurfaceRef,
  type SceneState,
} from "@/contracts";
import { CHAT_CONTACT_PLAYER_SUBJECT } from "./identity";
import { applyChatContactDeparture, chatSceneAfterDiscontinuity } from "./scene";

/**
 * #330, owner ruling 2026-09-27, correction round: a within-place furniture move
 * ("I walk over to the desk") is the PLAYER's own body relocating, not a whole-
 * scene discontinuity. In an ensemble, two OTHER present characters holding
 * hands must not be separated, and their distance must not go unknown, just
 * because the player walked to a desk. These are pure `chat-contact/scene`
 * tests — the owning layer for the two functions `chat-turn-contact.ts` composes
 * to implement that scoping — because a 1:1 chat (the int suite's fixture)
 * cannot distinguish "ends everyone" from "ends only the player": there is
 * nobody else to wrongly touch.
 */

const CHARACTER_A = affordanceSubjectId("character_a");
const CHARACTER_B = affordanceSubjectId("character_b");

/**
 * A minimal but fully-typed committed contact between two subjects. Hand-built
 * rather than resolved through the core's attempt pipeline, because these tests
 * are about SCOPING (which contact an end/clear reaches), not about resolution —
 * nothing here is read by `applyChatContactDeparture` or `chatSceneAfterDiscontinuity`
 * beyond `source`/`target`/`contactId`/`pairKey`/`lastUpdatedAt`.
 */
function committedContact(actorId: AffordanceSubjectId, targetId: AffordanceSubjectId): CommittedContactRead {
  const source: ContactBodySurfaceRef = { kind: "body", subjectId: actorId, locationId: "hands" };
  const target: ContactBodySurfaceRef = { kind: "body", subjectId: targetId, locationId: "hands" };
  const pairKey = contactPairKey(source, target);
  const ref = contactEventRef(`probe:${pairKey}`);
  return {
    phase: "active",
    contactId: contactId(pairKey),
    pairKey,
    startedByEventRef: ref,
    lastUpdatedByEventRef: ref,
    startedAt: 0,
    lastUpdatedAt: 0,
    actorId,
    actionKind: "affectionate",
    source,
    target,
    materialBetween: [],
    transmission: directContactTransmission(),
    implicitAdjustments: [],
    actorControl: { status: "allowed", actorId, evidence: [] },
    targetAgencies: [],
    policy: { status: "not_required", scopes: [], evidence: [] },
    evidence: [],
  };
}

/**
 * An ensemble scene: the player's own active contact and proximity with A, plus
 * an UNRELATED active contact and proximity between A and B that names neither
 * the player nor anything the player did.
 */
function ensembleScene(): {
  scene: SceneState;
  playerContact: CommittedContactRead;
  othersContact: CommittedContactRead;
} {
  const playerContact = committedContact(CHAT_CONTACT_PLAYER_SUBJECT, CHARACTER_A);
  const othersContact = committedContact(CHARACTER_A, CHARACTER_B);
  const ref = sceneEventRef("probe_scene");
  const provenance = sceneProvenance({ source: "npc_decision", ref, storyTime: 0 });
  const withContacts = withSceneContacts(emptySceneState(), {
    version: 1,
    contacts: [playerContact, othersContact],
  });
  const withPlayerProximity = withSceneProximity(withContacts, {
    subjectId: CHAT_CONTACT_PLAYER_SUBJECT,
    otherId: CHARACTER_A,
    band: sceneFact("close", provenance),
  });
  const scene = withSceneProximity(withPlayerProximity, {
    subjectId: CHARACTER_A,
    otherId: CHARACTER_B,
    band: sceneFact("close", provenance),
  });
  return { scene, playerContact, othersContact };
}

describe("#330 correction: a within-place move scopes to the player, never the ensemble", () => {
  it("applyChatContactDeparture (unnamed departure) ends only the player's own contact", () => {
    const { scene, playerContact, othersContact } = ensembleScene();
    const ended = applyChatContactDeparture({
      scene,
      departure: { targetSubject: null, band: "near" },
      eventRef: contactEventRef("desk_move"),
      storyTime: 100,
    });

    expect(ended.commits).toHaveLength(1);
    expect(ended.commits[0]).toMatchObject({
      kind: "contact_ended",
      reason: "separated",
      contactId: playerContact.contactId,
    });

    const remaining = ended.scene.contacts.contacts.map((contact) => contact.contactId);
    expect(remaining).toEqual([othersContact.contactId]);
  });

  it("chatSceneAfterDiscontinuity's movedSubjects clears only the player's own proximity", () => {
    const { scene } = ensembleScene();
    const cleared = chatSceneAfterDiscontinuity(scene, {
      wholeScene: false,
      awaySubjects: [],
      movedSubjects: [CHAT_CONTACT_PLAYER_SUBJECT],
    });

    expect(sceneProximityFact(cleared, CHAT_CONTACT_PLAYER_SUBJECT, CHARACTER_A)).toBeUndefined();
    // The two OTHER present characters did not move relative to each other
    // because the player crossed the room — their distance survives, known.
    expect(sceneProximityFact(cleared, CHARACTER_A, CHARACTER_B)?.value).toBe("close");
  });

  it("a real place change (wholeScene) still clears every pair, unlike a within-place move", () => {
    const { scene } = ensembleScene();
    const cleared = chatSceneAfterDiscontinuity(scene, {
      wholeScene: true,
      awaySubjects: [],
      movedSubjects: [],
    });

    expect(sceneProximityFact(cleared, CHAT_CONTACT_PLAYER_SUBJECT, CHARACTER_A)).toBeUndefined();
    expect(sceneProximityFact(cleared, CHARACTER_A, CHARACTER_B)).toBeUndefined();
  });
});
