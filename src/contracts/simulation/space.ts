import { z } from "zod";
import {
  createCommandEnvelopeSchema,
  createCommandResultSchema,
  createEventEnvelopeSchema,
  createStableStringSetSchema,
} from "./envelopes";
import {
  branchHeadSequenceSchema,
  branchVersionSchema,
  commandIdSchema,
  journeyIdSchema,
  linkIdSchema,
  locationIdSchema,
  rulesetVersionSchema,
  storySecondSchema,
  worldBranchIdSchema,
  worldCharacterIdSchema,
  worldIdSchema,
  zoneIdSchema,
} from "./identity";

/**
 * E3.1 — authoritative space (engine.plan.md §"Gate 3 build order").
 *
 * The first Gate 3 slice: topology, one physical locus per actor, deterministic
 * route planning with lower-bound durations, and the movement event family. It
 * deliberately owns no commitments, activities, engagements, or access *checks*
 * — access, privacy, and consent land in E3.5. Access/privacy *policy* fields
 * appear here only because Location/Zone/Link cannot be typed without them; the
 * fail-closed enforcement that reads them is E3.5's job.
 */

/** Route derivations that cause history record this version (engine.spec §6.4, §13.3). */
export const GATE3_ROUTE_VERSION = "gate3-route-v1" as const;
export const gate3RouteVersionSchema = z.literal(GATE3_ROUTE_VERSION).brand<"DerivationVersion">();

// --- Vocabulary ------------------------------------------------------------

/** Travel modes are an authored, forward-compatible set (memory: schema headroom). */
export const travelModes = ["walk", "run", "cycle", "drive", "transit"] as const;
export const travelModeSchema = z.enum(travelModes);

/**
 * Placeholder access/privacy vocabularies. E3.1 only stores them; E3.5 builds
 * the six-layer check that reads them. Ordered most-open to most-closed so a
 * fail-closed default (E3.5) can pick the last element.
 */
export const accessPolicies = ["public", "restricted", "private"] as const;
export const accessPolicySchema = z.enum(accessPolicies);

export const privacyPolicies = ["public", "semi_private", "private"] as const;
export const privacyPolicySchema = z.enum(privacyPolicies);

export const linkStates = ["open", "closed", "locked", "blocked"] as const;
export const linkStateSchema = z.enum(linkStates);

// --- Topology (engine.spec §13.1) ------------------------------------------

export const coordinateSchema = z
  .object({
    x: z.number(),
    y: z.number(),
  })
  .strict();

export const locationSchema = z
  .object({
    id: locationIdSchema,
    worldId: worldIdSchema,
    kind: z.string().trim().min(1),
    coordinate: coordinateSchema.optional(),
    defaultAccessPolicy: accessPolicySchema,
  })
  .strict();

export const zoneSchema = z
  .object({
    id: zoneIdSchema,
    locationId: locationIdSchema,
    kind: z.string().trim().min(1),
    parentZoneId: zoneIdSchema.optional(),
    occupancyLimit: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
    privacyPolicy: privacyPolicySchema,
  })
  .strict()
  .refine((zone) => zone.parentZoneId !== zone.id, {
    message: "A zone cannot be its own parent",
    path: ["parentZoneId"],
  });

/** A link's travel modes are a sorted-unique set; only its route uses order. */
const linkTravelModesSchema = z
  .array(travelModeSchema)
  .min(1)
  .refine(
    (modes) => new Set(modes).size === modes.length,
    "Link travel modes must be unique",
  )
  .refine(
    (modes) => modes.every((mode, index) => index === 0 || (modes[index - 1] ?? "") < mode),
    "Link travel modes must be sorted",
  );

export const accessWindowSchema = z
  .object({
    opensAtStorySecond: storySecondSchema,
    closesAtStorySecond: storySecondSchema,
  })
  .strict()
  .refine((window) => window.closesAtStorySecond > window.opensAtStorySecond, {
    message: "An access window must close after it opens",
    path: ["closesAtStorySecond"],
  });

export const linkSchema = z
  .object({
    id: linkIdSchema,
    fromZoneId: zoneIdSchema,
    toZoneId: zoneIdSchema,
    modes: linkTravelModesSchema,
    minimumDurationSeconds: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    schedule: z.array(accessWindowSchema).optional(),
    accessPolicy: accessPolicySchema,
    state: linkStateSchema,
  })
  .strict()
  .refine((link) => link.fromZoneId !== link.toZoneId, {
    message: "A link cannot connect a zone to itself",
    path: ["toZoneId"],
  });

// --- Physical locus (engine.spec §13.2) ------------------------------------

/**
 * Exactly one locus per actor per branch. An in-transit actor is not at the
 * origin or destination; projection queries return one row (§13.2).
 */
export const physicalLocusSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("at"),
      actorId: worldCharacterIdSchema,
      locationId: locationIdSchema,
      zoneId: zoneIdSchema,
      since: storySecondSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("in_transit"),
      actorId: worldCharacterIdSchema,
      journeyId: journeyIdSchema,
      linkId: linkIdSchema,
      enteredAt: storySecondSchema,
      earliestExitAt: storySecondSchema,
    })
    .strict()
    .refine((locus) => locus.earliestExitAt >= locus.enteredAt, {
      message: "A transit locus cannot exit before it is entered",
      path: ["earliestExitAt"],
    }),
]);

// --- Route planning (engine.spec §13.3) ------------------------------------

/** Ordered path; hop order is meaningful, so this is not a sorted set. */
const routeLinkIdsSchema = z
  .array(linkIdSchema)
  .min(1)
  .refine((ids) => new Set(ids).size === ids.length, "Route link IDs must be unique");

/** Zones on the route that require an access grant — E3.5 resolves them. */
const routeAccessZoneIdsSchema = createStableStringSetSchema(
  zoneIdSchema,
  "Route access-required zone IDs",
);

export const routeHazardKinds = ["closure", "congestion", "weather", "obstruction"] as const;
export const routeHazardKindSchema = z.enum(routeHazardKinds);

export const routeHazardSchema = z
  .object({
    linkId: linkIdSchema,
    kind: routeHazardKindSchema,
  })
  .strict();

export const routeResultSchema = z
  .object({
    originZoneId: zoneIdSchema,
    destinationZoneId: zoneIdSchema,
    linkIds: routeLinkIdsSchema,
    travelMode: travelModeSchema,
    minimumDurationSeconds: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    expectedDurationSeconds: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    uncertaintySeconds: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    accessRequiredZoneIds: routeAccessZoneIdsSchema.default([]),
    knownHazards: z.array(routeHazardSchema).default([]),
    derivationVersion: gate3RouteVersionSchema,
  })
  .strict()
  .refine((route) => route.destinationZoneId !== route.originZoneId, {
    message: "A route must move between distinct zones",
    path: ["destinationZoneId"],
  })
  .refine((route) => route.expectedDurationSeconds >= route.minimumDurationSeconds, {
    message: "Expected duration cannot precede the lower-bound minimum",
    path: ["expectedDurationSeconds"],
  });

// --- Journey (engine.spec §17) ---------------------------------------------

export const journeyStatuses = [
  "planned",
  "active",
  "delayed",
  "interrupted",
  "arrived",
  "abandoned",
] as const;
export const journeyStatusSchema = z.enum(journeyStatuses);

const journeyActorIdsSchema = createStableStringSetSchema(worldCharacterIdSchema, "Journey actor IDs");

export const journeySchema = z
  .object({
    id: journeyIdSchema,
    actorIds: journeyActorIdsSchema,
    originZoneId: zoneIdSchema,
    destinationZoneId: zoneIdSchema,
    routeLinkIds: routeLinkIdsSchema,
    travelMode: travelModeSchema,
    departedAt: storySecondSchema.optional(),
    earliestArrivalAt: storySecondSchema,
    expectedArrivalAt: storySecondSchema,
    status: journeyStatusSchema,
    currentLinkIndex: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    routeDerivationVersion: gate3RouteVersionSchema,
  })
  .strict()
  .refine((journey) => journey.actorIds.length >= 1, {
    message: "A journey needs at least one traveller",
    path: ["actorIds"],
  })
  .refine((journey) => journey.destinationZoneId !== journey.originZoneId, {
    message: "A journey must move between distinct zones",
    path: ["destinationZoneId"],
  })
  .refine((journey) => journey.expectedArrivalAt >= journey.earliestArrivalAt, {
    message: "Expected arrival cannot precede the lower-bound earliest arrival",
    path: ["expectedArrivalAt"],
  })
  .refine((journey) => journey.currentLinkIndex < journey.routeLinkIds.length, {
    message: "currentLinkIndex must point inside the route",
    path: ["currentLinkIndex"],
  });

// --- MoveActor command (engine.spec §14.1) ---------------------------------

const moveActorPayloadSchema = z
  .object({
    actorId: worldCharacterIdSchema,
    destinationZoneId: zoneIdSchema,
    travelMode: travelModeSchema,
  })
  .strict();

export const moveActorCommandSchema = createCommandEnvelopeSchema(
  "move_actor",
  1,
  moveActorPayloadSchema,
);

export const moveActorRejectionCodes = [
  "invalid_command",
  "duplicate_command_id",
  "branch_mismatch",
  "actor_not_found",
  "unauthorized_actor",
  "destination_not_found",
  "already_at_destination",
  "actor_in_transit",
  "activity_conflict",
  "no_route",
  "route_access_denied",
  "travel_mode_unavailable",
] as const;
export const moveActorRejectionCodeSchema = z.enum(moveActorRejectionCodes);
export const moveActorCommandResultSchema = createCommandResultSchema(moveActorRejectionCodeSchema);

// --- ArriveJourney command (engine.spec §9.3) -------------------------------

/**
 * The command a journey-arrival trigger dispatches at its due story second.
 * It re-validates at fire time (the E2.6 caveat): the journey must still be
 * en route when the trigger fires, or the arrival is rejected rather than
 * forced.
 */
const arriveJourneyPayloadSchema = z
  .object({
    journeyId: journeyIdSchema,
  })
  .strict();

export const arriveJourneyCommandSchema = createCommandEnvelopeSchema(
  "arrive_journey",
  1,
  arriveJourneyPayloadSchema,
);

export const arriveJourneyRejectionCodes = [
  "invalid_command",
  "duplicate_command_id",
  "branch_mismatch",
  "journey_not_found",
  "journey_not_active",
  "unauthorized_principal",
] as const;
export const arriveJourneyRejectionCodeSchema = z.enum(arriveJourneyRejectionCodes);
export const arriveJourneyCommandResultSchema = createCommandResultSchema(
  arriveJourneyRejectionCodeSchema,
);

// --- Movement event family (engine.spec §9.2) ------------------------------

const journeyPlannedPayloadSchema = z
  .object({
    journeyId: journeyIdSchema,
    originZoneId: zoneIdSchema,
    destinationZoneId: zoneIdSchema,
    routeLinkIds: routeLinkIdsSchema,
    travelMode: travelModeSchema,
    earliestArrivalAt: storySecondSchema,
    expectedArrivalAt: storySecondSchema,
    routeDerivationVersion: gate3RouteVersionSchema,
  })
  .strict();

export const journeyPlannedEventSchema = createEventEnvelopeSchema(
  "journey_planned",
  1,
  journeyPlannedPayloadSchema,
).extend({ commandId: commandIdSchema });

const actorDepartedPayloadSchema = z
  .object({
    journeyId: journeyIdSchema,
    fromZoneId: zoneIdSchema,
    linkId: linkIdSchema,
    departedAt: storySecondSchema,
  })
  .strict();

export const actorDepartedEventSchema = createEventEnvelopeSchema(
  "actor_departed",
  1,
  actorDepartedPayloadSchema,
).extend({ commandId: commandIdSchema });

export const journeyDelayReasons = [
  "route_congestion",
  "hazard",
  "access_window_closed",
  "actor_paused",
] as const;
export const journeyDelayReasonSchema = z.enum(journeyDelayReasons);

const journeyDelayedPayloadSchema = z
  .object({
    journeyId: journeyIdSchema,
    previousExpectedArrivalAt: storySecondSchema,
    newExpectedArrivalAt: storySecondSchema,
    reason: journeyDelayReasonSchema,
  })
  .strict()
  .refine((payload) => payload.newExpectedArrivalAt > payload.previousExpectedArrivalAt, {
    message: "A delay must push the expected arrival later",
    path: ["newExpectedArrivalAt"],
  });

export const journeyDelayedEventSchema = createEventEnvelopeSchema(
  "journey_delayed",
  1,
  journeyDelayedPayloadSchema,
);

export const journeyInterruptReasons = [
  "blocked_link",
  "access_revoked",
  "actor_incapacitated",
  "external_event",
] as const;
export const journeyInterruptReasonSchema = z.enum(journeyInterruptReasons);

const journeyInterruptedPayloadSchema = z
  .object({
    journeyId: journeyIdSchema,
    atLinkId: linkIdSchema,
    interruptedAt: storySecondSchema,
    reason: journeyInterruptReasonSchema,
  })
  .strict();

export const journeyInterruptedEventSchema = createEventEnvelopeSchema(
  "journey_interrupted",
  1,
  journeyInterruptedPayloadSchema,
);

const actorArrivedPayloadSchema = z
  .object({
    journeyId: journeyIdSchema,
    destinationZoneId: zoneIdSchema,
    arrivedAt: storySecondSchema,
  })
  .strict();

export const actorArrivedEventSchema = createEventEnvelopeSchema(
  "actor_arrived",
  1,
  actorArrivedPayloadSchema,
);

export const journeyAbandonReasons = [
  "actor_choice",
  "destination_unreachable",
  "superseded",
] as const;
export const journeyAbandonReasonSchema = z.enum(journeyAbandonReasons);

const journeyAbandonedPayloadSchema = z
  .object({
    journeyId: journeyIdSchema,
    abandonedAt: storySecondSchema,
    reason: journeyAbandonReasonSchema,
  })
  .strict();

export const journeyAbandonedEventSchema = createEventEnvelopeSchema(
  "journey_abandoned",
  1,
  journeyAbandonedPayloadSchema,
);

// --- Space projection ------------------------------------------------------

/** The rebuildable current-space read the E3.1 store maintains and replay rebuilds. */
export const spaceProjectionSchema = z
  .object({
    worldId: worldIdSchema,
    branchId: worldBranchIdSchema,
    rulesetVersion: rulesetVersionSchema,
    version: branchVersionSchema,
    headSequence: branchHeadSequenceSchema,
    storySecond: storySecondSchema,
    locations: z.array(locationSchema),
    zones: z.array(zoneSchema),
    links: z.array(linkSchema),
    loci: z.array(physicalLocusSchema),
    journeys: z.array(journeySchema),
  })
  .strict();

// --- Types -----------------------------------------------------------------

export type TravelMode = z.infer<typeof travelModeSchema>;
export type AccessPolicy = z.infer<typeof accessPolicySchema>;
export type PrivacyPolicy = z.infer<typeof privacyPolicySchema>;
export type LinkState = z.infer<typeof linkStateSchema>;
export type Coordinate = z.infer<typeof coordinateSchema>;
export type SimulationLocation = z.infer<typeof locationSchema>;
export type SimulationZone = z.infer<typeof zoneSchema>;
export type AccessWindow = z.infer<typeof accessWindowSchema>;
export type SimulationLink = z.infer<typeof linkSchema>;
export type PhysicalLocus = z.infer<typeof physicalLocusSchema>;
export type RouteHazard = z.infer<typeof routeHazardSchema>;
export type RouteResult = z.infer<typeof routeResultSchema>;
export type RouteResultInput = z.input<typeof routeResultSchema>;
export type JourneyStatus = z.infer<typeof journeyStatusSchema>;
export type Journey = z.infer<typeof journeySchema>;
export type MoveActorCommand = z.infer<typeof moveActorCommandSchema>;
export type MoveActorCommandInput = z.input<typeof moveActorCommandSchema>;
export type MoveActorRejectionCode = z.infer<typeof moveActorRejectionCodeSchema>;
export type MoveActorCommandResult = z.infer<typeof moveActorCommandResultSchema>;
export type ArriveJourneyCommand = z.infer<typeof arriveJourneyCommandSchema>;
export type ArriveJourneyCommandInput = z.input<typeof arriveJourneyCommandSchema>;
export type ArriveJourneyRejectionCode = z.infer<typeof arriveJourneyRejectionCodeSchema>;
export type ArriveJourneyCommandResult = z.infer<typeof arriveJourneyCommandResultSchema>;
export type JourneyPlannedEvent = z.infer<typeof journeyPlannedEventSchema>;
export type ActorDepartedEvent = z.infer<typeof actorDepartedEventSchema>;
export type JourneyDelayReason = z.infer<typeof journeyDelayReasonSchema>;
export type JourneyDelayedEvent = z.infer<typeof journeyDelayedEventSchema>;
export type JourneyInterruptReason = z.infer<typeof journeyInterruptReasonSchema>;
export type JourneyInterruptedEvent = z.infer<typeof journeyInterruptedEventSchema>;
export type ActorArrivedEvent = z.infer<typeof actorArrivedEventSchema>;
export type JourneyAbandonReason = z.infer<typeof journeyAbandonReasonSchema>;
export type JourneyAbandonedEvent = z.infer<typeof journeyAbandonedEventSchema>;
export type SpaceProjection = z.infer<typeof spaceProjectionSchema>;
export type SpaceProjectionInput = z.input<typeof spaceProjectionSchema>;
