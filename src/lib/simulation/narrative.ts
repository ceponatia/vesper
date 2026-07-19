import type { SimulationBranchEvent } from "@/contracts/simulation/branching";
import type { TemporalPressure } from "@/contracts/simulation/commitments";
import type { Engagement } from "@/contracts/simulation/engagements";
import { composeSimulationId } from "@/contracts/simulation/identity";
import {
  armedEffectSchema,
  gate3NarrativeCutSchema,
  type Gate3NarrativeCut,
  type ProposedArmedEffect,
} from "@/contracts/simulation/narrative";
import type { Observation } from "@/contracts/simulation/perception";
import type { SpaceProjection } from "@/contracts/simulation/space";
import { simulationHash } from "./item-transfer";

/**
 * E3.4 slice 2 — the deterministic turn arbiter's pure parts: the departure
 * policy and the Gate 3 NarrativeCut compiler. No IO, no model, no clock.
 */

function compareStableText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

export function deriveCutId(input: {
  branchId: string;
  engagementId: string;
  viewpointActorId: string;
  fromSequence: number;
  throughSequence: number;
}): string {
  return composeSimulationId("cut", [
    input.branchId,
    input.engagementId,
    input.viewpointActorId,
    String(input.fromSequence),
    String(input.throughSequence),
  ]);
}

export function deriveArmedEffectId(cutId: string, effect: ProposedArmedEffect): string {
  return composeSimulationId("armed", [
    cutId,
    effect.effectType,
    effect.actorId,
    ...[...effect.targetActorIds].sort(compareStableText),
  ]);
}

// ---------------------------------------------------------------------------
// Departure policy (engine.spec §18.3 steps 4–6, §15.3 — deterministic)
// ---------------------------------------------------------------------------

export interface DeparturePolicyInput {
  /** Unresolved pressures of engagement participants, with their destinations. */
  pressures: readonly (TemporalPressure & { destinationZoneId: string })[];
  /** The story second the prepared turn ends at. */
  turnEndSecond: number;
  /** How far past the turn the policy anticipates (world-type look-ahead). */
  horizonSeconds: number;
  /**
   * Actors asked to stay (§15.3): the request defers departure to the last
   * possible moment — it never erases travel time or the commitment.
   */
  stayRequestedActorIds: readonly string[];
  /** Actors the policy may move (never the player's own actor — agency). */
  policyControlledActorIds: readonly string[];
}

export interface PolicyDeparture {
  actorId: string;
  commitmentId: string;
  destinationZoneId: string;
  actBy: number;
}

/**
 * Deterministic rule: a policy-controlled participant departs when their
 * act-by boundary falls inside the turn plus look-ahead — or, when asked to
 * stay, only once it falls inside the turn itself. Earliest actBy wins per
 * actor; ties break by commitment id.
 */
export function decideDepartures(input: DeparturePolicyInput): PolicyDeparture[] {
  const byActor = new Map<string, PolicyDeparture>();
  const sorted = [...input.pressures].sort(
    (left, right) => left.actBy - right.actBy || compareStableText(left.sourceCommitmentId, right.sourceCommitmentId),
  );
  for (const pressure of sorted) {
    if (!input.policyControlledActorIds.includes(pressure.actorId)) continue;
    if (pressure.resolvedAt !== undefined) continue;
    const anticipation = input.stayRequestedActorIds.includes(pressure.actorId) ? 0 : input.horizonSeconds;
    if (pressure.actBy > input.turnEndSecond + anticipation) continue;
    if (!byActor.has(pressure.actorId)) {
      byActor.set(pressure.actorId, {
        actorId: pressure.actorId,
        commitmentId: pressure.sourceCommitmentId,
        destinationZoneId: pressure.destinationZoneId,
        actBy: pressure.actBy,
      });
    }
  }
  return [...byActor.values()].sort((left, right) => compareStableText(left.actorId, right.actorId));
}

// ---------------------------------------------------------------------------
// Cut compilation (engine.spec §22 — Gate 3 deterministic subset)
// ---------------------------------------------------------------------------

function beatSummary(event: SimulationBranchEvent): string | null {
  switch (event.type) {
    case "actor_departed":
      return "A participant departed, beginning a journey.";
    case "actor_arrived":
      return "Someone arrived at this place.";
    case "journey_abandoned":
      return "A journey was abandoned before arrival.";
    case "activity_started":
      return "An activity visibly began here.";
    case "activity_completed":
      return "An activity visibly concluded here.";
    case "activity_cancelled":
      return "An activity was visibly broken off here.";
    case "engagement_interrupted":
      return "The conversation was interrupted.";
    case "engagement_ended":
      return "The conversation came to an end.";
    case "engagement_opened":
      return "A conversation began.";
    case "zone_entered":
      return "Someone came through into this place.";
    case "storyteller_relocation":
      return "Circumstances placed someone somewhere new.";
    case "item_transferred":
      return "An item visibly changed hands.";
    case "speech_act_delivered":
    case "trigger_scheduled":
    case "journey_planned":
    case "journey_delayed":
    case "journey_interrupted":
    case "activity_failed":
    case "activity_interrupted":
    case "activity_resumed":
    case "engagement_winding_down":
    case "commitment_created":
    case "pressure_raised":
    case "commitment_kept":
    case "commitment_late":
    case "commitment_missed":
      // Bookkeeping, private mental state, or already-presented material —
      // never a hard beat. Commitment outcomes reach a viewpoint only through
      // observable behavior (a departure, an absence), not as facts.
      return null;
  }
}

export interface CompileGate3CutInput {
  branchVersion: number;
  engagement: Engagement;
  viewpointActorId: string;
  /** The turn interval's committed events, ascending. */
  events: readonly SimulationBranchEvent[];
  fromSequence: number;
  throughSequence: number;
  fromStorySecond: number;
  throughStorySecond: number;
  space: SpaceProjection;
  /**
   * The viewpoint's E4.1 observations across the turn interval — the §20
   * perception engine's verdict on what this viewpoint perceived. An event
   * enters the cut only through an observation of it; the compiler re-decides
   * nothing about witnessing.
   */
  viewpointObservations: readonly Observation[];
  /** The VIEWPOINT's own unresolved pressures only — privacy by omission. */
  viewpointPressures: readonly TemporalPressure[];
  proposedArmedEffects: readonly ProposedArmedEffect[];
}

export const gate3ForbiddenClaims: readonly string[] = [
  "Do not place any actor at a location their committed movement has not reached.",
  "Do not invent, reverse, or imply travel, item changes, injuries, or entries beyond the listed beats.",
  "Do not state another actor's private obligations, destinations, or reasons; only observable behavior.",
  "Do not describe a departed or absent actor as present.",
  "Do not narrate a future event as already completed.",
];

/** Compile one immutable, perspective-safe Gate 3 cut. Pure and rerenderable. */
export function compileGate3Cut(input: CompileGate3CutInput): Gate3NarrativeCut {
  const viewpointLocus = input.space.loci.find((locus) => locus.actorId === input.viewpointActorId);
  if (!viewpointLocus) throw new Error(`Viewpoint ${input.viewpointActorId} has no physical locus`);
  const viewpointZoneId = viewpointLocus.kind === "at" ? viewpointLocus.zoneId : undefined;
  const observedEventIds = new Set(
    input.viewpointObservations
      .filter((observation) => observation.witnessActorId === input.viewpointActorId)
      .map((observation) => observation.sourceEventId),
  );

  const currentLoci = input.space.loci
    .filter(
      (locus) =>
        locus.actorId === input.viewpointActorId ||
        (locus.kind === "at" && viewpointZoneId !== undefined && locus.zoneId === viewpointZoneId),
    )
    .map((locus) => ({
      actorId: locus.actorId,
      kind: locus.kind,
      ...(locus.kind === "at" ? { zoneId: locus.zoneId } : {}),
    }))
    .sort((left, right) => compareStableText(left.actorId, right.actorId));

  const mustEnact = input.events
    .filter((event) => event.sequence > input.fromSequence && event.sequence <= input.throughSequence)
    .filter((event) => observedEventIds.has(event.id))
    .flatMap((event) => {
      const summary = beatSummary(event);
      return summary === null
        ? []
        : [{ kind: event.type, eventId: event.id, sequence: event.sequence, storySecond: event.storySecond, summary }];
    });

  const cutId = deriveCutId({
    branchId: input.space.branchId,
    engagementId: input.engagement.id,
    viewpointActorId: input.viewpointActorId,
    fromSequence: input.fromSequence,
    throughSequence: input.throughSequence,
  });

  const armedEffects = input.proposedArmedEffects
    .filter(
      (effect) =>
        input.engagement.participantIds.includes(effect.actorId as never) &&
        effect.targetActorIds.every((target) => input.engagement.participantIds.includes(target as never)),
    )
    .map((effect) =>
      armedEffectSchema.parse({
        id: deriveArmedEffectId(cutId, effect),
        cutId,
        effectType: effect.effectType,
        actorId: effect.actorId,
        targetActorIds: [...effect.targetActorIds].sort(compareStableText),
        detail: effect.detail,
      }),
    )
    .sort((left, right) => compareStableText(left.id, right.id));

  const content = {
    worldId: input.space.worldId,
    branchId: input.space.branchId,
    branchVersion: input.branchVersion,
    engagementId: input.engagement.id,
    viewpointActorId: input.viewpointActorId,
    fromSequence: input.fromSequence,
    throughSequence: input.throughSequence,
    fromStorySecond: input.fromStorySecond,
    throughStorySecond: input.throughStorySecond,
    currentLoci,
    mustEnact,
    relevantPressures: input.viewpointPressures
      .filter((pressure) => pressure.resolvedAt === undefined)
      .map((pressure) => ({
        commitmentId: pressure.sourceCommitmentId,
        severity: pressure.severity,
        actBy: pressure.actBy,
      }))
      .sort((left, right) => compareStableText(left.commitmentId, right.commitmentId)),
    forbiddenClaims: [...gate3ForbiddenClaims],
    armedEffects,
    provenance: mustEnact.map((beat) => beat.eventId),
  };

  return gate3NarrativeCutSchema.parse({
    id: cutId,
    semanticHash: simulationHash(content),
    ...content,
  });
}
