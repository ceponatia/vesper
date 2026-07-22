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
});
