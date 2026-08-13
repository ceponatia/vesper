import { describe, expect, it } from "vitest";
import { linkSchema, type SimulationLink } from "@vesper/simulation-core/contracts/space";
import { chatWorldSchema, simTravelResultSchema } from "@/lib/client/api";
import {
  atLocus,
  journeyTo,
  transitLocus,
  SPACE_HOME_ZONE,
  SPACE_NOW,
  SPACE_PLAYER,
  SPACE_SQUARE_ZONE,
} from "@vesper/simulation-core/testing/sim-space-fixtures";
import {
  actionChipLabel,
  actorWhereabouts,
  approxActivityMinutes,
  approxWalkMinutes,
  buildWorldActions,
  buildWorldDestinations,
  buildWorldPlaceOrTransit,
  capitalizeFirst,
  goChipLabel,
  placeGoPhrase,
  type WorldActionCandidate,
} from "@vesper/simulation-core/world-read";

/**
 * Pure world-read shaping tests (world-ui.plan.md slice 1). No IO — every
 * projection piece is a fixture (@/test/sim-space-fixtures), so the place/transit
 * envelope, the undirected destination derivation, the shared whereabouts
 * decision, the card phrasing, and the travel-response parsing are asserted
 * directly.
 */

const PLAYER = SPACE_PLAYER;
const HOME = SPACE_HOME_ZONE;
const SQUARE = SPACE_SQUARE_ZONE;
const NOW = SPACE_NOW;

const LABELS: Record<string, string> = { [HOME]: "home", [SQUARE]: "town square" };
const PHRASES: Record<string, string> = { [HOME]: "at home", [SQUARE]: "at the town square" };
const zoneLabelOf = (zoneId: string): string => LABELS[zoneId] ?? zoneId;
const zonePrivacyOf = (): string => "public";
const zonePhraseOf = (zoneId: string): string => PHRASES[zoneId] ?? "elsewhere";

function walkLink(from: string, to: string, seconds = 300): SimulationLink {
  return linkSchema.parse({
    id: `link-${from}-${to}`,
    fromZoneId: from,
    toZoneId: to,
    modes: ["walk"],
    minimumDurationSeconds: seconds,
    accessPolicy: "public",
    state: "open",
  });
}

describe("buildWorldPlaceOrTransit", () => {
  it("reports the player's place with label + privacy when `at`", () => {
    const { place, transit } = buildWorldPlaceOrTransit({
      playerLocus: atLocus(PLAYER, SQUARE),
      journeys: [],
      zoneLabelOf,
      zonePrivacyOf,
      atStorySecond: NOW,
    });
    expect(place).toEqual({ label: "town square", privacy: "public" });
    expect(transit).toBeNull();
  });

  it("reports transit with destination label + floored ETA from the journey", () => {
    const journey = journeyTo("j1", { destinationZoneId: SQUARE, earliestArrivalAt: NOW + 300 });
    const { place, transit } = buildWorldPlaceOrTransit({
      playerLocus: transitLocus(PLAYER, "j1", { earliestExitAt: NOW + 300 }),
      journeys: [journey],
      zoneLabelOf,
      zonePrivacyOf,
      atStorySecond: NOW + 60,
    });
    expect(place).toBeNull();
    expect(transit).toEqual({ toLabel: "town square", arrivesInSeconds: 240 });
  });

  it("floors a past ETA at 0 and falls back to the locus exit when the journey is missing", () => {
    const { transit } = buildWorldPlaceOrTransit({
      playerLocus: transitLocus(PLAYER, "gone", { earliestExitAt: NOW + 100 }),
      journeys: [],
      zoneLabelOf,
      zonePrivacyOf,
      atStorySecond: NOW + 500,
    });
    expect(transit).toEqual({ toLabel: "", arrivesInSeconds: 0 });
  });

  it("is empty for an unknown locus", () => {
    expect(buildWorldPlaceOrTransit({ playerLocus: undefined, journeys: [], zoneLabelOf, zonePrivacyOf, atStorySecond: NOW })).toEqual({
      place: null,
      transit: null,
    });
  });
});

describe("buildWorldDestinations", () => {
  const links = [walkLink(HOME, SQUARE)];

  it("offers the adjacent zone from the player's current zone (forward direction)", () => {
    expect(buildWorldDestinations({ playerLocus: atLocus(PLAYER, HOME), links, zoneLabelOf })).toEqual([
      { zoneId: SQUARE, label: "town square", mode: "walk", travelSeconds: 300 },
    ]);
  });

  it("treats links as undirected — a home→square link also offers square→home", () => {
    expect(buildWorldDestinations({ playerLocus: atLocus(PLAYER, SQUARE), links, zoneLabelOf })).toEqual([
      { zoneId: HOME, label: "home", mode: "walk", travelSeconds: 300 },
    ]);
  });

  it("is empty while the player is in transit", () => {
    expect(
      buildWorldDestinations({ playerLocus: transitLocus(PLAYER, "j1", { earliestExitAt: NOW + 300 }), links, zoneLabelOf }),
    ).toEqual([]);
  });

  it("excludes closed links and non-walkable links", () => {
    const closed = linkSchema.parse({ ...walkLink(HOME, SQUARE), state: "closed" });
    expect(buildWorldDestinations({ playerLocus: atLocus(PLAYER, HOME), links: [closed], zoneLabelOf })).toEqual([]);
    const drive = linkSchema.parse({ ...walkLink(HOME, SQUARE), modes: ["drive"] });
    expect(buildWorldDestinations({ playerLocus: atLocus(PLAYER, HOME), links: [drive], zoneLabelOf })).toEqual([]);
  });
});

describe("actorWhereabouts", () => {
  const playerAtHome = { kind: "at" as const, zoneId: HOME };

  it("is present when co-located with the player", () => {
    expect(actorWhereabouts({ actorLocus: { kind: "at", zoneId: HOME }, playerLocus: playerAtHome, zonePhraseOf })).toEqual({
      present: true,
      whereabouts: "",
    });
  });

  it("reads 'on the move' while in transit", () => {
    expect(actorWhereabouts({ actorLocus: { kind: "in_transit", zoneId: null }, playerLocus: playerAtHome, zonePhraseOf })).toEqual({
      present: false,
      whereabouts: "on the move",
    });
  });

  it("gives the zone phrase when apart from the player", () => {
    expect(actorWhereabouts({ actorLocus: { kind: "at", zoneId: SQUARE }, playerLocus: playerAtHome, zonePhraseOf })).toEqual({
      present: false,
      whereabouts: "at the town square",
    });
  });

  it("is 'elsewhere' for an unknown locus", () => {
    expect(actorWhereabouts({ actorLocus: undefined, playerLocus: playerAtHome, zonePhraseOf })).toEqual({
      present: false,
      whereabouts: "elsewhere",
    });
  });
});

describe("buildWorldActions", () => {
  const rest: WorldActionCandidate = {
    id: "stw-x1-action-rest",
    label: "Rest",
    controllerKinds: ["player", "npc_policy"],
    durationSeconds: 600,
    requiredZoneKinds: ["home"],
    needsConsent: false,
  };

  it("marks a zone-gated action available at the matching zone kind", () => {
    expect(buildWorldActions({ candidates: [rest], playerZoneKind: "home" })).toEqual([
      { id: "stw-x1-action-rest", label: "Rest", durationSeconds: 600, available: true },
    ]);
  });

  it("marks it unavailable (with a reason) at a non-matching zone kind", () => {
    const [action] = buildWorldActions({ candidates: [rest], playerZoneKind: "plaza" });
    expect(action).toMatchObject({ available: false, unavailableReason: "This is not the place for that." });
  });

  it("marks everything unavailable while the player is in transit (null zone)", () => {
    const [action] = buildWorldActions({ candidates: [rest], playerZoneKind: null });
    expect(action).toMatchObject({ available: false, unavailableReason: "Not while you're on the move." });
  });

  it("offers a no-precondition action anywhere the player is `at`", () => {
    const anywhere: WorldActionCandidate = { ...rest, id: "a-stretch", requiredZoneKinds: [] };
    expect(buildWorldActions({ candidates: [anywhere], playerZoneKind: "plaza" })[0]?.available).toBe(true);
  });

  it("drops actions the player cannot control", () => {
    const npcOnly: WorldActionCandidate = { ...rest, controllerKinds: ["npc_policy"] };
    expect(buildWorldActions({ candidates: [npcOnly], playerZoneKind: "home" })).toEqual([]);
  });

  it("marks a consent-gated action unavailable (the card can't gather consent)", () => {
    const intimate: WorldActionCandidate = { ...rest, requiredZoneKinds: [], needsConsent: true };
    const [action] = buildWorldActions({ candidates: [intimate], playerZoneKind: "home" });
    expect(action).toMatchObject({ available: false, unavailableReason: "That needs someone else's say-so." });
  });
});

describe("actionChipLabel", () => {
  it("prefers an authored label", () => {
    expect(actionChipLabel("stw-x1-action-rest", "Rest")).toBe("Rest");
    expect(actionChipLabel("stw-x1-action-rest", "  Take a nap ")).toBe("Take a nap");
  });

  it("falls back to a title-cased last id segment when unlabeled", () => {
    expect(actionChipLabel("stw-x1-action-rest")).toBe("Rest");
    expect(actionChipLabel("stw-x1-action-rest", "   ")).toBe("Rest");
  });
});

describe("card phrasing", () => {
  it("rounds activity minutes with a floor of 1", () => {
    expect(approxActivityMinutes(600)).toBe(10);
    expect(approxActivityMinutes(30)).toBe(1);
  });

  it("rounds walk minutes with a floor of 1", () => {
    expect(approxWalkMinutes(300)).toBe(5);
    expect(approxWalkMinutes(240)).toBe(4);
    expect(approxWalkMinutes(30)).toBe(1);
    expect(approxWalkMinutes(0)).toBe(1);
  });

  it("phrases the go-target and chip labels, articling everything but home", () => {
    expect(placeGoPhrase("home")).toBe("home");
    expect(placeGoPhrase("town square")).toBe("the town square");
    expect(placeGoPhrase("")).toBe("somewhere nearby");
    expect(goChipLabel("home")).toBe("Go home");
    expect(goChipLabel("town square")).toBe("Go to the town square");
  });

  it("capitalizes the place line", () => {
    expect(capitalizeFirst("at home")).toBe("At home");
    expect(capitalizeFirst("")).toBe("");
  });
});

describe("client response parsing", () => {
  it("parses the world envelope, dropping malformed cast/destination/action rows", () => {
    const parsed = chatWorldSchema.parse({
      place: { label: "home", privacy: "public" },
      transit: null,
      cast: [{ actorId: "actor-nora", name: "Nora", whereabouts: "", present: true, isPrimary: true }, "garbage"],
      destinations: [{ zoneId: SQUARE, label: "town square", mode: "walk", travelSeconds: 300 }, { label: "no id" }],
      held: [{ itemId: "item-1", name: "a keepsake" }],
      actions: [{ id: "action-rest", label: "Rest", durationSeconds: 600, available: true }, { label: "no id" }],
      sceneOpen: true,
    });
    expect(parsed.place).toEqual({ label: "home", privacy: "public" });
    expect(parsed.cast).toHaveLength(1);
    expect(parsed.cast[0]?.actorId).toBe("actor-nora");
    expect(parsed.cast[0]?.isPrimary).toBe(true);
    expect(parsed.destinations).toHaveLength(1);
    expect(parsed.held[0]).toEqual({ itemId: "item-1", name: "a keepsake" });
    expect(parsed.actions).toHaveLength(1);
    expect(parsed.actions[0]).toMatchObject({ id: "action-rest", label: "Rest", durationSeconds: 600, available: true });
    expect(parsed.sceneOpen).toBe(true);
  });

  it("parses a travel landing and a §14.4 refusal", () => {
    expect(
      simTravelResultSchema.parse({ status: "traveled", toStorySecond: 30_000, arrived: false, drainShort: true }),
    ).toMatchObject({
      status: "traveled",
      toStorySecond: 30_000,
      arrived: false,
      drainShort: true,
    });
    const refusal = simTravelResultSchema.parse({
      status: "rejected",
      code: "link_closed",
      publicReason: "The way is shut.",
      legalAlternatives: ["move"],
    });
    expect(refusal.status).toBe("rejected");
    expect(refusal.publicReason).toBe("The way is shut.");
    expect(refusal.legalAlternatives).toEqual(["move"]);
  });
});
