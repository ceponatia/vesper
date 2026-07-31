import { describe, expect, it } from "vitest";
import {
  adapterSupported,
  adapterUnavailable,
  affordanceEvidence,
  affordanceSubjectId,
  applySceneIntents,
  contactPairKey,
  DiagnosticCollector,
  emptyChatGarmentStore,
  emptyEffectiveCoverageRead,
  emptySceneState,
  garmentActorForCharacter,
  garmentInstanceStateSchema,
  sceneEventRef,
  sceneFacingFact,
  sceneParticipant,
  sceneProximityFact,
  sceneSupportSurface,
  withSceneContacts,
  withSceneParticipant,
  type AffordanceSubjectId,
  type ChatGarmentStore,
  type EffectiveCoverageRead,
  type GarmentInstanceState,
  type SceneMovementIntent,
  type SceneProximityBand,
  type SceneState,
} from "@/contracts";
import {
  applyChatContactRelease,
  chatApproachSceneIntents,
  chatContactAcknowledgment,
  chatContactActionId,
  chatContactActionOutcome,
  chatContactEventRef,
  chatContactMaterialLayers,
  chatContactMaterialSource,
  chatContactPhrase,
  CHAT_CONTACT_PLAYER_SUBJECT,
  CHAT_SCENE_GROUND_SUPPORT,
  detectChatAffectionateTouch,
  detectChatApproach,
  detectChatContactRelease,
  endAllChatContacts,
  planChatContactTurn,
  resolveChatContactAttempt,
  seededChatScene,
  type ChatContactAct,
  type ChatContactMaterialSource,
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

/** The wardrobe's own "nothing is on this body" answer — an ANSWER, not an absence. */
const BARE: ChatContactMaterialSource = adapterSupported(emptyEffectiveCoverageRead());

function member(
  subjectId: AffordanceSubjectId,
  name: string,
  aliases: readonly string[] = [],
  material: ChatContactMaterialSource = BARE,
): ChatContactRosterMember {
  return { subjectId, name, aliases, material };
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

  describe("a possessive names what somebody OWNS, not where they are", () => {
    it.each([
      ["I walk over to her desk.", "a possessive pronoun before a noun"],
      ["I walk over to Wren's desk.", "a possessed name before a noun"],
      ["I sit down next to your chair.", "the same, in the second person"],
      ["I move closer to his side of the table.", "the same, with a longer possession"],
      ["I walk over to Wren's side.", "an ambiguous body-part possessive — refused conservatively"],
    ])("%s moves nobody (%s)", (message) => {
      expect(approach(message)).toBeNull();
    });

    it.each([
      ["I walk over to Wren.", "a bare name"],
      ["I walk over to Wren, smiling.", "a name, then a new clause"],
      ["I walk over to her.", "a clause-final pronoun, sole character"],
      ["I walk over to Wren and sit down.", "a name joined to what happened next"],
      ["I step closer to you and wait.", "an object pronoun, which is never a determiner"],
    ])("%s still lands (%s)", (message) => {
      expect(approach(message)).toEqual({ targetSubject: WREN, band: "close" });
    });

    it("keeps scanning past the furniture it refused", () => {
      expect(approach("I walk over to her desk, then I step closer to Wren")).toEqual({
        targetSubject: WREN,
        band: "close",
      });
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

  const resolve = (scene: SceneState, material: ChatContactMaterialSource = BARE) =>
    resolveChatContactAttempt({ scene, act: act(), material, storyTime: AT });

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
      material: BARE,
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
    const resolution = resolveChatContactAttempt({ scene: uncontrolled, act: act(), material: BARE, storyTime: AT });
    expect(resolution.status).toBe("unresolved");
    if (resolution.status !== "unresolved") return;
    expect(resolution.reason).toBe("actor_control_unresolved");
  });

  it("lands through a sleeve rather than demanding it come off", () => {
    const coverage: EffectiveCoverageRead = {
      atMinutes: AT,
      entries: [{ locationId: "shoulders", band: "opaque", evidence: [] }],
    };
    const resolution = resolve(placed("close"), adapterSupported(coverage));
    expect(resolution.status).toBe("committable");
    if (resolution.status !== "committable") return;
    expect(resolution.access.mode).toBe("through_material");
    expect(resolution.access.transmission.directSkinContact).toBe(false);
  });

  it("stays silent when nobody can say what she has on", () => {
    // The correction: an unknown wardrobe is not a bare shoulder. The touch is
    // detected, the bodies are close enough, and the answer is still silence.
    const sink = new DiagnosticCollector();
    const resolution = resolveChatContactAttempt({
      scene: placed("close"),
      act: act(),
      material: adapterUnavailable,
      storyTime: AT,
      sink,
    });
    expect(resolution.status).toBe("unresolved");
    if (resolution.status !== "unresolved") return;
    expect(resolution.reason).toBe("material_unavailable");
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

describe("the material SOURCE — absent knowledge is not bare skin", () => {
  const ACTOR = garmentActorForCharacter("wren");

  const worn = (): GarmentInstanceState =>
    garmentInstanceStateSchema.parse({
      id: "garment_shirt",
      blueprintHash: "hash_shirt",
      name: "linen shirt",
      locus: { kind: "worn", actorId: ACTOR },
    });

  const store = (patch: Partial<ChatGarmentStore> = {}): ChatGarmentStore => ({
    ...emptyChatGarmentStore(),
    seeded: true,
    ...patch,
  });

  const coverage: EffectiveCoverageRead = {
    atMinutes: AT,
    entries: [{ locationId: "shoulders", band: "opaque", evidence: [] }],
  };

  it("(a) answers from the wardrobe when the wardrobe enumerated this body", () => {
    const source = chatContactMaterialSource({
      store: store({ instances: [worn()], coverage: { [ACTOR]: coverage } }),
      actorId: ACTOR,
      freeTextOutfit: "",
    });
    expect(source.status).toBe("supported");
    if (source.status !== "supported") return;
    expect(chatContactMaterialLayers(source.value, "shoulders")).toHaveLength(1);
    // And a location that capture does NOT cover is genuinely bare.
    expect(chatContactMaterialLayers(source.value, "hands")).toEqual([]);
  });

  it("(b) reports UNKNOWN for a look only the narrator can see", () => {
    // The legacy free-text path: she is dressed, in clothes nothing enumerated.
    expect(
      chatContactMaterialSource({ store: store(), actorId: ACTOR, freeTextOutfit: "a borrowed hoodie" }).status,
    ).toBe("unavailable");
    // The same absence reached two other ways: structured ids that predate
    // materialization, and materialized garments no coverage pass has run over.
    expect(
      chatContactMaterialSource({ store: store(), actorId: ACTOR, freeTextOutfit: "", wornItemIds: ["item_shirt"] })
        .status,
    ).toBe("unavailable");
    expect(
      chatContactMaterialSource({ store: store({ instances: [worn()] }), actorId: ACTOR, freeTextOutfit: "" }).status,
    ).toBe("unavailable");
  });

  it("(c) answers BARE only when the wardrobe says nothing is worn", () => {
    const source = chatContactMaterialSource({ store: store(), actorId: ACTOR, freeTextOutfit: "   " });
    expect(source.status).toBe("supported");
    if (source.status !== "supported") return;
    expect(chatContactMaterialLayers(source.value, "shoulders")).toEqual([]);
  });

  it("reads another actor's wardrobe as none of this one's business", () => {
    const other = garmentActorForCharacter("vaelith");
    expect(
      chatContactMaterialSource({
        store: store({ instances: [worn()], coverage: { [ACTOR]: coverage } }),
        actorId: other,
        freeTextOutfit: "",
      }).status,
    ).toBe("supported");
  });

  it("(b) resolves to silence end to end, never to a bare shoulder", () => {
    const dressed = member(
      WREN,
      "Wren",
      [],
      chatContactMaterialSource({ store: store(), actorId: ACTOR, freeTextOutfit: "a soft grey sweater" }),
    );
    const planned = planChatContactTurn({
      scene: placed("close"),
      message: "I rest my hand on your shoulder.",
      narratorInput: false,
      characters: [dressed],
      eventRef: EVENT,
      storyTime: AT,
    });
    // Detected, reachable — and still silent, because nothing can say what is
    // between the hand and the shoulder.
    expect(planned.act).not.toBeNull();
    expect(planned.resolution?.status).toBe("unresolved");
    expect(planned.commit).toBeNull();
    if (planned.resolution?.status !== "unresolved") return;
    expect(planned.resolution.reason).toBe("material_unavailable");
  });
});

// ---------------------------------------------------------------------------
// Release and the ends
// ---------------------------------------------------------------------------

/** The player at `band` from every listed body, turned toward each of them. */
function placedAmong(
  members: readonly ChatContactRosterMember[],
  band: SceneProximityBand = "close",
): SceneState {
  const intents: SceneMovementIntent[] = members.flatMap((entry) => [
    {
      intentId: `probe:proximity:${entry.subjectId}`,
      subjectId: CHAT_CONTACT_PLAYER_SUBJECT,
      origin: "player" as const,
      change: { kind: "set_proximity" as const, otherId: entry.subjectId, band },
      ref: REF,
      storyTime: AT,
      evidence: [affordanceEvidence("adapter", "probe")],
    },
    {
      intentId: `probe:facing:${entry.subjectId}`,
      subjectId: CHAT_CONTACT_PLAYER_SUBJECT,
      origin: "player" as const,
      change: { kind: "set_facing" as const, towardId: entry.subjectId, facing: "toward" as const },
      ref: REF,
      storyTime: AT,
      evidence: [affordanceEvidence("adapter", "probe")],
    },
  ]);
  return applySceneIntents(seeded(members), intents).state;
}

/** Fold one committed touch into the scene, the way the pipeline does after its write. */
function holding(
  scene: SceneState,
  message: string,
  characters: readonly ChatContactRosterMember[],
  eventRef = EVENT,
): { scene: SceneState; contactId: string } {
  const planned = planChatContactTurn({
    scene,
    message,
    narratorInput: false,
    characters,
    eventRef,
    storyTime: AT,
  });
  if (planned.commit?.status !== "committed") throw new Error(`fixture: "${message}" must commit`);
  return {
    scene: withSceneContacts(planned.scene, planned.commit.state),
    contactId: planned.commit.contact.contactId,
  };
}

describe("release detection", () => {
  const release = (message: string, characters: readonly ChatContactRosterMember[] = SOLO) =>
    detectChatContactRelease({ message, narratorInput: false, characters });

  it.each([
    "I pull my hand back.",
    "I draw my hand away.",
    "I take my hand back.",
    "I slowly move my hand away.",
    "I lift my hand.",
    "I withdraw my hand.",
    "I drop my hand.",
    "I let go.",
  ])("%s reads as a release of everything the player is holding", (message) => {
    expect(release(message)).toEqual({ targetSubject: null });
  });

  it.each([
    "I let go of her hand.",
    "I let go of Wren's hand.",
    "I take my hand off your shoulder.",
    "I lift my hand from Wren's arm.",
    "I remove my hand from her back.",
  ])("%s reads as a release of that person's contacts", (message) => {
    expect(release(message)).toEqual({ targetSubject: WREN });
  });

  it("reads a release from a forceful word, because refusing would strand the contact", () => {
    // The restraint veto is lifted HERE and nowhere else: "pull" is the plainest
    // English for this, and a missed release leaves a durable row claiming a hand
    // that is no longer there.
    expect(release("I pull my hand back from her shoulder.")).toEqual({ targetSubject: WREN });
    // It buys nothing on the commit side — a forceful touch still commits nothing.
    expect(touch("I grab your arm.")).toBeNull();
  });

  it.each([
    ["I don't let go.", "a denial"],
    ["Should I let go of her hand?", "a question"],
    ["Maybe I let go of her hand.", "a hedge"],
    ["I want to let go of her hand.", "an intention"],
    ["She lets go of my hand.", "somebody else's body"],
    ["I let go of her hand and kiss her.", "romantic framing in the same sentence"],
  ])("%s produces no release (%s)", (message) => {
    expect(release(message)).toBeNull();
  });

  it("ignores narration that is not the player's own", () => {
    expect(detectChatContactRelease({ message: "I let go.", narratorInput: true, characters: SOLO })).toBeNull();
    expect(release('"I let go of your hand."')).toBeNull();
  });

  it("does not read a placement as a release", () => {
    // "drop" means "off it" only when nothing follows it: a hand going somewhere
    // is the opposite beat, and ending a contact on it would undo the touch.
    expect(release("I drop my hand onto your shoulder.")).toBeNull();
    expect(release("I lower my hand.")).toBeNull();
    expect(release("I drop my hand.")).toEqual({ targetSubject: null });
  });

  it("refuses a target it cannot resolve rather than releasing everything", () => {
    // The sentence said WHAT it let go of. Substituting a different thing would be
    // this layer choosing whose hand came free.
    expect(release("I let go of the railing.")).toBeNull();
    expect(release("I let go of her hand.", PAIR)).toBeNull();
    expect(release("I let go of Vaelith's hand.", PAIR)).toEqual({ targetSubject: VAEL });
  });
});

describe("applying a release", () => {
  it("ends the contacts the player's own hand is making", () => {
    const held = holding(placedAmong(SOLO), "I rest my hand on your shoulder.", SOLO);
    const sink = new DiagnosticCollector();
    const ends = applyChatContactRelease({
      scene: held.scene,
      release: { targetSubject: null },
      eventRef: chatContactEventRef("msg_exchange_2"),
      storyTime: AT + 1,
      sink,
    });
    expect(ends.commits).toHaveLength(1);
    expect(ends.commits[0]?.contactId).toBe(held.contactId);
    expect(ends.commits[0]?.reason).toBe("withdrawn");
    expect(ends.scene.contacts.contacts).toEqual([]);
    expect(sink.hasErrors).toBe(false);
  });

  it("ends only the named person's contacts in a group", () => {
    const first = holding(placedAmong(PAIR), "I rest my hand on Wren's shoulder.", PAIR);
    const second = holding(first.scene, "I rest my hand on Vaelith's arm.", PAIR, chatContactEventRef("msg_2"));
    const ends = applyChatContactRelease({
      scene: second.scene,
      release: { targetSubject: WREN },
      eventRef: chatContactEventRef("msg_3"),
      storyTime: AT + 1,
    });
    expect(ends.commits.map((commit) => commit.contactId)).toEqual([first.contactId]);
    expect(ends.scene.contacts.contacts.map((contact) => contact.contactId)).toEqual([second.contactId]);
  });

  it("does nothing, quietly, when there is nothing in the hand", () => {
    const scene = placedAmong(SOLO);
    const sink = new DiagnosticCollector();
    const ends = applyChatContactRelease({
      scene,
      release: { targetSubject: null },
      eventRef: EVENT,
      storyTime: AT,
      sink,
    });
    // "I let go" with an empty hand is an ordinary sentence, not a caller bug.
    expect(ends.commits).toEqual([]);
    expect(ends.scene).toBe(scene);
    expect(sink.items).toEqual([]);
  });

  it("absorbs a release older than the contact it names (law 4)", () => {
    const held = holding(placedAmong(SOLO), "I rest my hand on your shoulder.", SOLO);
    const sink = new DiagnosticCollector();
    const ends = applyChatContactRelease({
      scene: held.scene,
      release: { targetSubject: null },
      eventRef: chatContactEventRef("msg_exchange_0"),
      storyTime: AT - 5,
      sink,
    });
    expect(ends.commits).toEqual([]);
    expect(ends.scene.contacts.contacts).toHaveLength(1);
    expect(sink.items.some((item) => item.severity === "warn")).toBe(true);
  });
});

describe("ending every contact at once", () => {
  it("sweeps the scene for a skip or a scene change, with the reason it was given", () => {
    const held = holding(placedAmong(SOLO), "I rest my hand on your shoulder.", SOLO);
    const swept = endAllChatContacts(held.scene, {
      reason: "separated",
      eventRef: chatContactEventRef("msg_skip"),
      storyTime: AT + 90,
    });
    expect(swept.commits.map((commit) => commit.reason)).toEqual(["separated"]);
    expect(swept.scene.contacts.contacts).toEqual([]);
  });

  it("carries `scene_changed` just as faithfully, and leaves an empty scene alone", () => {
    const held = holding(placedAmong(SOLO), "I rest my hand on your shoulder.", SOLO);
    const exited = endAllChatContacts(held.scene, {
      reason: "scene_changed",
      eventRef: chatContactEventRef("msg_exit"),
      storyTime: AT + 1,
    });
    expect(exited.commits.map((commit) => commit.reason)).toEqual(["scene_changed"]);
    const empty = placedAmong(SOLO);
    const again = endAllChatContacts(empty, {
      reason: "scene_changed",
      eventRef: EVENT,
      storyTime: AT,
    });
    expect(again.commits).toEqual([]);
    expect(again.scene).toBe(empty);
  });

  it("leaves a contact the sweep is older than, and says so", () => {
    const held = holding(placedAmong(SOLO), "I rest my hand on your shoulder.", SOLO);
    const sink = new DiagnosticCollector();
    const swept = endAllChatContacts(held.scene, {
      reason: "separated",
      eventRef: chatContactEventRef("msg_stale"),
      storyTime: AT - 1,
      sink,
    });
    expect(swept.commits).toEqual([]);
    expect(swept.scene.contacts.contacts).toHaveLength(1);
    expect(sink.items.some((item) => item.severity === "warn")).toBe(true);
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
    expect(planned.ended).toEqual([]);
  });

  it("releases BEFORE it touches, so the same pair starts fresh rather than continuing", () => {
    const held = holding(placedAmong(SOLO), "I rest my hand on your shoulder.", SOLO);
    const planned = planChatContactTurn({
      scene: held.scene,
      message: "I let go of her shoulder. I rest my hand on her shoulder.",
      narratorInput: false,
      characters: SOLO,
      eventRef: chatContactEventRef("msg_exchange_2"),
      storyTime: AT + 1,
    });
    // The release ends the held contact...
    expect(planned.ended.map((commit) => commit.contactId)).toEqual([held.contactId]);
    expect(planned.ended[0]?.reason).toBe("withdrawn");
    // ...and the touch that follows it starts a NEW one. Had the order been the
    // other way round, this would have been a `contact_continued` on the old id
    // and the release would have ended the contact this very turn made.
    expect(planned.commit?.status).toBe("committed");
    if (planned.commit?.status !== "committed") return;
    expect(planned.commit.commit.kind).toBe("contact_started");
    expect(planned.commit.contact.contactId).not.toBe(held.contactId);
  });

  it("folds the release into the planned scene, so a release-only turn shows it", () => {
    const held = holding(placedAmong(SOLO), "I rest my hand on your shoulder.", SOLO);
    const planned = planChatContactTurn({
      scene: held.scene,
      message: "I pull my hand back.",
      narratorInput: false,
      characters: SOLO,
      eventRef: chatContactEventRef("msg_exchange_2"),
      storyTime: AT + 1,
    });
    expect(planned.act).toBeNull();
    expect(planned.commit).toBeNull();
    expect(planned.ended).toHaveLength(1);
    expect(planned.scene.contacts.contacts).toEqual([]);
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
