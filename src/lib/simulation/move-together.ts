import type { ActivityInstance } from "@/contracts/simulation/activities";
import type { Commitment } from "@/contracts/simulation/commitments";
import type { Engagement, EngagementEndedEvent } from "@/contracts/simulation/engagements";
import type {
  ActorDepartedEvent,
  Journey,
  JourneyPlannedEvent,
  MoveTogetherCommand,
  MoveTogetherRejectionCode,
  PhysicalLocus,
} from "@/contracts/simulation/space";
import type { TriggerScheduledEvent } from "@/contracts/simulation/scheduler";
import { actorHoldsBodyClaim, decideAccompany } from "./accompany";
import { buildEngagementEndedEvent } from "./engagements";
import { buildJourneyBatch, planRoute, type SpaceTopology } from "./space";

/**
 * command-integrity A4 — the pure `move_together` resolver. The walk-with-me
 * choreography that once committed scene-end + the player move + the primary
 * move as THREE independent transactions (a crash between them stranded the
 * pair) collapses to ONE indivisible action over a shared journey.
 *
 * §14.2 preserved and STRENGTHENED: the player principal controls only the
 * player; the invited co-traveller is authorized not by the principal but by
 * `decideAccompany`, re-run HERE inside the locked authority view — closing the
 * read-vs-commit agency race the old pre-commit decision left open. Accept ⇒ one
 * `engagement_ended` (only when a scene stands, `participant_choice` — §18.2
 * grace), one `journey_planned` carrying BOTH actors, one `actor_departed`, one
 * arrival `trigger_scheduled`. Decline ⇒ the command's own §14.4 refusal (one
 * surface handles accept and decline). Pure: no IO, no clock, no db — the store
 * loads the locked view and writes what this returns.
 */

export interface MoveTogetherResolutionView {
  worldId: string;
  branchId: string;
  rulesetVersion: string;
  headSequence: number;
  storySecond: number;
  topology: SpaceTopology;
  /** The player actor exists in the branch registry. */
  playerExists: boolean;
  /** The invited co-traveller exists in the branch registry. */
  coTravelerExists: boolean;
  /** The player's current locus (every registered actor has exactly one). */
  playerLocus?: PhysicalLocus;
  /** The co-traveller's current locus. */
  coTravelerLocus?: PhysicalLocus;
  /** The co-traveller's display name — the §14.4 decline face names them, never an id. */
  coTravelerName: string;
  /** Claim-holding activities (both actors' — the resolver filters per actor). */
  activities: readonly ActivityInstance[];
  /** The branch commitments (the firm/hard-due decline gate reads the co-traveller's). */
  commitments: readonly Commitment[];
  /** The pair's standing co-present scene when one is open — ended in the same batch. */
  standingEngagement?: Engagement;
}

export interface MoveTogetherRejection {
  ok: false;
  code: MoveTogetherRejectionCode;
  publicReason: string;
  /** Present only for a policy decline — the §14.4 legal alternatives. */
  legalAlternatives?: readonly string[];
}

export interface MoveTogetherResolution {
  ok: true;
  journey: Journey;
  /** One in-transit locus per traveller (both share the journey by construction). */
  loci: PhysicalLocus[];
  /** The scene ended in this batch, when one stood (`participant_choice`). */
  endedEngagementId?: string;
  endedEvent?: EngagementEndedEvent;
  plannedEvent: JourneyPlannedEvent;
  departedEvent: ActorDepartedEvent;
  triggerEvent: TriggerScheduledEvent;
}

function reject(
  code: MoveTogetherRejectionCode,
  publicReason: string,
  legalAlternatives?: readonly string[],
): MoveTogetherRejection {
  return { ok: false, code, publicReason, ...(legalAlternatives ? { legalAlternatives } : {}) };
}

/** Pure MoveTogether resolver over a lock-consistent authority view. */
export function resolveMoveTogether(
  view: MoveTogetherResolutionView,
  command: MoveTogetherCommand,
): MoveTogetherRejection | MoveTogetherResolution {
  if (command.branchId !== view.branchId) {
    return reject("branch_mismatch", "That world branch is unavailable.");
  }
  const { actorId: playerActorId, coTravelerActorId, destinationZoneId } = command.payload;

  // The player — the principal's own actor (§14.2: a player directs only the player).
  if (!view.playerExists) return reject("actor_not_found", "That actor is unavailable.");
  if (!command.principal.controlledActorIds.includes(playerActorId)) {
    return reject("unauthorized_actor", "You cannot direct that actor.");
  }
  const playerLocus = view.playerLocus;
  if (!playerLocus) throw new Error(`Actor ${playerActorId} has no physical locus`);
  if (playerLocus.kind === "in_transit") return reject("actor_in_transit", "They are already traveling.");
  if (actorHoldsBodyClaim(playerActorId, view.activities)) {
    return reject("activity_conflict", "They are in the middle of something.");
  }

  // The invited co-traveller — authorized by the acceptance policy, never the principal.
  if (!view.coTravelerExists) return reject("co_traveler_not_found", "They are unavailable.");
  const coTravelerLocus = view.coTravelerLocus;
  if (!coTravelerLocus) throw new Error(`Actor ${coTravelerActorId} has no physical locus`);
  if (coTravelerLocus.kind === "in_transit") return reject("co_traveler_in_transit", "They are already traveling.");
  // Co-presence: the invite is only meaningful in each other's presence (§14.2).
  if (coTravelerLocus.zoneId !== playerLocus.zoneId) {
    return reject("not_copresent", `${view.coTravelerName} isn't here to walk with you.`);
  }

  const destination = view.topology.zones.find((zone) => zone.id === destinationZoneId);
  if (!destination) return reject("destination_not_found", "That destination is unknown.");
  if (playerLocus.zoneId === destination.id) return reject("already_at_destination", "They are already there.");

  const plan = planRoute(view.topology, {
    originZoneId: playerLocus.zoneId,
    destinationZoneId: destination.id,
    travelMode: command.payload.travelMode,
  });
  if (!plan.ok) {
    switch (plan.reason) {
      case "no_route":
        return reject("no_route", "No route leads there.");
      case "route_access_denied":
        return reject("route_access_denied", "The way there is not open to them.");
      case "travel_mode_unavailable":
        return reject("travel_mode_unavailable", "They cannot travel that way from here.");
    }
  }
  const route = plan.route;

  // NPC agency, re-run inside the locked view (§39 ruling 16): accept unless a
  // body claim occupies the co-traveller or a firm/hard commitment falls due
  // before arrival + a buffer. The arrival estimate is the route's lower bound
  // (§17.1) — more faithful than the pre-commit single-hop estimate it replaces.
  const decision = decideAccompany({
    primaryActorId: coTravelerActorId,
    primaryName: view.coTravelerName,
    activities: view.activities,
    commitments: view.commitments,
    arrivalStorySecond: view.storySecond + route.minimumDurationSeconds,
  });
  if (!decision.accept) {
    return reject("accompany_declined", decision.publicReason, decision.legalAlternatives);
  }

  const firstLinkId = route.linkIds[0];
  if (!firstLinkId) throw new Error("A planned route cannot be empty");
  const firstLink = view.topology.links.find((link) => link.id === firstLinkId);
  if (!firstLink) throw new Error("A planned route references a missing link");

  // §18.2 grace: an ended scene holds no claim, so the departure that follows
  // fires NO hard interrupt — a parting, not a rupture. Ends FIRST in the batch
  // (sequence headSequence+1), so the movement events start one later.
  const standingEngagement = view.standingEngagement;
  const endedEvent = standingEngagement
    ? buildEngagementEndedEvent({
        meta: {
          worldId: view.worldId,
          branchId: view.branchId,
          rulesetVersion: view.rulesetVersion,
          headSequence: view.headSequence,
          storySecond: view.storySecond,
        },
        command,
        engagement: standingEngagement,
        reason: "participant_choice",
        sequence: view.headSequence + 1,
      })
    : undefined;

  const batch = buildJourneyBatch(
    { worldId: view.worldId, branchId: view.branchId, rulesetVersion: view.rulesetVersion },
    {
      command,
      // Both travellers on ONE journey — "together" true by construction.
      travelerActorIds: [playerActorId, coTravelerActorId].sort(),
      originZoneId: playerLocus.zoneId,
      originLocationId: playerLocus.locationId,
      destinationZoneId: destination.id,
      route,
      firstLink,
      departedAt: view.storySecond,
      baseSequence: endedEvent ? view.headSequence + 1 : view.headSequence,
    },
  );

  const [plannedEvent, departedEvent, triggerEvent] = batch.events;
  return {
    ok: true,
    journey: batch.journey,
    loci: batch.loci,
    ...(standingEngagement ? { endedEngagementId: standingEngagement.id } : {}),
    ...(endedEvent ? { endedEvent } : {}),
    plannedEvent,
    departedEvent,
    triggerEvent,
  };
}
