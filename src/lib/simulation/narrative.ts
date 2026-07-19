import type { SimulationBranchEvent } from "@/contracts/simulation/branching";
import { claimHoldingActivityPhases, type ActivityInstance } from "@/contracts/simulation/activities";
import type { TemporalPressure } from "@/contracts/simulation/commitments";
import type { Engagement } from "@/contracts/simulation/engagements";
import { composeSimulationId } from "@/contracts/simulation/identity";
import type { Assertion, Belief } from "@/contracts/simulation/knowledge";
import {
  armedEffectSchema,
  CUT_COMPILER_VERSION,
  narrativeCutSchema,
  type CutBodilyReads,
  type ForbiddenClaim,
  type NarrativeCut,
  type ProposedArmedEffect,
  type PublicFailurePresentation,
} from "@/contracts/simulation/narrative";
import type { Observation } from "@/contracts/simulation/perception";
import type { SoftCanonEntry } from "@/contracts/simulation/soft-canon";
import type { SpaceProjection } from "@/contracts/simulation/space";
import { simulationHash } from "./item-transfer";
import { selectCutSoftCanon } from "./soft-canon";

/**
 * E4.3 — the deterministic turn arbiter's pure parts: the departure policy
 * (§18.3 steps 4–6) and the full §22.1 NarrativeCut compiler, replacing the
 * Gate 3 deterministic subset. No IO, no model, no clock. Perspective safety
 * is by OMISSION: private facts never enter the cut, so no prompt instruction
 * has to hold the line (§22.1).
 */

/** Bounded views: a cut is a working set, never a dump. */
const MAX_SPEAKER_BELIEFS = 64;
const MAX_CUT_SOFT_CANON = 32;

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
  fromStorySecond: number;
  throughStorySecond: number;
}): string {
  // Story-time bounds are part of the identity: two quiet turns can share a
  // sequence range (no events appended) while covering different spans, and
  // each must persist as its own addressable cut (§22.3).
  return composeSimulationId("cut", [
    input.branchId,
    input.engagementId,
    input.viewpointActorId,
    String(input.fromSequence),
    String(input.throughSequence),
    String(input.fromStorySecond),
    String(input.throughStorySecond),
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
  for (const pressure of departureCandidates(input)) {
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

/**
 * Every pressure the policy could legally act on this turn, earliest-first —
 * the §19.1 bounded candidate list. `decideDepartures` takes the head per
 * actor; a §19.3-admitted deliberator may pick another member, never more.
 */
export function departureCandidates(
  input: DeparturePolicyInput,
): (TemporalPressure & { destinationZoneId: string })[] {
  const sorted = [...input.pressures].sort(
    (left, right) => left.actBy - right.actBy || compareStableText(left.sourceCommitmentId, right.sourceCommitmentId),
  );
  return sorted.filter((pressure) => {
    if (!input.policyControlledActorIds.includes(pressure.actorId)) return false;
    if (pressure.resolvedAt !== undefined) return false;
    const anticipation = input.stayRequestedActorIds.includes(pressure.actorId) ? 0 : input.horizonSeconds;
    return pressure.actBy <= input.turnEndSecond + anticipation;
  });
}

// ---------------------------------------------------------------------------
// Beat classification (engine.spec §22.1 mustEnact / allowedTransitions)
// ---------------------------------------------------------------------------

type BeatDisposition = { kind: "hard" | "allowed"; summary: string } | null;

/**
 * Exhaustive ruling per event kind: `hard` beats MUST be enacted, `allowed`
 * transitions MAY be portrayed (already resolved, never a new outcome), and
 * `null` never surfaces — bookkeeping, private mental state, or
 * presentation-lane audit records. Commitment outcomes stay null on purpose:
 * they reach a viewpoint only through observable behavior (a departure, an
 * absence), never as facts.
 */
function beatDisposition(event: SimulationBranchEvent): BeatDisposition {
  switch (event.type) {
    case "actor_departed":
      return { kind: "hard", summary: "A participant departed, beginning a journey." };
    case "actor_arrived":
      return { kind: "hard", summary: "Someone arrived at this place." };
    case "journey_abandoned":
      return { kind: "hard", summary: "A journey was abandoned before arrival." };
    case "activity_started":
      return { kind: "hard", summary: "An activity visibly began here." };
    case "activity_completed":
      return { kind: "hard", summary: "An activity visibly concluded here." };
    case "activity_cancelled":
      return { kind: "hard", summary: "An activity was visibly broken off here." };
    case "engagement_interrupted":
      return { kind: "hard", summary: "The conversation was interrupted." };
    case "engagement_ended":
      return { kind: "hard", summary: "The conversation came to an end." };
    case "engagement_opened":
      return { kind: "hard", summary: "A conversation began." };
    case "zone_entered":
      return { kind: "hard", summary: "Someone came through into this place." };
    case "storyteller_relocation":
      return { kind: "hard", summary: "Circumstances placed someone somewhere new." };
    case "item_transferred":
      return { kind: "hard", summary: "An item visibly changed hands." };
    case "journey_delayed":
      return { kind: "allowed", summary: "A journey under way is running behind." };
    case "journey_interrupted":
      return { kind: "allowed", summary: "A journey was interrupted mid-way." };
    case "activity_failed":
      return { kind: "allowed", summary: "An attempt here visibly failed." };
    case "activity_interrupted":
      return { kind: "allowed", summary: "An activity here was broken off mid-stream." };
    case "activity_resumed":
      return { kind: "allowed", summary: "A paused activity picked back up." };
    case "engagement_winding_down":
      return { kind: "allowed", summary: "The conversation is naturally winding down." };
    case "speech_act_delivered":
      return { kind: "allowed", summary: "Something meaningful already said may be referenced." };
    case "disclosure_made":
      return { kind: "allowed", summary: "Something already shared in confidence may be referenced." };
    case "body_source_applied":
      // Interoception (E5.1): only the subject holds this observation, so the
      // license reaches no other viewpoint's cut.
      return { kind: "allowed", summary: "A bodily change was felt and may be described." };
    case "body_condition_applied":
      return { kind: "allowed", summary: "A condition visibly came over someone here." };
    case "body_condition_ended":
      return { kind: "allowed", summary: "A bodily state visibly passed." };
    case "body_threshold_crossed":
      // Allowed, not hard: a witnessed limit may be portrayed, but a quiet
      // crossing (hygiene sliding a band) must never force a mention.
      return { kind: "allowed", summary: "A body visibly reached a limit and may be portrayed." };
    case "body_collapsed":
      // A collapse is the E5.2 answer to that open note: dramatic, physical,
      // and witnessed — prose that skips it is lying about the scene.
      return { kind: "hard", summary: "Someone's body visibly gave out — they collapsed here." };
    case "trigger_scheduled":
    case "journey_planned":
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
      return null;
  }
}

// ---------------------------------------------------------------------------
// Forbidden claims (engine.spec §22.2 — typed, plus contextual bans)
// ---------------------------------------------------------------------------

const baseForbiddenClaims: readonly Omit<ForbiddenClaim, "subjectActorIds">[] = [
  {
    code: "impossible_presence",
    claim: "Do not place any actor at a location their committed movement has not reached.",
  },
  { code: "unearned_travel", claim: "Do not invent, reverse, or imply travel beyond the listed beats." },
  {
    code: "unearned_possession",
    claim: "Do not invent possession, consumption, injuries, or item changes beyond the listed beats.",
  },
  {
    code: "unearned_knowledge",
    claim: "Do not give any actor knowledge that is not in the listed evidence or beliefs.",
  },
  {
    code: "unearned_access",
    claim: "Do not let anyone pass a door, lock, or boundary without a listed grant or successful attempt.",
  },
  {
    code: "incompatible_action",
    claim: "Do not describe an action incompatible with a listed activity or bodily claim.",
  },
  {
    code: "unauthorized_player_speech",
    claim: "Do not attribute speech or decisions to the player's actor beyond what the player supplied.",
  },
  {
    code: "private_denial_disclosure",
    claim: "Do not state another actor's private obligations, destinations, or reasons; only observable behavior.",
  },
  { code: "future_completed", claim: "Do not narrate a future event as already completed." },
];

// ---------------------------------------------------------------------------
// Cut compilation (engine.spec §22.1 — the full contract)
// ---------------------------------------------------------------------------

export interface CompileNarrativeCutInput {
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
  /** The branch's activity instances; the compiler keeps co-located live ones. */
  activities: readonly ActivityInstance[];
  /**
   * The viewpoint's E4.1 observations across the turn interval — the §20
   * perception engine's verdict on what this viewpoint perceived. An event
   * enters the cut only through an observation of it; the compiler re-decides
   * nothing about witnessing.
   */
  viewpointObservations: readonly Observation[];
  /** The viewpoint's OWN live beliefs (§21), each joined with its assertion. */
  viewpointBeliefs: readonly { belief: Belief; assertion: Assertion }[];
  /** The VIEWPOINT's own unresolved pressures only — privacy by omission. */
  viewpointPressures: readonly TemporalPressure[];
  /** Public faces of this turn's failed attempts (§14.4) — pre-redacted by type. */
  failurePresentations: readonly PublicFailurePresentation[];
  /** The branch's soft-canon entries; the compiler licenses the in-scope live ones. */
  softCanonEntries: readonly SoftCanonEntry[];
  proposedArmedEffects: readonly ProposedArmedEffect[];
  /**
   * E5.2 layer-3 body surface, computed by the caller from body rows: the
   * viewpoint's own reads plus co-present actors' perceivable signs. Absent
   * (or empty) when no participant has an initialized body.
   */
  bodilyReads?: CutBodilyReads;
}

/** Compile one immutable, perspective-safe §22.1 cut. Pure and rerenderable. */
export function compileNarrativeCut(input: CompileNarrativeCutInput): NarrativeCut {
  const viewpointLocus = input.space.loci.find((locus) => locus.actorId === input.viewpointActorId);
  if (!viewpointLocus) throw new Error(`Viewpoint ${input.viewpointActorId} has no physical locus`);
  const viewpointZoneId = viewpointLocus.kind === "at" ? viewpointLocus.zoneId : undefined;

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
  const coLocatedActorIds = new Set(currentLoci.map((locus) => locus.actorId));

  const currentActivities = input.activities
    .filter((activity) => claimHoldingActivityPhases.includes(activity.phase))
    .filter((activity) => viewpointZoneId !== undefined && activity.zoneId === viewpointZoneId)
    .map((activity) => ({
      activityId: activity.id,
      actionDefinitionId: activity.actionDefinitionId,
      actorIds: [...activity.actorIds].sort(compareStableText),
      zoneId: activity.zoneId,
      phase: activity.phase,
    }))
    .sort((left, right) => compareStableText(left.activityId, right.activityId));

  const viewpointObservations = input.viewpointObservations
    .filter((observation) => observation.witnessActorId === input.viewpointActorId)
    .sort((left, right) => compareStableText(left.id, right.id));
  const observedEventIds = new Set(viewpointObservations.map((observation) => observation.sourceEventId));

  const intervalEvents = input.events.filter(
    (event) => event.sequence > input.fromSequence && event.sequence <= input.throughSequence,
  );
  const eventKindById = new Map(intervalEvents.map((event) => [event.id, event.type]));

  const mustEnact: NarrativeCut["mustEnact"] = [];
  const allowedTransitions: NarrativeCut["allowedTransitions"] = [];
  for (const event of intervalEvents) {
    if (!observedEventIds.has(event.id)) continue;
    const disposition = beatDisposition(event);
    if (disposition === null) continue;
    const beat = {
      kind: event.type,
      eventId: event.id,
      sequence: event.sequence,
      storySecond: event.storySecond,
      summary: disposition.summary,
    };
    if (disposition.kind === "hard") mustEnact.push(beat);
    else allowedTransitions.push(beat);
  }

  // Evidence views: only observations whose source event this interval holds —
  // an orphaned row is dropped rather than guessed at (fail closed).
  const perceptibleNow = viewpointObservations.flatMap((observation) => {
    const eventKind = eventKindById.get(observation.sourceEventId);
    if (eventKind === undefined) return [];
    return [
      {
        observationId: observation.id,
        sourceEventId: observation.sourceEventId,
        eventKind,
        channel: observation.channel,
        evidenceClass: observation.evidenceClass,
        confidenceFixedPoint: observation.confidenceFixedPoint,
        detailTier: observation.detailTier,
        storySecond: observation.storySecond,
      },
    ];
  });

  // The speaker's working set of beliefs: strongest and freshest first when
  // bounding, then id-ordered so the compiled cut hashes stably (§22.3).
  const speakerBeliefs = input.viewpointBeliefs
    .filter(({ belief }) => belief.holderActorId === input.viewpointActorId)
    .filter(({ belief }) => belief.status === "active" || belief.status === "doubted")
    .filter(({ belief, assertion }) => belief.assertionId === assertion.id)
    .sort(
      (left, right) =>
        right.belief.confidenceFixedPoint - left.belief.confidenceFixedPoint ||
        right.belief.believedFrom - left.belief.believedFrom ||
        compareStableText(left.belief.id, right.belief.id),
    )
    .slice(0, MAX_SPEAKER_BELIEFS)
    .map(({ belief, assertion }) => ({
      beliefId: belief.id,
      assertionId: assertion.id,
      propositionKey: assertion.propositionKey,
      subjectIds: [...assertion.subjectIds],
      claimedValue: assertion.claimedValue,
      confidenceFixedPoint: belief.confidenceFixedPoint,
      status: belief.status as "active" | "doubted",
      learnedFromActorIds: [...belief.learnedFromActorIds],
    }))
    .sort((left, right) => compareStableText(left.beliefId, right.beliefId));

  // Contextual presence bans: engagement participants the viewpoint cannot
  // currently see are exactly the ones a render must not seat at the table.
  const absentParticipantIds = input.engagement.participantIds
    .filter((participantId) => !coLocatedActorIds.has(participantId))
    .sort(compareStableText);
  const forbiddenClaims: ForbiddenClaim[] = [
    ...baseForbiddenClaims.map((claim) => ({ ...claim, subjectActorIds: [] })),
    ...(absentParticipantIds.length > 0 && input.engagement.channel === "co_present"
      ? [
          {
            code: "impossible_presence" as const,
            claim: "Do not describe a departed or absent participant as present in this scene.",
            subjectActorIds: absentParticipantIds,
          },
        ]
      : []),
  ];

  const cutId = deriveCutId({
    branchId: input.space.branchId,
    engagementId: input.engagement.id,
    viewpointActorId: input.viewpointActorId,
    fromSequence: input.fromSequence,
    throughSequence: input.throughSequence,
    fromStorySecond: input.fromStorySecond,
    throughStorySecond: input.throughStorySecond,
  });

  const licensedSoftCanon = selectCutSoftCanon({
    entries: input.softCanonEntries,
    participantActorIds: [...input.engagement.participantIds],
    zoneIds: viewpointZoneId === undefined ? [] : [viewpointZoneId],
    storySecond: input.throughStorySecond,
    limit: MAX_CUT_SOFT_CANON,
  });
  const creativeLicenses = [
    {
      kind: "ambient_detail",
      note: "Transient sensory ambiance of this place may be invented; it establishes no persistent fact unless proposed as soft canon.",
      subjectActorIds: [],
      ...(viewpointZoneId === undefined ? {} : { zoneId: viewpointZoneId }),
    },
    {
      kind: "inner_monologue",
      note: "The viewpoint's private thoughts, feelings, and reactions may be voiced.",
      subjectActorIds: [input.viewpointActorId],
    },
    {
      kind: "small_talk",
      note: "Conversational filler that delivers none of the armed semantic acts may be freely written.",
      subjectActorIds: [],
    },
    ...licensedSoftCanon.map((entry) => ({
      kind: "established_detail" as const,
      note: "This previously established detail may be reused as-is; propose it again only when it matters.",
      subjectActorIds: [],
      softCanon: { entryId: entry.id, key: entry.key, scope: entry.scope, value: entry.value },
    })),
  ];

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
        preconditionVersion: input.branchVersion,
        effectType: effect.effectType,
        actorId: effect.actorId,
        targetActorIds: [...effect.targetActorIds].sort(compareStableText),
        detail: effect.detail,
        ...(effect.disclosureContent === undefined
          ? {}
          : { disclosureContent: effect.disclosureContent }),
      }),
    )
    .sort((left, right) => compareStableText(left.id, right.id));

  const relevantPressures = input.viewpointPressures
    .filter((pressure) => pressure.resolvedAt === undefined)
    .map((pressure) => ({
      commitmentId: pressure.sourceCommitmentId,
      severity: pressure.severity,
      actBy: pressure.actBy,
    }))
    .sort((left, right) => compareStableText(left.commitmentId, right.commitmentId));

  const failurePresentations = [...input.failurePresentations].sort(
    (left, right) => compareStableText(left.code, right.code) || compareStableText(left.publicReason, right.publicReason),
  );

  const provenance: NarrativeCut["provenance"] = [];
  const addProvenance = (
    field: string,
    kind: NarrativeCut["provenance"][number]["kind"],
    ids: readonly string[],
  ): void => {
    if (ids.length > 0) provenance.push({ field, kind, ids: [...ids] });
  };
  addProvenance("currentLoci", "locus", currentLoci.map((locus) => locus.actorId));
  addProvenance("currentActivities", "activity", currentActivities.map((activity) => activity.activityId));
  addProvenance("mustEnact", "event", mustEnact.map((beat) => beat.eventId));
  addProvenance("allowedTransitions", "event", allowedTransitions.map((beat) => beat.eventId));
  addProvenance("perceptibleNow", "observation", perceptibleNow.map((view) => view.observationId));
  addProvenance("speakerBeliefs", "belief", speakerBeliefs.map((view) => view.beliefId));
  addProvenance("relevantPressures", "pressure", relevantPressures.map((view) => view.commitmentId));
  addProvenance("creativeLicenses", "soft_canon", licensedSoftCanon.map((entry) => entry.id));
  addProvenance("failurePresentations", "failure", failurePresentations.map((failure) => failure.code));

  const content = {
    compilerVersion: CUT_COMPILER_VERSION,
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
    currentActivities,
    mustEnact,
    perceptibleNow,
    speakerBeliefs,
    relevantPressures,
    allowedTransitions,
    forbiddenClaims,
    failurePresentations,
    creativeLicenses,
    armedEffects,
    bodilyReads: {
      ...(input.bodilyReads?.self === undefined ? {} : { self: input.bodilyReads.self }),
      observed: [...(input.bodilyReads?.observed ?? [])].sort((left, right) =>
        compareStableText(left.actorId, right.actorId),
      ),
    },
    provenance,
  };

  return narrativeCutSchema.parse({
    id: cutId,
    semanticHash: simulationHash(content),
    ...content,
  });
}
