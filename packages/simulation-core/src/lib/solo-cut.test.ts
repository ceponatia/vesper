import { describe, expect, it } from "vitest";
import { activityInstanceSchema, type ActivityInstance } from "../contracts/activities";
import { commitmentSchema, type Commitment } from "../contracts/commitments";
import {
  atLocus,
  journeyTo,
  transitLocus,
  SPACE_HOME_ZONE,
  SPACE_NEIGHBOR,
  SPACE_NOW,
  SPACE_PLAYER,
  SPACE_PRIMARY,
  SPACE_SQUARE_ZONE,
} from "../test-support/sim-space-fixtures";
import {
  buildSoloFallbackProse,
  buildSoloPlayerSide,
  buildSoloVignette,
  placeAtPhrase,
  type SoloCutContext,
} from "./solo-cut";

/**
 * Pure solo-cut shaping tests. No IO — every projection piece is a fixture
 * (@/test/sim-space-fixtures), so the two-block context and its deterministic
 * fallback prose are asserted directly.
 */

const PLAYER = SPACE_PLAYER;
const PRIMARY = SPACE_PRIMARY;
const NEIGHBOR = SPACE_NEIGHBOR;
const HOME = SPACE_HOME_ZONE;
const SQUARE = SPACE_SQUARE_ZONE;
const NOW = SPACE_NOW;

const LABELS: Record<string, string> = { [HOME]: "home", [SQUARE]: "town square" };
const NAMES: Record<string, string> = { [PLAYER]: "Bri", [PRIMARY]: "Nora", [NEIGHBOR]: "Sable" };
const zoneLabelOf = (zoneId: string): string => LABELS[zoneId] ?? zoneId;
const actorNameOf = (actorId: string): string => NAMES[actorId] ?? actorId;

function activity(actorId: string, actionDefinitionId: string, zoneId: string): ActivityInstance {
  return activityInstanceSchema.parse({
    id: `act-${actorId}`,
    actionDefinitionId,
    actionVersion: 1,
    actorIds: [actorId],
    zoneId,
    phase: "active",
    progressFixedPoint: 0,
    claims: [],
    reservedItemIds: [],
    sourceCommandId: "cmd-x",
  });
}

function commitment(overrides: Partial<Record<string, unknown>> = {}): Commitment {
  return commitmentSchema.parse({
    id: "commit-1",
    actorId: PRIMARY,
    kind: "shift",
    destinationZoneId: SQUARE,
    window: { latestArrival: NOW + 45 * 60 },
    priority: 5,
    flexibility: "firm",
    preparationSeconds: 0,
    reliabilityBufferSeconds: 0,
    noticeLeadSeconds: 0,
    status: "accepted",
    knowledgeSource: { kind: "authored" },
    sourceCommandId: "cmd-c",
    ...overrides,
  });
}

describe("placeAtPhrase", () => {
  it("drops the article for home and keeps it elsewhere", () => {
    expect(placeAtPhrase("home")).toBe("at home");
    expect(placeAtPhrase("town square")).toBe("at the town square");
    expect(placeAtPhrase("")).toBe("somewhere nearby");
  });
});

describe("buildSoloPlayerSide", () => {
  it("lists co-present NPCs at the player's zone, never the primary, with held items", () => {
    const side = buildSoloPlayerSide({
      playerActorId: PLAYER,
      primaryActorId: PRIMARY,
      loci: [atLocus(PLAYER, SQUARE), atLocus(PRIMARY, HOME), atLocus(NEIGHBOR, SQUARE)],
      journeys: [],
      activities: [activity(NEIGHBOR, "rest", SQUARE)],
      heldItems: ["a small keepsake"],
      zoneLabelOf,
      actorNameOf,
      atStorySecond: NOW,
    });
    expect(side.inTransit).toBe(false);
    expect(side.zoneLabel).toBe("town square");
    expect(side.coPresent).toEqual([{ name: "Sable", activity: "resting" }]);
    expect(side.coPresent.some((a) => a.name === "Nora")).toBe(false);
    expect(side.heldItems).toEqual(["a small keepsake"]);
  });

  it("reports an in-transit player with the journey destination and ETA, and no co-present list", () => {
    const side = buildSoloPlayerSide({
      playerActorId: PLAYER,
      primaryActorId: PRIMARY,
      loci: [transitLocus(PLAYER, "jrn-1"), atLocus(NEIGHBOR, SQUARE)],
      journeys: [journeyTo("jrn-1", { destinationZoneId: SQUARE, earliestArrivalAt: NOW + 240 })],
      activities: [],
      heldItems: [],
      zoneLabelOf,
      actorNameOf,
      atStorySecond: NOW,
    });
    expect(side.inTransit).toBe(true);
    expect(side.transitToLabel).toBe("town square");
    expect(side.arrivesInSeconds).toBe(240);
    expect(side.coPresent).toEqual([]);
  });
});

describe("buildSoloVignette", () => {
  it("renders id-free routine MUSTs from location, activity, and a due commitment", () => {
    const vignette = buildSoloVignette({
      primaryActorId: PRIMARY,
      primaryName: "Nora",
      loci: [atLocus(PRIMARY, HOME)],
      journeys: [],
      activities: [activity(PRIMARY, "prepare_meal", HOME)],
      commitments: [commitment()],
      zoneLabelOf,
      atStorySecond: NOW,
    });
    expect(vignette.inTransit).toBe(false);
    expect(vignette.zoneLabel).toBe("home");
    expect(vignette.activity).toBe("preparing a meal");
    expect(vignette.routineMusts).toEqual([
      "Nora is at home and stays there this turn.",
      "Nora is preparing a meal.",
      "Nora is due at the town square within about an hour (a shift).",
    ]);
    // Charter law: no raw id or clock second leaks into a MUST line.
    for (const must of vignette.routineMusts) {
      expect(must).not.toContain("zone-");
      expect(must).not.toContain("actor-");
      expect(must).not.toMatch(/\d{4,}/);
    }
  });

  it("ignores commitments belonging to other actors and non-open statuses", () => {
    const vignette = buildSoloVignette({
      primaryActorId: PRIMARY,
      primaryName: "Nora",
      loci: [atLocus(PRIMARY, HOME)],
      journeys: [],
      activities: [],
      commitments: [
        commitment({ id: "c-other", actorId: PLAYER }),
        commitment({ id: "c-done", status: "kept" }),
      ],
      zoneLabelOf,
      atStorySecond: NOW,
    });
    expect(vignette.routineMusts).toEqual(["Nora is at home and stays there this turn."]);
  });

  it("frames a travelling primary as bound to the journey", () => {
    const vignette = buildSoloVignette({
      primaryActorId: PRIMARY,
      primaryName: "Nora",
      loci: [transitLocus(PRIMARY, "jrn-2")],
      journeys: [journeyTo("jrn-2", { destinationZoneId: SQUARE, earliestArrivalAt: NOW + 120 })],
      activities: [],
      commitments: [],
      zoneLabelOf,
      atStorySecond: NOW,
    });
    expect(vignette.inTransit).toBe(true);
    expect(vignette.routineMusts[0]).toBe("Nora is on the way to the town square and cannot be anywhere else.");
  });
});

describe("buildSoloFallbackProse", () => {
  it("is always non-empty and dual-block when a vignette is present", () => {
    const context: SoloCutContext = {
      playerName: "Bri",
      primaryName: "Nora",
      playerSide: { zoneLabel: "town square", inTransit: false, coPresent: [{ name: "Sable" }], heldItems: ["a keepsake"] },
      vignette: { primaryName: "Nora", zoneLabel: "home", inTransit: false, routineMusts: [] },
    };
    const prose = buildSoloFallbackProse(context);
    expect(prose).toContain("You take a moment at the town square");
    expect(prose).toContain("Sable");
    expect(prose).toContain("a keepsake");
    expect(prose).toContain("Elsewhere, Nora goes about the day at home");
    expect(prose.split("\n\n")).toHaveLength(2);
  });

  it("degrades to block one alone (still non-empty) when the vignette is absent", () => {
    const context: SoloCutContext = {
      playerName: "Bri",
      primaryName: "Nora",
      playerSide: { zoneLabel: "", inTransit: true, transitToLabel: "town square", coPresent: [], heldItems: [] },
    };
    const prose = buildSoloFallbackProse(context);
    expect(prose.length).toBeGreaterThan(0);
    expect(prose).toContain("on your way to the town square");
    expect(prose).toContain("Elsewhere, Nora");
  });
});
