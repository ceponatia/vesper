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
import { worldBranchIdSchema } from "@/contracts/simulation/identity";
import { materialsProjectionSchema, type MaterialsProjection } from "@/contracts/simulation/materials";
import {
  itemTransferFeedConsumerKind,
  itemTransferFeedProjectionSchemaVersion,
} from "@/contracts/simulation/outbox";
import { schedulerDerivationVersion } from "@/contracts/simulation/scheduler";
import {
  isAccessEvent,
  isActivityEvent,
  isBodyEvent,
  isCommitmentEvent,
  isEngagementEvent,
  isHouseholdEvent,
  isItemConditionEvent,
  isMovementEvent,
} from "@/contracts/simulation/branching";
import {
  composeAncestryEventBounds,
  deriveMaterialLotRowKey,
  deriveMeansSubjectRowKey,
  emptyActivitiesSeed,
  emptyBodiesSeed,
  emptyCommitmentsSeed,
  emptyEngagementsSeed,
  emptyHouseholdsSeed,
  emptyItemConditionSeed,
  itemHoldingsAtSequence,
  replayActivitiesHistory,
  replayBodiesHistory,
  replayBranchHistory,
  replayCommitmentsHistory,
  replayEngagementsHistory,
  replayHouseholdsHistory,
  replayItemConditionHistory,
  replayKnowledgeHistory,
  replayObservationsHistory,
  replaySocialLedgerHistory,
  replaySoftCanonHistory,
  replaySpaceHistory,
  simulationHash,
  sortMaterialsProjection,
  spaceSeedForReplay,
  type BranchAncestryNode,
  type BranchEventRange,
} from "@/lib/simulation";
import {
  db,
  simActionDefinitions,
  simActivities,
  simBodyConditions,
  simBodyMeters,
  simBodyModifiers,
  simBodyRhythms,
  simBranches,
  simCharacters,
  simCommitments,
  simConsumerCheckpoints,
  simEngagements,
  simTemporalPressures,
  simEvents,
  simHouseholdMembers,
  simHouseholdRestockRoutines,
  simHouseholds,
  simItemConditionMeters,
  simItemConditionModifiers,
  simItemHoldings,
  simItems,
  simMaterialLots,
  simMeansBands,
  simSnapshots,
  simTriggers,
  simWorlds,
  type Db,
} from "@/server/db";
import { activityRowInsert, itemConditionMeterRowInsert, itemConditionModifierRowInsert } from "./activity-store";
import { bodyConditionRowInsert, bodyMeterRowInsert, bodyModifierRowInsert } from "./body-store";
import { commitmentRowInsert, pressureRowInsert } from "./commitment-store";
import { engagementRowInsert } from "./engagement-store";
import {
  householdMemberRowInsert,
  householdRestockRoutineRowInsert,
  householdRowInsert,
  materialLotRowInsert,
  meansBandRowInsert,
} from "./household-store";
import { insertReplayedKnowledge } from "./knowledge-recorder";
import { holdingRowFieldsForLocus, itemLocusFromHoldingRow } from "./material-store";
import { insertReplayedObservations } from "./observation-store";
import { insertReplayedSocialLedger } from "./social-recorder";
import { insertReplayedSoftCanon } from "./soft-canon-recorder";
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
  projection: MaterialsProjection;
  /** The branch's full logical event stream, ancestry-bounded, ordered. */
  events: SimulationBranchEvent[];
  ancestry: BranchAncestry;
}

/** Assemble the live typed projection and event stream inside a caller's transaction. */
export async function assembleBranchState(
  tx: DbExecutor,
  ancestry: BranchAncestry,
): Promise<DurableBranchState> {
  const branch = ancestry.rows[0];
  if (!branch) throw new Error("Simulation branch not found");
  const [worldRows, actorRows, itemRows, events] = await Promise.all([
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
      .select({
        itemId: simItems.itemId,
        name: simItems.name,
        materialKindKey: simItems.materialKindKey,
        ownerActorId: simItems.ownerActorId,
        containerCapacityCount: simItems.containerCapacityCount,
        containerAccess: simItems.containerAccess,
        conditionTracked: simItems.conditionTracked,
        locusKind: simItemHoldings.locusKind,
        locusActorId: simItemHoldings.actorId,
        slotKey: simItemHoldings.slotKey,
        containerItemId: simItemHoldings.containerItemId,
        zoneId: simItemHoldings.zoneId,
        goneBasis: simItemHoldings.goneBasis,
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

  const projection = materialsProjectionSchema.parse({
    worldId: branch.worldId,
    branchId: branch.id,
    rulesetVersion: world.rulesetVersion,
    version: branch.version,
    headSequence: branch.headSequence,
    storySecond: branch.storySecond,
    actors: actorRows.map((row) => ({ id: row.characterId, name: row.name })),
    items: itemRows.map((row) => ({
      id: row.itemId,
      name: row.name,
      ...(row.materialKindKey !== null ? { materialKindKey: row.materialKindKey } : {}),
      ownerActorId: row.ownerActorId,
      ...(row.containerCapacityCount !== null && row.containerAccess !== null
        ? { container: { capacityCount: row.containerCapacityCount, access: row.containerAccess } }
        : {}),
      /** §26.7: whether this item carries item-condition (wear/cleanliness) meters. */
      conditionTracked: row.conditionTracked,
      locus: itemLocusFromHoldingRow({
        locusKind: row.locusKind,
        actorId: row.locusActorId,
        slotKey: row.slotKey,
        containerItemId: row.containerItemId,
        zoneId: row.zoneId,
        goneBasis: row.goneBasis,
      }),
    })),
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
 *
 * E5.4 slice 2: an item created mid-branch by `item_instantiated_from_promotion`
 * did NOT exist at sequence 0 — reverse-deriving it into the origin seed would
 * carry it into every child, including one forked BEFORE the promotion, where
 * `applyMaterialEvent`'s double-instantiation guard would then throw the
 * moment forward replay reached that event. Excluding promoted items from the
 * seed is safe: a fork AT OR AFTER the promotion still gets the item, because
 * its instantiating event is then part of `inherited` and
 * `replayBranchHistory`'s forward fold re-adds it through the same new case.
 */
export function seedProjectionForReplay(input: {
  branchId: string;
  state: DurableBranchState;
}): MaterialsProjection {
  const { projection } = input.state;
  const promotedItemIds = new Set(
    input.state.events
      .filter((event) => event.type === "item_instantiated_from_promotion")
      .map((event) => event.payload.item.id),
  );
  const preExistingItems = projection.items.filter((item) => !promotedItemIds.has(item.id));
  const currentHoldings = new Map(preExistingItems.map((item) => [item.id, item.locus]));
  const seedHoldings = itemHoldingsAtSequence(currentHoldings, input.state.events, 0);
  return sortMaterialsProjection(
    materialsProjectionSchema.parse({
      worldId: projection.worldId,
      branchId: input.branchId,
      rulesetVersion: projection.rulesetVersion,
      version: 0,
      headSequence: 0,
      storySecond: input.state.ancestry.rootOriginStorySecond,
      actors: projection.actors,
      items: preExistingItems.map((item) => ({
        ...item,
        locus: seedHoldings.get(item.id) ?? item.locus,
      })),
    }),
  );
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
    const childProjection = materialsProjectionSchema.parse({
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
    // last-touched sequences come from the replay, not the parent's rows. A
    // touch is any material event naming the item — a placement move
    // (transfer/destroy) or an ownership reassignment — so `updatedSequence`
    // always reflects the most recent thing replay knows about the item.
    const lastPlacedSequence = new Map<string, number>();
    for (const event of inherited) {
      if (
        event.type === "item_transferred" ||
        event.type === "item_destroyed" ||
        event.type === "item_ownership_set"
      ) {
        lastPlacedSequence.set(event.payload.itemId, event.sequence);
      } else if (event.type === "item_instantiated_from_promotion") {
        // A promoted item's FIRST appearance IS its instantiation — without
        // this, its child holdings row would wrongly default to sequence 0.
        lastPlacedSequence.set(event.payload.item.id, event.sequence);
      }
    }
    if (childProjection.actors.length > 0) {
      await tx.insert(simCharacters).values(
        childProjection.actors.map((actor) => ({
          branchId: input.childBranchId,
          characterId: actor.id,
          name: actor.name,
        })),
      );
    }
    if (childProjection.items.length > 0) {
      await tx.insert(simItems).values(
        childProjection.items.map((item) => ({
          branchId: input.childBranchId,
          itemId: item.id,
          name: item.name,
          materialKindKey: item.materialKindKey ?? null,
          ownerActorId: item.ownerActorId,
          containerCapacityCount: item.container?.capacityCount ?? null,
          containerAccess: item.container?.access ?? null,
          conditionTracked: item.conditionTracked,
        })),
      );
      await tx.insert(simItemHoldings).values(
        childProjection.items.map((item) => ({
          branchId: input.childBranchId,
          itemId: item.id,
          ...holdingRowFieldsForLocus(item.locus),
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
    // `pressure_acknowledged` (E5.5 slice 3) carries no `commitmentId` — it is
    // deliberately absent from `commitmentEventTypeList` (its payload shape is
    // structurally incompatible) — so a pressure row's "last touch" can't be
    // read off `commitmentSequenceById` alone: a pressure most recently
    // touched by an acknowledgment would otherwise be under-stamped with its
    // source commitment's older sequence. Track acknowledgments separately,
    // keyed by pressure id (mirrors the engagement-side fix a few lines below
    // — `engagementEventTypeList` gained `pressure_acknowledged` because its
    // payload DOES carry `engagementId`), and take the max of the two when
    // stamping `updatedSequence`.
    const pressureAcknowledgedSequenceById = new Map<string, number>();
    for (const event of inherited) {
      if (isCommitmentEvent(event)) commitmentSequenceById.set(event.payload.commitmentId, event.sequence);
      if (event.type === "pressure_acknowledged") {
        pressureAcknowledgedSequenceById.set(event.payload.pressureId, event.sequence);
      }
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
            Math.max(
              commitmentSequenceById.get(pressure.sourceCommitmentId) ?? 0,
              pressureAcknowledgedSequenceById.get(pressure.id) ?? 0,
            ),
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

    // E5.2 rhythm rows copy over as authored statics, like action
    // definitions — a child lives the same daily life until re-authored.
    const parentRhythmRows = await tx
      .select()
      .from(simBodyRhythms)
      .where(eq(simBodyRhythms.branchId, parent.id));
    if (parentRhythmRows.length > 0) {
      await tx.insert(simBodyRhythms).values(
        parentRhythmRows.map((row) => ({
          branchId: input.childBranchId,
          actorId: row.actorId,
          kind: row.kind,
          startMinuteOfDay: row.startMinuteOfDay,
          endMinuteOfDay: row.endMinuteOfDay,
        })),
      );
    }

    // E5.1 bodies: fully evented — replay from the empty seed. Meter values
    // re-land on their last MATERIAL write; pending threshold and expiry
    // alarms re-arm or complete through the shared trigger ledger above.
    const childBodies = replayBodiesHistory({
      seed: emptyBodiesSeed(input.childBranchId, ancestry.rootOriginStorySecond),
      events: inherited,
    });
    const bodySequenceByActor = new Map<string, number>();
    for (const event of inherited) {
      if (isBodyEvent(event)) bodySequenceByActor.set(event.payload.actorId, event.sequence);
    }
    if (childBodies.meters.length > 0) {
      await tx.insert(simBodyMeters).values(
        childBodies.meters.map((meter) =>
          bodyMeterRowInsert(input.childBranchId, meter, bodySequenceByActor.get(meter.actorId) ?? 0),
        ),
      );
    }
    if (childBodies.conditions.length > 0) {
      await tx.insert(simBodyConditions).values(
        childBodies.conditions.map((condition) =>
          bodyConditionRowInsert(input.childBranchId, condition, bodySequenceByActor.get(condition.actorId) ?? 0),
        ),
      );
    }
    if (childBodies.modifiers.length > 0) {
      await tx.insert(simBodyModifiers).values(
        childBodies.modifiers.map((modifier) =>
          bodyModifierRowInsert(input.childBranchId, modifier, bodySequenceByActor.get(modifier.actorId) ?? 0),
        ),
      );
    }

    // E5.3 slice 3 item condition (§26.7): fully evented, its own projection
    // — replay from the empty seed, exactly like bodies. Meter values re-land
    // on their last MATERIAL write; pending `item_condition_threshold_due`
    // alarms re-arm or complete through the SAME shared trigger ledger above
    // (`replay.triggers`/`applyTriggerScheduledEvent` key off the trigger-kind
    // union generically — nothing here special-cases item-condition triggers,
    // and `lib/simulation/replay.ts` already tracks this kind's retirement
    // alongside body thresholds, so a child's pending alarm re-arms for free).
    const childItemConditions = replayItemConditionHistory({
      seed: emptyItemConditionSeed(input.childBranchId, ancestry.rootOriginStorySecond),
      events: inherited,
    });
    const itemConditionSequenceByItem = new Map<string, number>();
    for (const event of inherited) {
      if (isItemConditionEvent(event)) itemConditionSequenceByItem.set(event.payload.itemId, event.sequence);
    }
    if (childItemConditions.meters.length > 0) {
      await tx.insert(simItemConditionMeters).values(
        childItemConditions.meters.map((meter) =>
          itemConditionMeterRowInsert(
            input.childBranchId,
            meter,
            itemConditionSequenceByItem.get(meter.itemId) ?? 0,
          ),
        ),
      );
    }
    if (childItemConditions.modifiers.length > 0) {
      await tx.insert(simItemConditionModifiers).values(
        childItemConditions.modifiers.map((modifier) =>
          itemConditionModifierRowInsert(
            input.childBranchId,
            modifier,
            itemConditionSequenceByItem.get(modifier.itemId) ?? 0,
          ),
        ),
      );
    }

    // E5.4 households (§26.8–26.11): fully evented, its own projection —
    // replay from the empty seed, exactly like bodies/item condition.
    // Membership/lot/means-band/routine rows land on their last MATERIAL
    // write; a lazily-initialized lot a later command never touched again
    // keeps its own init sequence. `household_restock_due` alarms ride the
    // SAME shared trigger ledger every other domain's alarms use (built once,
    // above) — nothing household-specific happens for them here.
    const childHouseholds = replayHouseholdsHistory({
      seed: emptyHouseholdsSeed(input.childBranchId, ancestry.rootOriginStorySecond),
      events: inherited,
    });
    const membershipSequenceByKey = new Map<string, number>();
    const lotSequenceByKey = new Map<string, number>();
    const meansBandSequenceByKey = new Map<string, number>();
    const restockRoutineSequenceByKey = new Map<string, number>();
    for (const event of inherited) {
      if (!isHouseholdEvent(event)) continue;
      switch (event.type) {
        case "household_created":
          // sim_households carries no updated_sequence column (no branching
          // discriminant to synthesize a per-row key against — see the
          // migration note above simHouseholds) — nothing to record.
          break;
        case "household_membership_set":
          membershipSequenceByKey.set(
            `${event.payload.householdId}:${event.payload.actorId}`,
            event.sequence,
          );
          break;
        case "material_lot_initialized":
        case "material_lot_adjusted":
          lotSequenceByKey.set(
            deriveMaterialLotRowKey(event.payload.locus, event.payload.materialKindKey),
            event.sequence,
          );
          break;
        case "material_lot_transferred":
          lotSequenceByKey.set(
            deriveMaterialLotRowKey(event.payload.fromLocus, event.payload.materialKindKey),
            event.sequence,
          );
          lotSequenceByKey.set(
            deriveMaterialLotRowKey(event.payload.toLocus, event.payload.materialKindKey),
            event.sequence,
          );
          break;
        case "means_band_set":
          meansBandSequenceByKey.set(deriveMeansSubjectRowKey(event.payload.subject), event.sequence);
          break;
        case "household_restock_routine_configured":
          restockRoutineSequenceByKey.set(
            `${event.payload.householdId}:${event.payload.materialKindKey}`,
            event.sequence,
          );
          break;
        case "item_instantiated_from_promotion":
        case "household_restock_fulfilled":
        case "household_restock_deferred":
          // Promotion touches only the materials projection (handled by the
          // item-holdings block above); a restock outcome mutates lots only
          // through its own causally-linked `material_lot_adjusted`
          // companion event, already recorded by that case.
          break;
      }
    }
    if (childHouseholds.households.length > 0) {
      await tx.insert(simHouseholds).values(
        childHouseholds.households.map((household) => householdRowInsert(input.childBranchId, household)),
      );
    }
    if (childHouseholds.memberships.length > 0) {
      await tx.insert(simHouseholdMembers).values(
        childHouseholds.memberships.map((membership) =>
          householdMemberRowInsert(
            input.childBranchId,
            membership,
            membershipSequenceByKey.get(`${membership.householdId}:${membership.actorId}`) ?? 0,
          ),
        ),
      );
    }
    if (childHouseholds.lots.length > 0) {
      await tx.insert(simMaterialLots).values(
        childHouseholds.lots.map((lot) =>
          materialLotRowInsert(
            input.childBranchId,
            lot,
            lotSequenceByKey.get(deriveMaterialLotRowKey(lot.locus, lot.materialKindKey)) ?? 0,
          ),
        ),
      );
    }
    if (childHouseholds.meansBands.length > 0) {
      await tx.insert(simMeansBands).values(
        childHouseholds.meansBands.map((band) =>
          meansBandRowInsert(
            input.childBranchId,
            band,
            meansBandSequenceByKey.get(deriveMeansSubjectRowKey(band.subject)) ?? 0,
          ),
        ),
      );
    }
    if (childHouseholds.restockRoutines.length > 0) {
      await tx.insert(simHouseholdRestockRoutines).values(
        childHouseholds.restockRoutines.map((routine) =>
          householdRestockRoutineRowInsert(
            input.childBranchId,
            routine,
            restockRoutineSequenceByKey.get(`${routine.householdId}:${routine.materialKindKey}`) ?? 0,
          ),
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

    // E5.5 relationship ledger: a derived-and-persisted projection with no
    // incremental state machine (§6) — a full rebuild re-derives from the
    // inherited stream alone, the SAME fold the incremental recorder calls.
    // `commitmentById` resolves from `childCommitments`, the commitments
    // projection already rebuilt earlier in this fork (line ~618) — a pure
    // in-memory lookup, no extra query.
    const childCommitmentById = new Map<string, { kind: string; promisedToActorId?: string }>(
      childCommitments.commitments.map((commitment) => [
        commitment.id,
        { kind: commitment.kind, ...(commitment.promisedToActorId === undefined ? {} : { promisedToActorId: commitment.promisedToActorId }) },
      ]),
    );
    const childSocialLedger = replaySocialLedgerHistory({
      events: inherited,
      commitmentById: (commitmentId) => childCommitmentById.get(commitmentId),
    });
    await insertReplayedSocialLedger(tx, childSocialLedger, input.childBranchId);

    // E4.3 soft canon: every event carries its post-fold snapshot (§6.4), so
    // the child's bounded store rebuilds from the inherited stream alone.
    // Persisted cuts are NOT copied — they are presentation artifacts; a
    // retaken scene re-prepares and mints its own.
    const childSoftCanon = replaySoftCanonHistory(inherited);
    await insertReplayedSoftCanon(tx, childSoftCanon, input.childBranchId);

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
