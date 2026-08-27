import { and, asc, eq, gt, inArray } from "drizzle-orm";
import {
  assertionSchema,
  beliefSchema,
  knowledgeProjectionSchema,
  type Assertion,
  type Belief,
  type KnowledgeProjection,
} from "@vesper/simulation-core/contracts/knowledge";
import { observationSchema, type Observation } from "@vesper/simulation-core/contracts/perception";
import {
  applyDisclosureEvent,
  type KnowledgeReplayResult,
  type KnowledgeState,
} from "@vesper/simulation-core/knowledge";
import { db, simAssertions, simBeliefs, simEvents, simObservations, type Db } from "@/server/db";
import { branchEventFromRow } from "./observation-store";
import type { SimTx } from "./trigger-projector";

/**
 * E4.2 — the durable knowledge ledgers. Assertion and
 * belief rows are derived projections of disclosure events, written in the
 * same transaction that commits the event: the §11.1 shell calls
 * `recordCommandKnowledge` right after the §20 observation recorder, so the
 * belief fold always sees this command's observation rows. The fold itself is
 * pure (`lib/simulation/knowledge`); this module only loads the narrow seed
 * the fold's contract requires and upserts what it returns.
 *
 * This lives apart from `knowledge-store` (the command handler) so the
 * command shell can import the recorder without a cycle — the same reason
 * `observation-store` never imports `command-runner`.
 */

export function assertionFromRow(row: typeof simAssertions.$inferSelect): Assertion {
  return assertionSchema.parse({
    id: row.assertionId,
    branchId: row.branchId,
    propositionKey: row.propositionKey,
    subjectIds: row.subjectIds,
    claimedValue: row.claimedValue,
    ...(row.sourceActorId === null ? {} : { sourceActorId: row.sourceActorId }),
    ...(row.sourceEventId === null ? {} : { sourceEventId: row.sourceEventId }),
    ...(row.sourceEventSequence === null ? {} : { sourceEventSequence: row.sourceEventSequence }),
    assertedAt: row.assertedAt,
    ...(row.validFrom === null ? {} : { validFrom: row.validFrom }),
    ...(row.validUntil === null ? {} : { validUntil: row.validUntil }),
    status: row.status,
    ...(row.statusChangedAt === null ? {} : { statusChangedAt: row.statusChangedAt }),
    ...(row.statusCauseEventId === null ? {} : { statusCauseEventId: row.statusCauseEventId }),
    derivationVersion: row.derivationVersion,
  });
}

export function beliefFromRow(row: typeof simBeliefs.$inferSelect): Belief {
  return beliefSchema.parse({
    id: row.beliefId,
    branchId: row.branchId,
    holderActorId: row.holderActorId,
    assertionId: row.assertionId,
    confidenceFixedPoint: row.confidenceFixedPoint,
    basisObservationIds: row.basisObservationIds,
    learnedFromActorIds: row.learnedFromActorIds,
    believedFrom: row.believedFrom,
    ...(row.believedUntil === null ? {} : { believedUntil: row.believedUntil }),
    status: row.status,
    ...(row.statusCauseEventId === null ? {} : { statusCauseEventId: row.statusCauseEventId }),
    sourceEventId: row.sourceEventId,
    sourceEventSequence: row.sourceEventSequence,
    derivationVersion: row.derivationVersion,
  });
}

function assertionRowInsert(
  branchId: string,
  assertion: Assertion,
  updatedSequence: number,
): typeof simAssertions.$inferInsert {
  return {
    branchId,
    assertionId: assertion.id,
    propositionKey: assertion.propositionKey,
    subjectIds: [...assertion.subjectIds],
    claimedValue: assertion.claimedValue,
    sourceActorId: assertion.sourceActorId ?? null,
    sourceEventId: assertion.sourceEventId ?? null,
    sourceEventSequence: assertion.sourceEventSequence ?? null,
    assertedAt: assertion.assertedAt,
    validFrom: assertion.validFrom ?? null,
    validUntil: assertion.validUntil ?? null,
    status: assertion.status,
    statusChangedAt: assertion.statusChangedAt ?? null,
    statusCauseEventId: assertion.statusCauseEventId ?? null,
    derivationVersion: assertion.derivationVersion,
    updatedSequence,
  };
}

function beliefRowInsert(
  branchId: string,
  belief: Belief,
  updatedSequence: number,
): typeof simBeliefs.$inferInsert {
  return {
    branchId,
    beliefId: belief.id,
    holderActorId: belief.holderActorId,
    assertionId: belief.assertionId,
    confidenceFixedPoint: belief.confidenceFixedPoint,
    basisObservationIds: [...belief.basisObservationIds],
    learnedFromActorIds: [...belief.learnedFromActorIds],
    believedFrom: belief.believedFrom,
    believedUntil: belief.believedUntil ?? null,
    status: belief.status,
    statusCauseEventId: belief.statusCauseEventId ?? null,
    sourceEventId: belief.sourceEventId,
    sourceEventSequence: belief.sourceEventSequence,
    derivationVersion: belief.derivationVersion,
    updatedSequence,
  };
}

async function upsertAssertions(
  tx: SimTx,
  branchId: string,
  assertions: readonly Assertion[],
  updatedSequence: number,
): Promise<void> {
  for (const assertion of assertions) {
    const row = assertionRowInsert(branchId, assertion, updatedSequence);
    await tx
      .insert(simAssertions)
      .values(row)
      .onConflictDoUpdate({
        target: [simAssertions.branchId, simAssertions.assertionId],
        set: {
          status: row.status,
          statusChangedAt: row.statusChangedAt,
          statusCauseEventId: row.statusCauseEventId,
          updatedSequence: row.updatedSequence,
        },
      });
  }
}

async function upsertBeliefs(
  tx: SimTx,
  branchId: string,
  beliefs: readonly Belief[],
  updatedSequence: number,
): Promise<void> {
  for (const belief of beliefs) {
    const row = beliefRowInsert(branchId, belief, updatedSequence);
    await tx
      .insert(simBeliefs)
      .values(row)
      .onConflictDoUpdate({
        target: [simBeliefs.branchId, simBeliefs.beliefId],
        set: {
          status: row.status,
          believedUntil: row.believedUntil,
          statusCauseEventId: row.statusCauseEventId,
          confidenceFixedPoint: row.confidenceFixedPoint,
          updatedSequence: row.updatedSequence,
        },
      });
  }
}

/**
 * The fold's seed contract (see `KnowledgeState`): every assertion on the
 * branch sharing a proposition with what this command discloses, plus every
 * belief held by this command's listeners. Two steps because a relay names an
 * assertion whose proposition family is only known after loading it.
 */
async function loadKnowledgeSeed(
  tx: SimTx,
  branchId: string,
  input: {
    referencedAssertionIds: readonly string[];
    claimPropositionKeys: readonly string[];
    listenerActorIds: readonly string[];
  },
): Promise<KnowledgeState> {
  const assertions = new Map<string, Assertion>();
  if (input.referencedAssertionIds.length > 0) {
    const referencedRows = await tx
      .select()
      .from(simAssertions)
      .where(
        and(
          eq(simAssertions.branchId, branchId),
          inArray(simAssertions.assertionId, [...input.referencedAssertionIds]),
        ),
      )
      .orderBy(asc(simAssertions.assertionId));
    for (const row of referencedRows) {
      const assertion = assertionFromRow(row);
      assertions.set(assertion.id, assertion);
    }
  }
  const propositionKeys = [
    ...new Set([
      ...input.claimPropositionKeys,
      ...[...assertions.values()].map((assertion) => assertion.propositionKey),
    ]),
  ].sort();
  if (propositionKeys.length > 0) {
    const familyRows = await tx
      .select()
      .from(simAssertions)
      .where(
        and(eq(simAssertions.branchId, branchId), inArray(simAssertions.propositionKey, propositionKeys)),
      )
      .orderBy(asc(simAssertions.assertionId));
    for (const row of familyRows) {
      const assertion = assertionFromRow(row);
      assertions.set(assertion.id, assertion);
    }
  }

  const beliefs = new Map<string, Belief>();
  if (input.listenerActorIds.length > 0) {
    const beliefRows = await tx
      .select()
      .from(simBeliefs)
      .where(
        and(eq(simBeliefs.branchId, branchId), inArray(simBeliefs.holderActorId, [...input.listenerActorIds])),
      )
      .orderBy(asc(simBeliefs.beliefId));
    for (const row of beliefRows) {
      const belief = beliefFromRow(row);
      beliefs.set(belief.id, belief);
    }
  }
  return { assertions, beliefs };
}

/**
 * Derive and persist assertion/belief updates for every disclosure event an
 * accepted command appended. Runs inside the command transaction, AFTER
 * `recordCommandObservations` — the belief fold consumes the §20 rows that
 * recorder just wrote. Non-disclosure commands return without loading.
 */
export async function recordCommandKnowledge(
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
        eq(simEvents.type, "disclosure_made"),
      ),
    )
    .orderBy(asc(simEvents.sequence));
  if (eventRows.length === 0) return 0;

  const events = eventRows.map(branchEventFromRow);
  const eventIds = events.map((event) => event.id);
  const observationRows = await tx
    .select()
    .from(simObservations)
    .where(and(eq(simObservations.branchId, branch.id), inArray(simObservations.sourceEventId, eventIds)))
    .orderBy(asc(simObservations.observationId));
  const observations: Observation[] = observationRows.map((row) =>
    observationSchema.parse({
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
    }),
  );

  const referencedAssertionIds: string[] = [];
  const claimPropositionKeys: string[] = [];
  for (const event of events) {
    if (event.type !== "disclosure_made") continue;
    referencedAssertionIds.push(event.payload.derived.assertionId);
    if (event.payload.content.kind === "claim") {
      claimPropositionKeys.push(event.payload.content.propositionKey);
    }
  }
  const listenerActorIds = [...new Set(observations.map((observation) => observation.witnessActorId))];

  let state = await loadKnowledgeSeed(tx, branch.id, {
    referencedAssertionIds,
    claimPropositionKeys,
    listenerActorIds,
  });

  let written = 0;
  for (const event of events) {
    if (event.type !== "disclosure_made") continue;
    const update = applyDisclosureEvent(
      state,
      event,
      observations.filter((observation) => observation.sourceEventId === event.id),
    );
    state = update.state;
    await upsertAssertions(tx, branch.id, update.upsertedAssertions, event.sequence);
    await upsertBeliefs(tx, branch.id, update.upsertedBeliefs, event.sequence);
    written += update.upsertedAssertions.length + update.upsertedBeliefs.length;
  }
  return written;
}

/** The full knowledge projection of one branch, id-ordered for parity checks. */
export async function loadKnowledgeProjection(
  branchId: string,
  options: { database?: Db | SimTx } = {},
): Promise<KnowledgeProjection> {
  const database = options.database ?? db();
  const assertionRows = await database
    .select()
    .from(simAssertions)
    .where(eq(simAssertions.branchId, branchId))
    .orderBy(asc(simAssertions.assertionId));
  const beliefRows = await database
    .select()
    .from(simBeliefs)
    .where(eq(simBeliefs.branchId, branchId))
    .orderBy(asc(simBeliefs.beliefId));
  return knowledgeProjectionSchema.parse({
    branchId,
    assertions: assertionRows.map(assertionFromRow),
    beliefs: beliefRows.map(beliefFromRow),
  });
}

/** Bulk-insert replayed knowledge rows — the fork rebuild's write path. */
export async function insertReplayedKnowledge(
  tx: SimTx,
  replayed: KnowledgeReplayResult,
  targetBranchId: string,
): Promise<void> {
  if (replayed.assertions.length > 0) {
    await tx.insert(simAssertions).values(
      replayed.assertions.map((assertion) =>
        assertionRowInsert(targetBranchId, assertion, assertion.sourceEventSequence ?? 0),
      ),
    );
  }
  if (replayed.beliefs.length > 0) {
    await tx.insert(simBeliefs).values(
      replayed.beliefs.map((belief) => beliefRowInsert(targetBranchId, belief, belief.sourceEventSequence)),
    );
  }
}
