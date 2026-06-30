import { describe, expect, it } from "vitest";
import { NEUTRAL_AVATAR_CUE } from "@/contracts";
import type { SessionReactionBeat, StatusParticipant } from "@/lib/client/use-session";
import { resolveBeatTick, selectFocalParticipant } from "./session-avatar";

function sp(over: Partial<StatusParticipant>): StatusParticipant {
  return {
    id: "x",
    displayName: "X",
    role: "npc",
    tier: "minor",
    isUser: false,
    avatarImageId: null,
    characterId: "c-x",
    locationId: "loc-1",
    locationName: null,
    activity: "idle",
    posture: null,
    meters: {},
    emotion: null,
    avatarCue: NEUTRAL_AVATAR_CUE,
    conditions: [],
    wardrobe: [],
    wornFull: [],
    held: [],
    ...over,
  };
}

describe("selectFocalParticipant (avatar-3d)", () => {
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

  it("requires a cue and a library characterId (the manifest key)", () => {
    expect(selectFocalParticipant([sp({ id: "nocue", avatarCue: null })], "loc-1")).toBeNull();
    expect(selectFocalParticipant([sp({ id: "noid", characterId: null })], "loc-1")).toBeNull();
  });
});

describe("resolveBeatTick (avatar-3d beat replay guard)", () => {
  const beat = (over: Partial<SessionReactionBeat>): SessionReactionBeat => ({
    participantId: "focal",
    concept: "flirt",
    valence: "like",
    magnitude: 1,
    turn: 1,
    ...over,
  });

  it("fires turn 1 of a fresh session (baseline -1) — the bug the review caught", () => {
    expect(resolveBeatTick(-1, beat({ turn: 1 }), "focal")).toBe(1);
  });

  it("suppresses a resumed session's already-seen latest turn, fires the next", () => {
    expect(resolveBeatTick(5, beat({ turn: 5 }), "focal")).toBe(0); // already seen at mount
    expect(resolveBeatTick(5, beat({ turn: 6 }), "focal")).toBe(6); // a genuinely new turn
  });

  it("never fires before the baseline is captured, with no beat, or for a non-focal target", () => {
    expect(resolveBeatTick(null, beat({ turn: 9 }), "focal")).toBe(0);
    expect(resolveBeatTick(0, null, "focal")).toBe(0);
    expect(resolveBeatTick(0, beat({ turn: 9, participantId: "someone-else" }), "focal")).toBe(0);
  });
});
