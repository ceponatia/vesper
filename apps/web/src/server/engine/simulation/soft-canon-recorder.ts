import { and, asc, eq, gt, inArray } from "drizzle-orm";
import {
  softCanonEntrySchema,
  softCanonProjectionSchema,
  type SoftCanonEntry,
  type SoftCanonProjection,
} from "@vesper/simulation-core/contracts/soft-canon";
import { db, simEvents, simSoftCanon, type Db } from "@/server/db";
import { branchEventFromRow } from "./observation-store";
import type { SimTx } from "./trigger-projector";

/**
 * E4.3 — the durable soft-canon ledger (engine.spec §23.4). Rows are derived
 * projections of soft_canon_* events, written in the same transaction that
 * commits them: the §11.1 shell calls `recordCommandSoftCanon` after the
 * observation and knowledge recorders. Every event carries its full post-fold
 * snapshot (§6.4), so this module only upserts what the pure fold returns and
 * a fork's replay mints identical rows.
 */

export function softCanonEntryFromRow(row: typeof simSoftCanon.$inferSelect): SoftCanonEntry {
  return softCanonEntrySchema.parse({
    id: row.entryId,
    branchId: row.branchId,
    key: row.key,
    scope: row.scope,
    subjectIds: row.subjectIds,
    value: row.value,
    confidenceFixedPoint: row.confidenceFixedPoint,
    firstRecordedAt: row.firstRecordedAt,
    lastRecordedAt: row.lastRecordedAt,
    ...(row.validUntil === null ? {} : { validUntil: row.validUntil }),
    sourceCutIds: row.sourceCutIds,
    status: row.status,
    ...(row.statusChangedAt === null ? {} : { statusChangedAt: row.statusChangedAt }),
    ...(row.statusCauseEventId === null ? {} : { statusCauseEventId: row.statusCauseEventId }),
    rulesVersion: row.rulesVersion,
    derivationVersion: row.derivationVersion,
  });
}

function softCanonRowInsert(
  branchId: string,
  entry: SoftCanonEntry,
  updatedSequence: number,
): typeof simSoftCanon.$inferInsert {
  return {
    branchId,
    entryId: entry.id,
    key: entry.key,
    scope: entry.scope,
    subjectIds: [...entry.subjectIds],
    value: entry.value,
    confidenceFixedPoint: entry.confidenceFixedPoint,
    firstRecordedAt: entry.firstRecordedAt,
    lastRecordedAt: entry.lastRecordedAt,
    validUntil: entry.validUntil ?? null,
    sourceCutIds: [...entry.sourceCutIds],
    status: entry.status,
    statusChangedAt: entry.statusChangedAt ?? null,
    statusCauseEventId: entry.statusCauseEventId ?? null,
    rulesVersion: entry.rulesVersion,
    derivationVersion: entry.derivationVersion,
    updatedSequence,
  };
}

async function upsertSoftCanonEntry(
  tx: SimTx,
  branchId: string,
  entry: SoftCanonEntry,
  updatedSequence: number,
): Promise<void> {
  const row = softCanonRowInsert(branchId, entry, updatedSequence);
  await tx
    .insert(simSoftCanon)
    .values(row)
    .onConflictDoUpdate({
      target: [simSoftCanon.branchId, simSoftCanon.entryId],
      set: {
        // A revival of an expired key may replace the value and restart
        // provenance, so everything but identity is refreshed from the
        // captured snapshot.
        value: row.value,
        confidenceFixedPoint: row.confidenceFixedPoint,
        firstRecordedAt: row.firstRecordedAt,
        lastRecordedAt: row.lastRecordedAt,
        validUntil: row.validUntil,
        sourceCutIds: row.sourceCutIds,
        status: row.status,
        statusChangedAt: row.statusChangedAt,
        statusCauseEventId: row.statusCauseEventId,
        rulesVersion: row.rulesVersion,
        derivationVersion: row.derivationVersion,
        updatedSequence: row.updatedSequence,
      },
    });
}

/**
 * Fold every soft-canon event an accepted command appended into the durable
 * ledger. Runs inside the command transaction, after the observation and
 * knowledge recorders. Non-canon commands return without loading.
 */
export async function recordCommandSoftCanon(
  tx: SimTx,
  branch: { id: string; headSequence: number },
): Promise<number> {
  const eventRows = await tx
    .select()
    .from(simEvents)
    .where(
      and(
        eq(simEvents.branchId, branch.id),
        gt(simEvents.sequence, branch.headSequence),
        inArray(simEvents.type, ["soft_canon_recorded", "soft_canon_promoted", "soft_canon_demoted"]),
      ),
    )
    .orderBy(asc(simEvents.sequence));
  if (eventRows.length === 0) return 0;

  let written = 0;
  for (const row of eventRows) {
    const event = branchEventFromRow(row);
    // The §6.4 capture makes the fold a snapshot upsert — same shape the pure
    // `applySoftCanonEvent` applies during a fork's replay.
    const entry =
      event.type === "soft_canon_recorded"
        ? event.payload.derived.entry
        : event.type === "soft_canon_promoted" || event.type === "soft_canon_demoted"
          ? event.payload.entry
          : undefined;
    if (!entry) continue;
    await upsertSoftCanonEntry(tx, branch.id, softCanonEntrySchema.parse(entry), event.sequence);
    written += 1;
  }
  return written;
}

/** The full soft-canon projection of one branch, id-ordered for parity checks. */
export async function loadSoftCanonProjection(
  branchId: string,
  options: { database?: Db | SimTx } = {},
): Promise<SoftCanonProjection> {
  const database = options.database ?? db();
  const rows = await database
    .select()
    .from(simSoftCanon)
    .where(eq(simSoftCanon.branchId, branchId))
    .orderBy(asc(simSoftCanon.entryId));
  return softCanonProjectionSchema.parse({
    branchId,
    entries: rows.map(softCanonEntryFromRow),
  });
}

/** Bulk-insert replayed entries — the fork rebuild's write path. */
export async function insertReplayedSoftCanon(
  tx: SimTx,
  entries: readonly SoftCanonEntry[],
  targetBranchId: string,
): Promise<void> {
  if (entries.length === 0) return;
  await tx
    .insert(simSoftCanon)
    .values(entries.map((entry) => softCanonRowInsert(targetBranchId, entry, 0)));
}
