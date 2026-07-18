import {
  grantAdmitsEntry,
  storytellerRelocationEventSchema,
  zoneEnteredEventSchema,
  type AccessGrant,
  type AttemptEntryCommand,
  type AttemptEntryRejectionCode,
  type StorytellerRelocateActorCommand,
  type StorytellerRelocateRejectionCode,
  type StorytellerRelocationEvent,
  type ZoneEnteredEvent,
} from "@/contracts/simulation/access";
import { composeSimulationId } from "@/contracts/simulation/identity";
import {
  journeyAbandonedEventSchema,
  physicalLocusSchema,
  type Journey,
  type JourneyAbandonedEvent,
  type PhysicalLocus,
  type SimulationLink,
  type SimulationZone,
} from "@/contracts/simulation/space";

/**
 * E3.5 pure access kernel: the last-hop entry check (fail closed) and the
 * audited storyteller relocation. No IO, no model, no clock.
 */

function compareStableText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function sortedUnique<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].sort(compareStableText);
}

interface AccessBranchMeta {
  worldId: string;
  branchId: string;
  rulesetVersion: string;
  headSequence: number;
  storySecond: number;
}

export interface AttemptEntryResolutionView extends AccessBranchMeta {
  actorExists: boolean;
  locus?: PhysicalLocus;
  link?: SimulationLink;
  /** Facts for the zone on the far side of the link from the actor. */
  destinationZone?: SimulationZone;
  /**
   * The actor's WELL-FORMED grants only: the store drops malformed rows
   * before this view is built, so bad data denies rather than admits (§13.1).
   */
  grants: readonly AccessGrant[];
  worldPermitsTrespass: boolean;
  /** The actor holds a body claim (mid-activity hands can't force a door). */
  actorHoldsBodyClaim: boolean;
  /** Actors at either threshold zone — a forced entry is witnessed. */
  coLocatedActorIds: readonly string[];
}

interface EntryRejection {
  ok: false;
  code: AttemptEntryRejectionCode;
  publicReason: string;
  legalAlternativeCommandTypes: string[];
}

export interface EntryResolution {
  ok: true;
  event: ZoneEnteredEvent;
  locus: PhysicalLocus;
}

function entryRejection(
  code: AttemptEntryRejectionCode,
  publicReason: string,
  legalAlternativeCommandTypes: string[] = [],
): EntryRejection {
  return { ok: false, code, publicReason, legalAlternativeCommandTypes };
}

/**
 * Resolve one threshold crossing (§14.1): a route ends at the doorstep; this
 * separate validated action carries the actor through the private door — by
 * right, by grant, or (where the world type permits) by explicit witnessed
 * force that never auto-succeeds against a person, only a barrier.
 */
export function resolveAttemptEntry(
  view: AttemptEntryResolutionView,
  command: AttemptEntryCommand,
): EntryRejection | EntryResolution {
  if (command.branchId !== view.branchId) {
    return entryRejection("branch_mismatch", "That world branch is unavailable.");
  }
  if (!view.actorExists) return entryRejection("actor_not_found", "That actor is unavailable.");
  const principal = command.principal;
  if (principal.kind !== "system" && !principal.controlledActorIds.includes(command.payload.actorId)) {
    return entryRejection("unauthorized_actor", "You cannot direct that actor.");
  }
  const locus = view.locus;
  if (!locus) throw new Error(`Actor ${command.payload.actorId} has no physical locus`);
  if (locus.kind === "in_transit") {
    return entryRejection("actor_in_transit", "They are on the move right now.");
  }
  if (view.actorHoldsBodyClaim) {
    return entryRejection("activity_conflict", "They are in the middle of something.");
  }
  const link = view.link;
  if (!link) return entryRejection("link_not_found", "There is no way through there.");
  const atNearSide = locus.zoneId === link.fromZoneId || locus.zoneId === link.toZoneId;
  if (!atNearSide) return entryRejection("not_adjacent", "They are not at that threshold.");
  const destination = view.destinationZone;
  if (!destination) throw new Error(`Link ${link.id} has no destination zone in view`);

  const forced = command.payload.forced;
  if (link.state === "blocked" || (!forced && link.state === "locked")) {
    if (!forced) {
      return entryRejection(
        "link_impassable",
        "That way is shut fast.",
        sortedUnique(["attempt_entry", "move_actor"]),
      );
    }
    if (link.state === "blocked") {
      return entryRejection("link_impassable", "No amount of force opens that way.");
    }
  }

  let basis: "public" | "granted" | "forced";
  if (forced) {
    if (!view.worldPermitsTrespass) {
      // §14.3: a product restriction is stated as a rule, never disguised as
      // physical impossibility.
      return entryRejection(
        "trespass_not_permitted",
        "Forcing a way in is not something this world allows.",
        sortedUnique(["move_actor"]),
      );
    }
    basis = "forced";
  } else if (link.accessPolicy === "public" && link.state === "open") {
    basis = "public";
  } else {
    const admitted = view.grants.some((grant) =>
      grantAdmitsEntry(grant, {
        actorId: command.payload.actorId,
        locationId: destination.locationId,
        zoneId: destination.id,
        storySecond: view.storySecond,
      }),
    );
    if (!admitted) {
      // The public reason names no private cause (§14.4); the alternatives
      // are the playable next moves.
      return entryRejection(
        "entry_denied",
        "They are not free to go in there.",
        sortedUnique(["attempt_entry", "move_actor", "open_engagement"]),
      );
    }
    basis = "granted";
  }

  const observerActorIds = sortedUnique([...view.coLocatedActorIds, command.payload.actorId]);
  const event = zoneEnteredEventSchema.parse({
    id: composeSimulationId("event", [view.branchId, command.id, "zone-entered"]),
    worldId: view.worldId,
    branchId: view.branchId,
    sequence: view.headSequence + 1,
    storySecond: view.storySecond,
    type: "zone_entered",
    schemaVersion: 1,
    rulesetVersion: view.rulesetVersion,
    commandId: command.id,
    correlationId: command.correlationId,
    actorIds: [command.payload.actorId],
    entityIds: sortedUnique([command.payload.actorId, link.id, locus.zoneId, destination.id]),
    locationId: destination.locationId,
    recordedAtWallClock: command.submittedAtWallClock,
    payload: {
      actorId: command.payload.actorId,
      linkId: link.id,
      fromZoneId: locus.zoneId,
      toZoneId: destination.id,
      basis,
      observerActorIds,
    },
  });

  return {
    ok: true,
    event,
    locus: physicalLocusSchema.parse({
      kind: "at",
      actorId: command.payload.actorId,
      locationId: destination.locationId,
      zoneId: destination.id,
      since: view.storySecond,
    }),
  };
}

// ---------------------------------------------------------------------------
// Storyteller relocation (§7, ruling 4)
// ---------------------------------------------------------------------------

export interface StorytellerRelocationResolutionView extends AccessBranchMeta {
  actorExists: boolean;
  locus?: PhysicalLocus;
  destinationZone?: SimulationZone;
  /** The actor's journey when their locus is in transit. */
  journey?: Journey;
}

interface RelocationRejection {
  ok: false;
  code: StorytellerRelocateRejectionCode;
  publicReason: string;
}

export interface RelocationResolution {
  ok: true;
  events: [JourneyAbandonedEvent, StorytellerRelocationEvent] | [StorytellerRelocationEvent];
  locus: PhysicalLocus;
  abandonedJourneyId?: string;
}

function relocationRejection(code: StorytellerRelocateRejectionCode, publicReason: string): RelocationRejection {
  return { ok: false, code, publicReason };
}

/** The one privileged bypass: storyteller principals only, always audited. */
export function resolveStorytellerRelocation(
  view: StorytellerRelocationResolutionView,
  command: StorytellerRelocateActorCommand,
): RelocationRejection | RelocationResolution {
  if (command.branchId !== view.branchId) {
    return relocationRejection("branch_mismatch", "That world branch is unavailable.");
  }
  if (command.principal.kind !== "storyteller") {
    return relocationRejection("unauthorized_principal", "Only storyteller authority may do that.");
  }
  if (!view.actorExists) return relocationRejection("actor_not_found", "That actor is unavailable.");
  const destination = view.destinationZone;
  if (!destination) return relocationRejection("destination_not_found", "That destination is unknown.");
  const locus = view.locus;
  if (!locus) throw new Error(`Actor ${command.payload.actorId} has no physical locus`);

  let sequence = view.headSequence;
  const events: (JourneyAbandonedEvent | StorytellerRelocationEvent)[] = [];
  let abandonedJourneyId: string | undefined;
  if (locus.kind === "in_transit") {
    const journey = view.journey;
    if (!journey) throw new Error("Transit locus without a journey in view");
    sequence += 1;
    abandonedJourneyId = journey.id;
    events.push(
      journeyAbandonedEventSchema.parse({
        id: composeSimulationId("event", [view.branchId, command.id, "journey-abandoned"]),
        worldId: view.worldId,
        branchId: view.branchId,
        sequence,
        storySecond: view.storySecond,
        type: "journey_abandoned",
        schemaVersion: 1,
        rulesetVersion: view.rulesetVersion,
        commandId: command.id,
        correlationId: command.correlationId,
        actorIds: journey.actorIds,
        entityIds: sortedUnique([journey.id, ...journey.actorIds]),
        recordedAtWallClock: command.submittedAtWallClock,
        payload: { journeyId: journey.id, abandonedAt: view.storySecond, reason: "superseded" },
      }),
    );
  }
  sequence += 1;
  events.push(
    storytellerRelocationEventSchema.parse({
      id: composeSimulationId("event", [view.branchId, command.id, "storyteller-relocation"]),
      worldId: view.worldId,
      branchId: view.branchId,
      sequence,
      storySecond: view.storySecond,
      type: "storyteller_relocation",
      schemaVersion: 1,
      rulesetVersion: view.rulesetVersion,
      commandId: command.id,
      correlationId: command.correlationId,
      actorIds: [command.payload.actorId],
      entityIds: sortedUnique([command.payload.actorId, destination.id]),
      locationId: destination.locationId,
      recordedAtWallClock: command.submittedAtWallClock,
      payload: {
        actorId: command.payload.actorId,
        ...(locus.kind === "at" ? { fromZoneId: locus.zoneId } : {}),
        ...(abandonedJourneyId ? { abandonedJourneyId } : {}),
        toZoneId: destination.id,
        reason: command.payload.reason,
      },
    }),
  );

  return {
    ok: true,
    events: events as RelocationResolution["events"],
    locus: physicalLocusSchema.parse({
      kind: "at",
      actorId: command.payload.actorId,
      locationId: destination.locationId,
      zoneId: destination.id,
      since: view.storySecond,
    }),
    ...(abandonedJourneyId ? { abandonedJourneyId } : {}),
  };
}
