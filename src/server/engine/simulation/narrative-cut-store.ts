import { and, desc, eq } from "drizzle-orm";
import {
  CUT_COMPILER_VERSION,
  narrativeCutSchema,
  type NarrativeCut,
} from "@/contracts/simulation/narrative";
import { simulationHash } from "@/lib/simulation/item-transfer";
import { db, simNarrativeCuts, type Db } from "@/server/db";
import type { SimTx } from "./trigger-projector";

/**
 * E4.3 — the persisted NarrativeCut rows (engine.spec §22.3). A cut row is
 * immutable and addressable: this module can insert and read, never update.
 * Rerender and narrator-failure retry (ruling 8) are `loadPersistedCut` — a
 * pure read that provably creates no events, no rows, and no memories.
 */

export class NarrativeCutVersionError extends Error {
  readonly code = "cut_version_diagnostic";
}

function contentHash(cut: NarrativeCut): string {
  // The hash covers the semantic content — everything except the identity
  // fields derived from it (§22.3).
  const content: Record<string, unknown> = { ...cut };
  delete content.id;
  delete content.semanticHash;
  return simulationHash(content);
}

/**
 * Persist one compiled cut. Idempotent for byte-identical recompiles; a same
 * id with different content is a §22.3 violation and throws a version
 * diagnostic rather than silently replacing an addressable row.
 */
export async function persistNarrativeCut(
  cut: NarrativeCut,
  options: { database?: Db | SimTx } = {},
): Promise<{ created: boolean }> {
  const database = options.database ?? db();
  const inserted = await database
    .insert(simNarrativeCuts)
    .values({
      branchId: cut.branchId,
      cutId: cut.id,
      engagementId: cut.engagementId,
      viewpointActorId: cut.viewpointActorId,
      compilerVersion: cut.compilerVersion,
      semanticHash: cut.semanticHash,
      branchVersion: cut.branchVersion,
      fromSequence: cut.fromSequence,
      throughSequence: cut.throughSequence,
      fromStorySecond: cut.fromStorySecond,
      throughStorySecond: cut.throughStorySecond,
      content: cut,
    })
    .onConflictDoNothing({ target: [simNarrativeCuts.branchId, simNarrativeCuts.cutId] })
    .returning({ cutId: simNarrativeCuts.cutId });
  if (inserted.length === 1) return { created: true };

  const existing = await loadPersistedCut(cut.branchId, cut.id, options);
  if (existing.semanticHash !== cut.semanticHash || existing.compilerVersion !== cut.compilerVersion) {
    throw new NarrativeCutVersionError(
      `NarrativeCut ${cut.id} already persists with hash ${existing.semanticHash} ` +
        `(compiler ${existing.compilerVersion}); recompilation produced ${cut.semanticHash} ` +
        `(compiler ${cut.compilerVersion}) — §22.3 forbids replacing an addressable cut`,
    );
  }
  return { created: false };
}

/** One persisted cut row, unparsed — confirm rejects softly on absence. */
export async function readPersistedCutRow(
  database: Db | SimTx,
  branchId: string,
  cutId: string,
): Promise<typeof simNarrativeCuts.$inferSelect | undefined> {
  const [row] = await database
    .select()
    .from(simNarrativeCuts)
    .where(and(eq(simNarrativeCuts.branchId, branchId), eq(simNarrativeCuts.cutId, cutId)))
    .limit(1);
  return row;
}

/**
 * The rerender / retry-from-cut read (ruling 8): re-load the immutable row,
 * verify its §22.3 identity, and hand back exactly what the failed render
 * saw. Zero writes on this path — a retried narration cannot advance time,
 * emit events, or touch any ledger.
 */
export async function loadPersistedCut(
  branchId: string,
  cutId: string,
  options: { database?: Db | SimTx } = {},
): Promise<NarrativeCut> {
  const database = options.database ?? db();
  const row = await readPersistedCutRow(database, branchId, cutId);
  if (!row) throw new Error(`NarrativeCut ${cutId} is not persisted on branch ${branchId}`);
  const parsed = narrativeCutSchema.safeParse(row.content);
  if (!parsed.success) {
    throw new NarrativeCutVersionError(
      `NarrativeCut ${cutId} (compiler ${row.compilerVersion}) does not parse under ` +
        `${CUT_COMPILER_VERSION} — rerender needs a version-aware migration, not a guess`,
    );
  }
  if (contentHash(parsed.data) !== row.semanticHash) {
    throw new NarrativeCutVersionError(
      `NarrativeCut ${cutId} content no longer matches its recorded hash ${row.semanticHash}`,
    );
  }
  return parsed.data;
}

/** The newest persisted cut for one engagement — the only confirmable one. */
export async function latestCutIdForEngagement(
  database: Db | SimTx,
  branchId: string,
  engagementId: string,
): Promise<string | undefined> {
  const [row] = await database
    .select({ cutId: simNarrativeCuts.cutId })
    .from(simNarrativeCuts)
    .where(
      and(eq(simNarrativeCuts.branchId, branchId), eq(simNarrativeCuts.engagementId, engagementId)),
    )
    .orderBy(desc(simNarrativeCuts.throughSequence), desc(simNarrativeCuts.createdAt))
    .limit(1);
  return row?.cutId;
}
