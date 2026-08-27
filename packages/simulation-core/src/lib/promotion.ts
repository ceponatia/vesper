import {
  cohortAdjustedEventSchema,
  cohortRegistryVersionSchema,
  simulationCohortSchema,
  type CohortAdjustedEvent,
  type SimulationCohort,
} from "../contracts/cohorts";
import type { PromotionSampledDetail } from "../contracts/households";
import { composeSimulationId, worldCharacterIdSchema } from "../contracts/identity";
import {
  actorLodAssignedEventSchema,
  actorLodDefaultsByVersion,
  actorLodDerivationVersion,
  actorLodRegistryVersion,
  actorLodStateSchema,
  type ActorLodAssignedEvent,
  type ActorLodState,
} from "../contracts/lod";
import {
  actorMaterializedFromAggregateEventSchema,
  actorPromotionDerivationVersion,
  type ActorMaterializedFromAggregateEvent,
  type PromoteActorFromCohortCommand,
  type PromoteActorFromCohortRejectionCode,
} from "../contracts/promotion";
import { deterministicDrawUnit } from "../contracts/scheduler";
import { physicalLocusSchema, type PhysicalLocus } from "../contracts/space";
import { cohortCanMaterializeAt, cohortDerivationVersionForEvents } from "./cohorts";
import { sortedUnique } from "./hash";

/**
 * E6.4 — the pure actor-promotion kernel: the
 * §26.10 five-step item shape generalized to actors. One resolver produces
 * the whole causation-chained train — the conserved reservation debit, the
 * materialization (with any sampled detail captured so replay never
 * resamples), and the explicit landing-LOD pin. No IO, no clock, no model.
 */

interface PromotionRejection {
  ok: false;
  code: Extract<
    PromoteActorFromCohortRejectionCode,
    | "branch_mismatch"
    | "unauthorized_principal"
    | "cohort_not_found"
    | "zone_not_found"
    | "insufficient_population"
    | "cohort_not_present"
    | "actor_already_exists"
    | "name_required"
  >;
  publicReason: string;
}

function rejection(code: PromotionRejection["code"], publicReason: string): PromotionRejection {
  return { ok: false, code, publicReason };
}

function isPrivilegedPrincipal(kind: string): boolean {
  return kind === "storyteller" || kind === "system";
}

/**
 * The promoted actor's identity — one-level derivation from bounded ids (the
 * `promote_item_from_stock` itemId precedent), exported so the store can
 * probe existence for the SAME id the resolver will mint.
 */
export function derivedPromotedActorId(branchId: string, commandId: string): string {
  return composeSimulationId("actor", [branchId, commandId, "promoted"]);
}

export interface PromoteActorFromCohortResolutionView {
  worldId: string;
  branchId: string;
  rulesetVersion: string;
  headSequence: number;
  storySecond: number;
  worldSeed: string;
  cohort: SimulationCohort | undefined;
  /** The named zone's location, or undefined when the zone does not exist. */
  zoneLocationId: string | undefined;
  /** Fail-closed defense in depth — the derived id is command-unique already. */
  actorExists: boolean;
  /**
   * Authored per-cohort display-name pool (§26.10 step 3); an empty array
   * means no pool. As with item promotion, no pool is authored anywhere yet —
   * the store returns `[]` unconditionally, so a caller that omits `name`
   * MUST supply it until a pool registry exists (a future data edit).
   */
  namePool(cohortId: string): readonly string[];
}

export type PromoteActorFromCohortResolution =
  | PromotionRejection
  | {
      ok: true;
      events: [CohortAdjustedEvent, ActorMaterializedFromAggregateEvent, ActorLodAssignedEvent];
      cohortAfter: SimulationCohort;
      lodState: ActorLodState;
      actor: { id: string; name: string };
      locus: PhysicalLocus;
    };

/** Pure resolver, mirroring `resolvePromoteItemFromStockFromView`'s numbered order (§26.10/§27.2). */
export function resolvePromoteActorFromCohortFromView(
  view: PromoteActorFromCohortResolutionView,
  command: PromoteActorFromCohortCommand,
): PromoteActorFromCohortResolution {
  const { zoneId, landing } = command.payload;

  // 1. branch
  if (command.branchId !== view.branchId) {
    return rejection("branch_mismatch", "That world branch is unavailable.");
  }
  // 2. principal — the same privilege bar as cohort authoring
  if (!isPrivilegedPrincipal(command.principal.kind)) {
    return rejection("unauthorized_principal", "Only the storyteller draws people from the background.");
  }
  // 3. cohort existence
  const cohort = view.cohort;
  if (!cohort) return rejection("cohort_not_found", "That cohort is unavailable.");
  // 4. zone existence (fail-closed §13.1 integrity, as at cohort creation)
  if (view.zoneLocationId === undefined) {
    return rejection("zone_not_found", "That person would appear somewhere that does not exist.");
  }
  // 5. conserved population — someone must exist to draw (§27.2 step 2)
  if (cohort.population < 1) {
    return rejection("insufficient_population", "There is no one left in that crowd.");
  }
  // 6. presence legality — §27.2 step 5 made deterministic: the aggregate's
  // own read must admit a person at the named zone.
  if (!cohortCanMaterializeAt(cohort, zoneId, view.storySecond)) {
    return rejection("cohort_not_present", "No one from that crowd is there right now.");
  }
  // 7. derived-identity collision (defense in depth — command ids are unique)
  const actorId = worldCharacterIdSchema.parse(derivedPromotedActorId(view.branchId, command.id));
  if (view.actorExists) return rejection("actor_already_exists", "That person already exists.");

  // 8. name — supplied, else sampled from a named deterministic stream with
  // the draw captured on the event (§26.10 step 3; replay never resamples).
  let sampledDetail: PromotionSampledDetail | undefined;
  let sampledName: string | undefined;
  if (command.payload.name === undefined) {
    const stream = composeSimulationId("promotion-detail", [command.id, "actor-name"]);
    const pool = view.namePool(cohort.id);
    const draw = deterministicDrawUnit({
      worldSeed: view.worldSeed,
      branchId: view.branchId,
      stream,
      drawIndex: 0,
    });
    sampledName = pool.length > 0 ? pool[Math.floor(draw * pool.length)] : undefined;
    sampledDetail = {
      stream,
      drawIndex: 0,
      ...(sampledName === undefined ? {} : { sampledName }),
      registryVersion: cohortRegistryVersionSchema.parse(cohort.registryVersion),
    };
  }
  const finalName = command.payload.name ?? sampledName;
  if (finalName === undefined) {
    return rejection("name_required", "That person needs a name — none was given and none could be sampled.");
  }

  const shared = {
    worldId: view.worldId,
    branchId: view.branchId,
    schemaVersion: 1,
    rulesetVersion: view.rulesetVersion,
    commandId: command.id,
    correlationId: command.correlationId,
    recordedAtWallClock: command.submittedAtWallClock,
    storySecond: view.storySecond,
  };

  // §27.2 step 2: the reservation debit comes first — the actor exists only
  // because the aggregate provably gave one up.
  const populationAfter = cohort.population - 1;
  const debitEvent: CohortAdjustedEvent = cohortAdjustedEventSchema.parse({
    ...shared,
    id: composeSimulationId("event", [view.branchId, command.id, "cohort-adjusted"]),
    sequence: view.headSequence + 1,
    derivationVersion: cohortDerivationVersionForEvents,
    type: "cohort_adjusted",
    actorIds: [],
    entityIds: [cohort.id],
    payload: {
      cohortId: cohort.id,
      deltaCount: -1,
      reason: "promotion_reservation",
      populationBefore: cohort.population,
      populationAfter,
    },
  });

  // §27.2 step 4: the materialization, causation-chained to its funding debit.
  const materializedEvent: ActorMaterializedFromAggregateEvent =
    actorMaterializedFromAggregateEventSchema.parse({
      ...shared,
      id: composeSimulationId("event", [view.branchId, command.id, "actor-materialized"]),
      sequence: view.headSequence + 2,
      derivationVersion: actorPromotionDerivationVersion,
      causationId: debitEvent.id,
      type: "actor_materialized_from_aggregate",
      actorIds: [actorId],
      entityIds: sortedUnique([actorId, cohort.id]),
      payload: {
        actorId,
        name: finalName,
        cohortId: cohort.id,
        zoneId,
        locationId: view.zoneLocationId,
        ...(sampledDetail === undefined ? {} : { sampledDetail }),
      },
    });

  // The landing-LOD pin. Unlike `assign_actor_lod`, same-as-default values are
  // NOT a no-op here: the row pins a fresh actor's level explicitly, and the
  // event records the materialized landing for audit. `previousWasDefault` is
  // structurally true — the actor had no prior row (it had no prior anything).
  const defaults = actorLodDefaultsByVersion[actorLodRegistryVersion];
  const lodEvent: ActorLodAssignedEvent = actorLodAssignedEventSchema.parse({
    ...shared,
    id: composeSimulationId("event", [view.branchId, command.id, "actor-lod-assigned"]),
    sequence: view.headSequence + 3,
    derivationVersion: actorLodDerivationVersion,
    causationId: materializedEvent.id,
    type: "actor_lod_assigned",
    actorIds: [actorId],
    entityIds: [actorId],
    payload: {
      actorId,
      simulationLod: landing.simulationLod,
      inferenceLod: landing.inferenceLod,
      previousSimulationLod: defaults.simulationLod,
      previousInferenceLod: defaults.inferenceLod,
      previousWasDefault: true,
      registryVersion: actorLodRegistryVersion,
    },
  });

  return {
    ok: true,
    events: [debitEvent, materializedEvent, lodEvent],
    cohortAfter: simulationCohortSchema.parse({ ...cohort, population: populationAfter }),
    lodState: actorLodStateSchema.parse({
      actorId,
      simulationLod: landing.simulationLod,
      inferenceLod: landing.inferenceLod,
      registryVersion: actorLodRegistryVersion,
      assignedAtStorySecond: view.storySecond,
    }),
    actor: { id: actorId, name: finalName },
    locus: physicalLocusSchema.parse({
      kind: "at",
      actorId,
      locationId: view.zoneLocationId,
      zoneId,
      since: view.storySecond,
    }),
  };
}
