import { describe, expect, it } from "vitest";
import { actionById, actionDefinitions, actionDefinitionSchema, matchActions } from "./registry";

describe("action registry", () => {
  it("ids are unique and every definition validates", () => {
    const ids = actionDefinitions.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const def of actionDefinitions) {
      expect(() => actionDefinitionSchema.parse(def)).not.toThrow();
    }
  });

  it("meter effects reference well-formed adjustments", () => {
    for (const def of actionDefinitions) {
      for (const effect of def.meterEffects) {
        expect(effect.delta !== undefined || effect.set !== undefined).toBe(true);
      }
    }
  });

  it("actionById finds definitions", () => {
    expect(actionById("shower")?.minutes).toBe(20);
    expect(actionById("nope")).toBeUndefined();
  });
});

describe("matchActions", () => {
  it("matches a simple action", () => {
    expect(matchActions("I take a shower and get dressed").map((a) => a.id)).toEqual(["shower"]);
  });

  it("longest alias wins (take a bath, not a stray 'bath' submatch)", () => {
    expect(matchActions("I take a bath").map((a) => a.id)).toEqual(["bathe"]);
  });

  it("matches multiple actions in input order", () => {
    expect(matchActions("I shower, then cook dinner").map((a) => a.id)).toEqual(["shower", "meal"]);
  });

  it("each definition matches at most once", () => {
    expect(matchActions("I shower, then shower again").map((a) => a.id)).toEqual(["shower"]);
  });

  it("is case-insensitive and whole-word", () => {
    expect(matchActions("I SHOWER quickly").map((a) => a.id)).toEqual(["shower"]);
    expect(matchActions("the showerhead drips")).toEqual([]);
  });

  it("ignores quoted dialogue", () => {
    expect(matchActions('I tell her "go take a shower" and wait')).toEqual([]);
  });

  it("returns empty for ordinary input", () => {
    expect(matchActions("I look around the room and ask about the locket")).toEqual([]);
  });
});
