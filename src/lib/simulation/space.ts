import { composeSimulationId } from "@/contracts/simulation/identity";
import {
  journeyArrivalTriggerKind,
  schedulerDerivationVersion,
  triggerScheduledEventSchema,
  type TriggerScheduledEvent,
} from "@/contracts/simulation/scheduler";
import {
  GATE3_ROUTE_VERSION,
  actorArrivedEventSchema,
  actorDepartedEventSchema,
  journeyPlannedEventSchema,
  journeySchema,
  physicalLocusSchema,
  routeResultSchema,
  spaceProjectionSchema,
  type ActorArrivedEvent,
  type ActorDepartedEvent,
  type ArriveJourneyCommand,
  type ArriveJourneyRejectionCode,
  type Journey,
  type JourneyPlannedEvent,
  type MoveActorCommand,
  type MoveActorRejectionCode,
  type PhysicalLocus,
  type RouteResult,
  type SimulationLink,
  type SimulationLocation,
  type SimulationZone,
  type SpaceProjection,
  type TravelMode,
} from "@/contracts/simulation/space";
import type { SimulationBranchEvent } from "@/contracts/simulation/branching";

/**
 * E3.1 pure space kernel: deterministic route planning, the move/arrival
 * resolvers, and the projectors replay uses to rebuild space state from
 * events. No IO, no clock, no ambient randomness (engine.spec §31–32).
 */

export interface SpaceTopology {
  locations: readonly SimulationLocation[];
  zones: readonly SimulationZone[];
  links: readonly SimulationLink[];
}

function compareStableText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function sortedUnique<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].sort(compareStableText);
}

function zoneLocationId(topology: SpaceTopology, zoneId: string): string {
  const zone = topology.zones.find((candidate) => candidate.id === zoneId);
  if (!zone) throw new Error(`Space topology is missing zone ${zoneId}`);
  return zone.locationId;
}

// ---------------------------------------------------------------------------
// Route planning (engine.spec §13.3)
// ---------------------------------------------------------------------------

export type RoutePlanFailureReason = "no_route" | "route_access_denied" | "travel_mode_unavailable";

export type RoutePlan =
  | { ok: true; route: RouteResult }
  | { ok: false; reason: RoutePlanFailureReason };

interface RouteSearchConstraints {
  /** When false, a link's travel-mode list is ignored (diagnosis pass only). */
  enforceMode: boolean;
  /** When false, a link's access policy is ignored (diagnosis pass only). */
  enforceAccess: boolean;
}

interface RouteSearchHit {
  linkIds: string[];
  durationSeconds: number;
}

function comparePaths(left: readonly string[], right: readonly string[]): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const order = compareStableText(left[index] ?? "", right[index] ?? "");
    if (order !== 0) return order;
  }
  return left.length - right.length;
}

/**
 * Deterministic lowest-duration search. Links are traversed in either
 * direction (a hallway works both ways; one-way semantics can join the link
 * contract when a scenario demands them). Ties break by zone id at selection
 * and by lexicographic link-id path at relaxation, so equal-cost topologies
 * produce one canonical route (engine.spec §32: no iteration-order accidents).
 */
function searchRoute(
  topology: SpaceTopology,
  originZoneId: string,
  destinationZoneId: string,
  travelMode: TravelMode,
  constraints: RouteSearchConstraints,
): RouteSearchHit | null {
  const passable = topology.links.filter((link) => {
    if (link.state !== "open") return false;
    if (constraints.enforceAccess && link.accessPolicy !== "public") return false;
    if (constraints.enforceMode && !link.modes.includes(travelMode)) return false;
    return true;
  });

  const adjacency = new Map<string, { linkId: string; toZoneId: string; durationSeconds: number }[]>();
  for (const link of passable) {
    for (const [from, to] of [
      [link.fromZoneId, link.toZoneId],
      [link.toZoneId, link.fromZoneId],
    ] as const) {
      const edges = adjacency.get(from) ?? [];
      edges.push({ linkId: link.id, toZoneId: to, durationSeconds: link.minimumDurationSeconds });
      adjacency.set(from, edges);
    }
  }
  for (const edges of adjacency.values()) {
    edges.sort((left, right) => compareStableText(left.linkId, right.linkId));
  }

  const best = new Map<string, { durationSeconds: number; linkIds: string[] }>();
  best.set(originZoneId, { durationSeconds: 0, linkIds: [] });
  const settled = new Set<string>();

  for (;;) {
    let currentZoneId: string | null = null;
    for (const [zoneId, candidate] of best) {
      if (settled.has(zoneId)) continue;
      const current = currentZoneId ? best.get(currentZoneId) : undefined;
      if (
        !current ||
        candidate.durationSeconds < current.durationSeconds ||
        (candidate.durationSeconds === current.durationSeconds &&
          compareStableText(zoneId, currentZoneId ?? "") < 0)
      ) {
        currentZoneId = zoneId;
      }
    }
    if (currentZoneId === null) return null;
    if (currentZoneId === destinationZoneId) {
      const hit = best.get(currentZoneId);
      if (!hit || hit.linkIds.length === 0) return null;
      return { linkIds: hit.linkIds, durationSeconds: hit.durationSeconds };
    }
    settled.add(currentZoneId);

    const from = best.get(currentZoneId);
    if (!from) return null;
    for (const edge of adjacency.get(currentZoneId) ?? []) {
      // A route may not reuse a link; the contract's unique-link refinement
      // makes a self-crossing path unrepresentable rather than surprising.
      if (from.linkIds.includes(edge.linkId)) continue;
      const candidate = {
        durationSeconds: from.durationSeconds + edge.durationSeconds,
        linkIds: [...from.linkIds, edge.linkId],
      };
      const existing = best.get(edge.toZoneId);
      if (
        !existing ||
        candidate.durationSeconds < existing.durationSeconds ||
        (candidate.durationSeconds === existing.durationSeconds &&
          comparePaths(candidate.linkIds, existing.linkIds) < 0)
      ) {
        best.set(edge.toZoneId, candidate);
      }
    }
  }
}

/**
 * Plan a route or explain deterministically why none exists. E3.1 enforces
 * link-level access only (state open + public policy); the six-layer zone and
 * property checks are E3.5's fail-closed layer on top. Diagnosis relaxes one
 * constraint at a time so the rejection names the binding restriction.
 */
export function planRoute(
  topology: SpaceTopology,
  request: { originZoneId: string; destinationZoneId: string; travelMode: TravelMode },
): RoutePlan {
  if (request.originZoneId === request.destinationZoneId) {
    throw new Error("Route planning requires distinct origin and destination zones");
  }
  const constrained = searchRoute(topology, request.originZoneId, request.destinationZoneId, request.travelMode, {
    enforceMode: true,
    enforceAccess: true,
  });
  if (constrained) {
    return {
      ok: true,
      route: routeResultSchema.parse({
        originZoneId: request.originZoneId,
        destinationZoneId: request.destinationZoneId,
        linkIds: constrained.linkIds,
        travelMode: request.travelMode,
        minimumDurationSeconds: constrained.durationSeconds,
        // Uncertainty stays zero until a scenario funds a duration
        // distribution; delays are explicit journey_delayed events.
        expectedDurationSeconds: constrained.durationSeconds,
        uncertaintySeconds: 0,
        knownHazards: [],
        derivationVersion: GATE3_ROUTE_VERSION,
      }),
    };
  }
  const accessRelaxed = searchRoute(topology, request.originZoneId, request.destinationZoneId, request.travelMode, {
    enforceMode: true,
    enforceAccess: false,
  });
  if (accessRelaxed) return { ok: false, reason: "route_access_denied" };
  const modeRelaxed = searchRoute(topology, request.originZoneId, request.destinationZoneId, request.travelMode, {
    enforceMode: false,
    enforceAccess: true,
  });
  if (modeRelaxed) return { ok: false, reason: "travel_mode_unavailable" };
  return { ok: false, reason: "no_route" };
}

// ---------------------------------------------------------------------------
// MoveActor resolution (engine.spec §14.1, §17)
// ---------------------------------------------------------------------------

interface SpaceBranchMeta {
  worldId: SpaceProjection["worldId"];
  branchId: SpaceProjection["branchId"];
  rulesetVersion: SpaceProjection["rulesetVersion"];
  version: SpaceProjection["version"];
  headSequence: SpaceProjection["headSequence"];
  storySecond: SpaceProjection["storySecond"];
}

export interface MoveActorResolutionView extends SpaceBranchMeta {
  topology: SpaceTopology;
  /** Present when the actor exists in the branch's registry. */
  actorExists: boolean;
  /** The actor's current locus; every registered actor has exactly one. */
  locus?: PhysicalLocus;
  /**
   * Whether a claim-holding activity currently occupies the actor's body
   * (E3.2). Spec §3.1 invariant 4: departure would create incompatible
   * exclusive claims, so the activity must end or be cancelled first.
   */
  actorHoldsBodyClaim: boolean;
}

interface MoveRejection {
  ok: false;
  code: MoveActorRejectionCode;
  publicReason: string;
}

export interface MoveResolution {
  ok: true;
  route: RouteResult;
  journey: Journey;
  locus: PhysicalLocus;
  events: [JourneyPlannedEvent, ActorDepartedEvent, TriggerScheduledEvent];
}

function moveRejection(code: MoveActorRejectionCode, publicReason: string): MoveRejection {
  return { ok: false, code, publicReason };
}

export function deriveJourneyId(branchId: string, commandId: string): string {
  return composeSimulationId("journey", [branchId, commandId]);
}

/** The stable per-journey key the arrival trigger schedules under. */
export function journeyArrivalUniquenessKey(journeyId: string): string {
  return composeSimulationId("journey-arrival", [journeyId]);
}

/** Pure MoveActor resolver over a lock-consistent authority view. */
export function resolveMoveActor(
  view: MoveActorResolutionView,
  command: MoveActorCommand,
): MoveRejection | MoveResolution {
  if (command.branchId !== view.branchId) {
    return moveRejection("branch_mismatch", "That world branch is unavailable.");
  }
  if (!view.actorExists) return moveRejection("actor_not_found", "That actor is unavailable.");
  if (!command.principal.controlledActorIds.includes(command.payload.actorId)) {
    return moveRejection("unauthorized_actor", "You cannot direct that actor.");
  }
  const locus = view.locus;
  // A registered actor without a locus is authority corruption, not a
  // rejectable player mistake (spec §3.1 invariant 1).
  if (!locus) throw new Error(`Actor ${command.payload.actorId} has no physical locus`);
  if (locus.kind === "in_transit") {
    return moveRejection("actor_in_transit", "They are already traveling.");
  }
  if (view.actorHoldsBodyClaim) {
    return moveRejection("activity_conflict", "They are in the middle of something.");
  }
  const destination = view.topology.zones.find((zone) => zone.id === command.payload.destinationZoneId);
  if (!destination) return moveRejection("destination_not_found", "That destination is unknown.");
  if (locus.zoneId === destination.id) {
    return moveRejection("already_at_destination", "They are already there.");
  }

  const plan = planRoute(view.topology, {
    originZoneId: locus.zoneId,
    destinationZoneId: destination.id,
    travelMode: command.payload.travelMode,
  });
  if (!plan.ok) {
    switch (plan.reason) {
      case "no_route":
        return moveRejection("no_route", "No route leads there.");
      case "route_access_denied":
        return moveRejection("route_access_denied", "The way there is not open to them.");
      case "travel_mode_unavailable":
        return moveRejection("travel_mode_unavailable", "They cannot travel that way from here.");
    }
  }
  const route = plan.route;

  const journeyId = deriveJourneyId(view.branchId, command.id);
  const departedAt = view.storySecond;
  const earliestArrivalAt = departedAt + route.minimumDurationSeconds;
  const expectedArrivalAt = departedAt + route.expectedDurationSeconds;
  const firstLinkId = route.linkIds[0];
  if (!firstLinkId) throw new Error("A planned route cannot be empty");
  const firstLink = view.topology.links.find((link) => link.id === firstLinkId);
  if (!firstLink) throw new Error("A planned route references a missing link");

  const actorId = command.payload.actorId;
  const originLocationId = zoneLocationId(view.topology, locus.zoneId);

  const plannedEvent = journeyPlannedEventSchema.parse({
    id: composeSimulationId("event", [view.branchId, command.id, "journey-planned"]),
    worldId: view.worldId,
    branchId: view.branchId,
    sequence: view.headSequence + 1,
    storySecond: departedAt,
    type: "journey_planned",
    schemaVersion: 1,
    rulesetVersion: view.rulesetVersion,
    derivationVersion: GATE3_ROUTE_VERSION,
    commandId: command.id,
    correlationId: command.correlationId,
    actorIds: [actorId],
    entityIds: sortedUnique([actorId, journeyId, locus.zoneId, destination.id]),
    locationId: originLocationId,
    recordedAtWallClock: command.submittedAtWallClock,
    payload: {
      journeyId,
      originZoneId: locus.zoneId,
      destinationZoneId: destination.id,
      routeLinkIds: route.linkIds,
      travelMode: route.travelMode,
      earliestArrivalAt,
      expectedArrivalAt,
      routeDerivationVersion: GATE3_ROUTE_VERSION,
    },
  });

  const departedEvent = actorDepartedEventSchema.parse({
    id: composeSimulationId("event", [view.branchId, command.id, "actor-departed"]),
    worldId: view.worldId,
    branchId: view.branchId,
    sequence: view.headSequence + 2,
    storySecond: departedAt,
    type: "actor_departed",
    schemaVersion: 1,
    rulesetVersion: view.rulesetVersion,
    commandId: command.id,
    causationId: plannedEvent.id,
    correlationId: command.correlationId,
    actorIds: [actorId],
    entityIds: sortedUnique([actorId, journeyId, firstLinkId]),
    locationId: originLocationId,
    recordedAtWallClock: command.submittedAtWallClock,
    payload: {
      journeyId,
      fromZoneId: locus.zoneId,
      linkId: firstLinkId,
      departedAt,
    },
  });

  // The arrival is evaluated, never assumed: this schedules a durable trigger
  // whose command re-validates the journey at fire time (spec §9.3; the E2.6
  // stale-template caveat). Fork replay reconstructs the trigger from this
  // event alone.
  const templateId = composeSimulationId("template", [journeyId]);
  const triggerEvent = triggerScheduledEventSchema.parse({
    id: composeSimulationId("event", [view.branchId, command.id, "arrival-trigger"]),
    worldId: view.worldId,
    branchId: view.branchId,
    sequence: view.headSequence + 3,
    storySecond: departedAt,
    type: "trigger_scheduled",
    schemaVersion: 1,
    rulesetVersion: view.rulesetVersion,
    derivationVersion: schedulerDerivationVersion,
    commandId: command.id,
    causationId: departedEvent.id,
    correlationId: command.correlationId,
    actorIds: [actorId],
    entityIds: [journeyId],
    recordedAtWallClock: command.submittedAtWallClock,
    payload: {
      kind: journeyArrivalTriggerKind,
      triggerSchemaVersion: 1,
      dueStorySecond: expectedArrivalAt,
      priority: 0,
      uniquenessKey: journeyArrivalUniquenessKey(journeyId),
      command: {
        id: templateId,
        branchId: view.branchId,
        expectedVersion: 0,
        idempotencyKey: templateId,
        principal: { kind: "system", principalId: "sim-scheduler", controlledActorIds: [] },
        submittedAtWallClock: command.submittedAtWallClock,
        correlationId: command.correlationId,
        type: "arrive_journey",
        schemaVersion: 1,
        payload: { journeyId },
      },
    },
  });

  const journey = journeySchema.parse({
    id: journeyId,
    actorIds: [actorId],
    originZoneId: locus.zoneId,
    destinationZoneId: destination.id,
    routeLinkIds: route.linkIds,
    travelMode: route.travelMode,
    departedAt,
    earliestArrivalAt,
    expectedArrivalAt,
    status: "active",
    currentLinkIndex: 0,
    routeDerivationVersion: GATE3_ROUTE_VERSION,
  });

  const transitLocus = physicalLocusSchema.parse({
    kind: "in_transit",
    actorId,
    journeyId,
    linkId: firstLinkId,
    enteredAt: departedAt,
    earliestExitAt: departedAt + firstLink.minimumDurationSeconds,
  });

  return { ok: true, route, journey, locus: transitLocus, events: [plannedEvent, departedEvent, triggerEvent] };
}

// ---------------------------------------------------------------------------
// Journey arrival resolution (engine.spec §9.3, §17.1)
// ---------------------------------------------------------------------------

export interface JourneyArrivalResolutionView extends SpaceBranchMeta {
  topology: SpaceTopology;
  journey?: Journey;
}

interface ArrivalRejection {
  ok: false;
  code: ArriveJourneyRejectionCode;
  publicReason: string;
}

export interface ArrivalResolution {
  ok: true;
  event: ActorArrivedEvent;
  journey: Journey;
  loci: PhysicalLocus[];
}

function arrivalRejection(code: ArriveJourneyRejectionCode, publicReason: string): ArrivalRejection {
  return { ok: false, code, publicReason };
}

/** Pure fire-time arrival resolver. Re-validates rather than trusting the schedule. */
export function resolveJourneyArrival(
  view: JourneyArrivalResolutionView,
  command: ArriveJourneyCommand,
): ArrivalRejection | ArrivalResolution {
  if (command.branchId !== view.branchId) {
    return arrivalRejection("branch_mismatch", "That world branch is unavailable.");
  }
  if (command.principal.kind !== "system") {
    return arrivalRejection("unauthorized_principal", "Arrivals resolve mechanically, not by request.");
  }
  const journey = view.journey;
  if (!journey) return arrivalRejection("journey_not_found", "That journey is unknown.");
  if (journey.status !== "active" && journey.status !== "delayed") {
    return arrivalRejection("journey_not_active", "That journey is no longer underway.");
  }
  // The scheduler steps the clock to the trigger's due second before resolving
  // (spec §12.2 step 3), so firing early is corruption, not a rejection.
  if (view.storySecond < journey.earliestArrivalAt) {
    throw new Error(
      `Arrival for ${journey.id} fired at ${view.storySecond}, before its lower bound ${journey.earliestArrivalAt}`,
    );
  }

  const destinationLocationId = zoneLocationId(view.topology, journey.destinationZoneId);
  const arrivedAt = view.storySecond;

  const event = actorArrivedEventSchema.parse({
    id: composeSimulationId("event", [view.branchId, command.id, "actor-arrived"]),
    worldId: view.worldId,
    branchId: view.branchId,
    sequence: view.headSequence + 1,
    storySecond: arrivedAt,
    type: "actor_arrived",
    schemaVersion: 1,
    rulesetVersion: view.rulesetVersion,
    commandId: command.id,
    correlationId: command.correlationId,
    actorIds: journey.actorIds,
    entityIds: sortedUnique([journey.id, journey.destinationZoneId, ...journey.actorIds]),
    locationId: destinationLocationId,
    recordedAtWallClock: command.submittedAtWallClock,
    payload: {
      journeyId: journey.id,
      destinationZoneId: journey.destinationZoneId,
      arrivedAt,
    },
  });

  const arrivedJourney = journeySchema.parse({
    ...journey,
    status: "arrived",
    currentLinkIndex: journey.routeLinkIds.length - 1,
  });
  const loci = journey.actorIds.map((actorId) =>
    physicalLocusSchema.parse({
      kind: "at",
      actorId,
      locationId: destinationLocationId,
      zoneId: journey.destinationZoneId,
      since: arrivedAt,
    }),
  );

  return { ok: true, event, journey: arrivedJourney, loci };
}

// ---------------------------------------------------------------------------
// Space projection: canonical order, invariants, projectors, replay
// ---------------------------------------------------------------------------

/** Canonical ordering shared by live assembly, replay, and hashing. */
export function sortSpaceProjection(projection: SpaceProjection): SpaceProjection {
  return spaceProjectionSchema.parse({
    ...projection,
    locations: [...projection.locations].sort((a, b) => compareStableText(a.id, b.id)),
    zones: [...projection.zones].sort((a, b) => compareStableText(a.id, b.id)),
    links: [...projection.links].sort((a, b) => compareStableText(a.id, b.id)),
    loci: [...projection.loci].sort((a, b) => compareStableText(a.actorId, b.actorId)),
    journeys: [...projection.journeys].sort((a, b) => compareStableText(a.id, b.id)),
  });
}

export function assertSpaceInvariants(projection: SpaceProjection): void {
  const locationIds = new Set(projection.locations.map((location) => location.id));
  const zoneIds = new Set(projection.zones.map((zone) => zone.id));
  const journeyIds = new Set(projection.journeys.map((journey) => journey.id));
  if (locationIds.size !== projection.locations.length) throw new Error("Space has duplicate location ids");
  if (zoneIds.size !== projection.zones.length) throw new Error("Space has duplicate zone ids");
  if (journeyIds.size !== projection.journeys.length) throw new Error("Space has duplicate journey ids");
  for (const zone of projection.zones) {
    if (!locationIds.has(zone.locationId)) throw new Error(`Zone ${zone.id} references a missing location`);
  }
  for (const link of projection.links) {
    if (!zoneIds.has(link.fromZoneId) || !zoneIds.has(link.toZoneId)) {
      throw new Error(`Link ${link.id} references a missing zone`);
    }
  }
  const seenActors = new Set<string>();
  for (const locus of projection.loci) {
    if (seenActors.has(locus.actorId)) {
      throw new Error(`Actor ${locus.actorId} holds more than one physical locus`);
    }
    seenActors.add(locus.actorId);
    if (locus.kind === "at" && !zoneIds.has(locus.zoneId)) {
      throw new Error(`Locus for ${locus.actorId} references a missing zone`);
    }
    if (locus.kind === "in_transit" && !journeyIds.has(locus.journeyId)) {
      throw new Error(`Locus for ${locus.actorId} references a missing journey`);
    }
  }
}

function replaceLocus(loci: readonly PhysicalLocus[], next: PhysicalLocus): PhysicalLocus[] {
  const rest = loci.filter((locus) => locus.actorId !== next.actorId);
  return [...rest, next];
}

/** Pure synchronous projector for the movement event family. */
export function applySpaceEvent(
  projection: SpaceProjection,
  event: SimulationBranchEvent,
): SpaceProjection {
  const bumped = { ...projection, headSequence: event.sequence, storySecond: event.storySecond };
  switch (event.type) {
    case "journey_planned": {
      const journey = journeySchema.parse({
        id: event.payload.journeyId,
        actorIds: event.actorIds,
        originZoneId: event.payload.originZoneId,
        destinationZoneId: event.payload.destinationZoneId,
        routeLinkIds: event.payload.routeLinkIds,
        travelMode: event.payload.travelMode,
        earliestArrivalAt: event.payload.earliestArrivalAt,
        expectedArrivalAt: event.payload.expectedArrivalAt,
        status: "planned",
        currentLinkIndex: 0,
        routeDerivationVersion: event.payload.routeDerivationVersion,
      });
      return sortSpaceProjection({ ...bumped, journeys: [...projection.journeys, journey] });
    }
    case "actor_departed": {
      const journey = projection.journeys.find((candidate) => candidate.id === event.payload.journeyId);
      if (!journey) throw new Error("Departure replay references a missing journey");
      const link = projection.links.find((candidate) => candidate.id === event.payload.linkId);
      if (!link) throw new Error("Departure replay references a missing link");
      const active = journeySchema.parse({ ...journey, status: "active", departedAt: event.payload.departedAt });
      let loci = projection.loci;
      for (const actorId of journey.actorIds) {
        loci = replaceLocus(
          loci,
          physicalLocusSchema.parse({
            kind: "in_transit",
            actorId,
            journeyId: journey.id,
            linkId: link.id,
            enteredAt: event.payload.departedAt,
            earliestExitAt: event.payload.departedAt + link.minimumDurationSeconds,
          }),
        );
      }
      return sortSpaceProjection({
        ...bumped,
        journeys: projection.journeys.map((candidate) => (candidate.id === active.id ? active : candidate)),
        loci,
      });
    }
    case "journey_delayed": {
      return sortSpaceProjection({
        ...bumped,
        journeys: projection.journeys.map((candidate) =>
          candidate.id === event.payload.journeyId
            ? journeySchema.parse({
                ...candidate,
                status: "delayed",
                expectedArrivalAt: event.payload.newExpectedArrivalAt,
              })
            : candidate,
        ),
      });
    }
    case "journey_interrupted": {
      return sortSpaceProjection({
        ...bumped,
        journeys: projection.journeys.map((candidate) =>
          candidate.id === event.payload.journeyId
            ? journeySchema.parse({ ...candidate, status: "interrupted" })
            : candidate,
        ),
      });
    }
    case "actor_arrived": {
      const journey = projection.journeys.find((candidate) => candidate.id === event.payload.journeyId);
      if (!journey) throw new Error("Arrival replay references a missing journey");
      const zone = projection.zones.find((candidate) => candidate.id === event.payload.destinationZoneId);
      if (!zone) throw new Error("Arrival replay references a missing zone");
      const arrived = journeySchema.parse({
        ...journey,
        status: "arrived",
        currentLinkIndex: journey.routeLinkIds.length - 1,
      });
      let loci = projection.loci;
      for (const actorId of journey.actorIds) {
        loci = replaceLocus(
          loci,
          physicalLocusSchema.parse({
            kind: "at",
            actorId,
            locationId: zone.locationId,
            zoneId: zone.id,
            since: event.payload.arrivedAt,
          }),
        );
      }
      return sortSpaceProjection({
        ...bumped,
        journeys: projection.journeys.map((candidate) => (candidate.id === arrived.id ? arrived : candidate)),
        loci,
      });
    }
    case "zone_entered": {
      const zone = projection.zones.find((candidate) => candidate.id === event.payload.toZoneId);
      if (!zone) throw new Error("Entry replay references a missing zone");
      return sortSpaceProjection({
        ...bumped,
        loci: replaceLocus(
          projection.loci,
          physicalLocusSchema.parse({
            kind: "at",
            actorId: event.payload.actorId,
            locationId: zone.locationId,
            zoneId: zone.id,
            since: event.storySecond,
          }),
        ),
      });
    }
    case "storyteller_relocation": {
      const zone = projection.zones.find((candidate) => candidate.id === event.payload.toZoneId);
      if (!zone) throw new Error("Relocation replay references a missing zone");
      return sortSpaceProjection({
        ...bumped,
        loci: replaceLocus(
          projection.loci,
          physicalLocusSchema.parse({
            kind: "at",
            actorId: event.payload.actorId,
            locationId: zone.locationId,
            zoneId: zone.id,
            since: event.storySecond,
          }),
        ),
      });
    }
    case "journey_abandoned": {
      return sortSpaceProjection({
        ...bumped,
        journeys: projection.journeys.map((candidate) =>
          candidate.id === event.payload.journeyId
            ? journeySchema.parse({ ...candidate, status: "abandoned" })
            : candidate,
        ),
      });
    }
    case "item_transferred":
    case "item_destroyed":
    case "item_consumed":
    case "item_ownership_set":
    case "trigger_scheduled":
    case "activity_started":
    case "activity_completed":
    case "activity_cancelled":
    case "activity_failed":
    case "activity_interrupted":
    case "activity_resumed":
    case "commitment_created":
    case "pressure_raised":
    case "commitment_kept":
    case "commitment_late":
    case "commitment_missed":
    case "engagement_opened":
    case "engagement_ended":
    case "engagement_interrupted":
    case "engagement_winding_down":
    case "speech_act_delivered":
    case "disclosure_made":
    case "soft_canon_recorded":
    case "soft_canon_promoted":
    case "soft_canon_demoted":
    case "body_initialized":
    case "body_source_applied":
    case "body_modifier_applied":
    case "body_condition_applied":
    case "body_condition_ended":
    case "body_threshold_crossed":
    case "body_collapsed":
    case "item_condition_initialized":
    case "item_condition_source_applied":
    case "item_condition_modifier_applied":
    case "item_condition_modifier_ended":
    case "item_condition_threshold_crossed":
    case "household_created":
    case "household_membership_set":
    case "material_lot_initialized":
    case "material_lot_adjusted":
    case "material_lot_transferred":
    case "means_band_set":
      // Non-movement families advance the boundary without touching space.
      return spaceProjectionSchema.parse(bumped);
  }
}

export interface SpaceReplayInput {
  /** The space state just before the first replayed event (plan R3 seed rules). */
  seed: SpaceProjection;
  /** The contiguous full event stream after the seed boundary, any family mix. */
  events: readonly SimulationBranchEvent[];
}

/**
 * Fold one branch's full logical stream into its space projection. Version
 * counts distinct accepted commands across every family so the replayed
 * version matches the live branch version, exactly as item replay does.
 */
export function replaySpaceHistory(input: SpaceReplayInput): SpaceProjection {
  const seed = sortSpaceProjection(spaceProjectionSchema.parse(input.seed));
  assertSpaceInvariants(seed);
  const events = [...input.events].sort((left, right) => left.sequence - right.sequence);
  let projection = seed;
  const commandIds = new Set<string>();
  let lastSequence = seed.headSequence;
  for (const event of events) {
    if (event.sequence !== lastSequence + 1) {
      throw new Error(`Space replay sequence gap: expected ${lastSequence + 1}, received ${event.sequence}`);
    }
    if (event.commandId) commandIds.add(event.commandId);
    projection = applySpaceEvent(projection, event);
    lastSequence = event.sequence;
  }
  const replayed = spaceProjectionSchema.parse({
    ...projection,
    version: seed.version + commandIds.size,
  });
  assertSpaceInvariants(replayed);
  return replayed;
}

/**
 * Reverse-derive the space seed at the branch origin (plan R3): statics are
 * immutable copies, journeys are fully evented so the seed holds none, and
 * each moved actor's origin is the first zone their earliest journey_planned
 * departed from. Unmoved actors keep their current locus — that placement is
 * seed data the event stream cannot validate.
 */
export function spaceSeedForReplay(input: {
  branchId: string;
  current: SpaceProjection;
  events: readonly SimulationBranchEvent[];
  originStorySecond: number;
}): SpaceProjection {
  const originZoneByActor = new Map<string, string>();
  const ordered = [...input.events].sort((left, right) => left.sequence - right.sequence);
  for (const event of ordered) {
    if (event.type !== "journey_planned") continue;
    for (const actorId of event.actorIds) {
      if (!originZoneByActor.has(actorId)) originZoneByActor.set(actorId, event.payload.originZoneId);
    }
  }
  const topology: SpaceTopology = {
    locations: input.current.locations,
    zones: input.current.zones,
    links: input.current.links,
  };
  const loci = input.current.loci.map((locus) => {
    const originZoneId = originZoneByActor.get(locus.actorId);
    if (!originZoneId) return locus;
    return physicalLocusSchema.parse({
      kind: "at",
      actorId: locus.actorId,
      locationId: zoneLocationId(topology, originZoneId),
      zoneId: originZoneId,
      since: input.originStorySecond,
    });
  });
  return sortSpaceProjection(
    spaceProjectionSchema.parse({
      worldId: input.current.worldId,
      branchId: input.branchId,
      rulesetVersion: input.current.rulesetVersion,
      version: 0,
      headSequence: 0,
      storySecond: input.originStorySecond,
      locations: input.current.locations,
      zones: input.current.zones,
      links: input.current.links,
      loci,
      journeys: [],
    }),
  );
}
