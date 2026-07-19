import { and, asc, eq, inArray, lte, or } from "drizzle-orm";
import {
  branchForkInputSchema,
  branchForkResultSchema,
  deriveSnapshotId,
  itemTransferSnapshotProjectionKind,
  itemTransferSnapshotSchemaVersion,
  simulationBranchEventSchema,
  simulationSnapshotSchema,
  type BranchForkResult,
  type SimulationBranchEvent,
} from "@/contracts/simulation/branching";
import { composeSimulationId, worldBranchIdSchema } from "@/contracts/simulation/identity";
import {
  itemTransferObservationSchema,
  itemTransferProjectionSchema,
  type ItemTransferProjection,
} from "@/contracts/simulation/item-transfer";
import {
  itemTransferFeedConsumerKind,
  itemTransferFeedProjectionSchemaVersion,
} from "@/contracts/simulation/outbox";
import { schedulerDerivationVersion } from "@/contracts/simulation/scheduler";
import {
  isAccessEvent,
  isActivityEvent,
  isCommitmentEvent,
  isEngagementEvent,
  isMovementEvent,
} from "@/contracts/simulation/branching";
import {
  composeAncestryEventBounds,
  emptyActivitiesSeed,
  emptyCommitmentsSeed,
  emptyEngagementsSeed,
  itemHoldingsAtSequence,
  replayActivitiesHistory,
  replayBranchHistory,
  replayCommitmentsHistory,
  replayEngagementsHistory,
  replayKnowledgeHistory,
  replayObservationsHistory,
  replaySpaceHistory,
  simulationHash,
  spaceSeedForReplay,
  type BranchAncestryNode,
  type BranchEventRange,
} from "@/lib/simulation";
import {
  db,
  simActionDefinitions,
  simActivities,
  simBranches,
  simCharacters,
  simCommitments,
  simConsumerCheckpoints,
  simEngagements,
  simTemporalPressures,
  simEvents,
  simHoldingContainers,
  simItemHoldings,
  simItems,
  simSnapshots,
  simTriggers,
  simWorlds,
  type Db,
} from "@/server/db";
import { activityRowInsert } from "./activity-store";
import { commitmentRowInsert, pressureRowInsert } from "./commitment-store";
import { engagementRowInsert } from "./engagement-store";
import { insertReplayedKnowledge } from "./knowledge-recorder";
import { insertReplayedObservations } from "./observation-store";
import {
  insertSpaceRows,
  loadSpaceRows,
  spaceProjectionFromRows,
  spaceRowInsertsForProjection,
} from "./space-store";
import { applyTriggerScheduledEvent, type SimTx } from "./trigger-projector";

type DbExecutor = Db | SimTx;

/**
 * A pathological fork chain lengthens every ancestry walk; snapshots blunt the
 * cost but a hard ceiling keeps a runaway chain a loud error instead of a slow
 * query storm.
 */
const maxAncestryDepth = 256;

type BranchRow = typeof simBranches.$inferSelect;

export interface BranchAncestry {
  /** Branch rows child-first; the last row is the root. */
  rows: BranchRow[];
  chain: BranchAncestryNode[];
  ranges: BranchEventRange[];
  worldId: string;
  /** The story clock at world creation — the root's recorded origin. */
  rootOriginStorySecond: number;
}

/** Walk the parent chain (plan R4). Every branch-scoped read starts here. */
export async function loadBranchAncestry(
  executor: DbExecutor,
  rawBranchId: string,
): Promise<BranchAncestry> {
  const branchId = worldBranchIdSchema.parse(rawBranchId);
  const rows: BranchRow[] = [];
  const visited = new Set<string>();
  let cursor: string | null = branchId;
  while (cursor) {
    if (visited.has(cursor)) throw new Error("Simulation branch ancestry contains a cycle");
    if (rows.length >= maxAncestryDepth) {
      throw new Error(`Simulation branch ancestry exceeds ${maxAncestryDepth} levels`);
    }
    visited.add(cursor);
    const [row] = await executor.select().from(simBranches).where(eq(simBranches.id, cursor)).limit(1);
    if (!row) {
      throw new Error(rows.length === 0 ? "Simulation branch not found" : "Simulation branch ancestry is broken");
    }
    rows.push(row);
    cursor = row.parentBranchId;
  }
  const chain = rows.map((row) => ({ branchId: row.id, forkSequence: row.forkSequence }));
  const root = rows.at(-1);
  if (!root) throw new Error("Simulation branch not found");
  return {
    rows,
    chain,
    ranges: composeAncestryEventBounds(chain),
    worldId: root.worldId,
    rootOriginStorySecond: root.originStorySecond,
  };
}

function branchEventFromRow(row: typeof simEvents.$inferSelect): SimulationBranchEvent {
  return simulationBranchEventSchema.parse({
    id: row.id,
    worldId: row.worldId,
    branchId: row.branchId,
    sequence: row.sequence,
    storySecond: row.storySecond,
    type: row.type,
    schemaVersion: row.schemaVersion,
    rulesetVersion: row.rulesetVersion,
    ...(row.derivationVersion ? { derivationVersion: row.derivationVersion } : {}),
    ...(row.commandId ? { commandId: row.commandId } : {}),
    ...(row.causationId ? { causationId: row.causationId } : {}),
    correlationId: row.correlationId,
    actorIds: row.actorIds,
    entityIds: row.entityIds,
    ...(row.locationId ? { locationId: row.locationId } : {}),
    recordedAtWallClock: row.recordedAt.toISOString(),
    payload: row.payload,
  });
}

export interface ReadBranchAncestryEventsOptions {
  /** Global upper sequence bound applied on top of every ancestry range. */
  throughSequence?: number;
  /** Exact-sequence point lookup. */
  atSequence?: number;
  types?: readonly string[];
}

/**
 * The R4 read helper: a branch's logical event stream is its own rows plus
 * each ancestor's rows bounded by the fork chain. Call sites cannot forget the
 * bound because the bound is not theirs to supply.
 */
export async function readBranchAncestryEvents(
  executor: DbExecutor,
  ancestry: BranchAncestry,
  options: ReadBranchAncestryEventsOptions = {},
): Promise<SimulationBranchEvent[]> {
  const segments = ancestry.ranges.map((range) => {
    const maxSequence =
      options.throughSequence === undefined
        ? range.maxSequence
        : Math.min(range.maxSequence, options.throughSequence);
    return and(eq(simEvents.branchId, range.branchId), lte(simEvents.sequence, maxSequence));
  });
  const rows = await executor
    .select()
    .from(simEvents)
    .where(
      and(
        or(...segments),
        options.atSequence === undefined ? undefined : eq(simEvents.sequence, options.atSequence),
        options.types === undefined ? undefined : inArray(simEvents.type, [...options.types]),
      ),
    )
    .orderBy(asc(simEvents.sequence));
  return rows.map(branchEventFromRow);
}

export interface DurableBranchState {
  projection: ItemTransferProjection;
  /** The branch's full logical event stream, ancestry-bounded, ordered. */
  events: SimulationBranchEvent[];
  ancestry: BranchAncestry;
}

function compareStableId(left: { id: string }, right: { id: string }): number {
  if (left.id < right.id) return -1;
  if (left.id > right.id) return 1;
  return 0;
}

/** Assemble the live typed projection and event stream inside a caller's transaction. */
export async function assembleBranchState(
  tx: DbExecutor,
  ancestry: BranchAncestry,
): Promise<DurableBranchState> {
  const branch = ancestry.rows[0];
  if (!branch) throw new Error("Simulation branch not found");
  const [worldRows, actorRows, containerRows, itemRows, events] = await Promise.all([
    tx
      .select({ rulesetVersion: simWorlds.rulesetVersion })
      .from(simWorlds)
      .where(eq(simWorlds.id, ancestry.worldId))
      .limit(1),
    tx
      .select()
      .from(simCharacters)
      .where(eq(simCharacters.branchId, branch.id))
      .orderBy(asc(simCharacters.characterId)),
    tx
      .select()
      .from(simHoldingContainers)
      .where(eq(simHoldingContainers.branchId, branch.id))
      .orderBy(asc(simHoldingContainers.holdingContainerId)),
    tx
      .select({
        itemId: simItems.itemId,
        name: simItems.name,
        holdingContainerId: simItemHoldings.holdingContainerId,
      })
      .from(simItems)
      .innerJoin(
        simItemHoldings,
        and(eq(simItemHoldings.branchId, simItems.branchId), eq(simItemHoldings.itemId, simItems.itemId)),
      )
      .where(eq(simItems.branchId, branch.id))
      .orderBy(asc(simItems.itemId)),
    readBranchAncestryEvents(tx, ancestry),
  ]);

  const world = worldRows[0];
  if (!world) throw new Error("Simulation world not found");

  const observations = events.flatMap((event) =>
    event.type !== "item_transferred"
      ? []
      : event.payload.observerActorIds.map((witnessActorId) =>
          itemTransferObservationSchema.parse({
            id: composeSimulationId("observation", [event.id, witnessActorId]),
            sourceEventId: event.id,
            witnessActorId,
            sequence: event.sequence,
            storySecond: event.storySecond,
            itemId: event.payload.itemId,
            fromContainerId: event.payload.fromContainerId,
            toContainerId: event.payload.toContainerId,
            derivationVersion: "gate1-perception-v1",
          }),
        ),
  );

  const projection = itemTransferProjectionSchema.parse({
    worldId: branch.worldId,
    branchId: branch.id,
    rulesetVersion: world.rulesetVersion,
    version: branch.version,
    headSequence: branch.headSequence,
    storySecond: branch.storySecond,
    actors: actorRows.map((row) => ({
      id: row.characterId,
      name: row.name,
      observedContainerIds: row.observedContainerIds,
    })),
    containers: containerRows.map((row) => ({
      id: row.holdingContainerId,
      kind: row.kind,
      name: row.name,
      capacity: row.capacity,
      accessibleToActorIds: row.accessibleToActorIds,
    })),
    items: itemRows.map((row) => ({
      id: row.itemId,
      name: row.name,
      holdingContainerId: row.holdingContainerId,
    })),
    observations,
  });

  return { projection, events, ancestry };
}

/** Load the current typed projection and ancestry-bounded events without a write lock. */
export async function readDurableBranchState(
  rawBranchId: string,
  database: Db = db(),
): Promise<DurableBranchState> {
  return database.transaction(
    async (tx) => {
      const ancestry = await loadBranchAncestry(tx, rawBranchId);
      return assembleBranchState(tx, ancestry);
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}

/**
 * The world-creation state a replay starts from, reverse-derived because the
 * seed step itself is not an event (plan R3): statics are immutable copies,
 * and each item's origin is where its earliest recorded transfer found it.
 * The child identity is stamped so replayed state belongs to the reader.
 */
export function seedProjectionForReplay(input: {
  branchId: string;
  state: DurableBranchState;
}): ItemTransferProjection {
  const { projection } = input.state;
  const currentHoldings = new Map(projection.items.map((item) => [item.id, item.holdingContainerId]));
  const seedHoldings = itemHoldingsAtSequence(currentHoldings, input.state.events, 0);
  return itemTransferProjectionSchema.parse({
    worldId: projection.worldId,
    branchId: input.branchId,
    rulesetVersion: projection.rulesetVersion,
    version: 0,
    headSequence: 0,
    storySecond: input.state.ancestry.rootOriginStorySecond,
    actors: [...projection.actors].sort(compareStableId),
    containers: [...projection.containers].sort(compareStableId),
    items: [...projection.items]
      .map((item) => ({ ...item, holdingContainerId: seedHoldings.get(item.id) ?? item.holdingContainerId }))
      .sort(compareStableId),
    observations: [],
  });
}

export interface ForkBranchOptions {
  database?: Db;
  now?: Date;
}

/**
 * Fork a branch at a past sequence into a causally isolated child (spec §29.3,
 * plan R1/R4). The child's state is produced by replaying ancestor events
 * 1..N through the same projectors that ran live — never by copying current
 * projection or trigger rows — and the child references ancestor events by
 * ancestry rather than owning copies, so its own row set starts empty.
 */
export async function forkBranch(
  rawInput: unknown,
  options: ForkBranchOptions = {},
): Promise<BranchForkResult> {
  const input = branchForkInputSchema.parse(rawInput);
  const database = options.database ?? db();
  const now = options.now ?? new Date();

  return database.transaction(async (tx) => {
    // History at or below the fork point is immutable, but the parent lock
    // keeps the head boundary stable while it is validated and serializes
    // against branch teardown.
    const [parent] = await tx
      .select({
        id: simBranches.id,
        worldId: simBranches.worldId,
        headSequence: simBranches.headSequence,
        rulesetVersion: simWorlds.rulesetVersion,
        worldStatus: simWorlds.status,
      })
      .from(simBranches)
      .innerJoin(simWorlds, eq(simWorlds.id, simBranches.worldId))
      .where(eq(simBranches.id, input.parentBranchId))
      .limit(1)
      .for("update", { of: simBranches });
    if (!parent) throw new Error("Cannot fork an unavailable branch");
    if (parent.worldStatus !== "active") throw new Error("Cannot fork a branch of an inactive world");
    if (input.atSequence > parent.headSequence) {
      throw new Error("Cannot fork past the parent's head sequence");
    }

    const ancestry = await loadBranchAncestry(tx, input.parentBranchId);
    const parentState = await assembleBranchState(tx, ancestry);
    const inherited = parentState.events.filter((event) => event.sequence <= input.atSequence);
    const boundaryBefore = inherited.at(-1);
    const boundaryAfter = parentState.events.find((event) => event.sequence === input.atSequence + 1);
    if (boundaryBefore && boundaryAfter && boundaryBefore.commandId === boundaryAfter.commandId) {
      throw new Error("Cannot fork inside a command's atomic event range");
    }

    const chainBranchIds = ancestry.chain.map((node) => node.branchId);
    const seed = seedProjectionForReplay({ branchId: input.childBranchId, state: parentState });
    const replay = replayBranchHistory({ seed, events: inherited, chainBranchIds });
    const forkStorySecond = boundaryBefore?.storySecond ?? ancestry.rootOriginStorySecond;
    const childProjection = itemTransferProjectionSchema.parse({
      ...replay.projection,
      storySecond: forkStorySecond,
    });
    const inheritedSnapshotChecksum = simulationHash(childProjection);

    await tx.insert(simBranches).values({
      id: input.childBranchId,
      worldId: parent.worldId,
      headSequence: input.atSequence,
      version: childProjection.version,
      storySecond: forkStorySecond,
      originStorySecond: forkStorySecond,
      parentBranchId: parent.id,
      forkSequence: input.atSequence,
      parentRulesetVersion: parent.rulesetVersion,
      parentEventSchemaVersion: inherited.reduce((max, event) => Math.max(max, event.schemaVersion), 1),
      forkedByPrincipalKind: input.principal.kind,
      forkedByPrincipalId: input.principal.principalId,
      forkReason: input.reason,
      inheritedSnapshotChecksum,
    });

    // Materialize the child's typed projections from the replayed state. The
    // statics are the (non-evented) seed copies; placements and their
    // last-changed sequences come from the replay, not the parent's rows.
    const lastPlacedSequence = new Map<string, number>();
    for (const event of inherited) {
      if (event.type === "item_transferred") lastPlacedSequence.set(event.payload.itemId, event.sequence);
    }
    if (childProjection.actors.length > 0) {
      await tx.insert(simCharacters).values(
        childProjection.actors.map((actor) => ({
          branchId: input.childBranchId,
          characterId: actor.id,
          name: actor.name,
          observedContainerIds: actor.observedContainerIds,
        })),
      );
    }
    if (childProjection.containers.length > 0) {
      await tx.insert(simHoldingContainers).values(
        childProjection.containers.map((container) => ({
          branchId: input.childBranchId,
          holdingContainerId: container.id,
          kind: container.kind,
          name: container.name,
          capacity: container.capacity,
          accessibleToActorIds: container.accessibleToActorIds,
        })),
      );
    }
    if (childProjection.items.length > 0) {
      await tx.insert(simItems).values(
        childProjection.items.map((item) => ({
          branchId: input.childBranchId,
          itemId: item.id,
          name: item.name,
        })),
      );
      await tx.insert(simItemHoldings).values(
        childProjection.items.map((item) => ({
          branchId: input.childBranchId,
          itemId: item.id,
          holdingContainerId: item.holdingContainerId,
          updatedSequence: lastPlacedSequence.get(item.id) ?? 0,
        })),
      );
    }

    // Re-create triggers by replaying their setting events (plan R1). An alarm
    // whose firing is already part of inherited history is recorded completed,
    // never re-armed — replaying is not a reroll.
    const pendingTriggerIds: string[] = [];
    const completedTriggerIds: string[] = [];
    const eventById = new Map<string, SimulationBranchEvent>(
      inherited.map((event) => [event.id, event]),
    );
    for (const entry of replay.triggers) {
      const settingEvent = eventById.get(entry.scheduledByEventId);
      if (!settingEvent || settingEvent.type !== "trigger_scheduled") {
        throw new Error("Replayed trigger ledger references a missing setting event");
      }
      const trigger = await applyTriggerScheduledEvent(tx, settingEvent, {
        branchId: input.childBranchId,
        worldId: parent.worldId,
      });
      if (entry.firedByCommandId) {
        await tx
          .update(simTriggers)
          .set({
            state: "completed",
            resultCommandId: entry.firedByCommandId,
            derivationVersion: schedulerDerivationVersion,
            completedAt: now,
            updatedAt: now,
          })
          .where(eq(simTriggers.id, trigger.id));
        completedTriggerIds.push(trigger.id);
      } else {
        pendingTriggerIds.push(trigger.id);
      }
    }

    // E3.1 space: topology statics copy over; loci and journeys are rebuilt by
    // replaying inherited movement events onto the reverse-derived origin seed
    // — the same R4 rules items follow, so a fork mid-journey keeps the child
    // in transit and its pending arrival trigger re-arms through the trigger
    // ledger above.
    const parentRow = ancestry.rows[0];
    if (!parentRow) throw new Error("Simulation branch not found");
    const parentSpace = spaceProjectionFromRows(
      {
        worldId: parent.worldId,
        branchId: parent.id,
        rulesetVersion: parent.rulesetVersion,
        version: parentRow.version,
        headSequence: parentRow.headSequence,
        storySecond: parentRow.storySecond,
      },
      await loadSpaceRows(tx, parent.id),
    );
    const childSpaceSeed = spaceSeedForReplay({
      branchId: input.childBranchId,
      current: parentSpace,
      events: parentState.events,
      originStorySecond: ancestry.rootOriginStorySecond,
    });
    const childSpace = replaySpaceHistory({
      seed: childSpaceSeed,
      events: inherited,
    });
    const spaceSequenceByActor = new Map<string, number>();
    const spaceSequenceByJourney = new Map<string, number>();
    for (const event of inherited) {
      if (isMovementEvent(event)) {
        for (const eventActorId of event.actorIds) spaceSequenceByActor.set(eventActorId, event.sequence);
        spaceSequenceByJourney.set(event.payload.journeyId, event.sequence);
      } else if (isAccessEvent(event)) {
        for (const eventActorId of event.actorIds) spaceSequenceByActor.set(eventActorId, event.sequence);
      }
    }
    await insertSpaceRows(
      tx,
      spaceRowInsertsForProjection(input.childBranchId, childSpace, spaceSequenceByActor, spaceSequenceByJourney),
    );

    // E3.2 activities: the action catalog copies over as authored statics;
    // activity instances are fully evented and replay from the empty seed. A
    // fork mid-activity keeps the child's claims held with the completion
    // trigger re-armed by the ledger above; a cancelled activity's trigger is
    // recognized retired.
    const parentDefinitionRows = await tx
      .select()
      .from(simActionDefinitions)
      .where(eq(simActionDefinitions.branchId, parent.id));
    if (parentDefinitionRows.length > 0) {
      await tx.insert(simActionDefinitions).values(
        parentDefinitionRows.map((row) => ({
          branchId: input.childBranchId,
          actionDefinitionId: row.actionDefinitionId,
          version: row.version,
          payload: row.payload,
        })),
      );
    }
    const childActivities = replayActivitiesHistory({
      seed: emptyActivitiesSeed(input.childBranchId, ancestry.rootOriginStorySecond),
      events: inherited,
    });
    const activitySequenceById = new Map<string, number>();
    for (const event of inherited) {
      if (isActivityEvent(event)) activitySequenceById.set(event.payload.activityInstanceId, event.sequence);
    }
    if (childActivities.activities.length > 0) {
      await tx.insert(simActivities).values(
        childActivities.activities.map((activity) =>
          activityRowInsert(input.childBranchId, activity, activitySequenceById.get(activity.id) ?? 0),
        ),
      );
    }

    // E3.3 commitments: fully evented like activities — replay from the empty
    // seed; notice/deadline triggers re-arm or complete through the ledger.
    const childCommitments = replayCommitmentsHistory({
      seed: emptyCommitmentsSeed(input.childBranchId, ancestry.rootOriginStorySecond),
      events: inherited,
    });
    const commitmentSequenceById = new Map<string, number>();
    for (const event of inherited) {
      if (isCommitmentEvent(event)) commitmentSequenceById.set(event.payload.commitmentId, event.sequence);
    }
    if (childCommitments.commitments.length > 0) {
      await tx.insert(simCommitments).values(
        childCommitments.commitments.map((commitment) =>
          commitmentRowInsert(input.childBranchId, commitment, commitmentSequenceById.get(commitment.id) ?? 0),
        ),
      );
    }
    if (childCommitments.pressures.length > 0) {
      await tx.insert(simTemporalPressures).values(
        childCommitments.pressures.map((pressure) =>
          pressureRowInsert(
            input.childBranchId,
            pressure,
            commitmentSequenceById.get(pressure.sourceCommitmentId) ?? 0,
          ),
        ),
      );
    }

    // E3.4 engagements: fully evented — replay from the empty seed.
    const childEngagements = replayEngagementsHistory({
      seed: emptyEngagementsSeed(input.childBranchId, ancestry.rootOriginStorySecond),
      events: inherited,
    });
    const engagementSequenceById = new Map<string, number>();
    for (const event of inherited) {
      if (isEngagementEvent(event)) engagementSequenceById.set(event.payload.engagementId, event.sequence);
    }
    if (childEngagements.engagements.length > 0) {
      await tx.insert(simEngagements).values(
        childEngagements.engagements.map((engagement) =>
          engagementRowInsert(input.childBranchId, engagement, engagementSequenceById.get(engagement.id) ?? 0),
        ),
      );
    }

    // E4.1 observations: pure derivations of the inherited stream — replayed
    // onto the same reverse-derived space seed the child's loci used, so the
    // child holds exactly the observation rows its visible history explains.
    const childObservations = replayObservationsHistory({
      spaceSeed: childSpaceSeed,
      events: inherited,
    });
    await insertReplayedObservations(tx, childObservations.observations, input.childBranchId);

    // E4.2 knowledge: fold the inherited disclosures through the pure kernel
    // against the observations just replayed — the child holds exactly the
    // assertion and belief rows its visible history explains.
    const childKnowledge = replayKnowledgeHistory({
      events: inherited,
      observations: childObservations.observations,
    });
    await insertReplayedKnowledge(tx, childKnowledge, input.childBranchId);

    // Inherited delivery obligations were fulfilled on ancestor branches; the
    // child's consumer lane starts after the fork point (plan R4 — reference,
    // not copy, applies to disposable projections too).
    await tx.insert(simConsumerCheckpoints).values({
      consumerKind: itemTransferFeedConsumerKind,
      branchId: input.childBranchId,
      throughSequence: input.atSequence,
      projectionSchemaVersion: itemTransferFeedProjectionSchemaVersion,
    });

    // Snapshot the fork point (plan's default cadence: on fork + on demand) so
    // later replays of this child need not walk to the root.
    const snapshot = simulationSnapshotSchema.parse({
      id: deriveSnapshotId(input.childBranchId, itemTransferSnapshotProjectionKind, input.atSequence),
      worldId: parent.worldId,
      branchId: input.childBranchId,
      projectionKind: itemTransferSnapshotProjectionKind,
      sequence: input.atSequence,
      projectionSchemaVersion: itemTransferSnapshotSchemaVersion,
      rulesetVersion: parent.rulesetVersion,
      checksum: inheritedSnapshotChecksum,
      sourceFirstSequence: 0,
      sourceLastSequence: input.atSequence,
      payload: { projection: childProjection },
    });
    await tx.insert(simSnapshots).values(snapshot);

    return branchForkResultSchema.parse({
      childBranchId: input.childBranchId,
      parentBranchId: parent.id,
      worldId: parent.worldId,
      forkSequence: input.atSequence,
      forkStorySecond,
      version: childProjection.version,
      inheritedEventCount: inherited.length,
      inheritedSnapshotChecksum,
      pendingTriggerIds,
      completedTriggerIds,
      snapshotId: snapshot.id,
    });
  });
}
