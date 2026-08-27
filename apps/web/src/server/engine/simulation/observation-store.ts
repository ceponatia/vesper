import { and, asc, eq, gt, lte } from "drizzle-orm";
import {
  simulationBranchEventSchema,
  type SimulationBranchEvent,
} from "@vesper/simulation-core/contracts/branching";
import { observationSchema, type Observation } from "@vesper/simulation-core/contracts/perception";
import { physicalLocusSchema } from "@vesper/simulation-core/contracts/space";
import {
  deriveCommandObservations,
  type PerceptionSpaceView,
} from "@vesper/simulation-core/perception";
import { db, simEvents, simObservations, simPhysicalLoci, simZones, type Db } from "@/server/db";
import type { SimTx } from "./trigger-projector";

/**
 * E4.1 — the durable observation log. Every accepted
 * command's transaction ends by deriving who perceived its events and
 * inserting the rows here, so perception is committed atomically with the
 * truth it perceives. Rows are pure derivations of the event stream — the
 * replay fold (`replayObservationsHistory`) reproduces them bit-for-bit for
 * fork rebuilds and parity checks.
 */

/** Event kinds the rule table never grades — lets the recorder skip loading space state. */
const unobservableEventTypes: ReadonlySet<string> = new Set([
  "trigger_scheduled",
  "commitment_created",
  "pressure_raised",
  "commitment_kept",
  "commitment_late",
  "commitment_missed",
]);

/** Parse one sim_events row back into the typed branch-event union. */
export function branchEventFromRow(row: typeof simEvents.$inferSelect): SimulationBranchEvent {
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

function observationFromRow(row: typeof simObservations.$inferSelect): Observation {
  return observationSchema.parse({
    id: row.observationId,
    branchId: row.branchId,
    sourceEventId: row.sourceEventId,
    sourceEventSequence: row.sourceEventSequence,
    witnessActorId: row.witnessActorId,
    storySecond: row.storySecond,
    channel: row.channel,
    evidenceClass: row.evidenceClass,
    confidenceFixedPoint: row.confidenceFixedPoint,
    detailTier: row.detailTier,
    derivationVersion: row.derivationVersion,
  });
}

function observationInsert(observation: Observation): typeof simObservations.$inferInsert {
  return {
    branchId: observation.branchId,
    observationId: observation.id,
    sourceEventId: observation.sourceEventId,
    sourceEventSequence: observation.sourceEventSequence,
    witnessActorId: observation.witnessActorId,
    storySecond: observation.storySecond,
    channel: observation.channel,
    evidenceClass: observation.evidenceClass,
    confidenceFixedPoint: observation.confidenceFixedPoint,
    detailTier: observation.detailTier,
    derivationVersion: observation.derivationVersion,
  };
}

/** The post-command perception view: two narrow reads, no topology load. */
async function loadPerceptionSpaceView(tx: SimTx, branchId: string): Promise<PerceptionSpaceView> {
  const zoneRows = await tx
    .select({ zoneId: simZones.zoneId, locationId: simZones.locationId })
    .from(simZones)
    .where(eq(simZones.branchId, branchId))
    .orderBy(asc(simZones.zoneId));
  const locusRows = await tx
    .select()
    .from(simPhysicalLoci)
    .where(eq(simPhysicalLoci.branchId, branchId))
    .orderBy(asc(simPhysicalLoci.actorId));
  return {
    zones: zoneRows.map((row) => ({ id: row.zoneId, locationId: row.locationId })),
    loci: locusRows.map((row) =>
      physicalLocusSchema.parse(
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
      ),
    ),
  };
}

/**
 * Derive and persist the observations for every event an accepted command
 * appended (sequence > the locked branch head), graded against the
 * post-command locus rows. Runs inside the command transaction — called by
 * the shared command shell and by the pre-shell stores' inlined copies.
 */
export async function recordCommandObservations(
  tx: SimTx,
  branch: { id: string; headSequence: number },
): Promise<number> {
  const eventRows = await tx
    .select()
    .from(simEvents)
    .where(and(eq(simEvents.branchId, branch.id), gt(simEvents.sequence, branch.headSequence)))
    .orderBy(asc(simEvents.sequence));
  if (eventRows.length === 0) return 0;
  if (eventRows.every((row) => unobservableEventTypes.has(row.type))) return 0;
  const events = eventRows.map(branchEventFromRow);
  const space = await loadPerceptionSpaceView(tx, branch.id);
  const observations = deriveCommandObservations(events, space);
  if (observations.length === 0) return 0;
  await tx.insert(simObservations).values(observations.map(observationInsert));
  return observations.length;
}

/**
 * A viewpoint's observations across a sequence interval (from exclusive,
 * through inclusive) — the arbiter's cut compiler consumes exactly this
 * instead of re-deciding witnessing at compile time.
 */
export async function loadViewpointObservations(
  input: {
    branchId: string;
    witnessActorId: string;
    fromSequence: number;
    throughSequence: number;
  },
  options: { database?: Db | SimTx } = {},
): Promise<Observation[]> {
  const database = options.database ?? db();
  const rows = await database
    .select()
    .from(simObservations)
    .where(
      and(
        eq(simObservations.branchId, input.branchId),
        eq(simObservations.witnessActorId, input.witnessActorId),
        gt(simObservations.sourceEventSequence, input.fromSequence),
        lte(simObservations.sourceEventSequence, input.throughSequence),
      ),
    )
    .orderBy(asc(simObservations.sourceEventSequence), asc(simObservations.observationId));
  return rows.map(observationFromRow);
}

/**
 * Whether an actor holds any observation of one event — the E3.3 commitment
 * knowledge gate's `observed` source resolves through this (a pressure is
 * salient only if the actor can know).
 */
export async function hasObservationOfEvent(
  tx: SimTx,
  input: { branchId: string; witnessActorId: string; sourceEventId: string },
): Promise<boolean> {
  const [row] = await tx
    .select({ observationId: simObservations.observationId })
    .from(simObservations)
    .where(
      and(
        eq(simObservations.branchId, input.branchId),
        eq(simObservations.witnessActorId, input.witnessActorId),
        eq(simObservations.sourceEventId, input.sourceEventId),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/** Bulk-insert replayed observation rows — the fork rebuild's write path. */
export async function insertReplayedObservations(
  tx: SimTx,
  observations: readonly Observation[],
  targetBranchId: string,
): Promise<void> {
  if (observations.length === 0) return;
  await tx
    .insert(simObservations)
    .values(observations.map((observation) => ({ ...observationInsert(observation), branchId: targetBranchId })));
}
