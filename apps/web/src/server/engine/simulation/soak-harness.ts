import { performance } from "node:perf_hooks";
import { and, count, eq, gt, inArray, isNull, max } from "drizzle-orm";
import type { SimulationBranchEvent } from "@/contracts/simulation/branching";
import {
  itemLocusSchema,
  transferItemCommandSchema,
  type ItemLocus,
  type TransferItemCommand,
  type TransferItemCommandResult,
} from "@/contracts/simulation/materials";
import {
  deriveTriggerCommandId,
  deriveTriggerId,
  deterministicDrawUnit,
} from "@/contracts/simulation/scheduler";
import { itemTransferFeedConsumerKind } from "@/contracts/simulation/outbox";
import { simulationHash } from "@/lib/simulation/hash";
import { newId } from "@/lib/ids";
import {
  db,
  simBranches,
  simCommands,
  simEvents,
  simItemHoldings,
  simItemTransferFeed,
  simOutbox,
  simTriggers,
  type Db,
} from "@/server/db";
import { explainItemPlacement } from "./audit-store";
import { forkBranch, readDurableBranchState } from "./branch-store";
import {
  InjectedSimulationCrash,
  seedDurableMaterialBranch,
  submitDurableTransferItem,
  type DurableMaterialCrashPoint,
} from "./material-store";
import { consumeNextItemTransferOutbox, rebuildItemTransferFeed } from "./outbox-store";
import { advanceBranchStoryTime, scheduleDurableTrigger } from "./scheduler-store";
import { captureBranchSnapshot, rebuildDurableBranchProjection } from "./snapshot-store";
import { seedDurableSpaceTopology } from "./space-store";

/**
 * E2.6 — the Gate 2 soak. Drives a deterministic synthetic month of commands
 * and triggers through the durable kernel (E2.1–E2.5), then checks the
 * engine.plan.md §"Required proofs" list against what the database actually
 * recorded. docs/developer-notes/engine-gate2-soak.plan.md holds the proof
 * matrix this implements.
 *
 * E5.3 rework: the item lane now runs over §26's honest material model — a
 * real zone topology, containers that are themselves items, and locus-typed
 * transfers — rather than Gate 1's pseudo-container rows. "Place" indices
 * unify the fixture's transfer destinations: place 0 is the shared zone
 * (unbounded, no container config); places 1..CONTAINER_ITEM_COUNT are
 * container items held by actor 0, the last deliberately tiny. Items seed
 * inside containers (no seed-time zone locus — the branch does not exist yet
 * when the seed call starts, so nothing can reference `sim_zones` before it)
 * and the chaos run's own transfers exercise the zone locus live.
 */
export interface Gate2SoakProfile {
  /** Seeds every named draw stream; same profile ⇒ same workload structure. */
  worldSeed: string;
  monthStorySeconds: number;
  partitionTriggerCount: number;
  chaosTriggerCount: number;
  chaosDirectCommandCount: number;
  /** Partition count for fork child B, and the chaos month's round count. */
  partitionCount: number;
  /** One in N direct submissions runs against an injected transaction crash. */
  commandCrashDenominator: number;
  /** One in N outbox consumptions crashes after its projection write. */
  outboxCrashDenominator: number;
  /** One in N direct submissions goes out with a deliberately stale version. */
  staleDenominator: number;
  /** One in N direct submissions replays an earlier accepted envelope. */
  duplicateDenominator: number;
  /** Declared ceiling for sampled open outbox depth on the chaos branch. */
  queueDepthCap: number;
}

export const gate2SoakCiProfile: Gate2SoakProfile = {
  worldSeed: "gate2-soak-seed-01",
  monthStorySeconds: 2_592_000,
  partitionTriggerCount: 60,
  chaosTriggerCount: 60,
  chaosDirectCommandCount: 60,
  partitionCount: 10,
  commandCrashDenominator: 6,
  outboxCrashDenominator: 6,
  staleDenominator: 8,
  duplicateDenominator: 8,
  queueDepthCap: 130,
};

export const gate2SoakFullProfile: Gate2SoakProfile = {
  ...gate2SoakCiProfile,
  partitionTriggerCount: 600,
  chaosTriggerCount: 600,
  chaosDirectCommandCount: 600,
  partitionCount: 30,
  queueDepthCap: 700,
};

export interface Gate2SoakProofResult {
  name: string;
  pass: boolean;
  detail: string;
}

interface LatencySummary {
  samples: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
}

export interface Gate2SoakReport {
  profile: Gate2SoakProfile;
  /** Both synthetic worlds, for caller cleanup (cascade delete). */
  worldIds: string[];
  materialHash: { singleSkip: string; partitioned: string };
  metrics: {
    partition: {
      scheduled: number;
      forkPendingA: number;
      forkPendingB: number;
      drainedA: number;
      drainedB: number;
      outboxDelivered: number;
      feedRowsA: number;
      feedRowsB: number;
    };
    chaos: {
      triggersScheduled: number;
      triggersCompleted: number;
      triggersRejected: number;
      directAccepted: number;
      directRejected: number;
      staleConflicts: number;
      duplicateReplays: number;
      injectedCommandCrashes: number;
      injectedOutboxCrashes: number;
      outboxDelivered: number;
      maxOutboxDepth: number;
      maxTriggerDepth: number;
      rejectionCodes: Record<string, number>;
    };
    latency: { directSubmit: LatencySummary; triggerResolveAvgMs: number };
  };
  proofs: Gate2SoakProofResult[];
}

interface SoakCast {
  worldId: string;
  branchId: string;
  locationId: string;
  zoneId: string;
  actorIds: string[];
  /** Container ITEMS (place indices 1..N); place 0 is the shared zone. */
  containerIds: string[];
  itemIds: string[];
  /** Capacity by container index; the last container is deliberately tiny. */
  capacities: number[];
  /** Item index -> seed PLACE index (never 0 — zone-resting starts live). */
  seedHolding: number[];
}

interface PlannedTrigger {
  index: number;
  dueStorySecond: number;
  actorIndex: number;
  itemIndex: number;
  fromIndex: number;
  toIndex: number;
  uniquenessKey: string;
}

interface MaterialOutcome {
  storySecond: number;
  version: number;
  headSequence: number;
  events: Array<Record<string, unknown>>;
  holdings: Array<{ item: number; place: number }>;
}

const ACTOR_COUNT = 4;
/** Place 0 is the zone; places 1..(PLACE_COUNT-1) are container items. */
const PLACE_COUNT = 6;
const CONTAINER_ITEM_COUNT = PLACE_COUNT - 1;
const ITEM_COUNT = 8;
const SOAK_RULESET = "e2-6-soak-v1";
const SOAK_WORLD_TYPE = "e2-6-soak-world";
const WALL_CLOCK = "2026-07-17T00:00:00.000Z";
const CRASH_POINTS: readonly DurableMaterialCrashPoint[] = [
  "after_event_append",
  "after_projection_update",
  "after_outbox_insert",
  "after_branch_advance",
  "after_commit",
];
/**
 * Failpoints that fire even when the command resolves to a rejection.
 * `after_commit` is checked by the store's caller-facing wrapper after
 * `runSimulationCommand` returns, so it fires regardless of outcome; every
 * other point sits inside the shared shell's accepted-path `execute` branch
 * and is simply never reached when the command rejects first.
 */
const UNCONDITIONAL_CRASH_POINTS: readonly DurableMaterialCrashPoint[] = ["after_commit"];
/** Zero-progress catch_up_required loops tolerated before declaring a stall. */
const MAX_STALLED_ADVANCES = 100;

function at<T>(values: readonly T[], index: number, label: string): T {
  const value = values[index];
  if (value === undefined) throw new Error(`Soak ${label} index ${index} is out of range`);
  return value;
}

function percentile(sorted: readonly number[], ratio: number): number {
  if (sorted.length === 0) return 0;
  return at(sorted, Math.max(0, Math.ceil(sorted.length * ratio) - 1), "latency sample");
}

function summarizeLatency(samples: readonly number[]): LatencySummary {
  const sorted = [...samples].sort((left, right) => left - right);
  return {
    samples: sorted.length,
    p50Ms: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    maxMs: sorted.at(-1) ?? 0,
  };
}

/** Place index -> the locus it names (0 is the shared zone). */
function placeLocus(cast: SoakCast, placeIndex: number): ItemLocus {
  if (placeIndex === 0) return itemLocusSchema.parse({ kind: "zone", zoneId: cast.zoneId });
  return itemLocusSchema.parse({
    kind: "container",
    containerItemId: at(cast.containerIds, placeIndex - 1, "container place"),
  });
}

/** Place index -> its capacity; the zone (place 0) has none. */
function placeCapacity(cast: SoakCast, placeIndex: number): number {
  if (placeIndex === 0) return Number.MAX_SAFE_INTEGER;
  return at(cast.capacities, placeIndex - 1, "capacity");
}

class SoakRun {
  private readonly proofs: Gate2SoakProofResult[] = [];
  readonly runId = newId();

  constructor(
    private readonly profile: Gate2SoakProfile,
    private readonly database: Db,
  ) {}

  results(): Gate2SoakProofResult[] {
    return [...this.proofs];
  }

  record(name: string, pass: boolean, detail: string): void {
    this.proofs.push({ name, pass, detail });
  }

  /**
   * Draws key off the profile's seed and a constant scope — never a per-run
   * id — so the same profile reproduces the same workload structure (and the
   * same normalized material hash) across independent runs.
   */
  draw(stream: string, drawIndex: number): number {
    return deterministicDrawUnit({
      worldSeed: this.profile.worldSeed,
      branchId: "gate2-soak",
      stream,
      drawIndex,
    });
  }

  drawInt(stream: string, drawIndex: number, bound: number): number {
    return Math.min(bound - 1, Math.floor(this.draw(stream, drawIndex) * bound));
  }

  drawHit(stream: string, drawIndex: number, denominator: number): boolean {
    return this.drawInt(stream, drawIndex, denominator) === 0;
  }

  buildCast(label: string): SoakCast {
    const prefix = `${this.runId}-${label}`;
    return {
      worldId: `${prefix}-world`,
      branchId: `${prefix}-branch`,
      locationId: `${prefix}-loc`,
      zoneId: `${prefix}-zone`,
      actorIds: Array.from({ length: ACTOR_COUNT }, (_, index) => `${prefix}-actor-${index}`),
      containerIds: Array.from({ length: CONTAINER_ITEM_COUNT }, (_, index) => `${prefix}-cont-${index}`),
      itemIds: Array.from({ length: ITEM_COUNT }, (_, index) => `${prefix}-item-${index}`),
      capacities: Array.from({ length: CONTAINER_ITEM_COUNT }, (_, index) =>
        index === CONTAINER_ITEM_COUNT - 1 ? 1 : ITEM_COUNT,
      ),
      // Place indices 1..(CONTAINER_ITEM_COUNT-1): never the tiny last
      // container, never the zone (place 0) — zone-resting starts live.
      seedHolding: Array.from({ length: ITEM_COUNT }, (_, index) => 1 + (index % (CONTAINER_ITEM_COUNT - 1))),
    };
  }

  async seedCast(cast: SoakCast): Promise<void> {
    await seedDurableMaterialBranch(
      {
        worldId: cast.worldId,
        worldTypeId: SOAK_WORLD_TYPE,
        worldSeed: this.profile.worldSeed,
        branchId: cast.branchId,
        rulesetVersion: SOAK_RULESET,
        originStorySecond: 0,
        actors: cast.actorIds.map((id, index) => ({ id, name: `Soak actor ${index}` })),
        items: [
          // Containers are items too (§26.2): each held by its own actor
          // (round-robin), `open` so any co-located actor may still GIVE into
          // one — §26.4 person-sovereignty means only the holder may DRAW
          // from their own bag, deliberately exercising `held_by_other`
          // alongside the zone (place 0), which no actor owns.
          ...cast.containerIds.map((id, index) => ({
            id,
            name: `Soak container ${index}`,
            container: { capacityCount: at(cast.capacities, index, "capacity"), access: { kind: "open" as const } },
            locus: { kind: "held" as const, actorId: at(cast.actorIds, index % ACTOR_COUNT, "container holder") },
          })),
          ...cast.itemIds.map((id, index) => ({
            id,
            name: `Soak item ${index}`,
            locus: placeLocus(cast, at(cast.seedHolding, index, "seed holding")),
          })),
        ],
      },
      { database: this.database },
    );
    await seedDurableSpaceTopology(
      {
        branchId: cast.branchId,
        locations: [{ id: cast.locationId, worldId: cast.worldId, kind: "soak", defaultAccessPolicy: "public" }],
        zones: [{ id: cast.zoneId, locationId: cast.locationId, kind: "hall", privacyPolicy: "public" }],
        links: [],
        loci: cast.actorIds.map((actorId) => ({
          kind: "at" as const,
          actorId,
          locationId: cast.locationId,
          zoneId: cast.zoneId,
          since: 0,
        })),
      },
      { database: this.database },
    );
  }

  buildTransferCommand(input: {
    cast: SoakCast;
    expectedVersion: number;
    actorIndex: number;
    itemIndex: number;
    fromIndex: number;
    toIndex: number;
    commandId: string;
    idempotencyKey: string;
  }): TransferItemCommand {
    const actorId = at(input.cast.actorIds, input.actorIndex, "actor");
    return transferItemCommandSchema.parse({
      id: input.commandId,
      branchId: input.cast.branchId,
      expectedVersion: input.expectedVersion,
      idempotencyKey: input.idempotencyKey,
      principal: {
        kind: "system",
        principalId: `${this.runId}-scheduler`,
        controlledActorIds: [actorId],
      },
      submittedAtWallClock: WALL_CLOCK,
      type: "transfer_item",
      schemaVersion: 2,
      correlationId: input.commandId,
      payload: {
        actorId,
        itemId: at(input.cast.itemIds, input.itemIndex, "item"),
        fromLocus: placeLocus(input.cast, input.fromIndex),
        toLocus: placeLocus(input.cast, input.toIndex),
      },
    });
  }

  /**
   * Generate a trigger workload whose from-places come from walking a mirror
   * of the holdings in firing order (due second, then creation order — the
   * claim ordering with equal priorities), so most transfers stay legal at
   * fire time. Deterministic rejections (same-place draws, tiny-container
   * overflow) are left in deliberately. The zone (place 0) never overflows.
   */
  planTriggers(cast: SoakCast, streamPrefix: string, triggerCount: number): PlannedTrigger[] {
    const planned = Array.from({ length: triggerCount }, (_, index) => ({
      index,
      dueStorySecond: 1 + this.drawInt(`${streamPrefix}-due`, index, this.profile.monthStorySeconds),
      actorIndex: this.drawInt(`${streamPrefix}-actor`, index, ACTOR_COUNT),
      itemIndex: this.drawInt(`${streamPrefix}-item`, index, ITEM_COUNT),
      toIndex: this.drawInt(`${streamPrefix}-dest`, index, PLACE_COUNT),
      fromIndex: 0,
      uniquenessKey: `soak-${streamPrefix}-${index}`,
    }));
    const firingOrder = [...planned].sort(
      (left, right) => left.dueStorySecond - right.dueStorySecond || left.index - right.index,
    );
    const holding = [...cast.seedHolding];
    const load = Array.from(
      { length: PLACE_COUNT },
      (_, placeIndex) => holding.filter((value) => value === placeIndex).length,
    );
    for (const trigger of firingOrder) {
      trigger.fromIndex = at(holding, trigger.itemIndex, "mirror holding");
      const capacity = placeCapacity(cast, trigger.toIndex);
      const accepted =
        trigger.fromIndex !== trigger.toIndex && at(load, trigger.toIndex, "load") < capacity;
      if (accepted) {
        load[trigger.fromIndex] = at(load, trigger.fromIndex, "load") - 1;
        load[trigger.toIndex] = at(load, trigger.toIndex, "load") + 1;
        holding[trigger.itemIndex] = trigger.toIndex;
      }
    }
    return planned;
  }

  async scheduleTrigger(cast: SoakCast, trigger: PlannedTrigger, templateTag: string): Promise<string> {
    const scheduled = await scheduleDurableTrigger(
      {
        worldId: cast.worldId,
        branchId: cast.branchId,
        kind: "scheduled_transfer_item",
        schemaVersion: 1,
        dueStorySecond: trigger.dueStorySecond,
        uniquenessKey: trigger.uniquenessKey,
        payload: {
          command: this.buildTransferCommand({
            cast,
            expectedVersion: 0,
            actorIndex: trigger.actorIndex,
            itemIndex: trigger.itemIndex,
            fromIndex: trigger.fromIndex,
            toIndex: trigger.toIndex,
            commandId: `${this.runId}-${templateTag}-${trigger.uniquenessKey}`,
            idempotencyKey: `${this.runId}-${templateTag}-${trigger.uniquenessKey}`,
          }),
        },
      },
      { database: this.database },
    );
    return scheduled.id;
  }

  async advanceFully(
    branchId: string,
    target: number,
    workerId: string,
    now: Date,
  ): Promise<{ drained: number; elapsedMs: number }> {
    let drained = 0;
    let stalls = 0;
    const startedAt = performance.now();
    for (;;) {
      const outcome = await advanceBranchStoryTime(branchId, target, {
        workerId,
        now,
        database: this.database,
      });
      drained += outcome.drained;
      if (outcome.status === "advanced") {
        return { drained, elapsedMs: performance.now() - startedAt };
      }
      stalls = outcome.drained === 0 ? stalls + 1 : 0;
      if (stalls > MAX_STALLED_ADVANCES) {
        throw new Error(
          `Soak advance stalled on branch ${branchId} at ${outcome.storySecond} (${outcome.reason})`,
        );
      }
    }
  }

  /**
   * Drain the outbox lane. Counts and diagnostics assertions apply only to
   * this run's branches: a shared dev database may hold unrelated rows, and
   * the soak must neither claim their outcomes as its own nor fail on them.
   */
  async pumpOutbox(
    now: Date,
    ourBranchIds: readonly string[],
    injectCrash: () => boolean,
  ): Promise<{ delivered: number; crashed: number; crashDiagnosticsOk: boolean }> {
    let delivered = 0;
    let crashed = 0;
    let crashDiagnosticsOk = true;
    for (;;) {
      const wantCrash = injectCrash();
      const result = await consumeNextItemTransferOutbox({
        workerId: `${this.runId}-consumer`,
        now,
        database: this.database,
        ...(wantCrash ? { crashAt: "after_projection_write" as const } : {}),
      });
      if (result.status === "idle") return { delivered, crashed, crashDiagnosticsOk };
      if (result.status === "completed") {
        if (ourBranchIds.includes(result.branchId)) delivered += 1;
        continue;
      }
      if (result.status === "failed") {
        const [row] = await this.database
          .select({ branchId: simOutbox.branchId, state: simOutbox.state, lastError: simOutbox.lastError })
          .from(simOutbox)
          .where(eq(simOutbox.id, result.outboxId))
          .limit(1);
        if (row && ourBranchIds.includes(row.branchId)) {
          if (!wantCrash || result.terminal) {
            throw new Error(`Soak outbox obligation failed unexpectedly: ${row.lastError ?? "?"}`);
          }
          crashed += 1;
          if (row.state !== "pending" || !row.lastError?.includes("outbox=")) {
            crashDiagnosticsOk = false;
          }
        }
        continue;
      }
      // lease_lost with a single worker means a foreign process interfered;
      // treat as a skip rather than an outcome.
    }
  }

  async openQueueDepths(branchIds: readonly string[]): Promise<{ outbox: number; triggers: number }> {
    // Depth is measured on the lane this soak pumps. The E4.4 memory-index
    // lane shares the table but has its own consumer and its own lag
    // diagnostics (§24.3) — unpumped here, it would read as false growth.
    const [outboxRow] = await this.database
      .select({ value: count() })
      .from(simOutbox)
      .where(
        and(
          eq(simOutbox.consumerKind, itemTransferFeedConsumerKind),
          inArray(simOutbox.branchId, [...branchIds]),
          inArray(simOutbox.state, ["pending", "processing"]),
        ),
      );
    const [triggerRow] = await this.database
      .select({ value: count() })
      .from(simTriggers)
      .where(
        and(
          inArray(simTriggers.branchId, [...branchIds]),
          inArray(simTriggers.state, ["pending", "processing"]),
        ),
      );
    return { outbox: outboxRow?.value ?? 0, triggers: triggerRow?.value ?? 0 };
  }

  async branchHead(branchId: string): Promise<{ headSequence: number; version: number; storySecond: number }> {
    const [row] = await this.database
      .select({
        headSequence: simBranches.headSequence,
        version: simBranches.version,
        storySecond: simBranches.storySecond,
      })
      .from(simBranches)
      .where(eq(simBranches.id, branchId))
      .limit(1);
    if (!row) throw new Error(`Soak branch ${branchId} is missing`);
    return row;
  }

  /**
   * The branch-identity-free view of a timeline: entity IDs map to seed
   * indices, so equal partitionings — and equal profiles across separate
   * runs — hash identically. Only genuine items (never the container items
   * themselves) enter the holdings hash, matching the Gate 1 fixture's shape.
   */
  async materialOutcome(cast: SoakCast, branchId: string): Promise<MaterialOutcome> {
    const actorIndex = new Map(cast.actorIds.map((id, index) => [id, index]));
    const itemIndex = new Map(cast.itemIds.map((id, index) => [id, index]));
    const placeIndex = new Map<string, number>([
      [cast.zoneId, 0],
      ...cast.containerIds.map((id, index): [string, number] => [id, index + 1]),
    ]);
    const localeIndex = (locus: ItemLocus): number => {
      if (locus.kind === "zone") return placeIndex.get(locus.zoneId) ?? -1;
      if (locus.kind === "container") return placeIndex.get(locus.containerItemId) ?? -1;
      return -1;
    };
    const state = await readDurableBranchState(branchId, this.database);
    const transfers = state.events.filter(
      (event): event is Extract<SimulationBranchEvent, { type: "item_transferred" }> =>
        event.type === "item_transferred",
    );
    return {
      storySecond: state.projection.storySecond,
      version: state.projection.version,
      headSequence: state.projection.headSequence,
      events: transfers.map((event) => ({
        sequence: event.sequence,
        storySecond: event.storySecond,
        actor: actorIndex.get(event.payload.actorId),
        item: itemIndex.get(event.payload.itemId),
        from: localeIndex(event.payload.fromLocus),
        to: localeIndex(event.payload.toLocus),
      })),
      holdings: state.projection.items
        .filter((item) => itemIndex.has(item.id))
        .map((item) => ({ item: itemIndex.get(item.id) ?? -1, place: localeIndex(item.locus) }))
        .sort((left, right) => left.item - right.item),
    };
  }

  async feedRows(branchId: string): Promise<Array<Record<string, unknown>>> {
    return this.database
      .select({
        sourceSequence: simItemTransferFeed.sourceSequence,
        sourceEventId: simItemTransferFeed.sourceEventId,
        storySecond: simItemTransferFeed.storySecond,
        actorId: simItemTransferFeed.actorId,
        itemId: simItemTransferFeed.itemId,
        eventKind: simItemTransferFeed.eventKind,
        fromLocus: simItemTransferFeed.fromLocus,
        toLocus: simItemTransferFeed.toLocus,
      })
      .from(simItemTransferFeed)
      .where(eq(simItemTransferFeed.branchId, branchId))
      .orderBy(simItemTransferFeed.sourceSequence);
  }

  /** Incremental consumption must equal a from-zero rebuild, row for row. */
  async checkFeedRebuild(branchId: string, proofName: string, label: string): Promise<number> {
    const before = await this.feedRows(branchId);
    const rebuilt = await rebuildItemTransferFeed(branchId, this.database);
    const after = await this.feedRows(branchId);
    const matches =
      simulationHash(before) === simulationHash(after) && rebuilt.rowCount === before.length;
    this.record(
      proofName,
      matches,
      `${label}: ${before.length} incrementally consumed feed rows ${matches ? "equal" : "DIFFER FROM"} the from-zero rebuild (${rebuilt.rowCount} rows)`,
    );
    return before.length;
  }

  async checkProjectionRebuilds(branchId: string, label: string, expectSnapshot: boolean): Promise<void> {
    const fromZero = await rebuildDurableBranchProjection(branchId, { database: this.database });
    let snapshotDetail = "snapshot source not exercised";
    let snapshotOk = true;
    if (expectSnapshot) {
      const fromSnapshot = await rebuildDurableBranchProjection(branchId, {
        source: "snapshot",
        database: this.database,
      });
      snapshotOk = fromSnapshot.matches && fromSnapshot.rebuiltHash === fromZero.rebuiltHash;
      snapshotDetail = `snapshot rebuild ${snapshotOk ? "matches" : "DIVERGES"} (replayed ${fromSnapshot.replayedEventCount} vs ${fromZero.replayedEventCount} from zero)`;
    }
    this.record(
      "P6-rebuild-matches",
      fromZero.matches && snapshotOk,
      `${label}: from-zero rebuild ${fromZero.matches ? "matches live" : "DIVERGES"} (hash ${fromZero.rebuiltHash}); ${snapshotDetail}`,
    );
  }

  /** Contiguity + one-event-per-accepted-command + per-trigger multiplicity. */
  async checkNoDuplicateOutcomes(
    branchId: string,
    forkSequence: number | null,
    label: string,
  ): Promise<void> {
    const baseSequence = forkSequence ?? 0;
    const ownEvents = and(eq(simEvents.branchId, branchId), gt(simEvents.sequence, baseSequence));
    const [eventStats] = await this.database
      .select({ total: count(), maxSequence: max(simEvents.sequence) })
      .from(simEvents)
      .where(ownEvents);
    const [orphanRow] = await this.database
      .select({ value: count() })
      .from(simEvents)
      .where(and(ownEvents, isNull(simEvents.commandId)));
    const [acceptedRow] = await this.database
      .select({ value: count() })
      .from(simCommands)
      .where(and(eq(simCommands.branchId, branchId), eq(simCommands.status, "accepted")));
    const { headSequence } = await this.branchHead(branchId);

    const total = eventStats?.total ?? 0;
    const maxSequence = eventStats?.maxSequence ?? baseSequence;
    const contiguous = maxSequence === (total === 0 ? baseSequence : headSequence) && total === headSequence - baseSequence;
    const accepted = acceptedRow?.value ?? -1;
    const oneEventPerCommand = total === accepted;
    const noOrphans = (orphanRow?.value ?? 1) === 0;

    const triggers = await this.database
      .select({ id: simTriggers.id, state: simTriggers.state })
      .from(simTriggers)
      .where(eq(simTriggers.branchId, branchId));
    const dispatchCommandIds = triggers.map((trigger) => deriveTriggerCommandId(trigger.id));
    const dispatchEvents =
      dispatchCommandIds.length > 0
        ? await this.database
            .select({ commandId: simEvents.commandId, total: count() })
            .from(simEvents)
            .where(and(eq(simEvents.branchId, branchId), inArray(simEvents.commandId, dispatchCommandIds)))
            .groupBy(simEvents.commandId)
        : [];
    const dispatchCounts = new Map(dispatchEvents.map((row) => [row.commandId, row.total]));
    const triggerMultiplicityOk = triggers.every((trigger) => {
      const events = dispatchCounts.get(deriveTriggerCommandId(trigger.id)) ?? 0;
      return trigger.state === "completed" ? events === 1 : events === 0;
    });

    this.record(
      "G-no-duplicate-outcomes",
      contiguous && oneEventPerCommand && noOrphans && triggerMultiplicityOk,
      `${label}: ${total} own events, contiguous=${String(contiguous)} (head ${headSequence}), one event per accepted command=${String(oneEventPerCommand)} (${accepted} accepted), all command-caused=${String(noOrphans)}, per-trigger multiplicity=${String(triggerMultiplicityOk)} over ${triggers.length} triggers`,
    );
  }

  async checkDerivationsRecorded(branchIds: readonly string[]): Promise<void> {
    const [eventGap] = await this.database
      .select({ value: count() })
      .from(simEvents)
      .where(and(inArray(simEvents.branchId, [...branchIds]), isNull(simEvents.derivationVersion)));
    const [triggerGap] = await this.database
      .select({ value: count() })
      .from(simTriggers)
      .where(
        and(
          inArray(simTriggers.branchId, [...branchIds]),
          inArray(simTriggers.state, ["completed", "failed"]),
          isNull(simTriggers.derivationVersion),
        ),
      );
    const pass = (eventGap?.value ?? 1) === 0 && (triggerGap?.value ?? 1) === 0;
    this.record(
      "P5-derivation-recorded",
      pass,
      `events missing derivationVersion: ${eventGap?.value ?? "?"}; terminal triggers missing it: ${triggerGap?.value ?? "?"}`,
    );
  }

  async checkAudit(cast: SoakCast): Promise<void> {
    let seeds = 0;
    let eventChains = 0;
    let triggerChains = 0;
    let coherent = true;
    for (const itemId of cast.itemIds) {
      const explanation = await explainItemPlacement(cast.branchId, itemId, {
        database: this.database,
      });
      if (explanation.origin === "seed") {
        seeds += 1;
        continue;
      }
      eventChains += 1;
      if (!explanation.event || !explanation.command) coherent = false;
      if (explanation.trigger) {
        triggerChains += 1;
        if (!explanation.schedulingEvent || !explanation.schedulingCommand) coherent = false;
      }
    }
    this.record(
      "G-audit-explains",
      coherent,
      `causal explanations over ${cast.itemIds.length} items: ${seeds} seed-origin, ${eventChains} event chains (${triggerChains} through a trigger and its scheduling command), coherent=${String(coherent)}`,
    );
  }
}

interface ChaosCounters {
  directAccepted: number;
  directRejected: number;
  staleConflicts: number;
  duplicateReplays: number;
  injectedCommandCrashes: number;
  rejectionCodes: Record<string, number>;
  conflictsWellFormed: boolean;
  rejectionsCarryReason: boolean;
  duplicatesMatchCached: boolean;
  crashReplaysExactlyOnce: boolean;
}

function tallyRejection(counters: ChaosCounters, result: TransferItemCommandResult): void {
  if (result.status !== "rejected") return;
  counters.directRejected += 1;
  counters.rejectionCodes[result.code] = (counters.rejectionCodes[result.code] ?? 0) + 1;
  if (result.publicReason.length === 0) counters.rejectionsCarryReason = false;
}

/**
 * Run the full Gate 2 soak. Throws only on harness-level contradictions —
 * proof failures are recorded in the returned report, one entry per check.
 */
export async function runGate2Soak(
  profile: Gate2SoakProfile,
  options: { database?: Db } = {},
): Promise<Gate2SoakReport> {
  const database = options.database ?? db();
  const run = new SoakRun(profile, database);
  const farFuture = new Date(Date.now() + 365 * 24 * 3600 * 1000);

  // ------------------------------------------------------ partition world (P1)
  const partitionCast = run.buildCast("part");
  await run.seedCast(partitionCast);
  const partitionPlan = run.planTriggers(partitionCast, "part", profile.partitionTriggerCount);
  for (const trigger of partitionPlan) {
    await run.scheduleTrigger(partitionCast, trigger, "tmpl");
  }

  // Idempotent rescheduling: repeating a drawn subset must return the same
  // trigger rows without advancing the branch.
  const rescheduleCount = Math.max(1, Math.floor(profile.partitionTriggerCount / 10));
  let rescheduleStable = true;
  for (let index = 0; index < rescheduleCount; index += 1) {
    const target = at(
      partitionPlan,
      run.drawInt("part-reschedule", index, partitionPlan.length),
      "planned trigger",
    );
    const repeatId = await run.scheduleTrigger(partitionCast, target, `resched-${index}`);
    if (repeatId !== deriveTriggerId(partitionCast.branchId, target.uniquenessKey)) {
      rescheduleStable = false;
    }
  }
  const partitionRootHead = await run.branchHead(partitionCast.branchId);
  run.record(
    "G-schedule-idempotent",
    rescheduleStable &&
      partitionRootHead.headSequence === profile.partitionTriggerCount &&
      partitionRootHead.version === profile.partitionTriggerCount,
    `${rescheduleCount} repeated schedules returned existing triggers=${String(rescheduleStable)}; branch stayed at head/version ${partitionRootHead.headSequence}/${partitionRootHead.version} for ${profile.partitionTriggerCount} schedules`,
  );

  const childA = `${partitionCast.branchId}-single`;
  const childB = `${partitionCast.branchId}-partitioned`;
  const forkPrincipal = { kind: "system" as const, principalId: "gate2-soak" };
  const forkA = await forkBranch(
    {
      parentBranchId: partitionCast.branchId,
      childBranchId: childA,
      atSequence: profile.partitionTriggerCount,
      principal: forkPrincipal,
      reason: "gate2-soak-single-skip",
    },
    { database },
  );
  const forkB = await forkBranch(
    {
      parentBranchId: partitionCast.branchId,
      childBranchId: childB,
      atSequence: profile.partitionTriggerCount,
      principal: forkPrincipal,
      reason: "gate2-soak-partitioned",
    },
    { database },
  );
  run.record(
    "G-fork-inherits-alarms",
    forkA.pendingTriggerIds.length === profile.partitionTriggerCount &&
      forkB.pendingTriggerIds.length === profile.partitionTriggerCount &&
      forkA.completedTriggerIds.length === 0,
    `fork children inherited ${forkA.pendingTriggerIds.length}/${forkB.pendingTriggerIds.length} pending alarms of ${profile.partitionTriggerCount} scheduled`,
  );

  const advanceA = await run.advanceFully(childA, profile.monthStorySeconds, "soak-worker-a", farFuture);
  let drainedB = 0;
  for (let round = 1; round <= profile.partitionCount; round += 1) {
    const target = Math.floor((profile.monthStorySeconds * round) / profile.partitionCount);
    const advanced = await run.advanceFully(childB, target, "soak-worker-b", farFuture);
    drainedB += advanced.drained;
  }

  const outcomeA = await run.materialOutcome(partitionCast, childA);
  const outcomeB = await run.materialOutcome(partitionCast, childB);
  const hashA = simulationHash(outcomeA);
  const hashB = simulationHash(outcomeB);
  run.record(
    "P1-partition-invariance",
    hashA === hashB,
    `one skip drained ${advanceA.drained}, ${profile.partitionCount} partitions drained ${drainedB}; material hashes ${hashA} vs ${hashB} ${hashA === hashB ? "match" : "DIFFER"}`,
  );

  const partitionPump = await run.pumpOutbox(farFuture, [childA, childB], () => false);
  const feedRowsA = await run.checkFeedRebuild(childA, "G-feed-rebuild", "partition child A");
  const feedRowsB = await run.checkFeedRebuild(childB, "G-feed-rebuild", "partition child B");
  await run.checkProjectionRebuilds(partitionCast.branchId, "partition root", false);
  await run.checkProjectionRebuilds(childA, "partition child A", true);
  await run.checkProjectionRebuilds(childB, "partition child B", true);
  await run.checkNoDuplicateOutcomes(childA, forkA.forkSequence, "partition child A");
  await run.checkNoDuplicateOutcomes(childB, forkB.forkSequence, "partition child B");

  // ---------------------------------------------------------- chaos world
  const chaosCast = run.buildCast("chaos");
  await run.seedCast(chaosCast);
  const chaosPlan = run.planTriggers(chaosCast, "chaos", profile.chaosTriggerCount);
  for (const trigger of chaosPlan) {
    await run.scheduleTrigger(chaosCast, trigger, "tmpl");
  }

  const counters: ChaosCounters = {
    directAccepted: 0,
    directRejected: 0,
    staleConflicts: 0,
    duplicateReplays: 0,
    injectedCommandCrashes: 0,
    rejectionCodes: {},
    conflictsWellFormed: true,
    rejectionsCarryReason: true,
    duplicatesMatchCached: true,
    crashReplaysExactlyOnce: true,
  };
  const latencies: number[] = [];
  const acceptedEnvelopes: Array<{ command: TransferItemCommand; result: TransferItemCommandResult }> = [];
  let version = profile.chaosTriggerCount;
  let injectedOutboxCrashes = 0;
  let outboxDelivered = 0;
  let maxOutboxDepth = 0;
  let maxTriggerDepth = 0;
  let crashDiagnosticsOk = true;
  let triggerDrainMs = 0;
  let triggersDrained = 0;
  let outboxDrawIndex = 0;
  const wallBase = Date.now();

  const liveFromIndex = async (itemId: string): Promise<number> => {
    const [row] = await database
      .select({
        locusKind: simItemHoldings.locusKind,
        containerItemId: simItemHoldings.containerItemId,
        zoneId: simItemHoldings.zoneId,
      })
      .from(simItemHoldings)
      .where(and(eq(simItemHoldings.branchId, chaosCast.branchId), eq(simItemHoldings.itemId, itemId)));
    if (!row) throw new Error(`Soak item ${itemId} lost its holding row`);
    if (row.locusKind === "zone" && row.zoneId === chaosCast.zoneId) return 0;
    if (row.locusKind === "container" && row.containerItemId) {
      const index = chaosCast.containerIds.indexOf(row.containerItemId);
      if (index >= 0) return index + 1;
    }
    throw new Error(`Soak item ${itemId} sits in an unrecognized locus (${row.locusKind})`);
  };

  const submitTimed = async (
    command: TransferItemCommand,
    crashAt?: DurableMaterialCrashPoint,
  ): Promise<TransferItemCommandResult> => {
    const startedAt = performance.now();
    try {
      return await submitDurableTransferItem(command, {
        database,
        ...(crashAt ? { crashAt } : {}),
      });
    } finally {
      if (!crashAt) latencies.push(performance.now() - startedAt);
    }
  };

  const acceptResult = (command: TransferItemCommand, result: TransferItemCommandResult): void => {
    if (result.status !== "accepted") return;
    counters.directAccepted += 1;
    version = result.branchVersion;
    acceptedEnvelopes.push({ command, result });
  };

  for (let round = 1; round <= profile.partitionCount; round += 1) {
    const roundNow = new Date(wallBase + round * 3600 * 1000);
    for (let k = round - 1; k < profile.chaosDirectCommandCount; k += profile.partitionCount) {
      const itemIndex = run.drawInt("direct-item", k, ITEM_COUNT);
      const fromIndex = await liveFromIndex(at(chaosCast.itemIds, itemIndex, "item"));
      const base = {
        cast: chaosCast,
        expectedVersion: version,
        actorIndex: run.drawInt("direct-actor", k, ACTOR_COUNT),
        itemIndex,
        fromIndex,
        toIndex: run.drawInt("direct-dest", k, PLACE_COUNT),
        commandId: `${chaosCast.branchId}-cmd-${k}`,
        idempotencyKey: `${chaosCast.branchId}-idem-${k}`,
      };
      if (run.drawHit("direct-crash", k, profile.commandCrashDenominator)) {
        const command = run.buildTransferCommand(base);
        const point = at(CRASH_POINTS, k % CRASH_POINTS.length, "crash point");
        counters.injectedCommandCrashes += 1;
        let crashed = false;
        try {
          const unreached = await submitTimed(command, point);
          // No throw is only legal when the resolution rejected before an
          // accepted-path failpoint; the unconditional points always fire.
          if (unreached.status === "rejected" && !UNCONDITIONAL_CRASH_POINTS.includes(point)) {
            counters.injectedCommandCrashes -= 1;
            tallyRejection(counters, unreached);
          } else {
            counters.crashReplaysExactlyOnce = false;
          }
        } catch (error) {
          if (!(error instanceof InjectedSimulationCrash)) throw error;
          crashed = true;
        }
        if (crashed) {
          // Pre-commit points rolled everything back, so the replay resolves
          // fresh; after_commit replays the cached result — either way the
          // replay may legally accept or reject, never conflict.
          const replay = await submitTimed(command);
          if (replay.status === "accepted") acceptResult(command, replay);
          else if (replay.status === "rejected") tallyRejection(counters, replay);
          else counters.crashReplaysExactlyOnce = false;
        }
      } else if (version > 0 && run.drawHit("direct-stale", k, profile.staleDenominator)) {
        const staleCommand = run.buildTransferCommand({
          ...base,
          expectedVersion: version - 1,
          commandId: `${base.commandId}-stale`,
          idempotencyKey: `${base.idempotencyKey}-stale`,
        });
        const conflicted = await submitTimed(staleCommand);
        if (
          conflicted.status === "conflict" &&
          conflicted.currentVersion === version &&
          conflicted.retryable
        ) {
          counters.staleConflicts += 1;
        } else {
          counters.conflictsWellFormed = false;
        }
        const retryCommand = run.buildTransferCommand(base);
        const retry = await submitTimed(retryCommand);
        if (retry.status === "accepted") acceptResult(retryCommand, retry);
        else tallyRejection(counters, retry);
      } else if (
        acceptedEnvelopes.length > 0 &&
        run.drawHit("direct-dup", k, profile.duplicateDenominator)
      ) {
        const prior = at(
          acceptedEnvelopes,
          run.drawInt("direct-dup-pick", k, acceptedEnvelopes.length),
          "accepted envelope",
        );
        const replayed = await submitTimed(prior.command);
        counters.duplicateReplays += 1;
        if (simulationHash(replayed) !== simulationHash(prior.result)) {
          counters.duplicatesMatchCached = false;
        }
      } else {
        const command = run.buildTransferCommand(base);
        const result = await submitTimed(command);
        if (result.status === "accepted") acceptResult(command, result);
        else if (result.status === "conflict") counters.conflictsWellFormed = false;
        else tallyRejection(counters, result);
      }
    }

    const target = Math.floor((profile.monthStorySeconds * round) / profile.partitionCount);
    const advanced = await run.advanceFully(chaosCast.branchId, target, "soak-worker-chaos", roundNow);
    triggerDrainMs += advanced.elapsedMs;
    triggersDrained += advanced.drained;
    version = (await run.branchHead(chaosCast.branchId)).version;

    if (round === Math.max(1, Math.floor(profile.partitionCount / 2))) {
      await captureBranchSnapshot(chaosCast.branchId, { database });
    }

    const pump = await run.pumpOutbox(roundNow, [chaosCast.branchId], () => {
      outboxDrawIndex += 1;
      return run.drawHit("outbox-crash", outboxDrawIndex, profile.outboxCrashDenominator);
    });
    outboxDelivered += pump.delivered;
    injectedOutboxCrashes += pump.crashed;
    crashDiagnosticsOk = crashDiagnosticsOk && pump.crashDiagnosticsOk;

    const depths = await run.openQueueDepths([chaosCast.branchId]);
    maxOutboxDepth = Math.max(maxOutboxDepth, depths.outbox);
    maxTriggerDepth = Math.max(maxTriggerDepth, depths.triggers);
  }

  const finalPump = await run.pumpOutbox(farFuture, [chaosCast.branchId], () => false);
  outboxDelivered += finalPump.delivered;
  const finalDepths = await run.openQueueDepths([chaosCast.branchId, childA, childB]);
  const partitionRootDepths = await run.openQueueDepths([partitionCast.branchId]);
  run.record(
    "G-queues-bounded-drained",
    maxOutboxDepth <= profile.queueDepthCap &&
      maxTriggerDepth <= profile.chaosTriggerCount &&
      finalDepths.outbox === 0 &&
      finalDepths.triggers === 0 &&
      partitionRootDepths.triggers === profile.partitionTriggerCount,
    `max sampled open outbox ${maxOutboxDepth} (cap ${profile.queueDepthCap}); max pending triggers ${maxTriggerDepth} (scheduled ${profile.chaosTriggerCount}); final open outbox=${finalDepths.outbox} triggers=${finalDepths.triggers} on month-completed branches; partition root deliberately retains ${partitionRootDepths.triggers}`,
  );

  const chaosTriggerRows = await database
    .select({ state: simTriggers.state, lastError: simTriggers.lastError })
    .from(simTriggers)
    .where(eq(simTriggers.branchId, chaosCast.branchId));
  const triggersCompleted = chaosTriggerRows.filter((row) => row.state === "completed").length;
  const triggersRejected = chaosTriggerRows.filter((row) => row.state === "failed").length;
  const failedTriggersHaveDiagnostics = chaosTriggerRows
    .filter((row) => row.state === "failed")
    .every((row) => (row.lastError ?? "").includes("rejected code="));
  run.record(
    "P2-trigger-no-duplication",
    triggersCompleted + triggersRejected === profile.chaosTriggerCount,
    `${profile.chaosTriggerCount} chaos triggers reached terminal state: ${triggersCompleted} completed, ${triggersRejected} deterministically rejected (per-trigger event multiplicity in the duplicate-outcome scan)`,
  );
  run.record(
    "P3-stale-conflict",
    counters.staleConflicts > 0 && counters.conflictsWellFormed,
    `${counters.staleConflicts} stale submissions returned structured retryable conflicts carrying currentVersion; no sequential submit conflicted unexpectedly=${String(counters.conflictsWellFormed)}`,
  );
  run.record(
    "G-diagnostics",
    counters.rejectionsCarryReason && failedTriggersHaveDiagnostics && crashDiagnosticsOk,
    `rejections carry typed code+publicReason=${String(counters.rejectionsCarryReason)} (${JSON.stringify(counters.rejectionCodes)}); failed triggers carry lastError=${String(failedTriggersHaveDiagnostics)}; crashed outbox rows carried structured lastError=${String(crashDiagnosticsOk)}`,
  );
  run.record(
    "G-idempotency-replays",
    counters.duplicatesMatchCached && counters.crashReplaysExactlyOnce,
    `${counters.duplicateReplays} duplicate idempotency keys replayed cached results identically=${String(counters.duplicatesMatchCached)}; ${counters.injectedCommandCrashes} injected command crashes replayed exactly once=${String(counters.crashReplaysExactlyOnce)}`,
  );

  await run.checkFeedRebuild(chaosCast.branchId, "P4-outbox-crash-resume", "chaos root (with injected consumer crashes)");
  await run.checkProjectionRebuilds(chaosCast.branchId, "chaos root", true);
  await run.checkNoDuplicateOutcomes(chaosCast.branchId, null, "chaos root");
  await run.checkDerivationsRecorded([partitionCast.branchId, childA, childB, chaosCast.branchId]);
  await run.checkAudit(chaosCast);

  const chaosHead = await run.branchHead(chaosCast.branchId);
  run.record(
    "G-month-advanced",
    chaosHead.storySecond === profile.monthStorySeconds &&
      outcomeA.storySecond === profile.monthStorySeconds &&
      outcomeB.storySecond === profile.monthStorySeconds,
    `story clocks at month-end (${profile.monthStorySeconds}s): chaos=${chaosHead.storySecond}, partition A/B=${outcomeA.storySecond}/${outcomeB.storySecond}`,
  );

  return {
    profile,
    worldIds: [partitionCast.worldId, chaosCast.worldId],
    materialHash: { singleSkip: hashA, partitioned: hashB },
    metrics: {
      partition: {
        scheduled: profile.partitionTriggerCount,
        forkPendingA: forkA.pendingTriggerIds.length,
        forkPendingB: forkB.pendingTriggerIds.length,
        drainedA: advanceA.drained,
        drainedB,
        outboxDelivered: partitionPump.delivered,
        feedRowsA,
        feedRowsB,
      },
      chaos: {
        triggersScheduled: profile.chaosTriggerCount,
        triggersCompleted,
        triggersRejected,
        directAccepted: counters.directAccepted,
        directRejected: counters.directRejected,
        staleConflicts: counters.staleConflicts,
        duplicateReplays: counters.duplicateReplays,
        injectedCommandCrashes: counters.injectedCommandCrashes,
        injectedOutboxCrashes,
        outboxDelivered,
        maxOutboxDepth,
        maxTriggerDepth,
        rejectionCodes: counters.rejectionCodes,
      },
      latency: {
        directSubmit: summarizeLatency(latencies),
        triggerResolveAvgMs: triggersDrained > 0 ? triggerDrainMs / triggersDrained : 0,
      },
    },
    proofs: run.results(),
  };
}
