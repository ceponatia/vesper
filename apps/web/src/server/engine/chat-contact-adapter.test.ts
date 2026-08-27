import { describe, expect, it } from "vitest";
import {
  adapterSupported,
  adapterUnavailable,
  affordanceEvidence,
  affordanceSubjectId,
  applySceneIntents,
  commitContactResolution,
  contactPairKey,
  DiagnosticCollector,
  emptyChatGarmentStore,
  emptyEffectiveCoverageRead,
  emptySceneState,
  chatRomanticContactGestures,
  derivePermissionPolicyRead,
  foldRomanticPermissionProjection,
  garmentActorForCharacter,
  garmentInstanceStateSchema,
  isAdapterSupported,
  resolveContactAttempt,
  sceneEventRef,
  sceneFacingFact,
  sceneGeometryRead,
  sceneParticipant,
  sceneProximityFact,
  sceneSupportRead,
  sceneSupportSurface,
  withSceneContacts,
  withSceneParticipant,
  type AffordanceSubjectId,
  type ChatGarmentStore,
  type ContactBodySurfaceRef,
  type ContactSurfaceRef,
  type EffectiveCoverageRead,
  type GarmentInstanceState,
  type SceneMovementIntent,
  type SceneProximityBand,
  type RomanticPermissionEvent,
  type SceneState,
} from "@/contracts";
import {
  applyChatContactDeparture,
  applyChatContactRelease,
  approachedBand,
  chatActorControl,
  chatApproachSceneIntents,
  chatContactAcknowledgment,
  chatContactActionId,
  chatContactActionOutcome,
  chatContactEventRef,
  chatContactMaterialBetween,
  chatContactMaterialLayers,
  chatContactMaterialSource,
  chatContactPhrase,
  chatContactUnresolvedPremise,
  chatDepartureSceneIntents,
  CHAT_CONTACT_PLAYER_SUBJECT,
  CHAT_SCENE_GROUND_SUPPORT,
  departedBand,
  detectChatAffectionateTouch,
  detectChatApproach,
  detectChatContactAct,
  detectChatRomanticTouch,
  detectChatContactRelease,
  detectChatDeparture,
  endAllChatContacts,
  npcMovementSceneIntents,
  planChatContactTurn,
  resolveChatContactAttempt,
  chatSceneAfterDiscontinuity,
  seededChatScene,
  type ChatContactAct,
  type ChatContactMaterialSource,
  type ChatContactPolicySource,
  type ChatContactRosterMember,
  type ChatDeparture,
} from "./chat-contact-adapter";
import { chatContactActionsEnabled } from "./prompts/constants";
import { probePermissionEvent } from "@/contracts/affordances/permission/test-support";

/**
 * The chat lane's contact adapter.
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

  /**
   * The 2026-08-18 romantic proof recorded that "a character's first name alone
   * is not recognized". It was worse than that: EVERY owner capture in this lane
   * was one word, so a character named "Sabrina Vale" could not be named at all
   * — "Sabrina's arm" missed, and so did "Sabrina Vale's arm". Players write
   * first names constantly, and most authored characters have two-word names, so
   * the shipped lane answered ordinary writing with silence.
   *
   * These live here rather than beside each detector because the rule is one
   * resolver's, and the approach path is where the widened capture can do damage
   * — it is the only site where over-capturing changes a target that used to
   * resolve.
   */
  describe("naming a character — a unique first name, and a name of more than one word", () => {
    const VALE = [member(WREN, "Sabrina Vale")];
    const TWO_SABRINAS = [member(WREN, "Sabrina Vale"), member(VAEL, "Sabrina Cruz")];

    it.each([
      ["I walk over to Sabrina.", "a unique first name — the case the trial hit"],
      ["I walk over to Sabrina Vale.", "the full name, which nothing could match before"],
      ["I walk over to sabrina.", "the same, written lower-case"],
    ])("%s reaches her (%s)", (message) => {
      expect(approach(message, VALE)).toEqual({ targetSubject: WREN, band: "close" });
    });

    it("an ambiguous first name is silence, exactly as an ambiguous pronoun is", () => {
      expect(approach("I walk over to Sabrina.", TWO_SABRINAS)).toBeNull();
      // The full name still separates them.
      expect(approach("I walk over to Sabrina Vale.", TWO_SABRINAS)).toEqual({
        targetSubject: WREN,
        band: "close",
      });
    });

    /**
     * The hazard the widened capture creates, and the only way it could LOSE a
     * target: greedily taking a second capitalised word and then failing to
     * resolve the pair. Falling back to the longest resolvable prefix is what
     * keeps "Wren Vaelith" an approach to Wren.
     */
    it("a second name after the first still moves the player to the first", () => {
      expect(approach("I walk over to Wren Vaelith.", PAIR)).toEqual({ targetSubject: WREN, band: "close" });
    });

    it("the possessive guard survives a capitalised possession", () => {
      expect(approach("I walk over to Wren's Desk.", SOLO)).toBeNull();
    });

    /**
     * The capture spans several words REGARDLESS OF CASE, and the resolver is
     * what stops it running away — not the pattern.
     *
     * The obvious design here was a capitalised-continuation rule, and it would
     * have been silently inert: every pattern this fragment splices into carries
     * `i`, and case folding makes `\p{Lu}` match lowercase. These cases pin the
     * behaviour that actually holds, so a future "tightening" back to `\p{Lu}`
     * fails here rather than shipping a guard that does nothing.
     */
    it.each([
      ["I walk over to Wren and sit down by the fire.", "ordinary lowercase prose after the name"],
      ["I walk over to Wren then wait quietly.", "a lowercase continuation that is not a clause break"],
      ["I walk over to wren.", "the name itself written lower-case"],
    ])("%s still resolves to the person (%s)", (message) => {
      expect(approach(message, SOLO)).toEqual({ targetSubject: WREN, band: "close" });
    });

    it("a lower-case multi-word name resolves, because case never gated the capture", () => {
      expect(approach("I walk over to sabrina vale.", VALE)).toEqual({ targetSubject: WREN, band: "close" });
      expect(
        detectChatRomanticTouch({
          message: "I caress sabrina vale's arm.",
          narratorInput: false,
          characters: VALE,
          eventRef: EVENT,
        })?.targetLocationId,
      ).toBe("arms");
    });

    /**
     * A caseless script has no uppercase form at all, so `\p{Lu}` excluded it
     * even under folding: a character named this way was unreachable by the very
     * fragment written to reach multi-word names. The touch path proves the fix,
     * because its owner capture is followed by whitespace rather than `\b`.
     *
     * The APPROACH path still cannot name them, and the cause is elsewhere:
     * JavaScript's `\b` is ASCII-only even under `u`, so the destination's
     * trailing boundary never matches after a non-Latin character. That is a
     * pre-existing limitation of every pattern in this lane, not of this
     * fragment, and it is left alone rather than fixed under cover of a
     * capitalisation change.
     */
    it("a caseless-script name can be touched — the old capitalised rule excluded it entirely", () => {
      const roster = [member(WREN, "さくら 中村")];
      for (const message of ["I caress さくら 中村's arm.", "I caress さくら's arm."]) {
        expect(
          detectChatRomanticTouch({ message, narratorInput: false, characters: roster, eventRef: EVENT })
            ?.targetLocationId,
        ).toBe("arms");
      }
    });

    it.each([
      ["I caress Sabrina's arm.", "arms"],
      ["I caress Sabrina Vale's arm.", "arms"],
    ])("%s is a romantic act on %s", (message, locationId) => {
      const act = detectChatRomanticTouch({
        message,
        narratorInput: false,
        characters: VALE,
        eventRef: EVENT,
      });
      expect(act?.targetLocationId).toBe(locationId);
    });

    /**
     * Falsified against a first-name pass that also read the leading word of
     * every ALIAS. An alias is free authored text, so its first word is as
     * likely to be a descriptor's article as a person's given name — and both
     * ways of getting that wrong commit a durable touch on a body the sentence
     * never identified.
     *
     * The pronoun case is the worse of the two, because it does not merely add a
     * wrong match: it SKIPS the sole-character rule entirely, turning a
     * two-character room — where a pronoun is silence by law — into a guess.
     */
    it("an alias beginning with a pronoun does not make that pronoun resolve in a group", () => {
      const roster = [member(WREN, "Wren", ["her ladyship"]), member(VAEL, "Vaelith")];
      expect(
        detectChatRomanticTouch({
          message: "I caress her arm.",
          narratorInput: false,
          characters: roster,
          eventRef: EVENT,
        }),
      ).toBeNull();
      // The alias itself still resolves in full — only its leading word stopped.
      expect(approach("I walk over to her ladyship.", roster)).toEqual({ targetSubject: WREN, band: "close" });
    });

    it("an alias beginning with an ordinary word does not capture ordinary prose", () => {
      const roster = [member(WREN, "Wren", ["the redhead"])];
      // "the" is not a possessive pronoun, so nothing downstream would have
      // caught this: the turn recorded an approach TOWARD her for a sentence
      // that walked away.
      expect(approach("I walk over to the window.", roster)).toBeNull();
      expect(approach("I walk over to the redhead.", roster)).toEqual({ targetSubject: WREN, band: "close" });
    });

    /**
     * The first-name rule's own failure mode: "Sabrina's sister" names somebody
     * the roster does not contain, and a resolver that read its leading word
     * would commit a durable touch on the wrong body. An internal possessive
     * makes the whole phrase unreadable rather than merely unmatched.
     */
    it("a possessed third party is not the character whose name it borrows", () => {
      expect(
        detectChatRomanticTouch({
          message: "I caress Sabrina's sister's arm.",
          narratorInput: false,
          characters: VALE,
          eventRef: EVENT,
        }),
      ).toBeNull();
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
      chatContactActionId(EVENT, {
        actorSubject: CHAT_CONTACT_PLAYER_SUBJECT,
        targetSubject: WREN,
        targetLocationId: "shoulders",
      }),
    );
    // A different exchange is a different attempt, so a stale acknowledgment cannot match.
    expect(chatContactActionId(chatContactEventRef("msg_exchange_2"), {
      actorSubject: CHAT_CONTACT_PLAYER_SUBJECT,
      targetSubject: WREN,
      targetLocationId: "shoulders",
    })).not.toBe(shoulder?.actionId);
    // ...and so is a different ACTOR: one reply event ref spans the whole roster
    // on the NPC leg, so two hands on the same shoulder must not share an id.
    expect(chatContactActionId(EVENT, {
      actorSubject: WREN,
      targetSubject: CHAT_CONTACT_PLAYER_SUBJECT,
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

  /** The player leg's one-sided read: the target's shoulder and nothing else. */
  const targetSide = (material: ChatContactMaterialSource) =>
    chatContactMaterialBetween([{ side: "target", material, locationId: "shoulders" }]);

  const resolve = (scene: SceneState, material: ChatContactMaterialSource = BARE) =>
    resolveChatContactAttempt({
      scene,
      act: act(),
      material: targetSide(material),
      control: "player_controlled",
      storyTime: AT,
    });

  it("commits a hand on a shoulder at arm's length", () => {
    const resolution = resolve(placed("close"));
    expect(resolution.status).toBe("committable");
    if (resolution.status !== "committable") return;
    expect(resolution.access.mode).toBe("direct");
    expect(resolution.intent.requestedPressure).toBe("light");
    // Permission-neutral by ruling: the read was never consulted, and says so.
    expect(resolution.policy.status).toBe("not_required");
    expect(resolution.targetAgencies).toEqual([]);
  });

  it("stays silent when nobody has said where the bodies are", () => {
    const sink = new DiagnosticCollector();
    const resolution = resolveChatContactAttempt({
      scene: seeded(),
      act: act(),
      material: targetSide(BARE),
      control: "player_controlled",
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
    const resolution = resolveChatContactAttempt({
      scene: uncontrolled,
      act: act(),
      material: targetSide(BARE),
      control: "player_controlled",
      storyTime: AT,
    });
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
      material: targetSide(adapterUnavailable),
      control: "player_controlled",
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

// ---------------------------------------------------------------------------
// Two-sided material
// ---------------------------------------------------------------------------

describe("chatContactMaterialBetween — both wardrobes, one stack", () => {
  const covers = (locationId: string, band: "opaque" | "hinted" | "exposed") =>
    adapterSupported({ atMinutes: AT, entries: [{ locationId, band, evidence: [] }] });
  const bare = () => adapterSupported(emptyEffectiveCoverageRead());

  const between = (source: ChatContactMaterialSource, target: ChatContactMaterialSource) =>
    chatContactMaterialBetween([
      { side: "source", material: source, locationId: "hands" },
      { side: "target", material: target, locationId: "shoulders" },
    ]);

  it("puts the reaching hand's own cover FIRST and the touched surface's after it", () => {
    const read = between(covers("hands", "opaque"), covers("shoulders", "hinted"));
    expect(isAdapterSupported(read)).toBe(true);
    if (!isAdapterSupported(read)) return;
    expect(read.value.layers.map((layer) => layer.layerId)).toEqual([
      "source:coverage:hands",
      "target:coverage:shoulders",
    ]);
    // One CONTINUOUS stack: the second side is renumbered rather than restarting
    // at zero, which is what the lifecycle's content fingerprint reads.
    expect(read.value.layers.map((layer) => layer.order)).toEqual([0, 1]);
  });

  it("keeps two `hands` reads apart — a glove and the hand it lands on are different layers", () => {
    const read = chatContactMaterialBetween([
      { side: "source", material: covers("hands", "opaque"), locationId: "hands" },
      { side: "target", material: covers("hands", "opaque"), locationId: "hands" },
    ]);
    if (!isAdapterSupported(read)) throw new Error("both sides were readable");
    expect(new Set(read.value.layers.map((layer) => layer.layerId)).size).toBe(2);
  });

  it("both bodies bare ⇒ no layers at all, which is skin", () => {
    const read = between(bare(), bare());
    if (!isAdapterSupported(read)) throw new Error("both sides were readable");
    expect(read.value.layers).toEqual([]);
  });

  it("an unreadable SOURCE makes the whole read unavailable", () => {
    expect(isAdapterSupported(between(adapterUnavailable, covers("shoulders", "opaque")))).toBe(false);
  });

  it("an unreadable TARGET makes the whole read unavailable", () => {
    expect(isAdapterSupported(between(bare(), adapterUnavailable))).toBe(false);
  });

  it("a location the wardrobe does not reach contributes nothing, on either side", () => {
    // She is wearing something, just not over the surfaces this touch involves.
    const read = between(covers("back", "opaque"), covers("back", "opaque"));
    if (!isAdapterSupported(read)) throw new Error("both sides were readable");
    expect(read.value.layers).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Actor control — the same read, mirrored per origin
// ---------------------------------------------------------------------------

describe("chatActorControl reads the scene rather than asserting the caller's authority", () => {
  const scene = () => placed("close");

  it("an NPC-origin act over an `npc_controlled` body is allowed", () => {
    expect(chatActorControl({ scene: scene(), actorId: WREN, requires: "npc_controlled" }).status).toBe("allowed");
  });

  it("an NPC-origin act over the PLAYER's body is denied", () => {
    expect(
      chatActorControl({ scene: scene(), actorId: CHAT_CONTACT_PLAYER_SUBJECT, requires: "npc_controlled" }).status,
    ).toBe("denied");
  });

  it("the player leg's question is the exact mirror", () => {
    expect(
      chatActorControl({ scene: scene(), actorId: CHAT_CONTACT_PLAYER_SUBJECT, requires: "player_controlled" }).status,
    ).toBe("allowed");
    expect(chatActorControl({ scene: scene(), actorId: WREN, requires: "player_controlled" }).status).toBe("denied");
  });

  it("a body with no control fact is UNRESOLVED for either origin — silence, not a refusal", () => {
    const base = scene();
    const wren = sceneParticipant(base, WREN);
    const uncontrolled = withSceneParticipant(base, {
      subjectId: WREN,
      ...(wren?.posture === undefined ? {} : { posture: wren.posture }),
      ...(wren?.support === undefined ? {} : { support: wren.support }),
    });
    expect(chatActorControl({ scene: uncontrolled, actorId: WREN, requires: "npc_controlled" }).status).toBe(
      "unresolved",
    );
    expect(chatActorControl({ scene: uncontrolled, actorId: WREN, requires: "player_controlled" }).status).toBe(
      "unresolved",
    );
  });
});

describe("the material SOURCE — the current cut answers, and absent knowledge is not bare skin", () => {
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

  it("(a) answers from the CURRENT cut's derived coverage", () => {
    const source = chatContactMaterialSource({
      coverage,
      store: store({ instances: [worn()] }),
      actorId: ACTOR,
      freeTextOutfit: "",
    });
    expect(source.status).toBe("supported");
    if (source.status !== "supported") return;
    expect(chatContactMaterialLayers(source.value, "shoulders")).toHaveLength(1);
    // And a location that read does NOT cover is genuinely bare.
    expect(chatContactMaterialLayers(source.value, "hands")).toEqual([]);
  });

  it("(a) the current cut WINS over a stale persisted capture", () => {
    // The stored capture describes an earlier cut — a cardigan over the
    // shoulders that the current wardrobe no longer wears. The current
    // derivation says the shoulders are uncovered, and the current answer is
    // the answer: the touch lands on skin, not on last exchange's cloth.
    const stale: EffectiveCoverageRead = {
      atMinutes: 0,
      entries: [{ locationId: "shoulders", band: "opaque", evidence: [] }],
    };
    const current: EffectiveCoverageRead = { atMinutes: AT, entries: [] };
    const source = chatContactMaterialSource({
      coverage: current,
      store: store({ instances: [worn()], coverage: { [ACTOR]: stale } }),
      actorId: ACTOR,
      freeTextOutfit: "",
    });
    expect(source.status).toBe("supported");
    if (source.status !== "supported") return;
    expect(source.value).toBe(current);
    expect(chatContactMaterialLayers(source.value, "shoulders")).toEqual([]);
  });

  it("(b) reports UNKNOWN for a look only the narrator can see", () => {
    // The legacy free-text path: she is dressed, in clothes nothing modelled.
    expect(
      chatContactMaterialSource({ coverage: null, store: store(), actorId: ACTOR, freeTextOutfit: "a borrowed hoodie" })
        .status,
    ).toBe("unavailable");
    // The same absence reached two other ways: structured ids that predate
    // materialization, and materialized garments this cut could not model.
    expect(
      chatContactMaterialSource({
        coverage: null,
        store: store(),
        actorId: ACTOR,
        freeTextOutfit: "",
        wornItemIds: ["item_shirt"],
      }).status,
    ).toBe("unavailable");
    expect(
      chatContactMaterialSource({ coverage: null, store: store({ instances: [worn()] }), actorId: ACTOR, freeTextOutfit: "" })
        .status,
    ).toBe("unavailable");
  });

  it("(b) a failed current derivation does NOT fall back to an older capture", () => {
    // A capture from some earlier cut sits in the store; the current cut could
    // not model this dressed body. Falling back would answer from garments that
    // may no longer match the current state — the honest answer is silence.
    const source = chatContactMaterialSource({
      coverage: null,
      store: store({ instances: [worn()], coverage: { [ACTOR]: coverage } }),
      actorId: ACTOR,
      freeTextOutfit: "",
    });
    expect(source.status).toBe("unavailable");
  });

  it("(c) answers BARE only when the wardrobe says nothing is worn", () => {
    const source = chatContactMaterialSource({ coverage: null, store: store(), actorId: ACTOR, freeTextOutfit: "   " });
    expect(source.status).toBe("supported");
    if (source.status !== "supported") return;
    expect(chatContactMaterialLayers(source.value, "shoulders")).toEqual([]);
  });

  it("(c) an EMPTY current read is a real answer — bare, not absent", () => {
    // Derivation ran and nothing covers anything. That is the wardrobe's own
    // "nothing over that surface", even for a body whose store holds instances.
    const source = chatContactMaterialSource({
      coverage: { atMinutes: AT, entries: [] },
      store: store({ instances: [worn()] }),
      actorId: ACTOR,
      freeTextOutfit: "",
    });
    expect(source.status).toBe("supported");
    if (source.status !== "supported") return;
    expect(chatContactMaterialLayers(source.value, "shoulders")).toEqual([]);
  });

  it("(b) resolves to silence end to end, never to a bare shoulder", () => {
    const dressed = member(
      WREN,
      "Wren",
      [],
      chatContactMaterialSource({ coverage: null, store: store(), actorId: ACTOR, freeTextOutfit: "a soft grey sweater" }),
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

/**
 * A contact the CHARACTER is making on the PLAYER.
 *
 * The one direction this lane's own detectors cannot produce — every act they
 * read is the player's own hand — and the direction the departure's ending law
 * is specifically about. Built through the shared core with her control asserted
 * NPC-side, which is the only honest way to say she reached out.
 */
function herHandOnMe(
  scene: SceneState,
  eventRef = chatContactEventRef("msg_her_hand"),
): { scene: SceneState; contactId: string } {
  // She has to be turned toward the player for the reach to read at all, and that
  // is her fact: an `npc`-origin intent, never a player-origin one.
  const turned = applySceneIntents(scene, [
    {
      intentId: "probe:facing:hers",
      subjectId: WREN,
      origin: "npc",
      change: { kind: "set_facing", towardId: CHAT_CONTACT_PLAYER_SUBJECT, facing: "toward" },
      ref: REF,
      storyTime: AT,
      evidence: [affordanceEvidence("adapter", "probe")],
    },
  ]).state;
  const source: ContactBodySurfaceRef = { kind: "body", subjectId: WREN, locationId: "hands" };
  const target: ContactSurfaceRef = {
    kind: "body",
    subjectId: CHAT_CONTACT_PLAYER_SUBJECT,
    locationId: "shoulders",
  };
  const resolution = resolveContactAttempt({
    intent: {
      actionId: "probe:her_hand",
      actorId: WREN,
      source,
      target,
      actionKind: "affectionate",
      access: "any_material",
      requestedPressure: "light",
      storyTime: AT,
    },
    context: {
      actorControl: { status: "allowed", actorId: WREN, evidence: [affordanceEvidence("adapter", "probe")] },
      targetAgencies: [],
      policy: { status: "not_required", scopes: [], evidence: [] },
      geometry: sceneGeometryRead({ state: turned, source, target }),
      sourceSupport: sceneSupportRead(turned, source),
      targetSupport: sceneSupportRead(turned, {
        kind: "body",
        subjectId: CHAT_CONTACT_PLAYER_SUBJECT,
        locationId: "shoulders",
      }),
      material: adapterSupported({ layers: [], evidence: [] }),
      adjustments: [],
    },
  });
  if (resolution.status !== "committable") throw new Error(`fixture: her hand must commit (${resolution.status})`);
  const commit = commitContactResolution({ state: turned.contacts, resolution, eventRef });
  if (commit.status !== "committed") throw new Error("fixture: her hand must commit");
  return { scene: withSceneContacts(turned, commit.state), contactId: commit.contact.contactId };
}

// ---------------------------------------------------------------------------
// Departure — the player moving away
// ---------------------------------------------------------------------------

describe("departure detection", () => {
  const depart = (message: string, characters: readonly ChatContactRosterMember[] = SOLO) =>
    detectChatDeparture({ message, narratorInput: false, characters });

  it.each([
    "I step back.",
    "I take a step back.",
    "I slowly step back.",
    "I step away.",
    "I back away.",
    "I pull away.",
    "I move away.",
    "I draw away.",
    "I lean back.",
    "I put some distance between us.",
    "I put a little distance between us.",
  ])("%s reads as a step's worth of distance from everyone", (message) => {
    expect(depart(message)).toEqual({ targetSubject: null, band: "near" });
  });

  it.each(["I walk away.", "I walk across the room.", "I step across the room.", "I move across the room."])(
    "%s reads as the width of the room",
    (message) => {
      // WALKING is the other class: the space between them is now a space that has
      // to be crossed, which is what `distant` means.
      expect(depart(message)).toEqual({ targetSubject: null, band: "distant" });
    },
  );

  it.each([
    ["I step back from Wren.", "near"],
    ["I step away from her.", "near"],
    ["I pull away from Wren.", "near"],
    ["I walk away from her.", "distant"],
  ])("%s names who was left (%s)", (message, band) => {
    expect(depart(message)).toEqual({ targetSubject: WREN, band });
  });

  it.each([
    ["I don't step back.", "a denial"],
    ["Should I step away from her?", "a question"],
    ["Maybe I step back.", "a hedge"],
    ["I want to walk away.", "an intention"],
    ["I almost step back.", "a near miss"],
    ["She steps away from me.", "somebody else's body"],
    ["I step back and kiss her.", "romantic framing in the same sentence"],
  ])("%s produces no departure (%s)", (message) => {
    expect(depart(message)).toBeNull();
  });

  it("ignores narration that is not the player's own", () => {
    expect(detectChatDeparture({ message: "I step back.", narratorInput: true, characters: SOLO })).toBeNull();
    expect(depart('"I step back."')).toBeNull();
    expect(depart("*I step back.*")).toBeNull();
  });

  it("reads a departure from a forceful word, because refusing would strand the contact", () => {
    // Same argument as the release's: "pull away" is the plainest English for this,
    // and the restraint veto exists to stop contacts being MADE, not ended.
    expect(depart("I pull away from her.")).toEqual({ targetSubject: WREN, band: "near" });
    // It buys nothing on the commit side — a forceful touch still commits nothing.
    expect(touch("I grab your arm.")).toBeNull();
  });

  it("refuses a target it cannot resolve rather than departing from everyone", () => {
    // The sentence said WHAT it moved away from. Substituting "everyone" would be
    // this layer choosing whose contact ended.
    expect(depart("I step back from the desk.")).toBeNull();
    expect(depart("I step away from her.", PAIR)).toBeNull();
    expect(depart("I step away from Vaelith.", PAIR)).toEqual({ targetSubject: VAEL, band: "near" });
  });

  it("reads a possessed target as the furniture it is", () => {
    // "her desk" is a thing she owns, and ending her contacts because the player
    // backed off from it would be the possessive guard's failure in reverse.
    expect(depart("I step back from her desk.")).toBeNull();
    expect(depart("I step back from Wren's desk.")).toBeNull();
    // Clause-final still names the person, exactly as the approach guard has it.
    expect(depart("I step back from her, quiet.")).toEqual({ targetSubject: WREN, band: "near" });
  });

  it("reads a sentence that names somewhere to ARRIVE as an arrival", () => {
    // A destination outranks a departure WITHIN one sentence: otherwise the turn
    // would end her contacts on the way to standing next to her.
    expect(depart("I walk across the room to Wren.")).toBeNull();
    expect(depart("I lean back toward Wren.")).toBeNull();
    expect(approach("I walk across the room to Wren.")).toEqual({ targetSubject: WREN, band: "close" });
  });
});

describe("release and departure — a hand is not a body", () => {
  const depart = (message: string) => detectChatDeparture({ message, narratorInput: false, characters: SOLO });
  const release = (message: string) => detectChatContactRelease({ message, narratorInput: false, characters: SOLO });

  it.each(["I pull my hand back.", "I draw my hand away.", "I take my hand back.", "I slowly move my hand away."])(
    "%s releases WITHOUT departing",
    (message) => {
      // The ruling: a hand-only withdrawal ends the contact and states no distance.
      // Mechanically it is the adjacency — the direction word has to follow the verb.
      expect(release(message)).not.toBeNull();
      expect(depart(message)).toBeNull();
    },
  );

  it("a full-body pull-away departs, and is deliberately not ALSO a release", () => {
    // The departure already ends the same contacts and more, so adding this to the
    // release lexicon would compete over nothing but the recorded reason — and
    // `separated` is the truer one for a body that moved.
    expect(depart("I pull away.")).toEqual({ targetSubject: null, band: "near" });
    expect(release("I pull away.")).toBeNull();
    const held = holding(placedAmong(SOLO), "I rest my hand on your shoulder.", SOLO);
    const planned = planChatContactTurn({
      scene: held.scene,
      message: "I pull away.",
      narratorInput: false,
      characters: SOLO,
      eventRef: chatContactEventRef("msg_exchange_2"),
      storyTime: AT + 1,
    });
    expect(planned.ended.map((commit) => [commit.contactId, commit.reason])).toEqual([[held.contactId, "separated"]]);
  });

  it("a message that says both does both, release first, each with its own reason", () => {
    // Two sentences, because the detectors want a first-person subject beside the
    // verb: "I pull my hand back and step away" states its second clause with no
    // subject of its own, and both lexicons refuse a clause they cannot attribute.
    const mine = holding(placedAmong(SOLO), "I rest my hand on your shoulder.", SOLO);
    const hers = herHandOnMe(mine.scene);
    const planned = planChatContactTurn({
      scene: hers.scene,
      message: "I pull my hand back. I step away.",
      narratorInput: false,
      characters: SOLO,
      eventRef: chatContactEventRef("msg_exchange_2"),
      storyTime: AT + 1,
    });
    // The player's own hand comes back as `withdrawn`; what the departure still
    // finds — her hand on the player — ends as `separated`. Plan order, in the ends.
    expect(planned.ended.map((commit) => [commit.contactId, commit.reason])).toEqual([
      [mine.contactId, "withdrawn"],
      [hers.contactId, "separated"],
    ]);
    expect(planned.scene.contacts.contacts).toEqual([]);
    expect(sceneProximityFact(planned.scene, CHAT_CONTACT_PLAYER_SUBJECT, WREN)?.value).toBe("near");
  });
});

describe("applying a departure", () => {
  const depart = (scene: SceneState, departure: ChatDeparture, sink?: DiagnosticCollector) =>
    applyChatContactDeparture({
      scene,
      departure,
      eventRef: chatContactEventRef("msg_exchange_2"),
      storyTime: AT + 1,
      ...(sink === undefined ? {} : { sink }),
    });

  it("ends every contact the player is part of, reason `separated`", () => {
    const held = holding(placedAmong(SOLO), "I rest my hand on your shoulder.", SOLO);
    const sink = new DiagnosticCollector();
    const ends = depart(held.scene, { targetSubject: null, band: "near" }, sink);
    expect(ends.commits.map((commit) => commit.contactId)).toEqual([held.contactId]);
    expect(ends.commits[0]?.reason).toBe("separated");
    expect(ends.scene.contacts.contacts).toEqual([]);
    expect(sink.hasErrors).toBe(false);
  });

  it("ends a contact the CHARACTER is making, which a release may not touch", () => {
    // Either end, not just the player's own hand: her hand does not survive the
    // player walking away from her.
    const hers = herHandOnMe(placedAmong(SOLO));
    expect(depart(hers.scene, { targetSubject: WREN, band: "near" }).commits.map((c) => c.contactId)).toEqual([
      hers.contactId,
    ]);
    const released = applyChatContactRelease({
      scene: hers.scene,
      release: { targetSubject: null },
      eventRef: chatContactEventRef("msg_exchange_2"),
      storyTime: AT + 1,
    });
    expect(released.commits).toEqual([]);
  });

  it("ends only the named person's contacts, and an unnamed departure ends them all", () => {
    const first = holding(placedAmong(PAIR), "I rest my hand on Wren's shoulder.", PAIR);
    const second = holding(first.scene, "I rest my hand on Vaelith's arm.", PAIR, chatContactEventRef("msg_2"));
    const named = depart(second.scene, { targetSubject: WREN, band: "near" });
    expect(named.commits.map((commit) => commit.contactId)).toEqual([first.contactId]);
    expect(named.scene.contacts.contacts.map((contact) => contact.contactId)).toEqual([second.contactId]);

    const everyone = depart(second.scene, { targetSubject: null, band: "near" });
    expect(everyone.commits).toHaveLength(2);
    expect(everyone.scene.contacts.contacts).toEqual([]);
  });

  it("does nothing, quietly, when nothing was touching", () => {
    const scene = placedAmong(SOLO);
    const sink = new DiagnosticCollector();
    const ends = depart(scene, { targetSubject: null, band: "near" }, sink);
    expect(ends.commits).toEqual([]);
    expect(ends.scene).toBe(scene);
    expect(sink.items).toEqual([]);
  });

  it("absorbs a departure older than the contact it names (law 4)", () => {
    const held = holding(placedAmong(SOLO), "I rest my hand on your shoulder.", SOLO);
    const sink = new DiagnosticCollector();
    const ends = applyChatContactDeparture({
      scene: held.scene,
      departure: { targetSubject: null, band: "near" },
      eventRef: chatContactEventRef("msg_exchange_0"),
      storyTime: AT - 5,
      sink,
    });
    expect(ends.commits).toEqual([]);
    expect(ends.scene.contacts.contacts).toHaveLength(1);
    expect(sink.items.some((item) => item.severity === "warn")).toBe(true);
  });
});

describe("the departure's proximity law — never invent a distance", () => {
  const intents = (
    scene: SceneState,
    departure: ChatDeparture,
    characters: readonly ChatContactRosterMember[] = SOLO,
  ) =>
    chatDepartureSceneIntents(departure, {
      scene,
      characters: characters.map((entry) => entry.subjectId),
      player: CHAT_CONTACT_PLAYER_SUBJECT,
      ref: REF,
      storyTime: AT + 1,
    });

  it("says nothing at all about a pair nobody has placed", () => {
    // Stepping back from somebody the scene never placed tells us the player moved.
    // It does not tell us how far apart they are now, and a band here would be this
    // module inventing the one thing law 2 forbids it to.
    const scene = seeded();
    expect(intents(scene, { targetSubject: WREN, band: "near" })).toEqual([]);
    expect(intents(scene, { targetSubject: null, band: "distant" })).toEqual([]);
    expect(applySceneIntents(scene, intents(scene, { targetSubject: null, band: "near" })).state.proximity).toEqual([]);
  });

  it("widens a distance somebody stated, as the player's own claim", () => {
    const before = placedAmong(SOLO);
    const scene = applySceneIntents(before, intents(before, { targetSubject: WREN, band: "near" })).state;
    const fact = sceneProximityFact(scene, CHAT_CONTACT_PLAYER_SUBJECT, WREN);
    expect(fact?.value).toBe("near");
    expect(fact?.provenance.source).toBe("player_intent");
  });

  it("never makes the pair CLOSER than it already was", () => {
    // A `distant` pair does not become `near` because the player took a step back.
    const far = placedAmong(SOLO, "distant");
    expect(intents(far, { targetSubject: WREN, band: "near" })).toEqual([]);
    // The wider band over the same pair still lands.
    const close = placedAmong(SOLO, "close");
    expect(intents(close, { targetSubject: WREN, band: "distant" })).toHaveLength(1);
  });

  it("takes an active contact as proof they were close", () => {
    // A hand resting on a shoulder is proof of reach whether or not any movement
    // said so, so the distance it opens is a real claim rather than a guess.
    const held = holding(placedAmong(SOLO), "I rest my hand on your shoulder.", SOLO);
    const unplaced: SceneState = { ...held.scene, proximity: [] };
    const list = intents(unplaced, { targetSubject: WREN, band: "near" });
    expect(list).toHaveLength(1);
    expect(sceneProximityFact(applySceneIntents(unplaced, list).state, CHAT_CONTACT_PLAYER_SUBJECT, WREN)?.value).toBe(
      "near",
    );
  });

  it("moves only the player, and never turns them away", () => {
    const before = placedAmong(SOLO);
    const list = intents(before, { targetSubject: WREN, band: "distant" });
    expect(list.every((intent) => intent.subjectId === CHAT_CONTACT_PLAYER_SUBJECT)).toBe(true);
    expect(list.every((intent) => intent.origin === "player")).toBe(true);
    expect(list.every((intent) => intent.change.kind === "set_proximity")).toBe(true);
    // Stepping back is not turning away — only an explicit turn would be, and this
    // pass detects none, so the facing the approach wrote still stands.
    const scene = applySceneIntents(before, list).state;
    expect(sceneFacingFact(scene, CHAT_CONTACT_PLAYER_SUBJECT, WREN)?.value).toBe("toward");
  });

  it("an unnamed departure covers every PLACED pair, and only those", () => {
    const room = applySceneIntents(seeded(PAIR), [
      {
        intentId: "probe:proximity:wren",
        subjectId: CHAT_CONTACT_PLAYER_SUBJECT,
        origin: "player",
        change: { kind: "set_proximity", otherId: WREN, band: "close" },
        ref: REF,
        storyTime: AT,
        evidence: [affordanceEvidence("adapter", "probe")],
      },
    ]).state;
    const list = intents(room, { targetSubject: null, band: "near" }, PAIR);
    expect(list).toHaveLength(1);
    const scene = applySceneIntents(room, list).state;
    expect(sceneProximityFact(scene, CHAT_CONTACT_PLAYER_SUBJECT, WREN)?.value).toBe("near");
    // Vaelith is in the room, and nobody has ever said how far away she is.
    expect(sceneProximityFact(scene, CHAT_CONTACT_PLAYER_SUBJECT, VAEL)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The actor-generic band laws
// ---------------------------------------------------------------------------

describe("the approach band law — nearer only, and a contact outranks a sentence", () => {
  it("creates a FIRST fact for a pair nobody placed", () => {
    // Unlike a departure, an approach on an unplaced pair is not a guess: the
    // admitted evidence states where the body ended up, and the congruence gate
    // already proved the band.
    expect(approachedBand(seeded(), WREN, CHAT_CONTACT_PLAYER_SUBJECT, "close")).toBe("close");
    expect(approachedBand(seeded(), WREN, CHAT_CONTACT_PLAYER_SUBJECT, "touching")).toBe("touching");
  });

  it("replaces a standing fact only with a STRICTLY nearer band", () => {
    const near = placed("near");
    expect(approachedBand(near, WREN, CHAT_CONTACT_PLAYER_SUBJECT, "close")).toBe("close");
    const close = placed("close");
    // Equal is a no-op, not a restatement handed to the ordering law.
    expect(approachedBand(close, WREN, CHAT_CONTACT_PLAYER_SUBJECT, "close")).toBeNull();
    expect(approachedBand(close, WREN, CHAT_CONTACT_PLAYER_SUBJECT, "touching")).toBe("touching");
  });

  it("never downgrades a pair the scene already calls `touching`", () => {
    const touching = placed("touching");
    expect(approachedBand(touching, WREN, CHAT_CONTACT_PLAYER_SUBJECT, "close")).toBeNull();
    expect(approachedBand(touching, WREN, CHAT_CONTACT_PLAYER_SUBJECT, "touching")).toBeNull();
  });

  it("counts an active contact as effective `touching`, whatever the facts say", () => {
    // A hand on a shoulder is stronger evidence of distance than any sentence
    // about walking over: an approach may never demote a live touch to `close`.
    const held = holding(placedAmong(SOLO), "I rest my hand on your shoulder.", SOLO);
    const unplaced: SceneState = { ...held.scene, proximity: [] };
    expect(approachedBand(unplaced, WREN, CHAT_CONTACT_PLAYER_SUBJECT, "close")).toBeNull();
    expect(approachedBand(unplaced, WREN, CHAT_CONTACT_PLAYER_SUBJECT, "touching")).toBeNull();
    // …and the same holds when the standing fact is stale and further out.
    expect(approachedBand(held.scene, WREN, CHAT_CONTACT_PLAYER_SUBJECT, "close")).toBeNull();
  });
});

describe("the departure band law is actor-generic — the same helper serves both lanes", () => {
  it("says nothing about a pair with neither a fact nor a contact", () => {
    expect(departedBand(seeded(), WREN, CHAT_CONTACT_PLAYER_SUBJECT, "near")).toBeNull();
    expect(departedBand(seeded(), WREN, CHAT_CONTACT_PLAYER_SUBJECT, "distant")).toBeNull();
  });

  it("widens a standing fact and never narrows one", () => {
    expect(departedBand(placed("close"), WREN, CHAT_CONTACT_PLAYER_SUBJECT, "near")).toBe("near");
    expect(departedBand(placed("distant"), WREN, CHAT_CONTACT_PLAYER_SUBJECT, "near")).toBeNull();
    expect(departedBand(placed("near"), WREN, CHAT_CONTACT_PLAYER_SUBJECT, "near")).toBeNull();
  });

  it("takes an active contact as proof an unplaced pair was touching", () => {
    const held = holding(placedAmong(SOLO), "I rest my hand on your shoulder.", SOLO);
    const unplaced: SceneState = { ...held.scene, proximity: [] };
    expect(departedBand(unplaced, WREN, CHAT_CONTACT_PLAYER_SUBJECT, "distant")).toBe("distant");
  });
});

describe("the NPC movement intent builder", () => {
  const build = (
    kind: "approach" | "depart",
    band: SceneProximityBand,
    facing: "toward" | null,
  ): readonly SceneMovementIntent[] =>
    npcMovementSceneIntents({
      kind,
      actor: WREN,
      counterpart: CHAT_CONTACT_PLAYER_SUBJECT,
      band,
      facing,
      ref: REF,
      storyTime: AT + 1,
    });

  it("moves the NPC's OWN body, NPC-origin — never the player's", () => {
    const intents = build("approach", "close", null);
    expect(intents.every((intent) => intent.subjectId === WREN)).toBe(true);
    expect(intents.every((intent) => intent.origin === "npc")).toBe(true);
    const scene = applySceneIntents(placedAmong(SOLO, "near"), intents).state;
    expect(sceneProximityFact(scene, WREN, CHAT_CONTACT_PLAYER_SUBJECT)?.value).toBe("close");
    expect(sceneProximityFact(scene, WREN, CHAT_CONTACT_PLAYER_SUBJECT)?.provenance.source).toBe("npc_decision");
  });

  it("writes facing ONLY when the candidate proposed it", () => {
    expect(build("approach", "close", null).map((intent) => intent.change.kind)).toEqual(["set_proximity"]);
    expect(build("approach", "close", "toward").map((intent) => intent.change.kind)).toEqual([
      "set_proximity",
      "set_facing",
    ]);
  });

  it("backing into place changes proximity without changing facing", () => {
    // A departure never turns a body: `facing` is ignored outright on that side,
    // so even a caller that passed one cannot make an NPC look away.
    expect(build("depart", "near", "toward").map((intent) => intent.change.kind)).toEqual(["set_proximity"]);
    const before = applySceneIntents(placedAmong(SOLO, "close"), build("approach", "close", "toward")).state;
    expect(sceneFacingFact(before, WREN, CHAT_CONTACT_PLAYER_SUBJECT)?.value).toBe("toward");
    const after = applySceneIntents(before, build("depart", "near", null)).state;
    expect(sceneProximityFact(after, WREN, CHAT_CONTACT_PLAYER_SUBJECT)?.value).toBe("near");
    expect(sceneFacingFact(after, WREN, CHAT_CONTACT_PLAYER_SUBJECT)?.value).toBe("toward");
  });

  it("gives two NPCs distinct intent ids under ONE reply event ref", () => {
    const hers = npcMovementSceneIntents({
      kind: "approach",
      actor: WREN,
      counterpart: CHAT_CONTACT_PLAYER_SUBJECT,
      band: "close",
      facing: null,
      ref: REF,
      storyTime: AT,
    });
    const theirs = npcMovementSceneIntents({
      kind: "approach",
      actor: VAEL,
      counterpart: CHAT_CONTACT_PLAYER_SUBJECT,
      band: "close",
      facing: null,
      ref: REF,
      storyTime: AT,
    });
    expect(hers[0]?.intentId).not.toBe(theirs[0]?.intentId);
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

  it("departs BEFORE it approaches, so a step back and a walk over land where they were written", () => {
    // Two sentences, one message, in the order the player wrote them: the departure
    // widens the distance and ends the touch, and the approach that FOLLOWS it
    // re-establishes `close` over the top. Reversed, the player would end the turn a
    // step away from somebody they had just walked up to.
    const held = holding(placedAmong(SOLO), "I rest my hand on your shoulder.", SOLO);
    const planned = planChatContactTurn({
      scene: held.scene,
      message: "I step back. I walk over to Wren.",
      narratorInput: false,
      characters: SOLO,
      eventRef: chatContactEventRef("msg_exchange_2"),
      storyTime: AT + 1,
    });
    expect(planned.ended.map((commit) => [commit.contactId, commit.reason])).toEqual([[held.contactId, "separated"]]);
    expect(sceneProximityFact(planned.scene, CHAT_CONTACT_PLAYER_SUBJECT, WREN)?.value).toBe("close");
    expect(planned.scene.contacts.contacts).toEqual([]);
  });

  it("folds a departure into the planned scene, and the touch after it cannot reach", () => {
    const held = holding(placedAmong(SOLO), "I rest my hand on your shoulder.", SOLO);
    const planned = planChatContactTurn({
      scene: held.scene,
      message: "I step back. I rest my hand on her shoulder.",
      narratorInput: false,
      characters: SOLO,
      eventRef: chatContactEventRef("msg_exchange_2"),
      storyTime: AT + 1,
    });
    expect(planned.ended.map((commit) => commit.reason)).toEqual(["separated"]);
    expect(sceneProximityFact(planned.scene, CHAT_CONTACT_PLAYER_SUBJECT, WREN)?.value).toBe("near");
    // Detected, and refused: `near` is one reposition away, and the scene says so
    // rather than letting the hand cross the gap the player just opened.
    expect(planned.act).not.toBeNull();
    expect(planned.resolution?.status).toBe("explicit_transition_required");
    expect(planned.commit).toBeNull();
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

// ---------------------------------------------------------------------------
// The reach premise (S3)
// ---------------------------------------------------------------------------

describe("the unresolved premise — the reasons that earn a presentation fence", () => {
  /** The plan for one line over one scene — the premise's whole input surface. */
  function planned(scene: SceneState, message: string, characters: readonly ChatContactRosterMember[] = SOLO) {
    const plan = planChatContactTurn({ scene, message, narratorInput: false, characters, eventRef: EVENT, storyTime: AT });
    return {
      plan,
      premise: chatContactUnresolvedPremise({ act: plan.act, resolution: plan.resolution, characters }),
    };
  }

  const TOUCH = "I rest my hand on your shoulder.";

  it("(1) unknown reach: the premise carries the target and surface, and the state stays untouched", () => {
    const { plan, premise } = planned(seeded(), TOUCH);
    expect(plan.resolution?.status).toBe("unresolved");
    if (plan.resolution?.status !== "unresolved") return;
    expect(plan.resolution.reason).toBe("geometry_unavailable");
    // The premise exists, names the resolved target, and words the surface.
    expect(premise).toEqual({ kind: "reach", targetName: "Wren", locus: "shoulder" });
    // The underlying result is untouched: no commit, no ends.
    expect(plan.commit).toBeNull();
    expect(plan.ended).toEqual([]);
  });

  it("(2) a same-turn valid approach establishes reach — no premise, and the touch can commit", () => {
    const { plan, premise } = planned(seeded(), `I walk over to Wren. ${TOUCH}`);
    expect(plan.commit?.status).toBe("committed");
    expect(premise).toBeNull();
  });

  it("(3) previously established reachable geometry produces no false premise", () => {
    const { plan, premise } = planned(placed("close"), TOUCH);
    expect(plan.commit?.status).toBe("committed");
    expect(premise).toBeNull();
  });

  it("(4) KNOWN out-of-reach keeps its typed refusal — never degraded to 'unknown'", () => {
    const far = planned(placed("distant"), TOUCH);
    expect(far.plan.resolution?.status).toBe("rejected");
    if (far.plan.resolution?.status === "rejected") expect(far.plan.resolution.reason).toBe("out_of_reach");
    expect(far.premise).toBeNull();

    const near = planned(placed("near"), TOUCH);
    expect(near.plan.resolution?.status).toBe("explicit_transition_required");
    expect(near.premise).toBeNull();
  });

  it("(5) material unavailable with reach established is NOT mislabeled as a reach problem", () => {
    const dressed = [member(WREN, "Wren", [], adapterUnavailable)];
    const { plan, premise } = planned(placed("close"), TOUCH, dressed);
    expect(plan.resolution?.status).toBe("unresolved");
    if (plan.resolution?.status === "unresolved") expect(plan.resolution.reason).toBe("material_unavailable");
    expect(premise).toBeNull();
  });

  it.each([
    ["romantic framing", "I kiss your shoulder."],
    ["forceful framing", "I grab your shoulder."],
    ["a hedge", "I want to rest my hand on your shoulder."],
    ["a negation", "I don't rest my hand on your shoulder."],
    ["a perfect negation", "I haven't ever rested my hand on your shoulder."],
    ["a curly-apostrophe conditional denial", "I wouldn’t rest my hand on your shoulder."],
    ["an apostrophe-free conditional denial", "I wouldnt rest my hand on your shoulder."],
    ["a state denial", "I wasn't resting my hand on your shoulder."],
    ["a hypothetical", "Maybe I rest my hand on your shoulder."],
    ["a question", "Do I rest my hand on your shoulder?"],
  ])("(6) %s stays vetoed and earns no premise", (_label, message) => {
    const { plan, premise } = planned(seeded(), message);
    expect(plan.act).toBeNull();
    expect(premise).toBeNull();
  });

  it("(6) narrator-mode input is excluded and earns no premise", () => {
    const plan = planChatContactTurn({
      scene: seeded(),
      message: TOUCH,
      narratorInput: true,
      characters: SOLO,
      eventRef: EVENT,
      storyTime: AT,
    });
    expect(plan.act).toBeNull();
    expect(chatContactUnresolvedPremise({ act: plan.act, resolution: plan.resolution, characters: SOLO })).toBeNull();
  });

  it("words the surface only when the lexicon can — an unwordable locus still names the target", () => {
    // Directly-shaped inputs: an unresolved geometry answer for a locus with no
    // lexicon phrase must not sink the premise with it.
    const act = touch(TOUCH);
    if (act === null) throw new Error("fixture: the touch must detect");
    const premise = chatContactUnresolvedPremise({
      act: { ...act, targetLocationId: "collarbone" },
      resolution: { status: "unresolved", reason: "geometry_unavailable", evidence: [] },
      characters: SOLO,
    });
    expect(premise).toEqual({ kind: "reach", targetName: "Wren" });
  });

  /**
   * The 2026-08-18 romantic proof's headline finding: with no permission on
   * record the resolver correctly commits nothing, but `unresolved` renders no
   * narrator line, so the reply still described the caress as landing.
   *
   * Kills the two implementations that look right and are not: reusing the
   * reach premise for it (which would tell the narrator reach is unknown when
   * the two are standing together), and leaving it unmapped (the shipped
   * behaviour — silence, and prose that invents the landing).
   */
  it("an unanswered permission owner earns its OWN premise, not the reach one", () => {
    const act = touch(TOUCH);
    if (act === null) throw new Error("fixture: the touch must detect");
    expect(
      chatContactUnresolvedPremise({
        act,
        resolution: { status: "unresolved", reason: "permission_unresolved", evidence: [] },
        characters: SOLO,
      }),
    ).toEqual({ kind: "permission", targetName: "Wren", locus: "shoulder" });
  });

  /**
   * The selection rule itself. Every OTHER unresolved reason still renders
   * nothing, so widening the premise seam cannot quietly start narrating gaps
   * whose wording nobody chose.
   */
  it.each([
    ["material_unavailable"],
    ["support_unavailable"],
    ["actor_control_unresolved"],
    ["target_agency_unresolved"],
  ] as const)("%s earns no premise — an unlisted reason is still silence", (reason) => {
    const act = touch(TOUCH);
    if (act === null) throw new Error("fixture: the touch must detect");
    expect(
      chatContactUnresolvedPremise({
        act,
        resolution: { status: "unresolved", reason, evidence: [] },
        characters: SOLO,
      }),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Scene discontinuities (owner ruling 2026-08-04)
// ---------------------------------------------------------------------------

/**
 * Proximity and facing are valid only during CONTINUOUS CO-PRESENCE in one
 * place. Three discontinuities break it — a member going away, the place
 * changing, an explicit story-clock skip — and each already ends the active
 * contacts, so keeping the distance across them is internally contradictory.
 * The ordinary per-turn clock tick is NOT one of the three.
 */
describe("scene discontinuities clear pair relations", () => {
  it("clears EVERY pair when the place changes or the clock skips", () => {
    const before = placed("touching");
    expect(before.proximity).toHaveLength(1);
    const after = chatSceneAfterDiscontinuity(before, { wholeScene: true, awaySubjects: [] });
    expect(after.proximity).toEqual([]);
    expect(after.facing).toEqual([]);
    // Cleared means UNKNOWN — never a substituted band. `distant` would be this
    // layer deciding how far away the next room is.
    expect(sceneProximityFact(after, CHAT_CONTACT_PLAYER_SUBJECT, WREN)).toBeUndefined();
  });

  it("clears only the departing member's relations when one body leaves", () => {
    // Two characters placed against the player; only Wren leaves.
    const both = placedAmong(PAIR, "near");
    const after = chatSceneAfterDiscontinuity(both, { wholeScene: false, awaySubjects: [WREN] });
    expect(sceneProximityFact(after, CHAT_CONTACT_PLAYER_SUBJECT, WREN)).toBeUndefined();
    // Vaelith did not move because somebody else walked out.
    expect(sceneProximityFact(after, CHAT_CONTACT_PLAYER_SUBJECT, VAEL)?.value).toBe("near");
  });

  it("leaves the scene untouched on an ordinary clock tick", () => {
    const before = placed("close");
    // No discontinuity at all — minutes passing inside one continuous scene is
    // what a conversation IS, and clearing on it would make reach permanently
    // unknown. Identity by REFERENCE, so nothing churns the projection either.
    expect(chatSceneAfterDiscontinuity(before, { wholeScene: false, awaySubjects: [] })).toBe(before);
  });

  it("is idempotent, so re-entry does not resurrect the old distance", () => {
    const gone = chatSceneAfterDiscontinuity(placed("close"), { wholeScene: false, awaySubjects: [WREN] });
    // She is still away next exchange: nothing left to drop, and the band stays
    // unknown until explicit movement states a new one.
    const again = chatSceneAfterDiscontinuity(gone, { wholeScene: false, awaySubjects: [WREN] });
    expect(again).toBe(gone);
    // And simply being present again places no distance — a returning body is
    // seeded, and seeding never invents proximity.
    const returned = seededChatScene(again, {
      player: CHAT_CONTACT_PLAYER_SUBJECT,
      characters: [WREN],
      ref: REF,
      storyTime: AT + 30,
    });
    expect(sceneProximityFact(returned, CHAT_CONTACT_PLAYER_SUBJECT, WREN)).toBeUndefined();
  });

  it("keeps the bodies themselves placed — this repair only touches pair facts", () => {
    const after = chatSceneAfterDiscontinuity(placed("touching"), { wholeScene: true, awaySubjects: [] });
    expect(sceneParticipant(after, WREN)?.control?.value).toBe("npc_controlled");
    expect(sceneParticipant(after, CHAT_CONTACT_PLAYER_SUBJECT)?.posture).toBeDefined();
  });
});


// ---------------------------------------------------------------------------
// The romantic action producer
// (the first genuinely romantic contact proof)
// ---------------------------------------------------------------------------

const ROMANTIC_BRANCH = "chat_probe_branch";

function romantic(message: string, characters: readonly ChatContactRosterMember[] = SOLO): ChatContactAct | null {
  return detectChatRomanticTouch({ message, narratorInput: false, characters, eventRef: EVENT });
}

/** The shipped producer WITH a permission owner available. */
function anyAct(message: string, characters: readonly ChatContactRosterMember[] = SOLO): ChatContactAct | null {
  return detectChatContactAct({ message, narratorInput: false, characters, eventRef: EVENT, romanticEnabled: true });
}

/** The shipped producer with NO permission owner — today's live flag state. */
function ownerlessAct(
  message: string,
  characters: readonly ChatContactRosterMember[] = SOLO,
): ChatContactAct | null {
  return detectChatContactAct({ message, narratorInput: false, characters, eventRef: EVENT });
}

function grantEvent(overrides: Partial<RomanticPermissionEvent> = {}): RomanticPermissionEvent {
  return probePermissionEvent({
    branchId: ROMANTIC_BRANCH,
    permittedActorId: CHAT_CONTACT_PLAYER_SUBJECT,
    grantingTargetId: WREN,
    scope: "romantic_touch",
    kind: "granted",
    storyTime: AT - 10,
    ...overrides,
  });
}

/**
 * The REAL permission seam, assembled exactly as `chat-pipeline.ts` assembles
 * it: real events, the real fold, the real derive. A stubbed policy read would
 * prove the resolver reads a field; this proves the owner answers an attempt.
 */
function permissionPolicyFor(events: readonly RomanticPermissionEvent[]): ChatContactPolicySource {
  const projection = foldRomanticPermissionProjection({ events });
  return (attempt) =>
    derivePermissionPolicyRead({
      projection,
      permittedActorId: attempt.permittedActorId,
      grantingTargetId: attempt.grantingTargetId,
      actionKind: attempt.actionKind,
      playerSubjectId: CHAT_CONTACT_PLAYER_SUBJECT,
      attemptActionId: attempt.actionId,
    });
}

function resolveAct(act: ChatContactAct, permissionPolicy?: ChatContactPolicySource, scene: SceneState = placed("touching")) {
  return resolveChatContactAttempt({
    scene,
    act,
    material: chatContactMaterialBetween([{ side: "target", material: BARE, locationId: act.targetLocationId }]),
    control: "player_controlled",
    storyTime: AT,
    ...(permissionPolicy === undefined ? {} : { permissionPolicy }),
  });
}

describe("the romantic producer — admitted evidence", () => {
  it.each([
    ["I caress your arm.", "caress", "arms"],
    ["I stroke your hair.", "stroke", "hair"],
    ["I cup your hands in mine.", "cup", "hands"],
    ["I slowly caress your shoulder.", "caress", "shoulders"],
    ["I stroke your upper back.", "stroke", "back"],
    ["I cup your cheek.", "cup", "face"],
    ["I cup your face.", "cup", "face"],
    ["I cup your hands in mine.", "cup", "hands"],
    ["I gently caress your arm.", "caress", "arms"],
  ])("%s is a romantic %s on %s", (message, gesture, locationId) => {
    const act = romantic(message);
    expect(act).not.toBeNull();
    expect(act?.actionKind).toBe("romantic");
    expect(act?.gesture).toBe(gesture);
    expect(act?.targetLocationId).toBe(locationId);
    // The acting surface is the same one the whole lane models.
    expect(act?.sourceLocationId).toBe("hands");
    expect(act?.actorSubject).toBe(CHAT_CONTACT_PLAYER_SUBJECT);
  });

  it("names the character the sentence named, not the only one in the room", () => {
    const act = romantic("I caress Vaelith's arm.", PAIR);
    expect(act?.targetSubject).toBe(VAEL);
  });
});

describe("the romantic producer — everything it refuses", () => {
  it.each([
    ["I kiss your shoulder.", "kissing"],
    ["I caress your thigh.", "an intimate target"],
    ["I caress your breast.", "intimate anatomy"],
    ["I stroke your neck.", "a locus off the allow-list"],
    ["I caress your bare arm.", "an adjective between the owner and the locus"],
    ["I undress you.", "undressing"],
    ["I caress your arm?", "a question"],
    ["I would caress your arm.", "a hedge"],
    ["I almost caress your arm.", "a hedge"],
    ["I want to caress your arm.", "an intention"],
    ["I don't caress your arm.", "a denial"],
    ["I trace my fingers along your arm.", "a verb outside the closed family"],
    ["I glide my hand down your arm.", "a verb outside the closed family"],
    ["I fondle your arm.", "a verb outside the closed family"],
    ["I nuzzle your shoulder.", "a verb outside the closed family"],
    ["She caresses my arm.", "an NPC as the actor"],
  ])("%s produces nothing (%s)", (message) => {
    expect(romantic(message)).toBeNull();
  });

  it("refuses an ambiguous pronoun when more than one body could be meant", () => {
    expect(romantic("I caress her arm.", PAIR)).toBeNull();
    // The same line is unambiguous with one character present.
    expect(romantic("I caress her arm.", SOLO)).not.toBeNull();
  });

  it("ignores storyteller narration and non-narration spans", () => {
    expect(
      detectChatRomanticTouch({ message: "I caress your arm.", narratorInput: true, characters: SOLO, eventRef: EVENT }),
    ).toBeNull();
    expect(romantic('"I caress your arm."')).toBeNull();
    expect(romantic("((I caress your arm))")).toBeNull();
  });
});

/**
 * Approach and romantic touch in ONE message, written as two sentences.
 *
 * The shape every romantic case has to use, because the producer is anchored to
 * the whole sentence and the scene does not remember a walk across the room from
 * one turn to the next. So "I walk over to Sabrina and I caress Sabrina's arm"
 * — one sentence with a leading clause — commits nothing at all, while the same
 * content split at the full stop closes the distance AND lands the act.
 *
 * The distinction is worth a test of its own because both readings look correct
 * in prose and only one produces anything, and the failure is silent: the turn
 * resolves to nothing, which is indistinguishable from a refusal unless somebody
 * checks the act was built. (The romantic rollout rerun sends exactly these two
 * shapes — `scripts/trial/romantic-contact/`. Its case lines are its own; the
 * workspace boundary keeps the two apart, and its runner refuses to continue
 * when a case that must produce an act produces none.)
 */
describe("closing the distance and touching in one message", () => {
  const SABRINA = affordanceSubjectId("char_sabrina");
  const ROSTER = [member(SABRINA, "Sabrina Vale")];
  const romantic = (message: string) =>
    detectChatRomanticTouch({ message, narratorInput: false, characters: ROSTER, eventRef: EVENT });

  it.each([
    ["I walk over to Sabrina. I caress Sabrina's arm.", "a name in both sentences"],
    ["I step closer to you. I caress your arm.", "a pronoun, sole character present"],
  ])("%s produces the act (%s)", (message) => {
    expect(romantic(message)?.actionKind).toBe("romantic");
    expect(detectChatApproach({ message, narratorInput: false, characters: ROSTER })).toEqual({
      targetSubject: SABRINA,
      band: "close",
    });
  });

  it("the same content in ONE sentence produces nothing — the trailing clause refuses it", () => {
    expect(romantic("I walk over to Sabrina and I caress Sabrina's arm.")).toBeNull();
  });
});

describe("the never-degrade law — a refused romantic line is not an affectionate one", () => {
  it("never relabels an admitted romantic act as affectionate", () => {
    expect(anyAct("I caress your arm.")?.actionKind).toBe("romantic");
    expect(anyAct("I stroke your hair.")?.actionKind).toBe("romantic");
  });

  it("leaves the affectionate detector's own answers untouched", () => {
    // The affectionate producer still refuses every romantic verb, exactly as
    // it did before the romantic lane existed.
    expect(touch("I caress your arm.")).toBeNull();
    expect(touch("I stroke your hair.")).toBeNull();
    expect(touch("I rest my hand on your shoulder.")?.actionKind).toBe("affectionate");
  });
});

describe("the one producer — first eligible sentence wins, whichever kind it is", () => {
  it("keeps written order when the affectionate sentence comes first", () => {
    const act = anyAct("I rest my hand on your shoulder. I caress your arm.");
    expect(act?.actionKind).toBe("affectionate");
    expect(act?.targetLocationId).toBe("shoulders");
  });

  it("keeps written order when the romantic sentence comes first", () => {
    const act = anyAct("I caress your arm. I rest my hand on your shoulder.");
    expect(act?.actionKind).toBe("romantic");
    expect(act?.targetLocationId).toBe("arms");
  });

  it("still admits a later affectionate sentence when an earlier one was vetoed whole", () => {
    // The kiss sentence is refused by both gates; the shoulder is untouched by it.
    const act = anyAct("I kiss you. I rest my hand on your shoulder.");
    expect(act?.actionKind).toBe("affectionate");
  });

  it("produces exactly one act per turn", () => {
    const act = anyAct("I caress your arm. I stroke your hair. I caress your back.");
    expect(act?.targetLocationId).toBe("arms");
  });
});

describe("the permission proof — the owner finally has an attempt to answer", () => {
  it("commits a physically valid romantic touch when the exact directional grant exists", () => {
    const act = anyAct("I caress your arm");
    expect(act?.actionKind).toBe("romantic");
    const resolution = resolveAct(act!, permissionPolicyFor([grantEvent()]));
    expect(resolution.status).toBe("committable");
  });

  it("refuses with NO grant at all — unresolved, never a silent allow", () => {
    const act = anyAct("I caress your arm")!;
    const resolution = resolveAct(act, permissionPolicyFor([]));
    expect(resolution.status).toBe("unresolved");
    expect(resolution.status === "unresolved" && resolution.reason).toBe("permission_unresolved");
  });

  it("refuses a REVERSE-direction grant — the NPC allowing herself says nothing", () => {
    const reversed = grantEvent({ permittedActorId: WREN, grantingTargetId: CHAT_CONTACT_PLAYER_SUBJECT });
    const act = anyAct("I caress your arm")!;
    const resolution = resolveAct(act, permissionPolicyFor([reversed]));
    expect(resolution.status).toBe("unresolved");
  });

  it("refuses a grant naming a DIFFERENT target", () => {
    const act = anyAct("I caress your arm")!;
    const resolution = resolveAct(act, permissionPolicyFor([grantEvent({ grantingTargetId: VAEL })]));
    expect(resolution.status).toBe("unresolved");
  });

  it("refuses once the grant is WITHDRAWN", () => {
    const events = [grantEvent(), grantEvent({ kind: "withdrawn", storyTime: AT - 5 })];
    const act = anyAct("I caress your arm")!;
    const resolution = resolveAct(act, permissionPolicyFor(events));
    expect(resolution.status).toBe("rejected");
    expect(resolution.status === "rejected" && resolution.reason).toBe("permission_withdrawn");
  });

  it("refuses the exact attempt a denial named, without deleting the standing grant", () => {
    const act = anyAct("I caress your arm")!;
    const denial = grantEvent({ kind: "attempt_denied", storyTime: AT - 5, attemptActionId: act.actionId });
    const resolution = resolveAct(act, permissionPolicyFor([grantEvent(), denial]));
    expect(resolution.status).toBe("rejected");
    expect(resolution.status === "rejected" && resolution.reason).toBe("permission_denied");

    // A DIFFERENT attempt in the same direction still rides the standing grant.
    const other = detectChatContactAct({
      message: "I caress your back",
      narratorInput: false,
      characters: SOLO,
      eventRef: chatContactEventRef("msg_exchange_2"),
      romanticEnabled: true,
    })!;
    expect(resolveAct(other, permissionPolicyFor([grantEvent(), denial])).status).toBe("committable");
  });

  it("fails closed when no permission owner is wired at all (the flag-off path)", () => {
    const act = anyAct("I caress your arm")!;
    const resolution = resolveAct(act, undefined);
    expect(resolution.status).toBe("unresolved");
    expect(resolution.status === "unresolved" && resolution.reason).toBe("permission_unresolved");
  });

  it("leaves affectionate contact permission-neutral, grant or no grant", () => {
    const act = anyAct("I rest my hand on your shoulder")!;
    expect(act.actionKind).toBe("affectionate");
    expect(resolveAct(act, permissionPolicyFor([])).status).toBe("committable");
    expect(resolveAct(act, undefined).status).toBe("committable");
  });

  it("keeps permission orthogonal to physical feasibility", () => {
    // A granted romantic touch across the room is still out of reach: the owner
    // makes an attempt eligible, never possible.
    const act = anyAct("I caress your arm")!;
    const resolution = resolveAct(act, permissionPolicyFor([grantEvent()]), placed("distant"));
    expect(resolution.status).not.toBe("committable");
  });
});

describe("the romantic narrator seam", () => {
  // Kills a producer that can commit an act the renderer cannot word: a gesture
  // or refusal with no lexicon entry silently drops its clause, so the prompt
  // states a contact without saying what kind it was.
  it("words every code the romantic lane can emit", () => {
    for (const gesture of chatRomanticContactGestures) {
      expect(chatContactPhrase(`contact.gesture.${gesture}`)?.kind).toBe("gesture");
    }
    for (const reason of ["permission_denied", "permission_withdrawn", "permission_scope_missing"]) {
      expect(chatContactPhrase(`contact.blocked.${reason}`)?.kind).toBe("blocked");
    }
    expect(chatContactPhrase("contact.locus.face")?.kind).toBe("locus");
  });

  it("never exposes the permission record itself", () => {
    for (const code of [
      "contact.blocked.permission_denied",
      "contact.blocked.permission_withdrawn",
      "contact.blocked.permission_scope_missing",
    ]) {
      const phrase = chatContactPhrase(code)?.phrase ?? "";
      expect(phrase).not.toMatch(/permission|grant|ledger|scope|romantic_touch/iu);
    }
  });
});

describe("the owner gate — no permission owner, no romantic act at all", () => {
  it("produces nothing romantic when no owner is wired", () => {
    expect(ownerlessAct("I caress your arm.")).toBeNull();
    expect(ownerlessAct("I stroke your hair.")).toBeNull();
    expect(ownerlessAct("I cup your hands.")).toBeNull();
  });

  it("does not let a romantic sentence cost a later affectionate one its slot", () => {
    // THE REGRESSION THIS GATE EXISTS FOR. With the permission flag off, the
    // shoulder touch is what the lane committed before the romantic producer
    // existed, and it must still commit: a romantic act nobody can authorize
    // must not silently consume the turn's single act slot.
    const act = ownerlessAct("I stroke your hair. I rest my hand on your shoulder.");
    expect(act?.actionKind).toBe("affectionate");
    expect(act?.targetLocationId).toBe("shoulders");

    const second = ownerlessAct("I caress your arm. I pat your head.");
    expect(second?.actionKind).toBe("affectionate");
    expect(second?.gesture).toBe("pat");
  });

  it("matches the affectionate-only detector exactly on every ordinary message", () => {
    for (const message of [
      "I rest my hand on your shoulder.",
      "I pat your head.",
      "I squeeze your hand.",
      "I stroke your hair. I rest my hand on your shoulder.",
      "I caress your arm. I pat your head.",
      "I kiss you. I rest my hand on your shoulder.",
      "I walk over to you.",
      "I caress your arm.",
    ]) {
      expect(ownerlessAct(message)).toEqual(touch(message));
    }
  });

  it("admits the romantic act once an owner is available", () => {
    expect(anyAct("I caress your arm.")?.actionKind).toBe("romantic");
    // And THEN it may outrank a later affectionate sentence, which is correct:
    // refusing the romantic act and quietly doing the milder one instead is the
    // degrade this lane forbids.
    expect(anyAct("I stroke your hair. I rest my hand on your shoulder.")?.actionKind).toBe("romantic");
  });
});

describe("the whole-sentence boundary — an admitted act is the entire sentence", () => {
  // These are refused by SHAPE, not by a list of forbidden words. An earlier
  // deny-list revision leaked 75 of 86 adversarial probes across exactly these
  // families while over-firing on ordinary prose; anchoring closes the whole set
  // at once and never has to be extended for a wording nobody enumerated.
  it.each([
    // One case per SHAPE, not per forbidden word: with the act anchored to the
    // whole sentence these all fail identically, so enumerating more vocabulary
    // would buy no additional defect detection.
    ["I caress your arm and we make love.", "a trailing clause"],
    ["I caress your arm and touch your privates.", "a trailing clause naming anatomy"],
    ["I stroke your hair and tear off your shirt.", "a trailing clause undressing"],
    ["I caress your arm and hogtie you.", "a trailing clause restraining"],
    ["I caress your arm, taking off your dress.", "a trailing participial clause"],
    ["Later I chain you to the bed and I caress your arm.", "a leading clause"],
  ])("%s produces nothing (%s)", (message) => {
    expect(romantic(message)).toBeNull();
    expect(anyAct(message)).toBeNull();
  });

  it("pays that boundary's cost in the safe direction only", () => {
    // Ordinary romantic prose carrying a second clause commits nothing. A
    // refusal where a commit was arguably fine — never the reverse.
    for (const message of [
      "I caress your arm until you smile.",
      "I caress your arm and lift my eyes to yours.",
      "I stroke your hair and blow out the candle.",
    ]) {
      expect(anyAct(message)).toBeNull();
    }
  });

  it.each([
    // Restraint the shared regex never named.
    "I stroke your arm and tie your wrists.",
    "I stroke your arm and bind your hands.",
    "I stroke your arm and handcuff you.",
    "I stroke your arm and gag you.",
    "I stroke your arm and choke you.",
    // Garment removal beyond the un- prefixes.
    "I stroke your arm and unbuckle your belt.",
    "I stroke your arm and untie your robe.",
    "I caress your hair and unlace your corset.",
    "I caress your arm and remove your bra.",
    "I stroke your arm and peel off your top.",
    "I caress your arm and lift your skirt.",
    // Explicit sexual acts.
    "I caress your arm and finger you.",
    "I stroke your arm and we have sex.",
    "I cup your hands and cum on them.",
    "I stroke your arm and press my erection against you.",
    "I stroke your arm as I rape you.",
    // Intimate anatomy the shared target list misses.
    "I caress your arm and touch your tits.",
    "I caress your arm and touch your boobs.",
    "I caress your arm and cup your balls.",
    "I caress your arm and touch your labia.",
    "I caress your arm and touch your asshole.",
    "I caress your arm and touch your genitals.",
  ])("%s produces nothing", (message) => {
    expect(romantic(message)).toBeNull();
    expect(anyAct(message)).toBeNull();
  });
});

describe("the cheek is romantic-only — the shared veto keeps it out of the affectionate lane", () => {
  it("admits a cupped cheek as a romantic act on the registry's coarse `face`", () => {
    expect(anyAct("I cup your cheek.")?.targetLocationId).toBe("face");
    expect(anyAct("I cup your cheek.")?.actionKind).toBe("romantic");
  });

  it("still refuses the cheek to every affectionate form", () => {
    // Owner ruling (2026-08-18): the romantic lane reaches the cheek WITHOUT the
    // shared veto losing the word — that veto also guards the frozen NPC ending
    // floor, so weakening it to buy the cheek was explicitly ruled out.
    for (const message of ["I rest my hand on your cheek.", "I pat your cheek.", "I squeeze your cheek."]) {
      expect(touch(message)).toBeNull();
      expect(anyAct(message)).toBeNull();
      expect(ownerlessAct(message)).toBeNull();
    }
  });
});

describe("the shipped path carries the same guards as the isolated detector", () => {
  // The guard suites above call `detectChatAffectionateTouch`, which no longer
  // has a production caller. The owner-gate block's equivalence test already
  // re-proves all of them through the shipped path for the owner-OFF case, in
  // one assertion rather than a second enumeration. What it cannot reach is the
  // owner-ON half, where romantic verbs are live — so that is what these cover.
  it.each([
    "I grip your hand and stroke it.",
    "I pull your arm and caress it.",
    "I caress your bare shoulder.",
    "I stroke the small of your back.",
  ])("%s produces nothing with the owner on", (message) => {
    expect(anyAct(message)).toBeNull();
  });

});
