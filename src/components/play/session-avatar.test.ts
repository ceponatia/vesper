import { describe, expect, it } from "vitest";
import type { StatusParticipant } from "@/lib/client/use-session";
import { selectFocalParticipant } from "./session-avatar";

function sp(over: Partial<StatusParticipant>): StatusParticipant {
  return {
    id: "x",
    displayName: "X",
    role: "npc",
    tier: "minor",
    isUser: false,
    avatarImageId: "img-x",
    locationId: "loc-1",
    locationName: null,
    activity: "idle",
    posture: null,
    meters: {},
    emotion: null,
    conditions: [],
    wardrobe: [],
    wornFull: [],
    held: [],
    ...over,
  };
}

describe("selectFocalParticipant", () => {
  it("prefers a present companion over a higher-tier NPC", () => {
    const companion = sp({ id: "comp", role: "companion", tier: "minor" });
    const majorNpc = sp({ id: "npc", role: "npc", tier: "major" });
    expect(selectFocalParticipant([majorNpc, companion], "loc-1")?.id).toBe("comp");
  });

  it("among the same role, prefers the higher tier, then a stable id order", () => {
    const minor = sp({ id: "b", tier: "minor" });
    const major = sp({ id: "c", tier: "major" });
    const majorB = sp({ id: "a", tier: "major" });
    expect(selectFocalParticipant([minor, major, majorB], "loc-1")?.id).toBe("a"); // major beats minor; "a" < "c"
  });

  it("excludes NPCs not co-located with the player", () => {
    const here = sp({ id: "here", locationId: "loc-1" });
    const elsewhere = sp({ id: "away", locationId: "loc-2", role: "companion" });
    expect(selectFocalParticipant([elsewhere, here], "loc-1")?.id).toBe("here");
  });

  it("includes everyone when a location is unknown either side", () => {
    expect(selectFocalParticipant([sp({ id: "a", locationId: null })], "loc-1")?.id).toBe("a");
    expect(selectFocalParticipant([sp({ id: "a", locationId: "loc-9" })], null)?.id).toBe("a");
  });

  it("returns null when no eligible NPC is present (player alone)", () => {
    expect(selectFocalParticipant([sp({ id: "p", isUser: true })], "loc-1")).toBeNull();
    expect(selectFocalParticipant([], "loc-1")).toBeNull();
  });

  it("requires an avatar image to show", () => {
    expect(selectFocalParticipant([sp({ id: "noimg", avatarImageId: null })], "loc-1")).toBeNull();
  });
});
