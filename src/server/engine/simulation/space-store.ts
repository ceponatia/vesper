import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import {
  activityClaimSchema,
  claimHoldingActivityPhases,
} from "@/contracts/simulation/activities";
import {
  claimHoldingEngagementStates,
  engagementSchema,
} from "@/contracts/simulation/engagements";
import { buildDepartureInterruptEvent } from "@/lib/simulation/engagements";
import {
  branchHeadSequenceSchema,
  branchVersionSchema,
  rulesetVersionSchema,
  storySecondSchema,
  worldBranchIdSchema,
  worldIdSchema,
} from "@/contracts/simulation/identity";
import {
  arriveJourneyCommandResultSchema,
  arriveJourneyCommandSchema,
  journeySchema,
  linkSchema,
  locationSchema,
  moveActorCommandResultSchema,
  moveActorCommandSchema,
  physicalLocusSchema,
  spaceProjectionSchema,
  zoneSchema,
  type ArriveJourneyCommand,
  type ArriveJourneyCommandResult,
  type Journey,
  type MoveActorCommand,
  type MoveActorCommandResult,
  type PhysicalLocus,
  type SpaceProjection,
} from "@/contracts/simulation/space";
import {
  assertSpaceInvariants,
  resolveJourneyArrival,
  resolveMoveActor,
  sortSpaceProjection,
} from "@/lib/simulation/space";
import {
  db,
  simActivities,
  simBranches,
  simCharacters,
  simCommands,
  simEngagements,
  simEvents,
  simJourneys,
  simLinks,
  simLocations,
  simPhysicalLoci,
  simWorlds,
  simZones,
  type Db,
} from "@/server/db";
import { recordCommandObservations } from "./observation-store";
import { applyTriggerScheduledEvent, type SimTx } from "./trigger-projector";

type DbExecutor = Db | SimTx;

/**
 * E3.1 durable space authority. Topology rows are branch-scoped seeded
 * statics; loci and journeys are event-projected state maintained in the same
 * transaction as their events, exactly like item holdings (E2.2).
 */

export interface SpaceStoreOptions {
  database?: Db;
  /** See item-transfer-store: scheduler-originated commands admit at the locked version. */
  admitAtLockedVersion?: boolean;
}

const spaceTopologySeedSchema = z
  .object({
    branchId: worldBranchIdSchema,
    locations: z.array(locationSchema),
    zones: z.array(zoneSchema),
    links: z.array(linkSchema),
    loci: z.array(physicalLocusSchema),
  })
  .strict();

export type SpaceTopologySeed = z.input<typeof spaceTopologySeedSchema>;

interface SpaceRows {
  locations: (typeof simLocations.$inferSelect)[];
  zones: (typeof simZones.$inferSelect)[];
  links: (typeof simLinks.$inferSelect)[];
  loci: (typeof simPhysicalLoci.$inferSelect)[];
  journeys: (typeof simJourneys.$inferSelect)[];
}

export async function loadSpaceRows(executor: DbExecutor, branchId: string): Promise<SpaceRows> {
  const [locations, zones, links, loci, journeys] = await Promise.all([
    executor.select().from(simLocations).where(eq(simLocations.branchId, branchId)).orderBy(asc(simLocations.locationId)),
    executor.select().from(simZones).where(eq(simZones.branchId, branchId)).orderBy(asc(simZones.zoneId)),
    executor.select().from(simLinks).where(eq(simLinks.branchId, branchId)).orderBy(asc(simLinks.linkId)),
    executor.select().from(simPhysicalLoci).where(eq(simPhysicalLoci.branchId, branchId)).orderBy(asc(simPhysicalLoci.actorId)),
    executor.select().from(simJourneys).where(eq(simJourneys.branchId, branchId)).orderBy(asc(simJourneys.journeyId)),
  ]);
  return { locations, zones, links, loci, journeys };
}

export function locusFromRow(row: typeof simPhysicalLoci.$inferSelect): PhysicalLocus {
  return physicalLocusSchema.parse(
    row.kind === "at"
      ? {
          kind: "at",
          actorId: row.actorId,
          locationId: row.locationId,
          zoneId: row.zoneId,
          since: row.since,
        }
      : {
          kind: "in_transit",
          actorId: row.actorId,
          journeyId: row.journeyId,
          linkId: row.linkId,
          enteredAt: row.enteredAt,
          earliestExitAt: row.earliestExitAt,
        },
  );
}

export function journeyFromRow(row: typeof simJourneys.$inferSelect): Journey {
  return journeySchema.parse({
    id: row.journeyId,
    actorIds: row.actorIds,
    originZoneId: row.originZoneId,
    destinationZoneId: row.destinationZoneId,
    routeLinkIds: row.routeLinkIds,
    travelMode: row.travelMode,
    ...(row.departedAt === null ? {} : { departedAt: row.departedAt }),
    earliestArrivalAt: row.earliestArrivalAt,
    expectedArrivalAt: row.expectedArrivalAt,
    status: row.status,
    currentLinkIndex: row.currentLinkIndex,
    routeDerivationVersion: row.routeDerivationVersion,
  });
}

export interface SpaceBranchMetaView {
  worldId: string;
  branchId: string;
  rulesetVersion: string;
  version: number;
  headSequence: number;
  storySecond: number;
}

/** Assemble the typed space projection from branch-scoped rows. */
export function spaceProjectionFromRows(meta: SpaceBranchMetaView, rows: SpaceRows): SpaceProjection {
  const projection = spaceProjectionSchema.parse({
    worldId: meta.worldId,
    branchId: meta.branchId,
    rulesetVersion: meta.rulesetVersion,
    version: meta.version,
    headSequence: meta.headSequence,
    storySecond: meta.storySecond,
    locations: rows.locations.map((row) => ({
      id: row.locationId,
      worldId: meta.worldId,
      kind: row.kind,
      ...(row.coordinateX === null || row.coordinateY === null
        ? {}
        : { coordinate: { x: row.coordinateX, y: row.coordinateY } }),
      defaultAccessPolicy: row.defaultAccessPolicy,
    })),
    zones: rows.zones.map((row) => ({
      id: row.zoneId,
      locationId: row.locationId,
      kind: row.kind,
      ...(row.parentZoneId === null ? {} : { parentZoneId: row.parentZoneId }),
      ...(row.occupancyLimit === null ? {} : { occupancyLimit: row.occupancyLimit }),
      privacyPolicy: row.privacyPolicy,
    })),
    links: rows.links.map((row) => ({
      id: row.linkId,
      fromZoneId: row.fromZoneId,
      toZoneId: row.toZoneId,
      modes: row.modes,
      minimumDurationSeconds: row.minimumDurationSeconds,
      ...(row.schedule === null ? {} : { schedule: row.schedule }),
      accessPolicy: row.accessPolicy,
      state: row.state,
    })),
    loci: rows.loci.map(locusFromRow),
    journeys: rows.journeys.map(journeyFromRow),
  });
  return sortSpaceProjection(projection);
}

/** Load the current typed space projection without a write lock. */
export async function readDurableSpaceBranch(
  rawBranchId: string,
  database: Db = db(),
): Promise<SpaceProjection> {
  const branchId = worldBranchIdSchema.parse(rawBranchId);
  return database.transaction(
    async (tx) => {
      const [branch] = await tx
        .select({
          id: simBranches.id,
          worldId: simBranches.worldId,
          headSequence: simBranches.headSequence,
          version: simBranches.version,
          storySecond: simBranches.storySecond,
          rulesetVersion: simWorlds.rulesetVersion,
        })
        .from(simBranches)
        .innerJoin(simWorlds, eq(simWorlds.id, simBranches.worldId))
        .where(eq(simBranches.id, branchId))
        .limit(1);
      if (!branch) throw new Error("Simulation branch not found");
      const rows = await loadSpaceRows(tx, branchId);
      return spaceProjectionFromRows(
        {
          worldId: branch.worldId,
          branchId: branch.id,
          rulesetVersion: branch.rulesetVersion,
          version: branch.version,
          headSequence: branch.headSequence,
          storySecond: branch.storySecond,
        },
        rows,
      );
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}

interface SpaceRowInserts {
  locations: (typeof simLocations.$inferInsert)[];
  zones: (typeof simZones.$inferInsert)[];
  links: (typeof simLinks.$inferInsert)[];
  loci: (typeof simPhysicalLoci.$inferInsert)[];
  journeys: (typeof simJourneys.$inferInsert)[];
}

function locusInsert(
  branchId: string,
  locus: PhysicalLocus,
  updatedSequence: number,
): typeof simPhysicalLoci.$inferInsert {
  return locus.kind === "at"
    ? {
        branchId,
        actorId: locus.actorId,
        kind: "at",
        locationId: locus.locationId,
        zoneId: locus.zoneId,
        since: locus.since,
        journeyId: null,
        linkId: null,
        enteredAt: null,
        earliestExitAt: null,
        updatedSequence,
      }
    : {
        branchId,
        actorId: locus.actorId,
        kind: "in_transit",
        locationId: null,
        zoneId: null,
        since: null,
        journeyId: locus.journeyId,
        linkId: locus.linkId,
        enteredAt: locus.enteredAt,
        earliestExitAt: locus.earliestExitAt,
        updatedSequence,
      };
}

function journeyInsert(
  branchId: string,
  journey: Journey,
  updatedSequence: number,
): typeof simJourneys.$inferInsert {
  return {
    branchId,
    journeyId: journey.id,
    actorIds: [...journey.actorIds],
    originZoneId: journey.originZoneId,
    destinationZoneId: journey.destinationZoneId,
    routeLinkIds: [...journey.routeLinkIds],
    travelMode: journey.travelMode,
    departedAt: journey.departedAt ?? null,
    earliestArrivalAt: journey.earliestArrivalAt,
    expectedArrivalAt: journey.expectedArrivalAt,
    status: journey.status,
    currentLinkIndex: journey.currentLinkIndex,
    routeDerivationVersion: journey.routeDerivationVersion,
    updatedSequence,
  };
}

/** Build the full row set for a space projection — the fork child materializer. */
export function spaceRowInsertsForProjection(
  branchId: string,
  projection: SpaceProjection,
  sequenceByActor: ReadonlyMap<string, number>,
  sequenceByJourney: ReadonlyMap<string, number>,
): SpaceRowInserts {
  return {
    locations: projection.locations.map((location) => ({
      branchId,
      locationId: location.id,
      kind: location.kind,
      coordinateX: location.coordinate?.x ?? null,
      coordinateY: location.coordinate?.y ?? null,
      defaultAccessPolicy: location.defaultAccessPolicy,
    })),
    zones: projection.zones.map((zone) => ({
      branchId,
      zoneId: zone.id,
      locationId: zone.locationId,
      kind: zone.kind,
      parentZoneId: zone.parentZoneId ?? null,
      occupancyLimit: zone.occupancyLimit ?? null,
      privacyPolicy: zone.privacyPolicy,
    })),
    links: projection.links.map((link) => ({
      branchId,
      linkId: link.id,
      fromZoneId: link.fromZoneId,
      toZoneId: link.toZoneId,
      modes: [...link.modes],
      minimumDurationSeconds: link.minimumDurationSeconds,
      schedule: link.schedule ? [...link.schedule] : null,
      accessPolicy: link.accessPolicy,
      state: link.state,
    })),
    loci: projection.loci.map((locus) => locusInsert(branchId, locus, sequenceByActor.get(locus.actorId) ?? 0)),
    journeys: projection.journeys.map((journey) =>
      journeyInsert(branchId, journey, sequenceByJourney.get(journey.id) ?? 0),
    ),
  };
}

export async function insertSpaceRows(tx: SimTx, inserts: SpaceRowInserts): Promise<void> {
  if (inserts.locations.length > 0) await tx.insert(simLocations).values(inserts.locations);
  if (inserts.zones.length > 0) await tx.insert(simZones).values(inserts.zones);
  if (inserts.links.length > 0) await tx.insert(simLinks).values(inserts.links);
  if (inserts.loci.length > 0) await tx.insert(simPhysicalLoci).values(inserts.loci);
  if (inserts.journeys.length > 0) await tx.insert(simJourneys).values(inserts.journeys);
}

/**
 * Seed one branch's topology and starting loci atomically. A seed is pre-event
 * state (plan R3): it must land before the branch's first event, and every
 * locus actor must already exist in the branch's character registry.
 */
export async function seedDurableSpaceTopology(
  rawSeed: SpaceTopologySeed,
  options: { database?: Db } = {},
): Promise<void> {
  const seed = spaceTopologySeedSchema.parse(rawSeed);
  const database = options.database ?? db();

  await database.transaction(async (tx) => {
    const [branch] = await tx
      .select({
        id: simBranches.id,
        worldId: simBranches.worldId,
        headSequence: simBranches.headSequence,
        version: simBranches.version,
        storySecond: simBranches.storySecond,
        rulesetVersion: simWorlds.rulesetVersion,
      })
      .from(simBranches)
      .innerJoin(simWorlds, eq(simWorlds.id, simBranches.worldId))
      .where(eq(simBranches.id, seed.branchId))
      .limit(1)
      .for("update", { of: simBranches });
    if (!branch) throw new Error("Cannot seed space onto an unavailable branch");
    if (branch.headSequence !== 0) {
      throw new Error("A space seed must land before the branch's first event");
    }

    // Validate the seed as a coherent zero-state projection before writing.
    const projection = spaceProjectionFromRows(
      {
        worldId: branch.worldId,
        branchId: branch.id,
        rulesetVersion: branch.rulesetVersion,
        version: 0,
        headSequence: 0,
        storySecond: branch.storySecond,
      },
      {
        locations: [],
        zones: [],
        links: [],
        loci: [],
        journeys: [],
      },
    );
    const seeded = sortSpaceProjection(
      spaceProjectionSchema.parse({
        ...projection,
        locations: seed.locations,
        zones: seed.zones,
        links: seed.links,
        loci: seed.loci,
      }),
    );
    assertSpaceInvariants(seeded);

    const inserts = spaceRowInsertsForProjection(branch.id, seeded, new Map(), new Map());
    await insertSpaceRows(tx, inserts);
  });
}

function invalidMoveResult(): MoveActorCommandResult {
  return {
    status: "rejected",
    commandId: "invalid",
    code: "invalid_command",
    publicReason: "That movement request is invalid.",
    legalAlternativeCommandTypes: [],
  };
}

function invalidArrivalResult(): ArriveJourneyCommandResult {
  return {
    status: "rejected",
    commandId: "invalid",
    code: "invalid_command",
    publicReason: "That arrival request is invalid.",
    legalAlternativeCommandTypes: [],
  };
}

async function loadTopologyView(tx: SimTx, meta: SpaceBranchMetaView) {
  const rows = await loadSpaceRows(tx, meta.branchId);
  const projection = spaceProjectionFromRows(meta, rows);
  return {
    projection,
    topology: {
      locations: projection.locations,
      zones: projection.zones,
      links: projection.links,
    },
  };
}

/**
 * Execute one MoveActor against PostgreSQL authority: journey_planned,
 * actor_departed, and the arrival trigger_scheduled event commit atomically
 * with the locus flip, journey row, trigger row, branch advance, and command
 * result (spec §11.1).
 */
export async function submitDurableMoveActor(
  rawCommand: unknown,
  options: SpaceStoreOptions = {},
): Promise<MoveActorCommandResult> {
  const parsed = moveActorCommandSchema.safeParse(rawCommand);
  if (!parsed.success) return invalidMoveResult();
  const submitted = parsed.data;
  const database = options.database ?? db();

  const [preLockCached] = await database
    .select({ result: simCommands.result })
    .from(simCommands)
    .where(
      and(eq(simCommands.branchId, submitted.branchId), eq(simCommands.idempotencyKey, submitted.idempotencyKey)),
    )
    .limit(1);
  if (preLockCached) return moveActorCommandResultSchema.parse(preLockCached.result);

  return database.transaction(async (tx) => {
    const [branch] = await tx
      .select({
        id: simBranches.id,
        worldId: simBranches.worldId,
        headSequence: simBranches.headSequence,
        version: simBranches.version,
        storySecond: simBranches.storySecond,
        rulesetVersion: simWorlds.rulesetVersion,
        worldStatus: simWorlds.status,
      })
      .from(simBranches)
      .innerJoin(simWorlds, eq(simWorlds.id, simBranches.worldId))
      .where(eq(simBranches.id, submitted.branchId))
      .limit(1)
      .for("update", { of: simBranches });
    if (!branch) {
      return {
        status: "rejected",
        commandId: submitted.id,
        code: "branch_mismatch",
        publicReason: "That world branch is unavailable.",
        legalAlternativeCommandTypes: [],
      } satisfies MoveActorCommandResult;
    }

    const command: MoveActorCommand = options.admitAtLockedVersion
      ? { ...submitted, expectedVersion: branchVersionSchema.parse(branch.version) }
      : submitted;

    const [cached] = await tx
      .select({ result: simCommands.result })
      .from(simCommands)
      .where(and(eq(simCommands.branchId, command.branchId), eq(simCommands.idempotencyKey, command.idempotencyKey)))
      .limit(1);
    if (cached) return moveActorCommandResultSchema.parse(cached.result);

    const [sameCommandId] = await tx
      .select({ idempotencyKey: simCommands.idempotencyKey })
      .from(simCommands)
      .where(and(eq(simCommands.branchId, command.branchId), eq(simCommands.commandId, command.id)))
      .limit(1);

    let commandResult: MoveActorCommandResult;
    if (sameCommandId) {
      commandResult = {
        status: "rejected",
        commandId: command.id,
        code: "duplicate_command_id",
        publicReason: "That movement request has already been submitted.",
        legalAlternativeCommandTypes: [],
      };
    } else if (branch.worldStatus !== "active") {
      commandResult = {
        status: "rejected",
        commandId: command.id,
        code: "branch_mismatch",
        publicReason: "That world branch is unavailable.",
        legalAlternativeCommandTypes: [],
      };
    } else if (command.expectedVersion !== branch.version) {
      commandResult = {
        status: "conflict",
        commandId: command.id,
        currentVersion: branch.version,
        retryable: true,
      };
    } else {
      const meta: SpaceBranchMetaView = {
        worldId: branch.worldId,
        branchId: branch.id,
        rulesetVersion: branch.rulesetVersion,
        version: branch.version,
        headSequence: branch.headSequence,
        storySecond: branch.storySecond,
      };
      const [actorRow] = await tx
        .select({ characterId: simCharacters.characterId })
        .from(simCharacters)
        .where(
          and(eq(simCharacters.branchId, command.branchId), eq(simCharacters.characterId, command.payload.actorId)),
        )
        .limit(1);
      const { projection, topology } = await loadTopologyView(tx, meta);
      const locus = projection.loci.find((candidate) => candidate.actorId === command.payload.actorId);

      // E3.2 claim integration: departure is illegal while a claim-holding
      // activity occupies the actor's body (spec §3.1 invariant 4).
      const claimRows = await tx
        .select({ claims: simActivities.claims })
        .from(simActivities)
        .where(
          and(
            eq(simActivities.branchId, command.branchId),
            inArray(simActivities.phase, [...claimHoldingActivityPhases]),
            sql`${simActivities.actorIds} @> ${JSON.stringify([command.payload.actorId])}::jsonb`,
          ),
        );
      const actorHoldsBodyClaim = claimRows.some((row) =>
        z.array(activityClaimSchema).parse(row.claims).some((claim) => claim.kind === "body"),
      );

      const resolution = resolveMoveActor(
        {
          worldId: worldIdSchema.parse(branch.worldId),
          branchId: worldBranchIdSchema.parse(branch.id),
          rulesetVersion: rulesetVersionSchema.parse(branch.rulesetVersion),
          version: branchVersionSchema.parse(branch.version),
          headSequence: branchHeadSequenceSchema.parse(branch.headSequence),
          storySecond: storySecondSchema.parse(branch.storySecond),
          topology,
          actorExists: actorRow !== undefined,
          ...(locus ? { locus } : {}),
          actorHoldsBodyClaim,
        },
        command,
      );

      if (!resolution.ok) {
        commandResult = {
          status: "rejected",
          commandId: command.id,
          code: resolution.code,
          publicReason: resolution.publicReason,
          legalAlternativeCommandTypes: [],
        };
      } else {
        for (const event of resolution.events) {
          await tx.insert(simEvents).values({
            id: event.id,
            worldId: event.worldId,
            branchId: event.branchId,
            sequence: event.sequence,
            storySecond: event.storySecond,
            type: event.type,
            schemaVersion: event.schemaVersion,
            rulesetVersion: event.rulesetVersion,
            derivationVersion: "derivationVersion" in event ? event.derivationVersion : undefined,
            commandId: event.commandId,
            causationId: event.causationId,
            correlationId: event.correlationId,
            actorIds: event.actorIds,
            entityIds: event.entityIds,
            locationId: event.locationId,
            recordedAt: new Date(event.recordedAtWallClock),
            payload: event.payload,
          });
        }

        const [, , triggerEvent] = resolution.events;
        await applyTriggerScheduledEvent(tx, triggerEvent, { branchId: branch.id, worldId: branch.worldId });

        await tx.insert(simJourneys).values(
          journeyInsert(branch.id, resolution.journey, resolution.events[1].sequence),
        );
        const flipped = await tx
          .update(simPhysicalLoci)
          .set({
            kind: "in_transit",
            locationId: null,
            zoneId: null,
            since: null,
            journeyId: resolution.locus.kind === "in_transit" ? resolution.locus.journeyId : null,
            linkId: resolution.locus.kind === "in_transit" ? resolution.locus.linkId : null,
            enteredAt: resolution.locus.kind === "in_transit" ? resolution.locus.enteredAt : null,
            earliestExitAt: resolution.locus.kind === "in_transit" ? resolution.locus.earliestExitAt : null,
            updatedSequence: resolution.events[1].sequence,
          })
          .where(
            and(
              eq(simPhysicalLoci.branchId, branch.id),
              eq(simPhysicalLoci.actorId, command.payload.actorId),
              eq(simPhysicalLoci.kind, "at"),
            ),
          )
          .returning({ actorId: simPhysicalLoci.actorId });
        if (flipped.length !== 1) {
          throw new Error("Locked physical locus changed before its transit flip");
        }

        // A departure breaks any open co-present scene the mover occupies:
        // interrupted in the same transaction (spec §18.2 — one body, one
        // physical scene).
        const lastSequence = await interruptCoPresentEngagementsForActor(tx, {
          branch: {
            worldId: branch.worldId,
            branchId: branch.id,
            rulesetVersion: branch.rulesetVersion,
            headSequence: branch.headSequence,
            storySecond: branch.storySecond,
          },
          command: {
            id: command.id,
            correlationId: command.correlationId,
            submittedAtWallClock: command.submittedAtWallClock,
          },
          actorId: command.payload.actorId,
          causationId: resolution.events[1].id,
          startSequence: resolution.events[2].sequence,
        });
        // E4.1: derive who perceived the departure (and any scene interrupt)
        // against the post-command loci, inside the same transaction (§20).
        await recordCommandObservations(tx, { id: branch.id, headSequence: branch.headSequence });
        const advanced = await tx
          .update(simBranches)
          .set({ headSequence: lastSequence, version: branch.version + 1 })
          .where(
            and(
              eq(simBranches.id, branch.id),
              eq(simBranches.version, branch.version),
              eq(simBranches.headSequence, branch.headSequence),
            ),
          )
          .returning({ id: simBranches.id });
        if (advanced.length !== 1) {
          throw new Error("Locked simulation branch failed its compare-and-swap advance");
        }

        commandResult = {
          status: "accepted",
          commandId: command.id,
          branchVersion: branch.version + 1,
          firstSequence: resolution.events[0].sequence,
          lastSequence,
          eventIds: resolution.events.map((event) => event.id),
        };
      }
    }

    await tx.insert(simCommands).values({
      branchId: command.branchId,
      idempotencyKey: command.idempotencyKey,
      commandId: command.id,
      type: command.type,
      schemaVersion: command.schemaVersion,
      expectedVersion: command.expectedVersion,
      principalKind: command.principal.kind,
      envelope: command,
      status: commandResult.status,
      result: commandResult,
      submittedAt: new Date(command.submittedAtWallClock),
    });
    return commandResult;
  });
}

/**
 * Resolve one journey arrival at fire time. The scheduler has already stepped
 * the branch clock to the trigger's due second (spec §12.2 step 3), so the
 * arrival event is stamped with the arrival time, not the submission time.
 */
export async function submitDurableJourneyArrival(
  rawCommand: unknown,
  options: SpaceStoreOptions = {},
): Promise<ArriveJourneyCommandResult> {
  const parsed = arriveJourneyCommandSchema.safeParse(rawCommand);
  if (!parsed.success) return invalidArrivalResult();
  const submitted = parsed.data;
  const database = options.database ?? db();

  const [preLockCached] = await database
    .select({ result: simCommands.result })
    .from(simCommands)
    .where(
      and(eq(simCommands.branchId, submitted.branchId), eq(simCommands.idempotencyKey, submitted.idempotencyKey)),
    )
    .limit(1);
  if (preLockCached) return arriveJourneyCommandResultSchema.parse(preLockCached.result);

  return database.transaction(async (tx) => {
    const [branch] = await tx
      .select({
        id: simBranches.id,
        worldId: simBranches.worldId,
        headSequence: simBranches.headSequence,
        version: simBranches.version,
        storySecond: simBranches.storySecond,
        rulesetVersion: simWorlds.rulesetVersion,
        worldStatus: simWorlds.status,
      })
      .from(simBranches)
      .innerJoin(simWorlds, eq(simWorlds.id, simBranches.worldId))
      .where(eq(simBranches.id, submitted.branchId))
      .limit(1)
      .for("update", { of: simBranches });
    if (!branch) {
      return {
        status: "rejected",
        commandId: submitted.id,
        code: "branch_mismatch",
        publicReason: "That world branch is unavailable.",
        legalAlternativeCommandTypes: [],
      } satisfies ArriveJourneyCommandResult;
    }

    const command: ArriveJourneyCommand = options.admitAtLockedVersion
      ? { ...submitted, expectedVersion: branchVersionSchema.parse(branch.version) }
      : submitted;

    const [cached] = await tx
      .select({ result: simCommands.result })
      .from(simCommands)
      .where(and(eq(simCommands.branchId, command.branchId), eq(simCommands.idempotencyKey, command.idempotencyKey)))
      .limit(1);
    if (cached) return arriveJourneyCommandResultSchema.parse(cached.result);

    const [sameCommandId] = await tx
      .select({ idempotencyKey: simCommands.idempotencyKey })
      .from(simCommands)
      .where(and(eq(simCommands.branchId, command.branchId), eq(simCommands.commandId, command.id)))
      .limit(1);

    let commandResult: ArriveJourneyCommandResult;
    if (sameCommandId) {
      commandResult = {
        status: "rejected",
        commandId: command.id,
        code: "duplicate_command_id",
        publicReason: "That arrival request has already been submitted.",
        legalAlternativeCommandTypes: [],
      };
    } else if (branch.worldStatus !== "active") {
      commandResult = {
        status: "rejected",
        commandId: command.id,
        code: "branch_mismatch",
        publicReason: "That world branch is unavailable.",
        legalAlternativeCommandTypes: [],
      };
    } else if (command.expectedVersion !== branch.version) {
      commandResult = {
        status: "conflict",
        commandId: command.id,
        currentVersion: branch.version,
        retryable: true,
      };
    } else {
      const meta: SpaceBranchMetaView = {
        worldId: branch.worldId,
        branchId: branch.id,
        rulesetVersion: branch.rulesetVersion,
        version: branch.version,
        headSequence: branch.headSequence,
        storySecond: branch.storySecond,
      };
      const { projection, topology } = await loadTopologyView(tx, meta);
      const journey = projection.journeys.find((candidate) => candidate.id === command.payload.journeyId);

      const resolution = resolveJourneyArrival(
        {
          worldId: worldIdSchema.parse(branch.worldId),
          branchId: worldBranchIdSchema.parse(branch.id),
          rulesetVersion: rulesetVersionSchema.parse(branch.rulesetVersion),
          version: branchVersionSchema.parse(branch.version),
          headSequence: branchHeadSequenceSchema.parse(branch.headSequence),
          storySecond: storySecondSchema.parse(branch.storySecond),
          topology,
          ...(journey ? { journey } : {}),
        },
        command,
      );

      if (!resolution.ok) {
        commandResult = {
          status: "rejected",
          commandId: command.id,
          code: resolution.code,
          publicReason: resolution.publicReason,
          legalAlternativeCommandTypes: [],
        };
      } else {
        const event = resolution.event;
        await tx.insert(simEvents).values({
          id: event.id,
          worldId: event.worldId,
          branchId: event.branchId,
          sequence: event.sequence,
          storySecond: event.storySecond,
          type: event.type,
          schemaVersion: event.schemaVersion,
          rulesetVersion: event.rulesetVersion,
          commandId: event.commandId,
          causationId: event.causationId,
          correlationId: event.correlationId,
          actorIds: event.actorIds,
          entityIds: event.entityIds,
          locationId: event.locationId,
          recordedAt: new Date(event.recordedAtWallClock),
          payload: event.payload,
        });

        const [journeyUpdated] = await tx
          .update(simJourneys)
          .set({
            status: "arrived",
            currentLinkIndex: resolution.journey.currentLinkIndex,
            updatedSequence: event.sequence,
          })
          .where(
            and(
              eq(simJourneys.branchId, branch.id),
              eq(simJourneys.journeyId, resolution.journey.id),
              inArray(simJourneys.status, ["active", "delayed"]),
            ),
          )
          .returning({ journeyId: simJourneys.journeyId });
        if (!journeyUpdated) throw new Error("Locked journey changed before its arrival update");

        for (const locus of resolution.loci) {
          if (locus.kind !== "at") throw new Error("Arrival must produce at-loci");
          const [flipped] = await tx
            .update(simPhysicalLoci)
            .set({
              kind: "at",
              locationId: locus.locationId,
              zoneId: locus.zoneId,
              since: locus.since,
              journeyId: null,
              linkId: null,
              enteredAt: null,
              earliestExitAt: null,
              updatedSequence: event.sequence,
            })
            .where(
              and(
                eq(simPhysicalLoci.branchId, branch.id),
                eq(simPhysicalLoci.actorId, locus.actorId),
                eq(simPhysicalLoci.kind, "in_transit"),
                eq(simPhysicalLoci.journeyId, resolution.journey.id),
              ),
            )
            .returning({ actorId: simPhysicalLoci.actorId });
          if (!flipped) throw new Error("Locked physical locus changed before its arrival flip");
        }

        // E4.1: the arrival is perceived by whoever stands at the destination
        // once the traveller does — graded against the flipped loci (§20).
        await recordCommandObservations(tx, { id: branch.id, headSequence: branch.headSequence });

        const advanced = await tx
          .update(simBranches)
          .set({ headSequence: event.sequence, version: branch.version + 1 })
          .where(
            and(
              eq(simBranches.id, branch.id),
              eq(simBranches.version, branch.version),
              eq(simBranches.headSequence, branch.headSequence),
            ),
          )
          .returning({ id: simBranches.id });
        if (advanced.length !== 1) {
          throw new Error("Locked simulation branch failed its compare-and-swap advance");
        }

        commandResult = {
          status: "accepted",
          commandId: command.id,
          branchVersion: branch.version + 1,
          firstSequence: event.sequence,
          lastSequence: event.sequence,
          eventIds: [event.id],
        };
      }
    }

    await tx.insert(simCommands).values({
      branchId: command.branchId,
      idempotencyKey: command.idempotencyKey,
      commandId: command.id,
      type: command.type,
      schemaVersion: command.schemaVersion,
      expectedVersion: command.expectedVersion,
      principalKind: command.principal.kind,
      envelope: command,
      status: commandResult.status,
      result: commandResult,
      submittedAt: new Date(command.submittedAtWallClock),
    });
    return commandResult;
  });
}


/**
 * Interrupt every open co-present engagement an actor occupies, appending one
 * engagement_interrupted event per scene starting after `startSequence`.
 * Returns the last sequence written (== startSequence when none were open).
 * Shared by ordinary departure, threshold entry, and storyteller relocation.
 */
export async function interruptCoPresentEngagementsForActor(
  tx: SimTx,
  input: {
    branch: { worldId: string; branchId: string; rulesetVersion: string; headSequence: number; storySecond: number };
    command: { id: string; correlationId: string; submittedAtWallClock: string };
    actorId: string;
    causationId: string;
    startSequence: number;
  },
): Promise<number> {
  const engagementRows = await tx
    .select()
    .from(simEngagements)
    .where(
      and(
        eq(simEngagements.branchId, input.branch.branchId),
        eq(simEngagements.channel, "co_present"),
        inArray(simEngagements.state, [...claimHoldingEngagementStates]),
        sql`${simEngagements.participantIds} @> ${JSON.stringify([input.actorId])}::jsonb`,
      ),
    )
    .orderBy(asc(simEngagements.engagementId));
  let lastSequence = input.startSequence;
  for (const row of engagementRows) {
    const engagement = engagementSchema.parse({
      id: row.engagementId,
      participantIds: row.participantIds,
      channel: row.channel,
      ...(row.locationId === null ? {} : { locationId: row.locationId }),
      ...(row.zoneId === null ? {} : { zoneId: row.zoneId }),
      state: row.state,
      openedAt: row.openedAt,
      attentionClaim: row.attentionClaim,
      sourceCommandId: row.sourceCommandId,
    });
    lastSequence += 1;
    const interruptEvent = buildDepartureInterruptEvent({
      meta: {
        worldId: input.branch.worldId,
        branchId: input.branch.branchId,
        rulesetVersion: input.branch.rulesetVersion,
        headSequence: input.branch.headSequence,
        storySecond: input.branch.storySecond,
      },
      command: input.command,
      engagement,
      sequence: lastSequence,
      causationId: input.causationId,
    });
    await tx.insert(simEvents).values({
      id: interruptEvent.id,
      worldId: interruptEvent.worldId,
      branchId: interruptEvent.branchId,
      sequence: interruptEvent.sequence,
      storySecond: interruptEvent.storySecond,
      type: interruptEvent.type,
      schemaVersion: interruptEvent.schemaVersion,
      rulesetVersion: interruptEvent.rulesetVersion,
      commandId: interruptEvent.commandId,
      causationId: interruptEvent.causationId,
      correlationId: interruptEvent.correlationId,
      actorIds: interruptEvent.actorIds,
      entityIds: interruptEvent.entityIds,
      locationId: interruptEvent.locationId,
      recordedAt: new Date(interruptEvent.recordedAtWallClock),
      payload: interruptEvent.payload,
    });
    await tx
      .update(simEngagements)
      .set({ state: "interrupted", updatedSequence: interruptEvent.sequence })
      .where(
        and(
          eq(simEngagements.branchId, input.branch.branchId),
          eq(simEngagements.engagementId, engagement.id),
        ),
      );
  }
  return lastSequence;
}
