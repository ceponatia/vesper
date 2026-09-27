import { describe, expect, it } from "vitest";
import {
  buildChatReplyGates,
  chatCueInviteLine,
  deriveChatSensoryAllowance,
  detectChatCue,
  detectSceneMovement,
  detectSensoryFocus,
  detectWithinPlaceMovement,
  isCheckInReply,
  replyEndsInQuestion,
  type ChatCueHint,
  type SceneMovementContext,
} from "./chat-intent";

const cue = (overrides: Partial<ChatCueHint> = {}): ChatCueHint => ({
  proximity: false,
  touch: false,
  intimate: false,
  attention: false,
  ...overrides,
});

const maraFocusContext = {
  characters: [{ id: "character_mara", name: "Mara", aliases: ["Mars"] }],
} as const;

describe("detectChatCue", () => {
  it("flags proximity when the player draws close", () => {
    expect(detectChatCue("She leans in close to you.").proximity).toBe(true);
    expect(detectChatCue("You step closer.").proximity).toBe(true);
  });

  it("flags touch on physical contact", () => {
    expect(detectChatCue("You take her hand.").touch).toBe(true);
    expect(detectChatCue("You brush against her shoulder.").touch).toBe(true);
  });

  it("flags intimate beats", () => {
    expect(detectChatCue("You kiss her.").intimate).toBe(true);
    expect(detectChatCue("You taste the salt on her skin.").intimate).toBe(true);
  });

  it("flags attention when the player looks the character over or compliments appearance", () => {
    expect(detectChatCue("I lean back and look her up and down.").attention).toBe(true);
    expect(detectChatCue("I can't stop staring at her.").attention).toBe(true);
    expect(detectChatCue("That dress looks amazing on you.").attention).toBe(true);
    expect(detectChatCue("I love your hair today.").attention).toBe(true);
    expect(detectChatCue("My eyes linger on the slit of her dress.").attention).toBe(true);
  });

  it("does not flag attention for impersonal looking or non-appearance compliments", () => {
    expect(detectChatCue("I glance at the clock on the wall.").attention).toBe(false);
    expect(detectChatCue("I admire your honesty.").attention).toBe(false);
    expect(detectChatCue("I look at the menu for a while.").attention).toBe(false);
  });

  it("flags nothing for ordinary distant conversation", () => {
    expect(detectChatCue("What did you do today?")).toEqual(cue());
    expect(detectChatCue("")).toEqual(cue());
  });

  it("does not turn denials, hypotheticals, speech, or history into physical cues", () => {
    expect(detectChatCue("I haven't touched her yet.").touch).toBe(false);
    expect(detectChatCue("I wouldn’t touch her.").touch).toBe(false);
    expect(detectChatCue("I wouldnt touch her.").touch).toBe(false);
    expect(detectChatCue('"Don\'t touch me."').touch).toBe(false);
    expect(detectChatCue("I've touched her before.").touch).toBe(false);
    expect(detectChatCue("I touch her now.", { narratorInput: true })).toEqual(cue());
  });
});

describe("chatCueInviteLine", () => {
  it("returns the most-charged invite (intimate > touch > proximity > attention)", () => {
    expect(chatCueInviteLine(cue({ proximity: true, touch: true, intimate: true, attention: true }), "Mara")).toContain(
      "turning intimate",
    );
    expect(chatCueInviteLine(cue({ proximity: true, touch: true, attention: true }), "Mara")).toContain("made contact");
    expect(chatCueInviteLine(cue({ proximity: true, attention: true }), "Mara")).toContain("drawn close");
    expect(chatCueInviteLine(cue({ attention: true }), "Mara")).toContain("attention is on Mara's appearance");
  });

  it("words the attention invite as one player-eye visual detail, never an inventory", () => {
    const line = chatCueInviteLine(cue({ attention: true }), "Mara");
    expect(line).toContain("seen from the player's eye");
    expect(line).toContain("never a head-to-toe description");
  });

  it("returns '' when nothing is invited", () => {
    expect(chatCueInviteLine(cue(), "Mara")).toBe("");
  });
});

describe("deriveChatSensoryAllowance (narrator-prompt-consolidation slice 4)", () => {
  it("a sense-targeted beat wins: focused_description", () => {
    expect(
      deriveChatSensoryAllowance({
        cue: cue({ intimate: true }),
        sensoryFocus: { sense: "smell", target: "hair", intimate: false },
      }),
    ).toBe("focused_description");
  });

  it("closeness (intimate/touch/proximity) grants a close-range hook", () => {
    expect(deriveChatSensoryAllowance({ cue: cue({ intimate: true }), sensoryFocus: null })).toBe("close_range_hook");
    expect(deriveChatSensoryAllowance({ cue: cue({ touch: true }), sensoryFocus: null })).toBe("close_range_hook");
    expect(deriveChatSensoryAllowance({ cue: cue({ proximity: true }), sensoryFocus: null })).toBe("close_range_hook");
  });

  it("attention alone grants a visual accent (sight carries at any distance)", () => {
    expect(deriveChatSensoryAllowance({ cue: cue({ attention: true }), sensoryFocus: null })).toBe("visual_accent");
  });

  it("an ordinary distant exchange earns none", () => {
    expect(deriveChatSensoryAllowance({ cue: cue(), sensoryFocus: null })).toBe("none");
    expect(deriveChatSensoryAllowance({ cue: null, sensoryFocus: null })).toBe("none");
  });
});

/** Both scene-movement reads of one line: the place change and the within-place move. */
const movement = (input: string, context: SceneMovementContext = {}) => ({
  place: detectSceneMovement(input, context),
  within: detectWithinPlaceMovement(input, context),
});
const placeChange = (place: string) => ({ place, within: null });
const withinPlace = (within: string) => ({ place: null, within });
const NO_MOVE = { place: null, within: null };
/** A place a mis-read once minted: a name and nothing the fiction established about it. */
const stubDesk = { name: "desk", details: [], connections: [] };
/** The same name, established by the fiction as a place (a nook called "the desk"). */
const establishedDesk = { name: "desk", details: ["a reading nook everyone calls the desk"], connections: [] };

describe("detectSceneMovement (chat scene memory)", () => {
  it("captures a destination after a movement verb + preposition + article", () => {
    expect(detectSceneMovement("I follow her to the kitchen.")).toBe("kitchen");
    expect(detectSceneMovement("Let's move to the living room.")).toBe("living room");
    expect(detectSceneMovement("She leads me into the back garden.")).toBe("back garden");
    expect(detectSceneMovement("We make our way to the kitchen.")).toBe("kitchen");
  });

  it("captures adverbial destinations (outside / upstairs)", () => {
    expect(detectSceneMovement("We head outside.")).toBe("outside");
    expect(detectSceneMovement("Come on, let's go upstairs.")).toBe("upstairs");
  });

  it("does not misfire on non-movement 'to' phrases", () => {
    expect(detectSceneMovement("I want to talk about your day.")).toBeNull();
    expect(detectSceneMovement("Listen to the radio with me.")).toBeNull();
    expect(detectSceneMovement("What did you do today?")).toBeNull();
    expect(detectSceneMovement("")).toBeNull();
    expect(movement("I walk over to talk to the bartender.")).toEqual(NO_MOVE);
    expect(movement("I walk over to Wren.")).toEqual(NO_MOVE);
  });

  it("rejects denied, hypothetical, and historical scene transitions", () => {
    expect(detectSceneMovement("I didn't go to the kitchen.")).toBeNull();
    expect(detectSceneMovement("I wouldn’t go to the kitchen.")).toBeNull();
    expect(detectSceneMovement("If she asks, I go to the kitchen.")).toBeNull();
    expect(detectSceneMovement("I have moved to the kitchen before.")).toBeNull();
    expect(detectSceneMovement("I moved to the kitchen.")).toBe("kitchen");
  });

  // #330: an unrelated third party's own errand, narrated in passing, must not teleport
  // the shared scene — only the player actually going (or being taken) somewhere may
  // switch the current place. (The reported "back room" shape: a background mention, not
  // the player moving.)
  it("does not move the scene for an unrelated third party's own errand (#330)", () => {
    expect(detectSceneMovement("The bartender walks back to the back room for napkins.")).toBeNull();
    expect(detectSceneMovement("Mara heads to the kitchen to grab a drink.")).toBeNull();
    expect(movement("I watch the bartender walk to the back room.")).toEqual(NO_MOVE);
    expect(movement("My friend walks to the kitchen.")).toEqual(NO_MOVE);
  });

  it("reads a shared subject from the previous clause, never an empty clause as the player (#330)", () => {
    expect(movement("The bartender nods and walks to the back room.")).toEqual(NO_MOVE);
    expect(movement("The bartender, sighing, walks to the back room.")).toEqual(NO_MOVE);
    expect(movement("Mara grabs her purse and heads to the kitchen.")).toEqual(NO_MOVE);
    // The player's own shared subject, and an imperative with nothing before its verb, still move.
    expect(detectSceneMovement("I grab my keys and head to the kitchen.")).toBe("kitchen");
    expect(detectSceneMovement("Head to the kitchen.")).toBe("kitchen");
    // An opening participle takes the subject after its comma.
    expect(detectSceneMovement("Walking into the kitchen, I grab a glass.")).toBe("kitchen");
    expect(detectSceneMovement("Walking into the kitchen, she grabs a glass.")).toBeNull();
  });

  it("still allows legitimate movement into a brand-new place (leading/being led)", () => {
    expect(detectSceneMovement("She leads me to the back room.")).toBe("back room");
    expect(detectSceneMovement("I lead her to the back room.")).toBe("back room");
    expect(detectSceneMovement("He carries me to the bedroom.")).toBe("bedroom");
    expect(detectSceneMovement("The two of us head to the kitchen.")).toBe("kitchen");
    expect(detectSceneMovement("Mara and I head to the kitchen.")).toBe("kitchen");
  });

  it("reads 'you' as the character in player input, as the sensory read does (#330)", () => {
    expect(movement("She leads you into the back garden.")).toEqual(NO_MOVE);
    expect(movement("He carries you to the bedroom.")).toEqual(NO_MOVE);
    expect(movement("The waiter shows you to your table.")).toEqual(NO_MOVE);
    expect(movement("The waiter leads you to your table.")).toEqual(NO_MOVE);
  });

  it("counts the persona's name as the player in player input (#330)", () => {
    const persona = { playerNames: ["Brian"] };
    expect(detectSceneMovement("Brian walks to the kitchen.", persona)).toBe("kitchen");
    expect(detectSceneMovement("Mara leads Brian to the cellar.", persona)).toBe("cellar");
    expect(detectSceneMovement("Brian walks to the kitchen.")).toBeNull();
    expect(detectSceneMovement("Mara leads Brian to the cellar.")).toBeNull();
  });

  it("lets storyteller input move the scene through any subject, furniture still vetoed (#330)", () => {
    const storyteller = { narratorInput: true };
    expect(detectSceneMovement("The group heads to the tavern.", storyteller)).toBe("tavern");
    expect(detectSceneMovement("Mara leads Brian to the cellar.", storyteller)).toBe("cellar");
    expect(detectSceneMovement("The bartender nods and walks to the back room.", storyteller)).toBe("back room");
    expect(detectSceneMovement("She leads you into the back garden.", storyteller)).toBe("back garden");
    expect(detectSceneMovement("The group heads to the tavern.")).toBeNull();
    expect(movement("The bartender walks over to the desk.", storyteller)).toEqual(NO_MOVE);
  });

  it("a mere mention of a place, with no movement verb, never changes the scene", () => {
    expect(detectSceneMovement("The desk in the back room is old.")).toBeNull();
    expect(detectSceneMovement("I love this kitchen.")).toBeNull();
  });

  // #330, owner ruling 2026-09-27: a player's move onto furniture/a fixture WITHIN the
  // current place is not a place change — the desk is not a room.
  it("does not read furniture/a fixture as a destination, even when the player moves", () => {
    expect(detectSceneMovement("I walk over to the desk.")).toBeNull();
    expect(detectSceneMovement("I carry my drink over to the counter.")).toBeNull();
    expect(detectSceneMovement("She leads me to the fireplace.")).toBeNull();
  });

  it("cuts the destination at its first function word before classifying it (#330)", () => {
    expect(movement("I walk over to her desk and lean against it.")).toEqual(withinPlace("desk"));
    expect(movement("I walk to the window to look out.")).toEqual(withinPlace("window"));
    expect(movement("I walk over to the table by the window.")).toEqual(withinPlace("table"));
    expect(movement("I walk to the back room for napkins.")).toEqual(placeChange("back room"));
  });

  it("room-type nouns are never read as furniture (back room / kitchen / garden stay places)", () => {
    expect(detectSceneMovement("I walk over to the back room.")).toBe("back room");
    expect(detectSceneMovement("I walk over to the kitchen.")).toBe("kitchen");
    expect(detectSceneMovement("I walk over to the garden.")).toBe("garden");
    expect(detectSceneMovement("We head up to the second floor.")).toBe("second floor");
  });

  it("switches to a furniture-named destination only once the fiction established it, never a stub (#330)", () => {
    expect(movement("I walk over to the desk.", { knownPlaces: [establishedDesk] })).toEqual(placeChange("desk"));
    expect(movement("I walk over to the desk.", { knownPlaces: [stubDesk] })).toEqual(withinPlace("desk"));
  });

  it("reads every movement in the line and reports the last place change (#330)", () => {
    expect(movement("I walk to the door, and we head outside.")).toEqual(placeChange("outside"));
    expect(movement("I grab my keys and walk to the door. We step outside.")).toEqual(placeChange("outside"));
    expect(movement("I walk to the kitchen to grab a drink, then carry it back to the living room.")).toEqual(
      placeChange("living room"),
    );
  });

  it("never reads a gesture, a garment, or an idiom as locomotion", () => {
    expect(movement("I move my hand to her thigh.")).toEqual(NO_MOVE);
    expect(movement("I bring the glass to my lips.")).toEqual(NO_MOVE);
    expect(movement("She takes me into her arms.")).toEqual(NO_MOVE);
    expect(movement("I slip into my dress.")).toEqual(NO_MOVE);
    expect(movement("We come to an agreement.")).toEqual(NO_MOVE);
    expect(movement("I take off my shirt and toss it to the floor.")).toEqual(NO_MOVE);
    expect(movement("I move closer to her on the couch.")).toEqual(NO_MOVE);
  });
});

describe("detectWithinPlaceMovement (chat scene memory: furniture, #330)", () => {
  it("reads the player's own move onto furniture/a fixture within the current place", () => {
    expect(detectWithinPlaceMovement("I walk over to the desk.")).toBe("desk");
    expect(detectWithinPlaceMovement("I carry my drink over to the counter.")).toBe("counter");
    expect(detectWithinPlaceMovement("She leads me to the fireplace.")).toBe("fireplace");
    expect(detectWithinPlaceMovement("I grab my keys and walk to the door.")).toBe("door");
    expect(detectWithinPlaceMovement("I slip to the floor.")).toBe("floor");
  });

  it("is null for a real place change, a mere mention, or a third party's move", () => {
    expect(detectWithinPlaceMovement("I walk over to the kitchen.")).toBeNull();
    expect(detectWithinPlaceMovement("There's a desk by the window.")).toBeNull();
    expect(detectWithinPlaceMovement("The bartender walks back to the counter.")).toBeNull();
    expect(detectWithinPlaceMovement("The bartender, sighing, walks over to the counter.")).toBeNull();
  });

  it("is null once the furniture-named phrase is an established place", () => {
    expect(detectWithinPlaceMovement("I walk over to the desk.", { knownPlaces: [establishedDesk] })).toBeNull();
  });

  it("reads only the player's own move in storyteller input ('you', the persona's name)", () => {
    const storyteller = { narratorInput: true, playerNames: ["Brian"] };
    expect(detectWithinPlaceMovement("You walk over to the desk.", storyteller)).toBe("desk");
    expect(detectWithinPlaceMovement("Brian walks over to the desk.", storyteller)).toBe("desk");
    expect(detectWithinPlaceMovement("The waiter leads you to your table.", storyteller)).toBe("table");
    expect(detectWithinPlaceMovement("Mara walks over to the desk.", storyteller)).toBeNull();
    expect(detectWithinPlaceMovement("You walk over to the desk.")).toBeNull();
  });
});

describe("detectSensoryFocus (scope guard)", () => {
  it("detects a sense verb aimed at a body region, carrying the resolved registry region", () => {
    expect(detectSensoryFocus("I breathe in the scent of her hair.")).toEqual({
      sense: "smell",
      target: "hair",
      intimate: false,
      region: "hair",
    });
    expect(detectSensoryFocus("I run my fingers along your collarbone.")).toEqual({
      sense: "touch",
      target: "collarbone",
      intimate: false,
      region: "shoulders",
    });
    expect(detectSensoryFocus("I taste the salt on your neck.")).toEqual({
      sense: "taste",
      target: "neck",
      intimate: false,
      region: "neck",
    });
  });

  it("carries no region for a garment target (nothing anatomical to expand)", () => {
    expect(detectSensoryFocus("I take in the lines of her dress.")).toEqual({ sense: "study", target: "dress", intimate: false });
  });

  it("resolves singular and colloquial nouns to their registry region", () => {
    expect(detectSensoryFocus("I lick her foot.")).toEqual({ sense: "taste", target: "foot", intimate: false, region: "foot" });
    expect(detectSensoryFocus("I lick the sole of her foot.")).toEqual({ sense: "taste", target: "sole", intimate: false, region: "feet" });
    expect(detectSensoryFocus("I press my nose against her heels and inhale.")).toEqual({
      sense: "smell",
      target: "heels",
      intimate: false,
      region: "feet",
    });
    expect(detectSensoryFocus("I kiss her throat, tasting her.")).toEqual({
      sense: "taste",
      target: "throat",
      intimate: false,
      region: "neck",
    });
    expect(detectSensoryFocus("I stroke her chest.")).toEqual({ sense: "touch", target: "chest", intimate: false, region: "chest" });
  });

  it("flags an intimate target and resolves its colloquial region", () => {
    expect(detectSensoryFocus("I cup her breasts.")).toEqual({ sense: "touch", target: "breasts", intimate: true, region: "breasts" });
    expect(detectSensoryFocus("I taste her pussy.")).toEqual({ sense: "taste", target: "pussy", intimate: true, region: "vulva" });
    expect(detectSensoryFocus("I breathe in the scent of her panties.")).toEqual({
      sense: "smell",
      target: "panties",
      intimate: true,
      region: "groin",
    });
  });

  it("returns null without a target noun (sense×TARGET only — 'I feel nervous' never fires)", () => {
    expect(detectSensoryFocus("I feel nervous about tomorrow.")).toBeNull();
    expect(detectSensoryFocus("She smells wonderful.")).toBeNull();
    expect(detectSensoryFocus("What are you thinking about?")).toBeNull();
    expect(detectSensoryFocus("")).toBeNull();
  });

  it("keeps the reported denial visual-only instead of fabricating eye contact", () => {
    const message =
      "She isn't afraid of me. I notice the faint glow in her eyes. I haven't even touched her yet.";
    const cueHint = detectChatCue(message);
    const focus = detectSensoryFocus(message, maraFocusContext);
    expect(cueHint).toEqual(cue({ attention: true }));
    expect(focus).toBeNull();
    expect(deriveChatSensoryAllowance({ cue: cueHint, sensoryFocus: focus })).toBe("visual_accent");
  });

  it("binds the first valid sense and owned target locally, in textual order", () => {
    expect(detectSensoryFocus("I touch her cheek and smell her hair.", maraFocusContext)).toEqual({
      sense: "touch",
      target: "cheek",
      intimate: false,
      region: "face",
      targetCharacterId: "character_mara",
      source: "player_narration",
    });
    expect(detectSensoryFocus("I touch her breasts and smell her hair.", maraFocusContext)).toMatchObject({
      sense: "touch",
      target: "breasts",
      intimate: true,
      targetCharacterId: "character_mara",
    });
  });

  it("rejects cross-sentence, cross-clause, wrong-actor, and self-owned pairings", () => {
    expect(detectSensoryFocus("I touched the tabletop. The glow in her eyes brightened.", maraFocusContext)).toBeNull();
    expect(
      detectSensoryFocus("I touched the tabletop while the faint glow in her eyes brightened.", maraFocusContext),
    ).toBeNull();
    expect(detectSensoryFocus("She touched her eyes.", maraFocusContext)).toBeNull();
    expect(detectSensoryFocus("I touched my own eyes.", maraFocusContext)).toBeNull();
  });

  it("accepts current plain-past narration but rejects perfect history and every denial contraction", () => {
    expect(detectSensoryFocus("I touched her cheek.", maraFocusContext)).toMatchObject({
      sense: "touch",
      target: "cheek",
      targetCharacterId: "character_mara",
    });
    expect(detectSensoryFocus("I've touched her cheek before.", maraFocusContext)).toBeNull();
    expect(detectSensoryFocus("I had gently touched her cheek before.", maraFocusContext)).toBeNull();
    expect(detectSensoryFocus("I haven't touched her cheek yet.", maraFocusContext)).toBeNull();
    expect(detectSensoryFocus("I wouldn’t touch her cheek.", maraFocusContext)).toBeNull();
    expect(detectSensoryFocus("I couldnt touch her cheek.", maraFocusContext)).toBeNull();
    expect(detectSensoryFocus("I used to touch her cheek.", maraFocusContext)).toBeNull();
  });

  it("reads only ordinary player narration and fails closed on an ambiguous ensemble owner", () => {
    expect(detectSensoryFocus('I say, "I touch her cheek."', maraFocusContext)).toBeNull();
    expect(detectSensoryFocus("*I touch her cheek.*", maraFocusContext)).toBeNull();
    expect(detectSensoryFocus("((I touch her cheek.))", maraFocusContext)).toBeNull();
    expect(detectSensoryFocus("I touch her cheek.", { ...maraFocusContext, narratorInput: true })).toBeNull();

    const ensemble = {
      characters: [
        ...maraFocusContext.characters,
        { id: "character_sen", name: "Sen", aliases: [] },
      ],
    } as const;
    expect(detectSensoryFocus("I touch her cheek.", ensemble)).toBeNull();
    expect(detectSensoryFocus("I touch Mara's cheek.", ensemble)).toMatchObject({
      target: "cheek",
      targetCharacterId: "character_mara",
    });
  });
});

describe("replyEndsInQuestion (deliverable D — hook cadence)", () => {
  it("fires when the last dialogue line ends in a question, including tag questions", () => {
    expect(replyEndsInQuestion('She smiles. "How have you been?"')).toBe(true);
    expect(replyEndsInQuestion('"You came back, didn\'t you?"')).toBe(true);
  });

  it("does not fire when a mid-reply question is followed by narration (the reply moves past it)", () => {
    expect(replyEndsInQuestion('"Where were you?" She turns back to the window, not waiting.')).toBe(false);
  });

  it("does not fire when the reply ends on a statement or an action", () => {
    expect(replyEndsInQuestion('"It\'s good to see you." She leans against the doorframe.')).toBe(false);
    expect(replyEndsInQuestion("She just nods, saying nothing.")).toBe(false);
  });

  it("treats a texted comms line as a dialogue line", () => {
    expect(replyEndsInQuestion("*Mara: you free tonight?*")).toBe(true);
    expect(replyEndsInQuestion("*Mara: on my way.*")).toBe(false);
  });
});

describe("isCheckInReply (deliverable D — intimate check-in)", () => {
  it("matches the check-in solicitation patterns", () => {
    expect(isCheckInReply('"Am I doing this right?" she breathes.')).toBe(true);
    expect(isCheckInReply('"Does that feel good?"')).toBe(true);
    expect(isCheckInReply('"Is this okay?"')).toBe(true);
    expect(isCheckInReply('"Do you like that?"')).toBe(true);
  });

  it("does not match ordinary intimate dialogue", () => {
    expect(isCheckInReply('"God, you feel incredible," she whispers.')).toBe(false);
    expect(isCheckInReply("She arches into you without a word.")).toBe(false);
  });
});

describe("buildChatReplyGates (deliverable D)", () => {
  const q1 = '"How was your day?"';
  const q2 = '"What did you get up to?"';
  const statement = '"Good to see you." She sits.';

  it("fires the hook-cadence note only when the last TWO replies both end in questions", () => {
    const both = buildChatReplyGates({ recentReplies: [statement, q1, q2], intimate: false, name: "Mara" });
    expect(both).toContain("ended in questions");
    const one = buildChatReplyGates({ recentReplies: [q1, statement], intimate: false, name: "Mara" });
    expect(one).toBe("");
  });

  it("fires the check-in gate only during an intimate beat when the previous reply solicited a check-in", () => {
    const prev = '"Does that feel good?"';
    const intimate = buildChatReplyGates({ recentReplies: [prev], intimate: true, name: "Mara" });
    expect(intimate).toContain("No check-in questions this turn");
    expect(intimate).toContain("Mara's experience");
    // Same reply, non-intimate beat ⇒ no check-in gate.
    expect(buildChatReplyGates({ recentReplies: [prev], intimate: false, name: "Mara" })).toBe("");
  });

  it("returns '' when neither gate fires", () => {
    expect(buildChatReplyGates({ recentReplies: [statement], intimate: true, name: "Mara" })).toBe("");
    expect(buildChatReplyGates({ recentReplies: [], intimate: true, name: "Mara" })).toBe("");
  });
});
