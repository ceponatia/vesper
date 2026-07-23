import { describe, expect, it } from "vitest";
import { admitPlayerCommand, type AdmissionSurface } from "./input-admission";

// R5 slice 2: deterministic input admission — prose onto the typed command
// set, matched against the world's ACTUAL surface, silence over cleverness.

const surface: AdmissionSurface = {
  heldItems: [{ itemId: "item-keepsake", name: "a small keepsake" }],
  zones: [
    { zoneId: "zone-home", kind: "home" },
    { zoneId: "zone-square", kind: "plaza" },
  ],
  actionDefinitionIds: ["stw-x-action-rest"],
};

describe("admitPlayerCommand", () => {
  it("admits handing over a HELD item by name", () => {
    expect(admitPlayerCommand("I hand her the keepsake with a smile.", surface)).toMatchObject({
      kind: "give_item",
      itemId: "item-keepsake",
    });
    expect(admitPlayerCommand("Smiling, I pass the small keepsake across the table.", surface)).toMatchObject({
      kind: "give_item",
    });
  });

  it("admits movement toward a zone the world actually has", () => {
    expect(admitPlayerCommand("I walk to the town square.", surface)).toMatchObject({
      kind: "move",
      toZoneId: "zone-square",
    });
    expect(admitPlayerCommand("I head home before it gets dark.", surface)).toMatchObject({
      kind: "move",
      toZoneId: "zone-home",
    });
  });

  it("admits rest verbs against the catalog's rest action", () => {
    expect(admitPlayerCommand("I lie down to rest for a while.", surface)).toMatchObject({
      kind: "start_activity",
      actionDefinitionId: "stw-x-action-rest",
    });
  });

  it("never acts on quoted speech or second-person suggestions", () => {
    expect(admitPlayerCommand('I say "let’s walk to the square later, okay?"', surface)).toBeNull();
    expect(admitPlayerCommand('"You should rest," I tell her.', surface)).toBeNull();
    expect(admitPlayerCommand("Maybe you could hand me the keepsake?", surface)).toBeNull();
  });

  it("stays silent on items not held and places that do not exist", () => {
    expect(admitPlayerCommand("I hand her the sword.", surface)).toBeNull();
    expect(admitPlayerCommand("I walk to the harbor.", surface)).toBeNull();
    expect(admitPlayerCommand("I rest.", { ...surface, actionDefinitionIds: [] })).toBeNull();
  });

  it("admits at most one command, give first", () => {
    expect(
      admitPlayerCommand("I hand her the keepsake, then walk to the square to rest.", surface),
    ).toMatchObject({ kind: "give_item" });
  });

  // Slice 5 — walk-with-me: first-person plural / invite phrasing over a known
  // zone word admits an ACCOMPANY (not a solo move), deterministic and quiet.
  describe("accompany (walk-with-me)", () => {
    it("admits a 'let's' invite over a known place", () => {
      expect(admitPlayerCommand("Let's walk to the square.", surface)).toMatchObject({
        kind: "accompany",
        toZoneId: "zone-square",
      });
    });

    it("admits first-person plural ('we head home')", () => {
      expect(admitPlayerCommand("We head home before dark.", surface)).toMatchObject({
        kind: "accompany",
        toZoneId: "zone-home",
      });
    });

    it("admits 'walk with me' and 'come with me' invites", () => {
      expect(admitPlayerCommand("Walk with me to the square.", surface)).toMatchObject({
        kind: "accompany",
        toZoneId: "zone-square",
      });
      expect(admitPlayerCommand("Come with me to the square, please.", surface)).toMatchObject({
        kind: "accompany",
        toZoneId: "zone-square",
      });
    });

    it("a plain first-person move stays a solo MOVE, never accompany", () => {
      expect(admitPlayerCommand("I walk to the town square.", surface)).toMatchObject({ kind: "move" });
    });

    it("stays silent on quoted invites, third-person, and no zone word", () => {
      expect(admitPlayerCommand('I say "let’s walk to the square."', surface)).toBeNull();
      expect(admitPlayerCommand("She walks to the square with her friends.", surface)).toBeNull();
      expect(admitPlayerCommand("Let's talk for a while.", surface)).toBeNull();
      expect(admitPlayerCommand("Come with me to the harbor.", surface)).toBeNull();
    });
  });
});
