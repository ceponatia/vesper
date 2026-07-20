import {
  isAccessEvent,
  isMovementEvent,
  type SimulationBranchEvent,
} from "@/contracts/simulation/branching";
import {
  deriveObservationId,
  observationSchema,
  type Observation,
  type ObservationChannel,
  type ObservationEvidenceClass,
} from "@/contracts/simulation/perception";
import type { PhysicalLocus, SpaceProjection } from "@/contracts/simulation/space";
import { applySpaceEvent } from "./space";

/**
 * E4.1 — the pure perception engine (engine.spec §20). One deterministic rule
 * table decides, for every committed event, who perceived it, through which
 * channel, and how well. It replaces the interim Gate 3 witness rule
 * (participant / captured payload set / shared location at compile time) as
 * the single source of "who perceived this".
 *
 * Perception evaluates against the space state AFTER the owning command's
 * events apply — an arrival is seen by whoever is at the destination once the
 * traveller stands in it. Live derivation reads the post-command loci rows;
 * replay folds the same space projection through `applySpaceEvent` and grades
 * each command's events against its group-final state, so both paths grade
 * against identical presence by construction.
 */

export const PERCEPTION_DERIVATION_VERSION = "perception-v1";

/**
 * Fixed-point confidence constants (10_000 = certainty). Deliberately coarse:
 * v1 grades by how the evidence arrived, not who the witness is. Impairment,
 * lighting, distance, and attention refine these under a bumped derivation
 * version when a scenario needs them.
 */
const CONFIDENCE = {
  direct: 10_000,
  remoteDirect: 9_500,
  clearWitness: 9_000,
  remoteReported: 8_500,
  glimpse: 8_000,
  muffled: 7_000,
} as const;

interface WitnessGrade {
  channel: ObservationChannel;
  evidenceClass: ObservationEvidenceClass;
  confidenceFixedPoint: number;
  detailTier: number;
}

const DIRECT_EMBODIED: WitnessGrade = {
  channel: "embodied",
  evidenceClass: "direct",
  confidenceFixedPoint: CONFIDENCE.direct,
  detailTier: 3,
};

const REMOTE_DIRECT: WitnessGrade = {
  channel: "device",
  evidenceClass: "direct",
  confidenceFixedPoint: CONFIDENCE.remoteDirect,
  detailTier: 2,
};

const SIGHT_WITNESS: WitnessGrade = {
  channel: "sight",
  evidenceClass: "sensory",
  confidenceFixedPoint: CONFIDENCE.clearWitness,
  detailTier: 2,
};

const SIGHT_GLIMPSE: WitnessGrade = {
  channel: "sight",
  evidenceClass: "sensory",
  confidenceFixedPoint: CONFIDENCE.glimpse,
  detailTier: 1,
};

const SOUND_MUFFLED: WitnessGrade = {
  channel: "sound",
  evidenceClass: "sensory",
  confidenceFixedPoint: CONFIDENCE.muffled,
  detailTier: 1,
};

/**
 * E4.2: how a disclosure's listener holds its content — knowledge that
 * arrived through another person (`social`/`reported`), graded by delivery.
 * The belief fold keys off exactly this evidence class: a muffled bystander
 * (sound/sensory above) heard talking, not content, and forms no belief.
 */
const SOCIAL_REPORTED_CO_PRESENT: WitnessGrade = {
  channel: "social",
  evidenceClass: "reported",
  confidenceFixedPoint: CONFIDENCE.clearWitness,
  detailTier: 3,
};

const SOCIAL_REPORTED_REMOTE: WitnessGrade = {
  channel: "social",
  evidenceClass: "reported",
  confidenceFixedPoint: CONFIDENCE.remoteReported,
  detailTier: 2,
};

/** Higher wins when one witness earns several grades for one event. */
function gradeRank(grade: WitnessGrade): number {
  const evidenceRank = grade.evidenceClass === "direct" ? 100 : 0;
  return evidenceRank + grade.detailTier * 10 + grade.confidenceFixedPoint / 10_000;
}

/**
 * The slice of space state perception needs: who stands where, and which
 * location each zone belongs to. A full SpaceProjection satisfies it
 * structurally; the live hook builds it from two narrow queries instead of
 * loading topology it never reads (and without importing the space store,
 * which itself calls the observation recorder).
 */
export interface PerceptionSpaceView {
  zones: readonly { id: string; locationId: string }[];
  loci: readonly PhysicalLocus[];
}

interface AtOccupant {
  actorId: string;
  locationId: string;
  zoneId: string;
}

function atOccupants(space: PerceptionSpaceView): AtOccupant[] {
  return space.loci.flatMap((locus) =>
    locus.kind === "at"
      ? [{ actorId: locus.actorId, locationId: locus.locationId, zoneId: locus.zoneId }]
      : [],
  );
}

function locationOfZone(space: PerceptionSpaceView, zoneId: string): string | undefined {
  return space.zones.find((zone) => zone.id === zoneId)?.locationId;
}

class GradeCollector {
  private readonly grades = new Map<string, WitnessGrade>();

  add(witnessActorId: string, grade: WitnessGrade): void {
    const held = this.grades.get(witnessActorId);
    if (!held || gradeRank(grade) > gradeRank(held)) this.grades.set(witnessActorId, grade);
  }

  toObservations(event: SimulationBranchEvent): Observation[] {
    return [...this.grades.entries()]
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([witnessActorId, grade]) =>
        observationSchema.parse({
          id: deriveObservationId(event.id, witnessActorId),
          branchId: event.branchId,
          sourceEventId: event.id,
          sourceEventSequence: event.sequence,
          witnessActorId,
          storySecond: event.storySecond,
          channel: grade.channel,
          evidenceClass: grade.evidenceClass,
          confidenceFixedPoint: grade.confidenceFixedPoint,
          detailTier: grade.detailTier,
          derivationVersion: PERCEPTION_DERIVATION_VERSION,
        }),
      );
  }
}

/**
 * Co-location grading for an event anchored to one zone: same zone sees it
 * clearly; the rest of the same location only hears something. An unknown
 * zone degrades to no bystander perception at all — fail closed, never wide.
 */
function gradeZoneBystanders(
  collector: GradeCollector,
  space: PerceptionSpaceView,
  eventZoneId: string,
  options: { sameZone?: WitnessGrade; crossZoneSound?: boolean } = {},
): void {
  const sameZoneGrade = options.sameZone ?? SIGHT_WITNESS;
  const crossZoneSound = options.crossZoneSound ?? true;
  const eventLocationId = locationOfZone(space, eventZoneId);
  for (const occupant of atOccupants(space)) {
    if (occupant.zoneId === eventZoneId) collector.add(occupant.actorId, sameZoneGrade);
    else if (crossZoneSound && eventLocationId !== undefined && occupant.locationId === eventLocationId) {
      collector.add(occupant.actorId, SOUND_MUFFLED);
    }
  }
}

/** Location-level bystander texture: a scene visibly starts/stops nearby. */
function gradeLocationBystanders(
  collector: GradeCollector,
  space: PerceptionSpaceView,
  locationId: string,
  grade: WitnessGrade,
): void {
  for (const occupant of atOccupants(space)) {
    if (occupant.locationId === locationId) collector.add(occupant.actorId, grade);
  }
}

/**
 * The v1 perception rule table. `space` is the projection AFTER the owning
 * command's events applied. Exhaustive over the event union so a new event
 * kind cannot ship without a perception ruling.
 */
export function deriveEventObservations(
  event: SimulationBranchEvent,
  space: PerceptionSpaceView,
): Observation[] {
  const collector = new GradeCollector();
  switch (event.type) {
    case "trigger_scheduled":
    case "commitment_created":
    case "pressure_raised":
    case "commitment_kept":
    case "commitment_late":
    case "commitment_missed":
    case "soft_canon_recorded":
    case "soft_canon_promoted":
    case "soft_canon_demoted":
    case "body_initialized":
    case "body_modifier_applied":
    case "item_ownership_set":
    case "item_condition_initialized":
    case "item_condition_source_applied":
    case "item_condition_modifier_applied":
    case "item_condition_modifier_ended":
    case "household_created":
    case "household_membership_set":
    case "material_lot_initialized":
    case "material_lot_adjusted":
    case "means_band_set":
    case "household_restock_routine_configured":
    case "household_restock_fulfilled":
    case "household_restock_deferred":
    case "relationship_entry_authored":
    case "relationship_change_recorded":
    case "pressure_acknowledged":
      // Scheduler and commitment-ledger bookkeeping is not perceptible; an
      // actor's knowledge of an obligation rides its commitment's `observed`
      // knowledge source pointing at a perceptible event (§15.1, §20).
      // Soft-canon records are presentation-lane audit entries (§23.4) —
      // nothing in the world happened for anyone to witness. Body setup and
      // modifier bookkeeping (E5.1) likewise derive nothing: the material
      // cause of a modifier (a drink, an illness onset) is witnessed through
      // its own causal event, never through the rate arithmetic it installs.
      // An ownership reassignment (§26.3) is a social-ledger entry — nothing in
      // the world moved for anyone to see. Item condition (§26.7) mirrors body
      // modifier bookkeeping exactly — the worn-window modifier's cause (a
      // transfer donning/doffing the item) is witnessed through its own
      // item_transferred event; a clean/adjustment source is interoception with
      // no subject to feel it (an item is not a witness of itself). Household
      // founding/membership, a lazy lot init, and a privileged authoring
      // adjustment (§26.8–26.9) are likewise off-screen authoring acts — a
      // conserved transfer (below) is the one lot event with a physical actor
      // to witness. A means band (§26.10) is a coarse authored fact about a
      // subject's means, not a witnessed event. A restock routine's
      // authoring, and its off-screen scheduled outcome — fulfilled or
      // deferred — are the household's own bookkeeping cycle (§26.11), not a
      // witnessed act (the top-up itself lands through its own
      // `material_lot_adjusted` event, which carries no acting actor to
      // witness it either). A relationship-ledger entry (§21.3, E5.5) —
      // authored or derived, and a relationship-change marker alike — is an
      // out-of-band ledger write, not a perceptible in-world event: an
      // actor's live perception of the underlying fact (a promise spoken, a
      // scene shared) already rides that fact's own causal event; the ledger
      // entry it produces is audit bookkeeping, mirrors `body_initialized`.
      // Pressure acknowledgment (E5.5 slice 3) is internal scheduling/turn
      // bookkeeping — mirrors `trigger_scheduled`'s no-observation treatment.
      return [];
    case "journey_planned":
    case "journey_delayed":
    case "journey_interrupted":
    case "journey_abandoned":
      // Private planning, or something felt mid-transit between places.
      for (const actorId of event.actorIds) collector.add(actorId, DIRECT_EMBODIED);
      break;
    case "actor_departed": {
      for (const actorId of event.actorIds) collector.add(actorId, DIRECT_EMBODIED);
      gradeZoneBystanders(collector, space, event.payload.fromZoneId);
      break;
    }
    case "actor_arrived": {
      for (const actorId of event.actorIds) collector.add(actorId, DIRECT_EMBODIED);
      gradeZoneBystanders(collector, space, event.payload.destinationZoneId);
      break;
    }
    case "activity_started":
    case "activity_completed":
    case "activity_cancelled":
    case "activity_failed": {
      // The captured payload set already encodes the action's noticeability
      // profile (§16.1) — a private activity captured no one. Trusting it
      // keeps replay exact and keeps private causes private.
      for (const actorId of event.actorIds) collector.add(actorId, DIRECT_EMBODIED);
      for (const witnessId of event.payload.observerActorIds) collector.add(witnessId, SIGHT_WITNESS);
      break;
    }
    case "activity_interrupted":
    case "activity_resumed":
      // No capture set exists on these yet (no command emits them — the E3.4
      // resumption design note). Participants only until that path lands.
      for (const actorId of event.actorIds) collector.add(actorId, DIRECT_EMBODIED);
      break;
    case "engagement_opened":
    case "engagement_ended":
    case "engagement_interrupted":
    case "engagement_winding_down": {
      const coPresent = event.locationId !== undefined;
      for (const actorId of event.actorIds) {
        collector.add(actorId, coPresent ? DIRECT_EMBODIED : REMOTE_DIRECT);
      }
      if (event.locationId !== undefined) {
        gradeLocationBystanders(collector, space, event.locationId, SIGHT_GLIMPSE);
      }
      break;
    }
    case "zone_entered": {
      // The threshold capture already holds both sides of the doorway,
      // noticeability-filtered at commit (§14.1) — no blanket co-location.
      collector.add(event.payload.actorId, DIRECT_EMBODIED);
      for (const witnessId of event.payload.observerActorIds) collector.add(witnessId, SIGHT_WITNESS);
      break;
    }
    case "storyteller_relocation": {
      // Privileged causality: destination occupants notice someone is
      // suddenly present — a glimpse, never the mechanism (ruling 4).
      collector.add(event.payload.actorId, DIRECT_EMBODIED);
      gradeZoneBystanders(collector, space, event.payload.toZoneId, {
        sameZone: SIGHT_GLIMPSE,
        crossZoneSound: false,
      });
      break;
    }
    case "item_transferred":
    case "item_destroyed":
    case "item_consumed":
    case "material_lot_transferred": {
      // An obvious same-zone manipulation (§26.4, §26.6, §26.9): the acting
      // actor has direct evidence, and everyone sharing their zone sees it
      // clearly. The manipulation is always at the acting actor's zone —
      // transfer law's root co-location guarantees both chains root there
      // (§26.8's access check is the lot-locus equivalent) — so witnesses are
      // derived live from presence rather than captured on the event.
      const actorId = event.payload.actorId;
      collector.add(actorId, DIRECT_EMBODIED);
      const actorZoneId = atOccupants(space).find((occupant) => occupant.actorId === actorId)?.zoneId;
      if (actorZoneId !== undefined) gradeZoneBystanders(collector, space, actorZoneId);
      break;
    }
    case "item_instantiated_from_promotion": {
      // Same shape as item_transferred above (§26.10/§27.2): an obvious
      // same-zone manipulation by the acting actor. The payload has no
      // top-level actorId (unlike a transfer) — the acting actor is the
      // event's own actorIds entry instead (v1 always places the promoted
      // item held by that actor).
      const actorId = event.actorIds[0];
      if (actorId !== undefined) {
        collector.add(actorId, DIRECT_EMBODIED);
        const actorZoneId = atOccupants(space).find((occupant) => occupant.actorId === actorId)?.zoneId;
        if (actorZoneId !== undefined) gradeZoneBystanders(collector, space, actorZoneId);
      }
      break;
    }
    case "disclosure_made": {
      // E4.2 gossip: the speaker knows what they said; each named listener
      // receives the content as reported testimony; a co-present disclosure
      // can be overheard at its location as sound only, a remote one cannot
      // (mirrors the speech-act ruling below).
      const coPresent = event.locationId !== undefined;
      collector.add(event.payload.speakerActorId, coPresent ? DIRECT_EMBODIED : REMOTE_DIRECT);
      const reported = coPresent ? SOCIAL_REPORTED_CO_PRESENT : SOCIAL_REPORTED_REMOTE;
      for (const targetId of event.payload.targetActorIds) collector.add(targetId, reported);
      if (event.locationId !== undefined) {
        gradeLocationBystanders(collector, space, event.locationId, SOUND_MUFFLED);
      }
      break;
    }
    case "body_source_applied":
    case "body_condition_ended":
      // Interoception (E5.1): only the subject feels a meter move or a state
      // pass. The physical act that caused it (a meal, a shower) is witnessed
      // through its own activity events; E5.2's perception-gated reads are
      // how bystanders see a body's visible signs.
      collector.add(event.payload.actorId, DIRECT_EMBODIED);
      break;
    case "body_condition_applied":
    case "body_threshold_crossed":
    case "body_collapsed": {
      // The subject feels it; a noticeable outcome captured co-located
      // witnesses at commit (trusted as-is, like activity captures — a
      // private threshold stays private).
      collector.add(event.payload.actorId, DIRECT_EMBODIED);
      for (const witnessId of event.payload.observerActorIds) collector.add(witnessId, SIGHT_WITNESS);
      break;
    }
    case "item_condition_threshold_crossed": {
      // An item has no interoceptive subject — only the captured co-located
      // witness set (§20's noticeable capture idiom) perceives a crossing.
      for (const witnessId of event.payload.observerActorIds) collector.add(witnessId, SIGHT_WITNESS);
      break;
    }
    case "speech_act_delivered": {
      const coPresent = event.locationId !== undefined;
      const spoken: WitnessGrade = coPresent
        ? { channel: "sound", evidenceClass: "direct", confidenceFixedPoint: CONFIDENCE.direct, detailTier: 3 }
        : REMOTE_DIRECT;
      collector.add(event.payload.actorId, spoken);
      for (const targetId of event.payload.targetActorIds) collector.add(targetId, spoken);
      if (event.locationId !== undefined) {
        gradeLocationBystanders(collector, space, event.locationId, SOUND_MUFFLED);
      }
      break;
    }
    case "consent_escalation_resolved": {
      // §8/§21.4: participant-only — the two named actors both witness the
      // outcome interoceptively. This is inherently a private negotiation
      // between the two parties, never surfaced to a co-located crowd even
      // if a shared engagement surrounds them (mirrors disclosure_made's
      // speaker+listener pattern, not a bystander-crowd witness set).
      collector.add(event.payload.actorId, DIRECT_EMBODIED);
      collector.add(event.payload.targetActorId, DIRECT_EMBODIED);
      break;
    }
  }
  return collector.toObservations(event);
}

/**
 * Derive every observation for one committed command, graded against the
 * post-command space state — exactly what the live hook loads from the locus
 * rows after the store's projection writes.
 */
export function deriveCommandObservations(
  events: readonly SimulationBranchEvent[],
  spaceAfterCommand: PerceptionSpaceView,
): Observation[] {
  return events.flatMap((event) => deriveEventObservations(event, spaceAfterCommand));
}

export interface ObservationsReplayInput {
  /** The space projection just before the first replayed event (same seed the space rebuild uses). */
  spaceSeed: SpaceProjection;
  /** The contiguous event stream after the seed boundary, ascending. */
  events: readonly SimulationBranchEvent[];
}

export interface ObservationsReplayResult {
  observations: Observation[];
  /** The folded space state after the last event — callers may reuse it. */
  space: SpaceProjection;
}

/**
 * Deterministic rebuild of the observation log (fork, parity, audit): fold
 * the space projection through each command's events, then grade that
 * command's events against its group-final state — the same presence the
 * live hook saw. Events sharing a commandId form one group; an event with no
 * commandId grades alone.
 */
export function replayObservationsHistory(input: ObservationsReplayInput): ObservationsReplayResult {
  const events = [...input.events].sort((left, right) => left.sequence - right.sequence);
  const observations: Observation[] = [];
  let space = input.spaceSeed;
  let index = 0;
  while (index < events.length) {
    const head = events[index];
    if (!head) break;
    const commandId = head.commandId;
    let end = index + 1;
    while (commandId !== undefined) {
      const next = events[end];
      if (next?.commandId !== commandId) break;
      end += 1;
    }
    const group = events.slice(index, end);
    for (const event of group) {
      if (isMovementEvent(event) || isAccessEvent(event)) space = applySpaceEvent(space, event);
    }
    for (const event of group) observations.push(...deriveEventObservations(event, space));
    index = end;
  }
  return { observations, space };
}
