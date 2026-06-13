import { describe, expect, it } from "vitest";
import { detectCommsIntent, detectIntent, isOocInput } from "./intent";

const NPCS = ["Maya", "Maya Brennan", "Rhett"];
const ITEMS = ["lantern", "old lantern", "letter"];

describe("detectIntent", () => {
  it("returns an empty intent for plain dialogue", () => {
    expect(detectIntent("Good morning, how did you sleep?", NPCS, ITEMS)).toEqual({});
  });

  it("detects a look target among NPC names", () => {
    expect(detectIntent("I look at Maya and smile", NPCS, ITEMS).lookTarget).toBe("Maya");
    expect(detectIntent("She's pretty. I glance at Rhett.", NPCS, ITEMS).lookTarget).toBe("Rhett");
  });

  it("matches names case-insensitively and longest-first", () => {
    const intent = detectIntent("i stare at maya brennan", NPCS, ITEMS);
    expect(intent.lookTarget).toBe("Maya Brennan");
    expect(detectIntent("I examine the OLD LANTERN closely", NPCS, ITEMS).examineItem).toBe("old lantern");
  });

  it("detects touch and smell targets", () => {
    expect(detectIntent("I gently touch Maya's shoulder", NPCS, ITEMS).touchTarget).toBe("Maya");
    expect(detectIntent("I lean in and smell Rhett's coat", NPCS, ITEMS).smellTarget).toBe("Rhett");
  });

  it("detects examined items via look or examine verbs", () => {
    expect(detectIntent("I inspect the letter", NPCS, ITEMS).examineItem).toBe("letter");
    expect(detectIntent("I look at the lantern on the table", NPCS, ITEMS).examineItem).toBe("lantern");
  });

  it("captures the location phrase after enter/move verbs", () => {
    expect(detectIntent("I walk into the kitchen.", NPCS, ITEMS).enterLocation).toBe("kitchen");
    expect(detectIntent("Let's go to the rose garden, alright?", NPCS, ITEMS).enterLocation).toBe("rose garden");
    expect(detectIntent("I head back into my bedroom", NPCS, ITEMS).enterLocation).toBe("bedroom");
  });

  it("ignores text inside double quotes", () => {
    expect(detectIntent('I say "look at Maya, she is tired"', NPCS, ITEMS)).toEqual({});
    expect(detectIntent('"Smell Rhett!" I joke, then look at Maya', NPCS, ITEMS)).toEqual({
      lookTarget: "Maya",
    });
    expect(detectIntent("I whisper “let’s go to the kitchen” and stay put", NPCS, ITEMS).enterLocation).toBeUndefined();
  });

  it("does not match names embedded in larger words", () => {
    // "Mayan" must not match "Maya"
    expect(detectIntent("I look at the Mayan carving", NPCS, ITEMS).lookTarget).toBeUndefined();
  });

  it("resolves each intent's target to the name nearest after its verb", () => {
    const intent = detectIntent("I look at Maya, touch Rhett's arm, and examine the letter", NPCS, ITEMS);
    expect(intent.lookTarget).toBe("Maya");
    expect(intent.touchTarget).toBe("Rhett");
    expect(intent.examineItem).toBe("letter");
  });
});

describe("detectCommsIntent", () => {
  it("detects a phone call and routes call verbs to kind 'call'", () => {
    expect(detectCommsIntent("I call Maya to check in", NPCS)).toEqual({ kind: "call", targetName: "Maya" });
    expect(detectCommsIntent("I phone Rhett", NPCS)).toEqual({ kind: "call", targetName: "Rhett" });
    expect(detectCommsIntent("I ring Maya Brennan", NPCS)).toEqual({ kind: "call", targetName: "Maya Brennan" });
  });

  it("detects a text and routes text verbs to kind 'text'", () => {
    expect(detectCommsIntent("I text Maya: where are you?", NPCS)).toEqual({ kind: "text", targetName: "Maya" });
    expect(detectCommsIntent("I send a message to Rhett", NPCS)).toEqual({ kind: "text", targetName: "Rhett" });
  });

  it("returns null without a comms verb or without a known target", () => {
    expect(detectCommsIntent("I look at Maya", NPCS)).toBeNull();
    expect(detectCommsIntent("I call the front desk", NPCS)).toBeNull();
  });

  it("ignores 'call out'/'call for' in-room shouts", () => {
    expect(detectCommsIntent("I call out to Maya across the room", NPCS)).toBeNull();
    expect(detectCommsIntent("I call for Rhett to come help", NPCS)).toBeNull();
  });

  it("ignores quoted speech", () => {
    expect(detectCommsIntent('I say "call Maya for me"', NPCS)).toBeNull();
  });
});

describe("isOocInput", () => {
  it("matches leading OOC markers in common formats", () => {
    expect(isOocInput("(OOC: what locations are accessible from here)")).toBe(true);
    expect(isOocInput("OOC: how much time has passed?")).toBe(true);
    expect(isOocInput("[ooc] who is in the room?")).toBe(true);
    expect(isOocInput("  ( ooc : where am I )")).toBe(true);
  });

  it("never matches in-world text that merely mentions OOC", () => {
    expect(isOocInput("I walk to the clinic")).toBe(false);
    expect(isOocInput('I tell Maya "use the OOC: channel"')).toBe(false);
    expect(isOocInput("The dock workers unload crates")).toBe(false);
    expect(isOocInput("ooczilla attacks the harbor")).toBe(false);
  });
});
