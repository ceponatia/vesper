import { and, desc, eq } from "drizzle-orm";
import {
  deriveSnapshotId,
  itemTransferSnapshotProjectionKind,
  itemTransferSnapshotSchemaVersion,
  projectionRebuildResultSchema,
  simulationSnapshotSchema,
  type ProjectionRebuildResult,
  type SimulationSnapshot,
} from "@vesper/simulation-core/contracts/branching";
import { worldBranchIdSchema } from "@vesper/simulation-core/contracts/identity";
import { materialsProjectionSchema } from "@vesper/simulation-core/contracts/materials";
import { simulationHash } from "@vesper/simulation-core/hash";
import { replayBranchHistory } from "@vesper/simulation-core/replay";
import { db, simSnapshots, type Db } from "@/server/db";
import {
  assembleBranchState,
  loadBranchAncestry,
  readDurableBranchState,
  seedProjectionForReplay,
} from "./branch-store";

export interface SnapshotStoreOptions {
  database?: Db;
}

/**
 * Checkpoint a branch's live projection at its current head.
 * Capture trusts the live projection — that is the point of a snapshot — which
 * is why the periodic from-zero rebuilds below are required: they are what
 * keeps a wrong snapshot from hiding a replay defect.
 */
export async function captureBranchSnapshot(
  rawBranchId: string,
  options: SnapshotStoreOptions = {},
): Promise<SimulationSnapshot> {
  const database = options.database ?? db();
  const branchId = worldBranchIdSchema.parse(rawBranchId);
  const state = await readDurableBranchState(branchId, database);
  const snapshot = simulationSnapshotSchema.parse({
    id: deriveSnapshotId(branchId, itemTransferSnapshotProjectionKind, state.projection.headSequence),
    worldId: state.ancestry.worldId,
    branchId,
    projectionKind: itemTransferSnapshotProjectionKind,
    sequence: state.projection.headSequence,
    projectionSchemaVersion: itemTransferSnapshotSchemaVersion,
    rulesetVersion: state.projection.rulesetVersion,
    checksum: simulationHash(state.projection),
    sourceFirstSequence: 0,
    sourceLastSequence: state.projection.headSequence,
    payload: { projection: state.projection },
  });
  await database
    .insert(simSnapshots)
    .values(snapshot)
    // Same boundary, newer clock: refresh rather than duplicate. Story time
    // may advance without events, so a re-capture at one sequence is legal.
    .onConflictDoUpdate({
      target: [simSnapshots.branchId, simSnapshots.projectionKind, simSnapshots.sequence],
      set: {
        checksum: snapshot.checksum,
        rulesetVersion: snapshot.rulesetVersion,
        payload: snapshot.payload,
        updatedAt: new Date(),
      },
    });
  return snapshot;
}

/** Snapshots are disposable coordination state; discarding them changes no truth. */
export async function discardBranchSnapshots(
  rawBranchId: string,
  options: SnapshotStoreOptions & { sequence?: number } = {},
): Promise<number> {
  const database = options.database ?? db();
  const branchId = worldBranchIdSchema.parse(rawBranchId);
  const discarded = await database
    .delete(simSnapshots)
    .where(
      and(
        eq(simSnapshots.branchId, branchId),
        eq(simSnapshots.projectionKind, itemTransferSnapshotProjectionKind),
        options.sequence === undefined ? undefined : eq(simSnapshots.sequence, options.sequence),
      ),
    )
    .returning({ id: simSnapshots.id });
  return discarded.length;
}

export interface RebuildBranchProjectionOptions extends SnapshotStoreOptions {
  /** "zero" replays the whole logical range; "snapshot" resumes from the latest one. */
  source?: "zero" | "snapshot";
}

/**
 * Rebuild the authoritative projection from immutable events and compare it to
 * the live rows by checksum. From-zero replays the entire ancestry
 * range through the pure projectors; from-snapshot resumes at the latest
 * checkpoint. Tests MUST keep exercising the from-zero path so a subtly wrong
 * snapshot cannot hide a replay defect by always being loaded.
 */
export async function rebuildDurableBranchProjection(
  rawBranchId: string,
  options: RebuildBranchProjectionOptions = {},
): Promise<ProjectionRebuildResult> {
  const database = options.database ?? db();
  const branchId = worldBranchIdSchema.parse(rawBranchId);
  const source = options.source ?? "zero";

  return database.transaction(
    async (tx) => {
      const ancestry = await loadBranchAncestry(tx, branchId);
      const state = await assembleBranchState(tx, ancestry);
      const chainBranchIds = ancestry.chain.map((node) => node.branchId);

      let seed = seedProjectionForReplay({ branchId, state });
      let snapshotSequence: number | undefined;
      let replayEvents = state.events;
      if (source === "snapshot") {
        const [row] = await tx
          .select()
          .from(simSnapshots)
          .where(
            and(
              eq(simSnapshots.branchId, branchId),
              eq(simSnapshots.projectionKind, itemTransferSnapshotProjectionKind),
            ),
          )
          .orderBy(desc(simSnapshots.sequence))
          .limit(1);
        if (!row) throw new Error("No snapshot exists to rebuild from");
        const snapshot = simulationSnapshotSchema.parse({
          id: row.id,
          worldId: row.worldId,
          branchId: row.branchId,
          projectionKind: row.projectionKind,
          sequence: row.sequence,
          projectionSchemaVersion: row.projectionSchemaVersion,
          rulesetVersion: row.rulesetVersion,
          checksum: row.checksum,
          sourceFirstSequence: row.sourceFirstSequence,
          sourceLastSequence: row.sourceLastSequence,
          payload: row.payload,
        });
        seed = snapshot.payload.projection;
        snapshotSequence = snapshot.sequence;
        replayEvents = state.events.filter((event) => event.sequence > snapshot.sequence);
      }

      const replay = replayBranchHistory({ seed, events: replayEvents, chainBranchIds });
      // The story clock advances without events (the command shell writes it
      // to the branch row), so the rebuilt projection stamps the live clock
      // rather than pretending events determine it.
      const rebuilt = materialsProjectionSchema.parse({
        ...replay.projection,
        storySecond: state.projection.storySecond,
      });

      const liveHash = simulationHash(state.projection);
      const rebuiltHash = simulationHash(rebuilt);
      return projectionRebuildResultSchema.parse({
        branchId,
        headSequence: state.projection.headSequence,
        source,
        ...(snapshotSequence === undefined ? {} : { snapshotSequence }),
        replayedEventCount: replay.replayedEventCount,
        liveHash,
        rebuiltHash,
        matches: liveHash === rebuiltHash,
      });
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}
