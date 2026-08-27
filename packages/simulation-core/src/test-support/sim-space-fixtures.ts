import type { z } from "zod";
import {
  journeySchema,
  linkSchema,
  locationSchema,
  physicalLocusSchema,
  zoneSchema,
  GATE3_ROUTE_VERSION,
  type Journey,
  type PhysicalLocus,
} from "../contracts/space";
import type { SpaceTopology } from "../lib/space";

/**
 * The locus/journey/topology fixtures the space suites share
 * (solo-cut, travel-settle, world-read, move-together, commitments, space).
 *
 * Every builder goes through its contract schema — a plain object literal typed
 * as `PhysicalLocus`/`Journey` would require the caller to already hold branded
 * ids, which these tests deliberately don't carry, and the `as unknown as
 * SpaceTopology` casts the topology builders used skipped validation entirely.
 */

export const SPACE_PLAYER = "actor-player";
export const SPACE_PRIMARY = "actor-primary";
export const SPACE_NEIGHBOR = "actor-neighbor";

export const SPACE_LOCATION = "loc-town";
export const SPACE_HOME_ZONE = "zone-home";
export const SPACE_SQUARE_ZONE = "zone-square";
export const SPACE_HOME_SQUARE_LINK = "link-home-square";

/** 08:00 on day one — the story second the world-read/solo-cut fixtures freeze at. */
export const SPACE_NOW = 8 * 3_600;

/** The leg duration a locus in transit still owes before it may exit. */
export const SPACE_TRANSIT_SECONDS = 300;

/**
 * The route derivation stamp a journey must carry. Re-exported from the
 * contract so the fixture can never drift from the literal the schema pins.
 */
export const SPACE_ROUTE_VERSION = GATE3_ROUTE_VERSION;

/** An actor standing in a zone. */
export function atLocus(
  actorId: string,
  zoneId: string,
  options: { locationId?: string; since?: number } = {},
): PhysicalLocus {
  return physicalLocusSchema.parse({
    kind: "at",
    actorId,
    locationId: options.locationId ?? SPACE_LOCATION,
    zoneId,
    since: options.since ?? SPACE_NOW,
  });
}

/** An actor mid-leg. Not at the origin and not at the destination — one row. */
export function transitLocus(
  actorId: string,
  journeyId: string,
  options: { linkId?: string; enteredAt?: number; earliestExitAt?: number } = {},
): PhysicalLocus {
  const enteredAt = options.enteredAt ?? SPACE_NOW;
  return physicalLocusSchema.parse({
    kind: "in_transit",
    actorId,
    journeyId,
    linkId: options.linkId ?? SPACE_HOME_SQUARE_LINK,
    enteredAt,
    earliestExitAt: options.earliestExitAt ?? enteredAt + SPACE_TRANSIT_SECONDS,
  });
}

/**
 * An active one-leg walk from home. `expectedArrivalAt` defaults to
 * `earliestArrivalAt`: a delay that slips expected PAST earliest is the
 * interesting case, so it is always stated explicitly.
 */
export function journeyTo(
  id: string,
  options: {
    actorIds?: readonly string[];
    originZoneId?: string;
    destinationZoneId?: string;
    routeLinkIds?: readonly string[];
    travelMode?: string;
    earliestArrivalAt?: number;
    expectedArrivalAt?: number;
    status?: string;
    currentLinkIndex?: number;
  } = {},
): Journey {
  const earliestArrivalAt = options.earliestArrivalAt ?? SPACE_NOW + SPACE_TRANSIT_SECONDS;
  return journeySchema.parse({
    id,
    actorIds: options.actorIds ?? [SPACE_PLAYER],
    originZoneId: options.originZoneId ?? SPACE_HOME_ZONE,
    destinationZoneId: options.destinationZoneId ?? SPACE_SQUARE_ZONE,
    routeLinkIds: options.routeLinkIds ?? [SPACE_HOME_SQUARE_LINK],
    travelMode: options.travelMode ?? "walk",
    earliestArrivalAt,
    expectedArrivalAt: options.expectedArrivalAt ?? earliestArrivalAt,
    status: options.status ?? "active",
    currentLinkIndex: options.currentLinkIndex ?? 0,
    routeDerivationVersion: SPACE_ROUTE_VERSION,
  });
}

/** The default walk between the two topology zones. */
export const WALK_LINK_SECONDS = 600;

const DEFAULT_LOCATIONS: readonly z.input<typeof locationSchema>[] = [
  { id: "loc-home", worldId: "world-1", kind: "home", defaultAccessPolicy: "private" },
  { id: "loc-cafe", worldId: "world-1", kind: "cafe", defaultAccessPolicy: "public" },
];

const DEFAULT_ZONES: readonly z.input<typeof zoneSchema>[] = [
  { id: "zone-a", locationId: "loc-home", kind: "room", privacyPolicy: "private" },
  { id: "zone-b", locationId: "loc-cafe", kind: "hall", privacyPolicy: "public" },
];

const DEFAULT_LINKS: readonly z.input<typeof linkSchema>[] = [
  {
    id: "link-ab",
    fromZoneId: "zone-a",
    toZoneId: "zone-b",
    modes: ["walk"],
    minimumDurationSeconds: WALK_LINK_SECONDS,
    accessPolicy: "public",
    state: "open",
  },
];

export interface WalkTopologySpec {
  locations?: readonly z.input<typeof locationSchema>[];
  zones?: readonly z.input<typeof zoneSchema>[];
  links?: readonly z.input<typeof linkSchema>[];
}

/**
 * The shared two-zone walking topology: a private room at home, a public hall at
 * the cafe, one open walk-only link between them. Override any tier wholesale
 * for a suite that needs more zones or a private/drive link.
 */
export function walkTopology(spec: WalkTopologySpec = {}): SpaceTopology {
  return {
    locations: (spec.locations ?? DEFAULT_LOCATIONS).map((location) => locationSchema.parse(location)),
    zones: (spec.zones ?? DEFAULT_ZONES).map((zone) => zoneSchema.parse(zone)),
    links: (spec.links ?? DEFAULT_LINKS).map((link) => linkSchema.parse(link)),
  };
}
