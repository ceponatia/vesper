import { describe, expect, it } from "vitest";
import {
  cardFromLibraryParts,
  findCardById,
  reactionKindToValence,
  resolveCardForTags,
  resolveCardReaction,
  severityToTier,
  socialReactionCardExtrasSchema,
  tierIntensity,
  type SocialReactionCard,
} from "./cards";

function card(over: Partial<SocialReactionCard> = {}): SocialReactionCard {
  return {
    id: "footfetish",
    label: "Foot fetish",
    description: "",
    kind: "taboo",
    triggers: ["proposition"],
    severity: 80, // ostracized
    reactionOverrides: [],
    ...over,
  };
}

describe("severityToTier", () => {
  it("buckets severity into the four tiers at 26/51/76", () => {
    expect(severityToTier(0)).toBe("odd");
    expect(severityToTier(25)).toBe("odd");
    expect(severityToTier(26)).toBe("disapproval");
    expect(severityToTier(50)).toBe("disapproval");
    expect(severityToTier(51)).toBe("shunning");
    expect(severityToTier(75)).toBe("shunning");
    expect(severityToTier(76)).toBe("ostracized");
    expect(severityToTier(100)).toBe("ostracized");
  });
});

describe("tierIntensity ramp", () => {
  it("maps tier → fixed base intensity (2/5/8/10)", () => {
    expect(tierIntensity("odd")).toBe(2);
    expect(tierIntensity("disapproval")).toBe(5);
    expect(tierIntensity("shunning")).toBe(8);
    expect(tierIntensity("ostracized")).toBe(10);
  });
});

describe("reactionKindToValence", () => {
  it("maps negative kinds to dislike, positive to like, indifferent to null", () => {
    for (const k of ["revulsion", "disapproval", "shunning", "fear"] as const) expect(reactionKindToValence(k)).toBe("dislike");
    for (const k of ["accepting", "enjoy", "kindred_spirit"] as const) expect(reactionKindToValence(k)).toBe("like");
    expect(reactionKindToValence("indifferent")).toBeNull();
  });
});

describe("resolveCardForTags", () => {
  it("derives a dislike at the tier's ramped intensity when no reaction is authored", () => {
    const r = resolveCardForTags(card({ severity: 80 }), "proposition", []);
    expect(r).toMatchObject({ valence: "dislike", intensity: 10, kind: "revulsion", cardId: "footfetish" });
  });

  it("flips to enjoy (a like) for a character carrying the override tag — the foot-fetish flip", () => {
    const c = card({ reactionOverrides: [{ tag: "foot-fetish-positive", toReaction: { kind: "enjoy", hint: "delighted" } }] });
    const flipped = resolveCardForTags(c, "proposition", ["foot-fetish-positive"]);
    expect(flipped).toMatchObject({ valence: "like", kind: "enjoy", hint: "delighted" });
    // intensity falls back to the tier ramp when the override authors none
    expect(flipped?.intensity).toBe(10);
    // a character without the tag still gets the default revulsion
    expect(resolveCardForTags(c, "proposition", [])?.valence).toBe("dislike");
  });

  it("returns null for an indifferent verdict (a real, winning verdict)", () => {
    const c = card({ defaultReaction: { kind: "indifferent", hint: "" } });
    expect(resolveCardForTags(c, "proposition", [])).toBeNull();
  });

  it("honours an authored intensity over the ramp", () => {
    const c = card({ severity: 80, defaultReaction: { kind: "disapproval", intensity: 3, hint: "" } });
    expect(resolveCardForTags(c, "proposition", [])?.intensity).toBe(3);
  });
});

describe("resolveCardReaction — ordered card set", () => {
  it("the first card whose triggers include the concept governs (character before world)", () => {
    const characterCard = card({ id: "personal", severity: 10, defaultReaction: { kind: "enjoy", hint: "" } });
    const worldCard = card({ id: "society", severity: 90, defaultReaction: { kind: "revulsion", hint: "" } });
    const r = resolveCardReaction("proposition", [], [characterCard, worldCard]);
    expect(r?.cardId).toBe("personal");
    expect(r?.valence).toBe("like");
  });

  it("returns null when no card triggers on the concept", () => {
    expect(resolveCardReaction("compliment", [], [card()])).toBeNull();
  });

  it("an indifferent first match wins (does not fall through to the next card)", () => {
    const indifferent = card({ id: "shrug", defaultReaction: { kind: "indifferent", hint: "" } });
    const harsh = card({ id: "harsh", defaultReaction: { kind: "revulsion", hint: "" } });
    expect(resolveCardReaction("proposition", [], [indifferent, harsh])).toBeNull();
  });
});

describe("findCardById", () => {
  it("locates a card by id within a set", () => {
    const a = card({ id: "a" });
    const b = card({ id: "b" });
    expect(findCardById("b", [a, b])?.id).toBe("b");
    expect(findCardById("c", [a, b])).toBeUndefined();
  });
});

describe("cardFromLibraryParts — library row → inline snapshot", () => {
  it("recomposes a full card: row id→fresh id, name→label, + the definition extras", () => {
    const source = card({ id: "lib-row", label: "ignored", description: "ignored" });
    const extras = socialReactionCardExtrasSchema.parse(source);
    const snapshot = cardFromLibraryParts("fresh-id", "Public nudity", "No exposure in the plaza", extras);
    expect(snapshot.id).toBe("fresh-id");
    expect(snapshot.label).toBe("Public nudity");
    expect(snapshot.description).toBe("No exposure in the plaza");
    // mechanical fields carried verbatim from the extras
    expect(snapshot).toMatchObject({ kind: "taboo", triggers: ["proposition"], severity: 80 });
    // and it still resolves through the curve like any card
    expect(resolveCardForTags(snapshot, "proposition", [])?.valence).toBe("dislike");
  });

  it("the extras schema drops the row-level id/label/description", () => {
    const extras = socialReactionCardExtrasSchema.parse(card());
    expect(extras).not.toHaveProperty("id");
    expect(extras).not.toHaveProperty("label");
    expect(extras).not.toHaveProperty("description");
  });
});
