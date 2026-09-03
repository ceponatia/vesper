import { and, asc, desc, eq, inArray, isNull, lte, or, sql, type SQL } from "drizzle-orm";
import {
  memoryQueryInputSchema,
  memoryRecallResponseSchema,
  type MemoryRecallResponse,
} from "@vesper/simulation-core/contracts/memory";
import { compareStableText } from "@vesper/simulation-core/hash";
import { rankMemoryDocuments, type MemoryRankCandidate } from "@vesper/simulation-core/memory";
import {
  db,
  simAssertions,
  simBeliefs,
  simBranches,
  simMemoryDocuments,
  simPhysicalLoci,
  simSoftCanon,
  simWorlds,
  type Db,
} from "@/server/db";
import { loadBranchAncestry } from "./branch-store";
import { memoryDocumentFromRow, memoryIndexLag } from "./memory-index-store";
import { softCanonEntryFromRow } from "./soft-canon-recorder";
import type { SimTx } from "./trigger-projector";

/**
 * E4.4 — the eligibility-before-similarity pipeline. Every gate before
 * ranking is relational: branch ancestry bounds which documents exist for
 * this timeline, visibility resolves against the viewpoint (fixed actor
 * lists, or a live-belief join for assertion documents), and validity for
 * ledger-backed kinds re-checks the QUERY branch's live rows — a fork that
 * diverged from its parent recalls its own truth, not its parent's. Only the
 * survivors ever meet a similarity score, so vector proximity can never
 * decide witness, truth, current validity, or access.
 */

const liveBeliefStatuses = ["active", "doubted"] as const;

/**
 * Relational validity for ledger-backed documents (pipeline steps 2–3): a
 * document survives only if its source row is live on the QUERY branch.
 * Missing rows fail closed — a document without a live source is silence.
 */
async function narrowByLiveSourceRows(
  tx: SimTx,
  branchId: string,
  viewpointActorId: string,
  atStorySecond: number,
  candidates: readonly (typeof simMemoryDocuments.$inferSelect)[],
): Promise<Set<string>> {
  const surviving = new Set<string>(
    candidates
      .filter(
        (row) =>
          row.sourceKind === "observation" ||
          row.sourceKind === "speech_act" ||
          row.sourceKind === "authored_lore",
      )
      .map((row) => row.docId),
  );

  const beliefDocIds = candidates.filter((row) => row.sourceKind === "belief");
  if (beliefDocIds.length > 0) {
    const rows = await tx
      .select({ beliefId: simBeliefs.beliefId })
      .from(simBeliefs)
      .where(
        and(
          eq(simBeliefs.branchId, branchId),
          inArray(
            simBeliefs.beliefId,
            beliefDocIds.map((row) => row.sourceId),
          ),
          inArray(simBeliefs.status, [...liveBeliefStatuses]),
        ),
      );
    const live = new Set(rows.map((row) => row.beliefId));
    for (const row of beliefDocIds) if (live.has(row.sourceId)) surviving.add(row.docId);
  }

  const assertionDocs = candidates.filter((row) => row.sourceKind === "assertion");
  if (assertionDocs.length > 0) {
    const assertionIds = assertionDocs.map((row) => row.sourceId);
    const activeRows = await tx
      .select({ assertionId: simAssertions.assertionId })
      .from(simAssertions)
      .where(
        and(
          eq(simAssertions.branchId, branchId),
          inArray(simAssertions.assertionId, assertionIds),
          eq(simAssertions.status, "active"),
        ),
      );
    const activeAssertions = new Set(activeRows.map((row) => row.assertionId));
    // visibility=belief_holders: the viewpoint must hold a live belief in the
    // assertion on this branch — knowing OF a claim is what authorizes recall.
    const heldRows = await tx
      .select({ assertionId: simBeliefs.assertionId })
      .from(simBeliefs)
      .where(
        and(
          eq(simBeliefs.branchId, branchId),
          eq(simBeliefs.holderActorId, viewpointActorId),
          inArray(simBeliefs.assertionId, assertionIds),
          inArray(simBeliefs.status, [...liveBeliefStatuses]),
        ),
      );
    const held = new Set(heldRows.map((row) => row.assertionId));
    for (const row of assertionDocs) {
      if (activeAssertions.has(row.sourceId) && held.has(row.sourceId)) surviving.add(row.docId);
    }
  }

  const softCanonDocs = candidates.filter((row) => row.sourceKind === "soft_canon");
  if (softCanonDocs.length > 0) {
    const rows = await tx
      .select()
      .from(simSoftCanon)
      .where(
        and(
          eq(simSoftCanon.branchId, branchId),
          inArray(
            simSoftCanon.entryId,
            softCanonDocs.map((row) => row.sourceId),
          ),
        ),
      );
    const live = new Set<string>(
      rows
        .map(softCanonEntryFromRow)
        .filter(
          (entry) =>
            entry.status === "promoted" ||
            (entry.status === "active" &&
              (entry.validUntil === undefined || entry.validUntil >= atStorySecond)),
        )
        .map((entry) => entry.id),
    );
    for (const row of softCanonDocs) if (live.has(row.sourceId)) surviving.add(row.docId);
  }

  return surviving;
}

export interface MemoryQueryOptions {
  database?: Db;
}

/** The recall pipeline, steps 1–7 in order. */
export async function queryMemoryDocuments(
  rawInput: unknown,
  options: MemoryQueryOptions = {},
): Promise<MemoryRecallResponse> {
  const database = options.database ?? db();
  const input = memoryQueryInputSchema.parse(rawInput);

  // Every relational gate and the index-lag diagnostic read one snapshot, so a
  // command committing mid-query cannot admit a document on the old branch
  // state and check its source row on the new one. Ranking is pure.
  return database.transaction(
    async (tx) => {
      // Step 1 — authenticate world, branch, and viewpoint. A viewpoint with no
      // presence on this timeline recalls nothing, by error rather than absence.
      const [branch] = await tx
        .select({ id: simBranches.id, worldStatus: simWorlds.status })
        .from(simBranches)
        .innerJoin(simWorlds, eq(simWorlds.id, simBranches.worldId))
        .where(eq(simBranches.id, input.branchId))
        .limit(1);
      if (!branch || branch.worldStatus !== "active") {
        throw new Error("Memory query requires an active world branch");
      }
      const [locus] = await tx
        .select({ actorId: simPhysicalLoci.actorId })
        .from(simPhysicalLoci)
        .where(
          and(
            eq(simPhysicalLoci.branchId, input.branchId),
            eq(simPhysicalLoci.actorId, input.viewpointActorId),
          ),
        )
        .limit(1);
      if (!locus) throw new Error("Memory query viewpoint has no presence on this branch");

      // Step 2 — branch ancestry bounds (R4: reference, never copy). Documents on
      // an ancestor are visible only below the tightest fork boundary crossed.
      const ancestry = await loadBranchAncestry(tx, input.branchId);
      const rangeConditions = ancestry.ranges.map((range) =>
        and(
          eq(simMemoryDocuments.branchId, range.branchId),
          lte(simMemoryDocuments.firstSequence, range.maxSequence),
        ),
      );

      // Steps 2–4 — source kind, validity interval, doc-level supersedence,
      // visibility, and structured filters, all relational, all before ranking.
      const conditions: (SQL | undefined)[] = [
        or(...rangeConditions),
        lte(simMemoryDocuments.validFromSecond, input.atStorySecond),
        or(
          isNull(simMemoryDocuments.validUntilSecond),
          sql`${simMemoryDocuments.validUntilSecond} >= ${input.atStorySecond}`,
        ),
        or(
          isNull(simMemoryDocuments.supersededAtSecond),
          sql`${simMemoryDocuments.supersededAtSecond} > ${input.atStorySecond}`,
        ),
        or(
          eq(simMemoryDocuments.visibility, "public"),
          and(
            eq(simMemoryDocuments.visibility, "actors"),
            sql`${simMemoryDocuments.eligibleActorIds} @> ${JSON.stringify([input.viewpointActorId])}::jsonb`,
          ),
          // Narrowed to actual belief holders relationally below (fail closed).
          eq(simMemoryDocuments.visibility, "belief_holders"),
        ),
      ];
      if (input.sourceKinds !== undefined) {
        conditions.push(inArray(simMemoryDocuments.sourceKind, input.sourceKinds));
      }

      const fetchedRows = await tx
        .select()
        .from(simMemoryDocuments)
        .where(and(...conditions))
        .orderBy(desc(simMemoryDocuments.storySecond), asc(simMemoryDocuments.docId))
        .limit(input.maxCandidates);

      // A fork child may hold its own re-indexed copy of an ancestor's document
      // (same doc id, diverged state). The nearest branch in the ancestry wins —
      // the child's view of its own timeline, never the parent's.
      const branchRank = new Map(ancestry.ranges.map((range, index) => [range.branchId, index]));
      const dedupedById = new Map<string, (typeof fetchedRows)[number]>();
      for (const row of fetchedRows) {
        const held = dedupedById.get(row.docId);
        const rowRank = branchRank.get(row.branchId) ?? Number.MAX_SAFE_INTEGER;
        const heldRank = held === undefined ? Number.MAX_SAFE_INTEGER : (branchRank.get(held.branchId) ?? Number.MAX_SAFE_INTEGER);
        if (held === undefined || rowRank < heldRank) dedupedById.set(row.docId, row);
      }
      const candidateRows = [...dedupedById.values()];

      const surviving = await narrowByLiveSourceRows(
        tx,
        input.branchId,
        input.viewpointActorId,
        input.atStorySecond,
        candidateRows,
      );
      let eligible = candidateRows.filter((row) => surviving.has(row.docId));
      if (input.aboutEntityIds !== undefined && input.aboutEntityIds.length > 0) {
        const wanted = new Set(input.aboutEntityIds);
        eligible = eligible.filter((row) => row.aboutEntityIds.some((id) => wanted.has(id)));
      }

      // Steps 5–6 — similarity and diversification inside the eligible set only.
      const candidates: MemoryRankCandidate[] = eligible.map((row) => ({
        doc: memoryDocumentFromRow(row),
        ...(row.embedding === null ? {} : { embedding: row.embedding }),
      }));
      const { ranked, unembeddedEligible } = rankMemoryDocuments({
        candidates,
        ...(input.queryText === undefined ? {} : { queryText: input.queryText }),
        ...(input.queryEmbedding === undefined ? {} : { queryEmbedding: input.queryEmbedding }),
        ...(input.queryEmbeddingModel === undefined
          ? {}
          : { queryEmbeddingModel: input.queryEmbeddingModel }),
        limit: input.limit,
      });

      // Step 7 — provenance and epistemic label on every result, plus index lag.
      const lag = await memoryIndexLag(input.branchId, { database: tx });
      return memoryRecallResponseSchema.parse({
        branchId: input.branchId,
        viewpointActorId: input.viewpointActorId,
        results: ranked
          .map(({ doc, scoreFixedPoint }) => ({
            docId: doc.id,
            sourceKind: doc.sourceKind,
            sourceId: doc.sourceId,
            ...(doc.sourceEventId === undefined ? {} : { sourceEventId: doc.sourceEventId }),
            epistemicLabel: doc.epistemicLabel,
            ...(doc.confidenceFixedPoint === undefined
              ? {}
              : { confidenceFixedPoint: doc.confidenceFixedPoint }),
            text: doc.text,
            storySecond: doc.storySecond,
            scoreFixedPoint,
          }))
          .sort(
            (left, right) =>
              right.scoreFixedPoint - left.scoreFixedPoint ||
              right.storySecond - left.storySecond ||
              compareStableText(left.docId, right.docId),
          ),
        diagnostics: {
          headSequence: lag.headSequence,
          indexedThroughSequence: lag.indexedThroughSequence,
          pendingObligations: lag.pendingObligations,
          failedObligations: lag.failedObligations,
          unembeddedEligible,
        },
      });
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}
