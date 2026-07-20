import { and, asc, eq, gt, inArray } from "drizzle-orm";
import { relationshipLedgerEntrySchema, type RelationshipLedgerEntry } from "@/contracts/simulation/social";
import { deriveRelationshipLedgerEntries } from "@/lib/simulation/social";
import { sortedUnique } from "@/lib/simulation/hash";
import { db, simCommitments, simEvents, simRelationshipLedger, type Db } from "@/server/db";
import { branchEventFromRow } from "./observation-store";
import type { SimTx } from "./trigger-projector";

/**
 * E5.5 slice 1 — the relationship-ledger recorder (engine.spec §21.3). Lives
 * apart from `social-store.ts` (the command handlers) for the same reason
 * `knowledge-recorder.ts` lives apart from `knowledge-store.ts` — the
 * command-transaction shell (`command-runner.ts`) imports the recorder
 * without importing the full command-handler module, avoiding a cycle. The
 * row mapping (`relationshipLedgerEntryFromRow`/`relationshipLedgerEntryRowInsert`)
 * lives HERE, not in `social-store.ts`, for the same reason: `social-store.ts`
 * imports `command-runner.ts` for the §11.1 shell, so a row mapper imported
 * FROM `social-store.ts` into this file would close
 * `command-runner.ts` → `social-recorder.ts` → `social-store.ts` →
 * `command-runner.ts` — confirmed by `pnpm lint:cycles` before this split.
 *
 * Unlike `recordCommandKnowledge`, this recorder needs NO seed load: the
 * ledger fold is genuinely append-only and stateless — each source event
 * maps to zero-or-more NEW entries with no dependency on prior ledger state
 * (unlike belief folding, which supersedes prior rows). This is a deliberate
 * simplification, not an oversight.
 */

// ---------------------------------------------------------------------------
// Row mapping — append-only, mirrors assertionRowInsert/beliefRowInsert
// (knowledge-recorder.ts) more than household-store.ts's upsert shape: a
// ledger entry is never updated once written.
// ---------------------------------------------------------------------------

export function relationshipLedgerEntryFromRow(
  row: typeof simRelationshipLedger.$inferSelect,
): RelationshipLedgerEntry {
  return relationshipLedgerEntrySchema.parse({
    id: row.entryId,
    branchId: row.branchId,
    kind: row.kind,
    fromActorId: row.fromActorId,
    toActorId: row.toActorId,
    provenance: row.provenance,
    payload: row.payload,
    ...(row.detail === null ? {} : { detail: row.detail }),
    sourceEventId: row.sourceEventId,
    sequence: row.sequence,
    storySecond: row.storySecond,
    derivationVersion: row.derivationVersion,
  });
}

export function relationshipLedgerEntryRowInsert(
  branchId: string,
  entry: RelationshipLedgerEntry,
): typeof simRelationshipLedger.$inferInsert {
  return {
    branchId,
    entryId: entry.id,
    kind: entry.kind,
    fromActorId: entry.fromActorId,
    toActorId: entry.toActorId,
    provenance: entry.provenance,
    payload: entry.payload,
    detail: entry.detail ?? null,
    sourceEventId: entry.sourceEventId,
    sequence: entry.sequence,
    storySecond: entry.storySecond,
    derivationVersion: entry.derivationVersion,
  };
}

/**
 * Every event type the fold reads — kept as one exported const so this
 * recorder's WHERE clause and `deriveRelationshipLedgerEntries`'s if-chain
 * can never silently drift. E5.5 slice 2 widens this to the full slice-2
 * subset (§5.7): `commitment_kept`/`commitment_missed`/`commitment_created`
 * now carry the `promisedToActorId`/`repairsCommitmentId` fields the fold
 * needs, and `activity_started` now carries `consentGrant`.
 * `consent_escalation_resolved`/`pressure_acknowledged` join in Slice 3.
 */
export const RELATIONSHIP_LEDGER_SOURCE_EVENT_TYPES = [
  "speech_act_delivered",
  "disclosure_made",
  "commitment_kept",
  "commitment_missed",
  "commitment_created",
  "engagement_ended",
  "activity_started",
  "relationship_entry_authored",
  "relationship_change_recorded",
] as const;

/**
 * Derive and persist relationship-ledger entries for every event an accepted
 * command appended. Runs inside the command transaction, AFTER
 * `recordCommandKnowledge` and BEFORE `recordCommandSoftCanon`/memory
 * indexing (command-runner.ts §11.1) — so a newly-recorded ledger entry is
 * visible to memory-index eligibility in the SAME transaction.
 */
export async function recordCommandRelationshipLedger(
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
        inArray(simEvents.type, RELATIONSHIP_LEDGER_SOURCE_EVENT_TYPES),
      ),
    )
    .orderBy(asc(simEvents.sequence));
  if (eventRows.length === 0) return 0;

  const events = eventRows.map(branchEventFromRow);

  // Only commitment_kept/commitment_missed need a commitment lookup — the
  // fold's `commitment_created` (repair) arm reads `promisedToActorId`
  // directly off that event's own payload (§4.2), so no lookup is needed for
  // it — narrower than the blueprint's literal §5.7 draft, which loaded a
  // commitment_created row too despite the fold never consuming it.
  const commitmentIds = sortedUnique(
    events.flatMap((event) =>
      event.type === "commitment_kept" || event.type === "commitment_missed" ? [event.payload.commitmentId] : [],
    ),
  );
  const commitmentRows = commitmentIds.length
    ? await tx
        .select({
          commitmentId: simCommitments.commitmentId,
          kind: simCommitments.kind,
          promisedToActorId: simCommitments.promisedToActorId,
        })
        .from(simCommitments)
        .where(and(eq(simCommitments.branchId, branch.id), inArray(simCommitments.commitmentId, commitmentIds)))
    : [];
  const commitmentById = new Map(commitmentRows.map((row) => [row.commitmentId, row]));

  const entries = deriveRelationshipLedgerEntries({
    events,
    commitmentById: (commitmentId) => {
      const row = commitmentById.get(commitmentId);
      return row ? { kind: row.kind, ...(row.promisedToActorId === null ? {} : { promisedToActorId: row.promisedToActorId }) } : undefined;
    },
  });
  if (entries.length === 0) return 0;

  await tx.insert(simRelationshipLedger).values(entries.map((entry) => relationshipLedgerEntryRowInsert(branch.id, entry)));
  return entries.length;
}

/** The full relationship-ledger projection of one branch, id-ordered for parity checks. */
export async function loadRelationshipLedgerProjection(
  branchId: string,
  options: { database?: Db | SimTx } = {},
): Promise<RelationshipLedgerEntry[]> {
  const database = options.database ?? db();
  const rows = await database
    .select()
    .from(simRelationshipLedger)
    .where(eq(simRelationshipLedger.branchId, branchId))
    .orderBy(asc(simRelationshipLedger.entryId));
  return rows.map(relationshipLedgerEntryFromRow);
}

/** Bulk-insert replayed ledger rows — the fork rebuild's write path (§6). */
export async function insertReplayedSocialLedger(
  tx: SimTx,
  entries: readonly RelationshipLedgerEntry[],
  targetBranchId: string,
): Promise<void> {
  if (entries.length === 0) return;
  await tx.insert(simRelationshipLedger).values(entries.map((entry) => relationshipLedgerEntryRowInsert(targetBranchId, entry)));
}
