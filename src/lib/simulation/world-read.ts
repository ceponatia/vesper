import type { Journey, PhysicalLocus, SimulationLink } from "@/contracts/simulation/space";

/**
 * World-read shaping (world-ui.plan.md slice 1) — PURE. The player-facing world
 * surface (`readSimChatWorld` in `server/engine/sim-surfaces.ts`) loads the raw
 * simulation projections and resolves display labels; this module turns those
 * typed pieces into the id-free envelope the `ChatWorldCard` renders, plus the
 * small phrase helpers the card composes with (charter law — display labels,
 * never raw identifiers).
 *
 * No IO, no env, no db (src/lib purity): every zone/actor label arrives resolved
 * through a caller-supplied lookup, so no raw id ever reaches this shaping or the
 * card.
 */

// ---------------------------------------------------------------------------
// The world envelope (server return shape; the client re-parses it with zod)
// ---------------------------------------------------------------------------

export interface SimWorldPlace {
  /** Zone display noun ("home", "town square"). */
  label: string;
  /** Zone privacy policy ("public", …) — forward-compat for the ruling-13 vignette-privacy design. */
  privacy: string;
}

export interface SimWorldTransit {
  /** Destination display noun. */
  toLabel: string;
  /** Seconds until the player's earliest arrival, floored at 0. */
  arrivesInSeconds: number;
}

export interface SimWorldCastMember {
  name: string;
  /** "" when present with the player; else a short phrase ("at the town square", "on the move"). */
  whereabouts: string;
  present: boolean;
}

export interface SimWorldDestination {
  zoneId: string;
  /** Destination display noun. */
  label: string;
  /** Travel mode ("walk"). */
  mode: string;
  /** The link's lower-bound duration (§17.1). */
  travelSeconds: number;
}

export interface SimWorldHeldItem {
  itemId: string;
  name: string;
}

export interface SimChatWorld {
  /** Set when the player's locus is `at` a zone; null while in transit. */
  place: SimWorldPlace | null;
  /** Set when the player is `in_transit`; null when `at`. */
  transit: SimWorldTransit | null;
  cast: SimWorldCastMember[];
  /** Open walkable links from the player's current zone; empty while in transit. */
  destinations: SimWorldDestination[];
  held: SimWorldHeldItem[];
  /** A standing co-present engagement between the player and the primary exists. */
  sceneOpen: boolean;
}

// ---------------------------------------------------------------------------
// Server-side shapers (fed contract projections + label lookups)
// ---------------------------------------------------------------------------

/** Just the locus fields the whereabouts decision needs — both callers can build it cheaply. */
export interface WhereaboutsLocus {
  kind: "at" | "in_transit";
  /** The zone id when `at`; null while in transit. */
  zoneId: string | null;
}

/**
 * The shared present / on-the-move / elsewhere decision (the phrase machinery
 * `readSimChatPresence` and the world-read cast both use — one copy, so the two
 * surfaces can never drift). `zonePhraseOf` returns the full presence phrase for
 * a zone ("at the town square") or a fallback ("elsewhere").
 */
export function actorWhereabouts(input: {
  actorLocus: WhereaboutsLocus | undefined;
  playerLocus: WhereaboutsLocus | undefined;
  zonePhraseOf: (zoneId: string) => string;
}): { present: boolean; whereabouts: string } {
  const { actorLocus, playerLocus, zonePhraseOf } = input;
  if (!actorLocus) return { present: false, whereabouts: "elsewhere" };
  if (actorLocus.kind === "in_transit") return { present: false, whereabouts: "on the move" };
  if (
    playerLocus &&
    playerLocus.kind === "at" &&
    actorLocus.zoneId !== null &&
    actorLocus.zoneId === playerLocus.zoneId
  ) {
    return { present: true, whereabouts: "" };
  }
  return { present: false, whereabouts: actorLocus.zoneId === null ? "elsewhere" : zonePhraseOf(actorLocus.zoneId) };
}

/** The player's `place` OR `transit` (exactly one), from their locus + the journey ETA. */
export function buildWorldPlaceOrTransit(input: {
  playerLocus: PhysicalLocus | undefined;
  journeys: readonly Journey[];
  zoneLabelOf: (zoneId: string) => string;
  zonePrivacyOf: (zoneId: string) => string;
  atStorySecond: number;
}): { place: SimWorldPlace | null; transit: SimWorldTransit | null } {
  const { playerLocus, journeys, zoneLabelOf, zonePrivacyOf, atStorySecond } = input;
  if (!playerLocus) return { place: null, transit: null };
  if (playerLocus.kind === "at") {
    return {
      place: { label: zoneLabelOf(playerLocus.zoneId), privacy: zonePrivacyOf(playerLocus.zoneId) },
      transit: null,
    };
  }
  const journey = journeys.find((candidate) => candidate.id === playerLocus.journeyId);
  const arrivesInSeconds = Math.max(0, (journey?.earliestArrivalAt ?? playerLocus.earliestExitAt) - atStorySecond);
  return {
    place: null,
    transit: { toLabel: journey ? zoneLabelOf(journey.destinationZoneId) : "", arrivesInSeconds },
  };
}

/**
 * The open, walkable destinations reachable in one hop from the player's zone.
 * Links are UNDIRECTED for travel (matching the route planner's adjacency in
 * `lib/simulation/space.ts`), so a home→square link also offers square→home.
 * Empty while the player is in transit.
 */
export function buildWorldDestinations(input: {
  playerLocus: PhysicalLocus | undefined;
  links: readonly SimulationLink[];
  zoneLabelOf: (zoneId: string) => string;
}): SimWorldDestination[] {
  const { playerLocus, links, zoneLabelOf } = input;
  if (!playerLocus || playerLocus.kind !== "at") return [];
  const fromZone = playerLocus.zoneId;
  const destinations: SimWorldDestination[] = [];
  const seen = new Set<string>();
  for (const link of links) {
    if (link.state !== "open") continue;
    if (!link.modes.includes("walk")) continue;
    const toZone = link.fromZoneId === fromZone ? link.toZoneId : link.toZoneId === fromZone ? link.fromZoneId : null;
    if (toZone === null || seen.has(toZone)) continue;
    seen.add(toZone);
    destinations.push({ zoneId: toZone, label: zoneLabelOf(toZone), mode: "walk", travelSeconds: link.minimumDurationSeconds });
  }
  return destinations;
}

// ---------------------------------------------------------------------------
// Client-side phrasing (the card composes these; kept pure + unit-tested)
// ---------------------------------------------------------------------------

/** Legible walk minutes for a story-time delta, floored at 1 ("~5 min"). */
export function approxWalkMinutes(seconds: number): number {
  return Math.max(1, Math.round(seconds / 60));
}

/** "home" reads bare; every other place takes the article — the "to/at the {place}" form. */
export function placeGoPhrase(label: string): string {
  if (!label) return "somewhere nearby";
  return label === "home" ? "home" : `the ${label}`;
}

/** The destination chip label: "Go home" / "Go to the town square". */
export function goChipLabel(label: string): string {
  if (!label) return "Go";
  return label === "home" ? "Go home" : `Go to the ${label}`;
}

/** Capitalize the first character (for the place line, "at home" → "At home"). */
export function capitalizeFirst(text: string): string {
  return text.length === 0 ? text : `${text[0]?.toUpperCase() ?? ""}${text.slice(1)}`;
}
