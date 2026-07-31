import { describe, expect, it } from "vitest";
import {
  affordanceEvidence,
  affordanceSubjectId,
  applySceneIntents,
  contactPairKey,
  DiagnosticCollector,
  emptySceneState,
  sceneEventRef,
  sceneFacingFact,
  sceneParticipant,
  sceneProximityFact,
  sceneSupportSurface,
  withSceneContacts,
  withSceneParticipant,
  type AffordanceSubjectId,
  type EffectiveCoverageRead,
  type SceneMovementIntent,
  type SceneProximityBand,
  type SceneState,
} from "@/contracts";
import {
  chatApproachSceneIntents,
  chatContactAcknowledgment,
  chatContactActionId,
  chatContactActionOutcome,
  chatContactEventRef,
  chatContactMaterialLayers,
  chatContactPhrase,
  CHAT_CONTACT_PLAYER_SUBJECT,
  CHAT_SCENE_GROUND_SUPPORT,
  detectChatAffectionateTouch,
  detectChatApproach,
  planChatContactTurn,
  resolveChatContactAttempt,
  seededChatScene,
  type ChatContactAct,
  type ChatContactRosterMember,
} from "./chat-contact-adapter";
import { chatContactActionsEnabled } from "./prompts/constants";

/**
 * The chat lane's contact adapter (romantic-contact-affordances.plan.md
 * §"Continuation order" 1).
 *
 * Organised by risk, like the premise detector's tests are. The GUARDS come
 * first, because every one of them stops a durable row claiming a contact the
 * player did not make — and the owner's two hard constraints on this proof
 * (genuinely affectionate only, never romantic relabeled; no restraint or
 * pinning) are guards, not features. The plumbing comes last.
 */

const WREN = affordanceSubjectId("character_wren");
const VAEL = affordanceSubjectId("character_vaelith");
const EVENT = chatContactEventRef("msg_exchange_1");
const REF = sceneEventRef(EVENT);
const AT = 120;

function member(subjectId: AffordanceSubjectId, name: string, aliases: readonly string[] = []): ChatContactRosterMember {
  return { subjectId, name, aliases };
}

const SOLO: readonly ChatContactRosterMember[] = [member(WREN, "Wren")];
const PAIR: readonly ChatContactRosterMember[] = [member(WREN, "Wren"), member(VAEL, "Vaelith")];

function seeded(characters: readonly ChatContactRosterMember[] = SOLO): SceneState {
  return seededChatScene(emptySceneState(), {
    player: CHAT_CONTACT_PLAYER_SUBJECT,
    characters: characters.map((entry) => entry.subjectId),
    ref: REF,
    storyTime: AT,
  });
}

/** A placed scene at a stated distance, with the player turned toward the target. */
function placed(band: SceneProximityBand, target: AffordanceSubjectId = WREN): SceneState {
  const intents: readonly SceneMovementIntent[] = [
    {
      intentId: "probe:proximity",
      subjectId: CHAT_CONTACT_PLAYER_SUBJECT,
      origin: "player",
      change: { kind: "set_proximity", otherId: target, band },
      ref: REF,
      storyTime: AT,
      evidence: [affordanceEvidence("adapter", "probe")],
    },
    {
      intentId: "probe:facing",
      subjectId: CHAT_CONTACT_PLAYER_SUBJECT,
      origin: "player",
      change: { kind: "set_facing", towardId: target, facing: "toward" },
      ref: REF,
      storyTime: AT,
      evidence: [affordanceEvidence("adapter", "probe")],
    },
  ];
  return applySceneIntents(seeded(), intents).state;
}

function touch(message: string, characters: readonly ChatContactRosterMember[] = SOLO): ChatContactAct | null {
  return detectChatAffectionateTouch({ message, narratorInput: false, characters, eventRef: EVENT });
}

function approach(message: string, characters: readonly ChatContactRosterMember[] = SOLO) {
  return detectChatApproach({ message, narratorInput: false, characters });
}

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

describe("the never-relabel guard — romantic framing commits nothing", () => {
  it.each([
    ["I kiss your shoulder.", "kiss"],
    ["I caress your arm.", "caress"],
    ["I stroke your hair.", "stroke"],
    ["I cup your hand in mine.", "cup"],
    ["I trace my hand over your back.", "trace"],
    ["I rest my hand on your thigh.", "an intimate target"],
    ["I rest my hand on your chest.", "an intimate target"],
    ["I rest my hand on the small of your back.", "the small of the back"],
    ["I put my hand on your neck.", "a romantic target"],
    ["I rest my hand on your bare shoulder.", "bare skin framing"],
    ["I rest my hand on your shoulder and kiss you.", "a romantic clause in the same sentence"],
  ])("%s produces nothing (%s)", (message) => {
    expect(touch(message)).toBeNull();
  });

  it("vetoes the whole sentence rather than keeping the affectionate half", () => {
    // A kiss beside a shoulder-touch is not an affectionate touch with decoration:
    // it is a beat this proof has no permission owner for.
    expect(touch("I rest my hand on your shoulder and kiss you.")).toBeNull();
    // The same act in its own sentence still lands — the veto is per sentence.
    expect(touch("I rest my hand on your shoulder. I kiss you.")).not.toBeNull();
  });
});

describe("the no-restraint guard — trapped mobility has no producer", () => {
  it.each([
    "I pin your shoulder against the wall.",
    "I grab your arm.",
    "I grip your hand.",
    "I pull your arm toward me.",
    "I hold your shoulder down.",
  ])("%s produces nothing", (message) => {
    expect(touch(message)).toBeNull();
  });
});

describe("the authority guard — only the player's own narrated act counts", () => {
  it("ignores an NPC's movement and an NPC's touch", () => {
    expect(approach("She walks over to me.")).toBeNull();
    expect(touch("She rests her hand on my shoulder.")).toBeNull();
  });

  it("ignores storyteller narration entirely", () => {
    expect(
      detectChatAffectionateTouch({
        message: "I rest my hand on Wren's shoulder.",
        narratorInput: true,
        characters: SOLO,
        eventRef: EVENT,
      }),
    ).toBeNull();
    expect(detectChatApproach({ message: "I walk over to Wren.", narratorInput: true, characters: SOLO })).toBeNull();
  });

  it("ignores speech, thought, and OOC — an act has to be performed, not said", () => {
    expect(touch('"I rest my hand on your shoulder."')).toBeNull();
    expect(touch("*I rest my hand on your shoulder*")).toBeNull();
    expect(touch("((I rest my hand on your shoulder))")).toBeNull();
  });
});

describe("the conservatism guards — a hedge, a denial, or a question is silence", () => {
  it.each([
    "I might rest my hand on your shoulder.",
    "I want to rest my hand on your shoulder.",
    "I almost rest my hand on your shoulder.",
    "If I rest my hand on your shoulder, what happens?",
    "I don't rest my hand on your shoulder.",
    "I never put my hand on your shoulder.",
    "Do I rest my hand on your shoulder?",
    "I move as if to rest my hand on your shoulder.",
  ])("%s produces nothing", (message) => {
    expect(touch(message)).toBeNull();
  });

  it("refuses an ambiguous target in a group, and accepts a named one", () => {
    expect(touch("I rest my hand on your shoulder.", PAIR)).toBeNull();
    expect(touch("I rest my hand on Wren's shoulder.", PAIR)?.targetSubject).toBe(WREN);
    expect(approach("I step closer to you.", PAIR)).toBeNull();
    expect(approach("I step closer to Vaelith.", PAIR)?.targetSubject).toBe(VAEL);
  });
});

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

describe("scene seeding", () => {
  it("places the player and every present character, with a declared controller", () => {
    const scene = seeded(PAIR);
    expect(sceneParticipant(scene, CHAT_CONTACT_PLAYER_SUBJECT)?.control?.value).toBe("player_controlled");
    expect(sceneParticipant(scene, WREN)?.control?.value).toBe("npc_controlled");
    expect(sceneParticipant(scene, VAEL)?.control?.value).toBe("npc_controlled");
    // Control is structural truth about the conversation, not a stated default.
    expect(sceneParticipant(scene, WREN)?.control?.provenance.source).toBe("authored");
  });

  it("stands a new arrival on a seeded floor, labelled as the default it is", () => {
    const scene = seeded();
    const player = sceneParticipant(scene, CHAT_CONTACT_PLAYER_SUBJECT);
    expect(player?.posture?.value).toBe("standing");
    expect(player?.posture?.provenance.source).toBe("scene_default");
    expect(player?.support?.value).toEqual([
      { role: "borne_by", anchor: { kind: "surface", supportId: CHAT_SCENE_GROUND_SUPPORT }, loadZones: ["legs"] },
    ]);
    expect(sceneSupportSurface(scene, CHAT_SCENE_GROUND_SUPPORT)?.height.value).toBe("ground");
  });

  it("never seeds a distance or an orientation — those are claims only movement may make", () => {
    const scene = seeded();
    expect(scene.proximity).toEqual([]);
    expect(scene.facing).toEqual([]);
    expect(sceneProximityFact(scene, CHAT_CONTACT_PLAYER_SUBJECT, WREN)).toBeUndefined();
  });

  it("is idempotent: re-seeding an already placed scene changes nothing", () => {
    const once = placed("close");
    const twice = seededChatScene(once, {
      player: CHAT_CONTACT_PLAYER_SUBJECT,
      characters: [WREN],
      ref: sceneEventRef("a_later_exchange"),
      storyTime: AT + 40,
    });
    expect(twice).toEqual(once);
  });

  it("never overwrites a fact somebody already stated", () => {
    const moved = applySceneIntents(seeded(), [
      {
        intentId: "probe:posture",
        subjectId: CHAT_CONTACT_PLAYER_SUBJECT,
        origin: "player",
        change: { kind: "set_posture", posture: "sitting" },
        ref: REF,
        storyTime: AT + 1,
        evidence: [],
      },
    ]).state;
    const reseeded = seededChatScene(moved, {
      player: CHAT_CONTACT_PLAYER_SUBJECT,
      characters: [WREN],
      ref: sceneEventRef("a_later_exchange"),
      storyTime: AT + 40,
    });
    expect(sceneParticipant(reseeded, CHAT_CONTACT_PLAYER_SUBJECT)?.posture?.value).toBe("sitting");
  });

  it("adds a later arrival without disturbing the bodies already here", () => {
    const grown = seededChatScene(placed("close"), {
      player: CHAT_CONTACT_PLAYER_SUBJECT,
      characters: [WREN, VAEL],
      ref: sceneEventRef("a_later_exchange"),
      storyTime: AT + 40,
    });
    expect(sceneParticipant(grown, VAEL)?.posture?.value).toBe("standing");
    expect(sceneProximityFact(grown, CHAT_CONTACT_PLAYER_SUBJECT, WREN)?.value).toBe("close");
    expect(sceneProximityFact(grown, CHAT_CONTACT_PLAYER_SUBJECT, VAEL)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Movement
// ---------------------------------------------------------------------------

describe("approach detection", () => {
  it.each([
    ["I walk over to Wren.", "close"],
    ["I step closer to you.", "close"],
    ["I sit down next to Wren.", "close"],
    ["I cross the room toward you.", "close"],
    ["I slowly move closer to you.", "close"],
    ["I settle in beside Wren.", "close"],
    ["I sit down right next to Wren.", "touching"],
    ["I step right up to you.", "touching"],
  ])("%s reads as %s", (message, band) => {
    expect(approach(message)).toEqual({ targetSubject: WREN, band });
  });

  it("ignores movement that names no person", () => {
    expect(approach("I walk over to the window.")).toBeNull();
    expect(approach("I head into the kitchen.")).toBeNull();
  });

  it("keeps looking past a destination that names no person", () => {
    expect(approach("I walk over to the window, then I step closer to Wren")).toEqual({
      targetSubject: WREN,
      band: "close",
    });
  });

  it("moves only the player, and asserts only the player's own facts", () => {
    const intents = chatApproachSceneIntents(
      { targetSubject: WREN, band: "close" },
      { player: CHAT_CONTACT_PLAYER_SUBJECT, ref: REF, storyTime: AT },
    );
    expect(intents.every((intent) => intent.subjectId === CHAT_CONTACT_PLAYER_SUBJECT)).toBe(true);
    expect(intents.every((intent) => intent.origin === "player")).toBe(true);
    const scene = applySceneIntents(seeded(), intents).state;
    expect(sceneProximityFact(scene, CHAT_CONTACT_PLAYER_SUBJECT, WREN)?.value).toBe("close");
    expect(sceneFacingFact(scene, CHAT_CONTACT_PLAYER_SUBJECT, WREN)?.value).toBe("toward");
    // Which way SHE is turned is hers — approaching somebody does not turn them.
    expect(sceneFacingFact(scene, WREN, CHAT_CONTACT_PLAYER_SUBJECT)).toBeUndefined();
    expect(sceneProximityFact(scene, CHAT_CONTACT_PLAYER_SUBJECT, WREN)?.provenance.source).toBe("player_intent");
  });
});

// ---------------------------------------------------------------------------
// Touch
// ---------------------------------------------------------------------------

describe("affectionate touch detection", () => {
  it.each([
    ["I rest my hand on your shoulder.", "shoulders", "rest"],
    ["I place a hand on Wren's arm.", "arms", "rest"],
    ["I put my hand on your upper back.", "back", "rest"],
    ["I lay my palm on your forearm.", "forearms", "rest"],
    ["I settle my hand on your hand.", "hands", "rest"],
    ["I pat your head.", "head", "pat"],
    ["I squeeze your hand.", "hands", "squeeze"],
  ])("%s → %s (%s)", (message, locationId, gesture) => {
    const act = touch(message);
    expect(act?.targetLocationId).toBe(locationId);
    expect(act?.gesture).toBe(gesture);
    expect(act?.actorSubject).toBe(CHAT_CONTACT_PLAYER_SUBJECT);
    expect(act?.sourceLocationId).toBe("hands");
    expect(act?.actionKind).toBe("affectionate");
  });

  it("resolves an authored alias as well as the display name", () => {
    expect(touch("I rest my hand on Birdie's shoulder.", [member(WREN, "Wren", ["Birdie"])])?.targetSubject).toBe(WREN);
  });

  it("mints an action id that is stable per exchange and distinct per surface", () => {
    const shoulder = touch("I rest my hand on your shoulder.");
    const again = touch("I rest my hand on your shoulder.");
    const arm = touch("I rest my hand on your arm.");
    expect(shoulder?.actionId).toBe(again?.actionId);
    expect(shoulder?.actionId).not.toBe(arm?.actionId);
    expect(shoulder?.actionId).toBe(
      chatContactActionId(EVENT, { targetSubject: WREN, targetLocationId: "shoulders" }),
    );
    // A different exchange is a different attempt, so a stale acknowledgment cannot match.
    expect(chatContactActionId(chatContactEventRef("msg_exchange_2"), {
      targetSubject: WREN,
      targetLocationId: "shoulders",
    })).not.toBe(shoulder?.actionId);
  });
});

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

describe("attempt resolution", () => {
  const act = (): ChatContactAct => {
    const detected = touch("I rest my hand on your shoulder.");
    if (detected === null) throw new Error("fixture: the shoulder touch must detect");
    return detected;
  };

  const resolve = (scene: SceneState, layers = chatContactMaterialLayers(undefined, "shoulders")) =>
    resolveChatContactAttempt({ scene, act: act(), garmentLayers: layers, storyTime: AT });

  it("commits a hand on a shoulder at arm's length", () => {
    const resolution = resolve(placed("close"));
    expect(resolution.status).toBe("committable");
    if (resolution.status !== "committable") return;
    expect(resolution.access.mode).toBe("direct");
    expect(resolution.intent.requestedPressure).toBe("light");
    // Permission-neutral by ruling: neither read was consulted, and both say so.
    expect(resolution.policy.status).toBe("not_required");
    expect(resolution.participantEligibility.status).toBe("not_required");
    expect(resolution.targetAgencies).toEqual([]);
  });

  it("stays silent when nobody has said where the bodies are", () => {
    const sink = new DiagnosticCollector();
    const resolution = resolveChatContactAttempt({
      scene: seeded(),
      act: act(),
      garmentLayers: [],
      storyTime: AT,
      sink,
    });
    expect(resolution.status).toBe("unresolved");
    if (resolution.status !== "unresolved") return;
    expect(resolution.reason).toBe("geometry_unavailable");
    expect(sink.items.some((item) => item.code.startsWith("contact."))).toBe(true);
  });

  it("refuses a touch across the room — an answer the fiction can carry", () => {
    const resolution = resolve(placed("distant"));
    expect(resolution.status).toBe("rejected");
    if (resolution.status !== "rejected") return;
    expect(resolution.reason).toBe("out_of_reach");
  });

  it("demands a visible move when the reach needs one", () => {
    const resolution = resolve(placed("near"));
    expect(resolution.status).toBe("explicit_transition_required");
    if (resolution.status !== "explicit_transition_required") return;
    expect(resolution.requirements.map((requirement) => requirement.code)).toContain("reposition");
  });

  it("reads actor control off the scene rather than asserting it", () => {
    // A scene that never declared a controller cannot authorize a movement, and
    // the honest answer is silence — not a refusal nobody made.
    const base = placed("close");
    const player = sceneParticipant(base, CHAT_CONTACT_PLAYER_SUBJECT);
    const uncontrolled = withSceneParticipant(base, {
      subjectId: CHAT_CONTACT_PLAYER_SUBJECT,
      ...(player?.posture === undefined ? {} : { posture: player.posture }),
      ...(player?.support === undefined ? {} : { support: player.support }),
    });
    const resolution = resolveChatContactAttempt({ scene: uncontrolled, act: act(), garmentLayers: [], storyTime: AT });
    expect(resolution.status).toBe("unresolved");
    if (resolution.status !== "unresolved") return;
    expect(resolution.reason).toBe("actor_control_unresolved");
  });

  it("lands through a sleeve rather than demanding it come off", () => {
    const coverage: EffectiveCoverageRead = {
      atMinutes: AT,
      entries: [{ locationId: "shoulders", band: "opaque", evidence: [] }],
    };
    const resolution = resolve(placed("close"), chatContactMaterialLayers(coverage, "shoulders"));
    expect(resolution.status).toBe("committable");
    if (resolution.status !== "committable") return;
    expect(resolution.access.mode).toBe("through_material");
    expect(resolution.access.transmission.directSkinContact).toBe(false);
  });
});

describe("the material adapter", () => {
  it("reads a location no garment reaches as bare skin", () => {
    expect(chatContactMaterialLayers(undefined, "shoulders")).toEqual([]);
    expect(chatContactMaterialLayers({ atMinutes: AT, entries: [] }, "shoulders")).toEqual([]);
  });

  it("treats an `exposed` cover as a layer — that band is about sight, not touch", () => {
    const layers = chatContactMaterialLayers(
      { atMinutes: AT, entries: [{ locationId: "arms", band: "exposed", evidence: [] }] },
      "arms",
    );
    expect(layers).toHaveLength(1);
    expect(layers[0]?.visibleThrough).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The turn plan and the narrator seam
// ---------------------------------------------------------------------------

describe("the turn plan", () => {
  const plan = (message: string, scene: SceneState, characters: readonly ChatContactRosterMember[] = SOLO) =>
    planChatContactTurn({ scene, message, narratorInput: false, characters, eventRef: EVENT, storyTime: AT });

  it("moves and touches in one message", () => {
    const planned = plan("I walk over to Wren. I rest my hand on her shoulder.", emptySceneState());
    expect(sceneProximityFact(planned.scene, CHAT_CONTACT_PLAYER_SUBJECT, WREN)?.value).toBe("close");
    expect(planned.commit?.status).toBe("committed");
  });

  it("leaves the projection alone until the caller has written the fold", () => {
    const planned = plan("I rest my hand on your shoulder.", placed("close"));
    // `commit.state` holds the new contact; `planned.scene` deliberately does not.
    expect(planned.scene.contacts.contacts).toEqual([]);
    expect(planned.commit?.status).toBe("committed");
    if (planned.commit?.status !== "committed") return;
    expect(planned.commit.state.contacts).toHaveLength(1);
    expect(planned.commit.contact.pairKey).toBe(
      contactPairKey(
        { kind: "body", subjectId: CHAT_CONTACT_PLAYER_SUBJECT, locationId: "hands" },
        { kind: "body", subjectId: WREN, locationId: "shoulders" },
      ),
    );
  });

  it("re-planning the same exchange reproduces the identical contact id", () => {
    const scene = placed("close");
    const first = plan("I rest my hand on your shoulder.", scene);
    const second = plan("I rest my hand on your shoulder.", scene);
    expect(first.commit?.status).toBe("committed");
    if (first.commit?.status !== "committed" || second.commit?.status !== "committed") return;
    expect(second.commit.contact.contactId).toBe(first.commit.contact.contactId);
  });

  it("holding the same contact across an exchange continues it rather than restarting it", () => {
    const scene = placed("close");
    const first = plan("I rest my hand on your shoulder.", scene);
    if (first.commit?.status !== "committed") throw new Error("fixture: the first touch must commit");
    const held = planChatContactTurn({
      scene: withSceneContacts(first.scene, first.commit.state),
      message: "I rest my hand on your shoulder.",
      narratorInput: false,
      characters: SOLO,
      eventRef: chatContactEventRef("msg_exchange_2"),
      storyTime: AT + 1,
    });
    expect(held.commit?.status).toBe("committed");
    if (held.commit?.status !== "committed") return;
    expect(held.commit.commit.kind).toBe("contact_continued");
    expect(held.commit.contact.contactId).toBe(first.commit.contact.contactId);
  });

  it("plans nothing at all when the message carries no act", () => {
    const planned = plan("I ask her how the shop went today.", placed("close"));
    expect(planned.act).toBeNull();
    expect(planned.resolution).toBeNull();
    expect(planned.commit).toBeNull();
  });
});

describe("the flag", () => {
  it("is off unless it is explicitly on", () => {
    const before = process.env.CHAT_CONTACT_ACTIONS;
    try {
      delete process.env.CHAT_CONTACT_ACTIONS;
      expect(chatContactActionsEnabled()).toBe(false);
      process.env.CHAT_CONTACT_ACTIONS = "true";
      expect(chatContactActionsEnabled()).toBe(false);
      process.env.CHAT_CONTACT_ACTIONS = "on";
      expect(chatContactActionsEnabled()).toBe(true);
    } finally {
      if (before === undefined) delete process.env.CHAT_CONTACT_ACTIONS;
      else process.env.CHAT_CONTACT_ACTIONS = before;
    }
  });
});

describe("the narrator seam", () => {
  const committedPlan = () => {
    const planned = planChatContactTurn({
      scene: placed("close"),
      message: "I rest my hand on your shoulder.",
      narratorInput: false,
      characters: SOLO,
      eventRef: EVENT,
      storyTime: AT,
    });
    if (planned.act === null || planned.resolution === null || planned.commit?.status !== "committed") {
      throw new Error("fixture: the shoulder touch must commit");
    }
    return { act: planned.act, resolution: planned.resolution, commit: planned.commit };
  };

  it("reports `committed` only once a write has been acknowledged", () => {
    const { act, resolution, commit } = committedPlan();
    const outcome = chatContactActionOutcome({
      act,
      resolution,
      commit,
      eventRef: EVENT,
      acknowledgment: chatContactAcknowledgment({ commit, eventRef: EVENT, actionId: act.actionId }),
    });
    expect(outcome.status).toBe("committed");
    expect(outcome.narratorMustResolve).toBe(false);
    expect(outcome.disclosure).toBe("consistency_only");
    expect(outcome.resultCodes).toEqual(["contact.locus.shoulders", "contact.gesture.rest", "contact.material.direct"]);
  });

  it("falls silent when nothing acknowledged the write", () => {
    const { act, resolution, commit } = committedPlan();
    const sink = new DiagnosticCollector();
    const outcome = chatContactActionOutcome({ act, resolution, commit, eventRef: EVENT, sink });
    expect(outcome.status).toBe("unresolved");
    expect(outcome.narratorMustResolve).toBe(false);
    expect(sink.hasErrors).toBe(true);
  });

  it("falls silent for an acknowledgment that names a different attempt", () => {
    const { act, resolution, commit } = committedPlan();
    const stale = chatContactAcknowledgment({
      commit,
      eventRef: chatContactEventRef("msg_exchange_0"),
      actionId: act.actionId,
    });
    const outcome = chatContactActionOutcome({ act, resolution, commit, eventRef: EVENT, acknowledgment: stale });
    expect(outcome.status).toBe("unresolved");
  });

  it("makes a refusal mandatory for the narrator", () => {
    const planned = planChatContactTurn({
      scene: placed("distant"),
      message: "I rest my hand on your shoulder.",
      narratorInput: false,
      characters: SOLO,
      eventRef: EVENT,
      storyTime: AT,
    });
    if (planned.act === null || planned.resolution === null) throw new Error("fixture: the touch must be detected");
    const outcome = chatContactActionOutcome({ act: planned.act, resolution: planned.resolution, eventRef: EVENT });
    expect(outcome.status).toBe("rejected");
    expect(outcome.narratorMustResolve).toBe(true);
    expect(outcome.resultCodes).toEqual(["contact.locus.shoulders", "contact.blocked.out_of_reach"]);
  });

  it("carries an unresolved attempt as a candidate the narrator is told nothing about", () => {
    const planned = planChatContactTurn({
      scene: seeded(),
      message: "I rest my hand on your shoulder.",
      narratorInput: false,
      characters: SOLO,
      eventRef: EVENT,
      storyTime: AT,
    });
    if (planned.act === null || planned.resolution === null) throw new Error("fixture: the touch must be detected");
    const outcome = chatContactActionOutcome({ act: planned.act, resolution: planned.resolution, eventRef: EVENT });
    expect(outcome.status).toBe("unresolved");
    expect(outcome.narratorMustResolve).toBe(false);
    // The reason rides the codes for the inspector; the lexicon words none of them.
    expect(outcome.resultCodes).toContain("contact.unresolved.geometry_unavailable");
    expect(chatContactPhrase("contact.unresolved.geometry_unavailable")).toBeUndefined();
  });
});
