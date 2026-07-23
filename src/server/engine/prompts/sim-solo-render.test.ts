import { describe, expect, it } from "vitest";
import { characterProfileSchema, type CharacterProfile } from "@/contracts/world/profile";
import type { SoloCutContext } from "@/lib/simulation/solo-cut";
import { buildSimSoloRenderPrompt, type SimSoloRenderContext } from "./sim-solo-render";

/**
 * Pure solo-cut prompt tests (world-ui.plan.md slice 0, ruling 21). No IO — the
 * whole prompt is asserted from a fixture context. The focus is the dual-block
 * shape, the charter-law invariants (second person to the player, third person
 * for the primary, no raw ids), and the standing limits on the vignette.
 */

const NOW = 8 * 3_600;

function profile(age = "29"): CharacterProfile {
  return characterProfileSchema.parse({
    age,
    bio: "Nora runs the corner café her mother left her.",
    personality: "Wry, private, and slow to trust.",
    voice: "Low and dry.",
    traits: [{ id: "social.dominance", value: 60 }],
  });
}

const SOLO: SoloCutContext = {
  playerName: "Bri",
  primaryName: "Nora",
  playerSide: {
    zoneLabel: "town square",
    inTransit: false,
    coPresent: [{ name: "Sable", activity: "selling wares" }],
    heldItems: ["a small keepsake"],
  },
  vignette: {
    primaryName: "Nora",
    zoneLabel: "home",
    inTransit: false,
    activity: "preparing a meal",
    routineMusts: ["Nora is at home and stays there this turn.", "Nora is preparing a meal."],
  },
};

function context(overrides: Partial<SimSoloRenderContext> = {}): SimSoloRenderContext {
  return {
    storySecond: NOW,
    calendarStart: null,
    actorNames: { "actor-player": "Bri", "actor-primary": "Nora" },
    primary: { name: "Nora", profile: profile() },
    player: { name: "Bri" },
    solo: SOLO,
    playerUtterance: "I look around the square.",
    ...overrides,
  };
}

describe("buildSimSoloRenderPrompt", () => {
  it("renders a dual-block prompt with the away vignette and its routine MUSTs", () => {
    const { prompt } = buildSimSoloRenderPrompt(context());
    expect(prompt).toContain("BLOCK ONE");
    expect(prompt).toContain("BLOCK TWO");
    expect(prompt).toContain("SECOND PERSON");
    expect(prompt).toContain("Nora is at home and stays there this turn.");
    expect(prompt).toContain("Nora is preparing a meal.");
    // The vignette is audience-only, never player-character knowledge (ruling 21).
    expect(prompt).toContain("This glimpse is for the reader only");
    // The standing limits the narrator must respect.
    expect(prompt).toContain("CANNOT: move Nora to a different place");
    expect(prompt).toContain("phone or text Bri more than glancingly");
  });

  it("grounds the player-side block in the zone, co-present cast, and held items", () => {
    const { prompt } = buildSimSoloRenderPrompt(context());
    expect(prompt).toContain("Bri is at the town square.");
    expect(prompt).toContain("Sable (selling wares)");
    expect(prompt).toContain("In Bri's hands: a small keepsake.");
  });

  it("never leaks a raw zone or actor id into the prompt", () => {
    const { prompt } = buildSimSoloRenderPrompt(context());
    expect(prompt).not.toContain("actor-player");
    expect(prompt).not.toContain("actor-primary");
    expect(prompt).not.toContain("zone-");
  });

  it("narrates the farewell/walk/arrival arc when this is a chosen departure (slice 4)", () => {
    const { prompt } = buildSimSoloRenderPrompt(
      context({ departure: { farewellFrom: "Nora", fromLabel: "home", toLabel: "town square" } }),
    );
    // The departure line rides inside block one, before the where/here lines.
    expect(prompt).toContain("taking their leave of Nora at home and setting out for the town square");
    expect(prompt).toContain("Narrate the goodbye, the walk, and the arrival as one continuous moment");
    expect(prompt).not.toContain("zone-");
  });

  it("a solo departure (already away) narrates only the walk and arrival — no farewell", () => {
    const { prompt } = buildSimSoloRenderPrompt(context({ departure: { fromLabel: "home", toLabel: "town square" } }));
    expect(prompt).toContain("set out from home for the town square");
    expect(prompt).not.toContain("taking their leave");
  });

  it("omits the departure line entirely on an ordinary solo turn", () => {
    const { prompt } = buildSimSoloRenderPrompt(context());
    expect(prompt).not.toContain("This turn began with");
    expect(prompt).not.toContain("set out from");
  });

  it("omits block two and asks for block one alone when the vignette degraded away", () => {
    const soloNoVignette: SoloCutContext = { ...SOLO, vignette: undefined };
    const { prompt } = buildSimSoloRenderPrompt(context({ solo: soloNoVignette }));
    expect(prompt).toContain("BLOCK ONE");
    expect(prompt).not.toContain("BLOCK TWO");
    expect(prompt).toContain("Write only BLOCK ONE");
  });

  it("reframes a narrator-mode line as storyteller steering, not the player acting", () => {
    const { prompt } = buildSimSoloRenderPrompt(context({ narratorInput: true }));
    expect(prompt).toContain("STORY NARRATION from Bri");
    expect(prompt).toContain("Do NOT reply as if Bri said or did any of it");
  });

  it("shows an in-transit player with an ETA in the player-side block", () => {
    const transiting: SoloCutContext = {
      ...SOLO,
      playerSide: { zoneLabel: "", inTransit: true, transitToLabel: "town square", arrivesInSeconds: 240, coPresent: [], heldItems: [] },
    };
    const { prompt } = buildSimSoloRenderPrompt(context({ solo: transiting }));
    expect(prompt).toContain("Bri is on the move toward the town square — about 4 min to go.");
  });
});
