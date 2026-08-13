import { eq } from "drizzle-orm";
import {
  aggregateTrialGrades,
  IDENTITY_PACK_POLICY_VERSION,
  type IdentityReferenceStrategy,
  type ImageIdentityPackTrialGradeRequest,
  type ImageIdentityPackTrialReviewPairWire,
  type ImageIdentityPackTrialSummaryWire,
  pairTrialCells,
  trialCellComboSchema,
  type TrialCellCounts,
  type TrialCellPair,
  type TrialGradeRecord,
  trialPairGradeSchema,
  type TrialRenderedCombo,
  type TrialRunStatus,
  type TrialVerdict,
  type TrialVerdictValue,
  unblindTrialPairGrade,
} from "@vesper/image-core";
import type { DiagnosticSink } from "@/contracts/diagnostics";
import { newId } from "@/lib/ids";
import { db, imageIdentityPackTrialGrades, imageIdentityPackTrialVerdicts } from "../db";
import { readJsonColumn } from "./identity-pack-store";
import {
  countTrialCells,
  gradedPairIds,
  GRADES_JSON_PATH,
  type IdentityPackTrialCellRow,
  type IdentityPackTrialRefusal,
  ownedTrialRun,
  readTrialVerdicts,
  refusal,
  type RenderedComboTally,
  renderedTrialCombos,
  reviewableTrialCells,
  settleTrialRunStatus,
  trialCellRows,
  trialPairLeftIsA,
  verdictComboKey,
} from "./identity-pack-trial-store";

/**
 * Review: serve blinded pairs, record grades, aggregate the summary, and write
 * the per-(profile, strategy) verdicts that complete a run.
 *
 * The pairing readers it shares with run-status settlement live in
 * `./identity-pack-trial-store.ts`.
 */

/* ------------------------------------------------------------------------ *
 * Blinded review                                                            *
 * ------------------------------------------------------------------------ */


export type NextUnreviewedTrialPairResult = { pair: ImageIdentityPackTrialReviewPairWire | null };

/**
 * The next blinded pair, or `{ pair: null }` when the queue is empty. Null when
 * the run is not this owner's. Deliberately stateless: the left/right mapping
 * is derived ({@link trialPairLeftIsA}), so serving the same pair twice shows
 * the same sides, and nothing strategy-shaped crosses the wire.
 */
export async function nextUnreviewedTrialPair(
  runId: string,
  ownerId: string,
  sink?: DiagnosticSink,
): Promise<NextUnreviewedTrialPairResult | null> {
  const run = await ownedTrialRun(runId, ownerId);
  if (!run) return null;
  const { pairable, outputImageIdByCellId } = reviewableTrialCells(await trialCellRows(runId), sink);
  const graded = await gradedPairIds(runId);
  for (const pair of pairTrialCells(pairable)) {
    if (graded.has(pair.pairId)) continue;
    const imageA = outputImageIdByCellId.get(pair.cellAId);
    const imageB = outputImageIdByCellId.get(pair.cellBId);
    if (imageA === undefined || imageB === undefined) continue; // unreachable: pairs are built from reviewable cells
    const leftIsA = trialPairLeftIsA(runId, pair.pairId);
    return {
      pair: {
        pairId: pair.pairId,
        leftImageId: leftIsA ? imageA : imageB,
        rightImageId: leftIsA ? imageB : imageA,
        task: pair.task,
        promptFixtureId: pair.promptFixtureId,
      },
    };
  }
  return { pair: null };
}

export interface SubmitTrialPairGradeInput {
  runId: string;
  ownerId: string;
  request: ImageIdentityPackTrialGradeRequest;
  sink?: DiagnosticSink;
}

export type SubmitTrialPairGradeResult =
  | { ok: true; leftIsA: boolean; runStatus: TrialRunStatus }
  | { ok: false; refusal: IdentityPackTrialRefusal };

/**
 * Store one blinded submission, unblinded into A/B space with the same derived
 * mapping the pair was served under — which is then PERSISTED on the row, so
 * the stored grade is interpretable on its own. Insert-once under the
 * `(run, pair)` unique via `onConflictDoNothing`: a duplicate is a loud
 * `grade_conflict`, never a silent averaging of two opinions. Null when the run
 * — or the named pair — does not exist for this owner.
 *
 * **The run's status is re-settled after a successful insert, and returned.**
 * Grading is one of exactly two writes that can complete a run — the other is a
 * verdict — because `complete` needs full verdict coverage AND every reviewable
 * pair graded. Without this, a run whose slots were all ruled early (through the
 * explicit override) stayed in `review` after its final grade landed, and only
 * an unrelated later verdict write would notice. Status is derived at WRITE
 * time in this module; a write that changes one of its inputs has to settle it.
 *
 * A grade is accepted on a `complete` run, deliberately and narrowly: the pair
 * must ALREADY exist, since pairs are derived from rendered cells and a complete
 * run has none left to settle. No NEW pair can appear on one either — with the
 * degraded-evidence gates, evidence can only be LOST after completion, and
 * losing it blocks a future completion rather than manufacturing a pair. So this
 * path is for a slot that was legitimately gradable all along, and the re-settle
 * keeps the status consistent with the evidence either way.
 */
export async function submitTrialPairGrade(input: SubmitTrialPairGradeInput): Promise<SubmitTrialPairGradeResult | null> {
  const { runId, ownerId, request, sink } = input;
  const run = await ownedTrialRun(runId, ownerId);
  if (!run) return null;
  const { pairable } = reviewableTrialCells(await trialCellRows(runId), sink);
  const pair = pairTrialCells(pairable).find((candidate) => candidate.pairId === request.pairId);
  if (!pair) return null;

  const leftIsA = trialPairLeftIsA(runId, pair.pairId);
  const grade = unblindTrialPairGrade(
    {
      grades: request.grades,
      catastrophicLeft: request.catastrophicLeft,
      catastrophicRight: request.catastrophicRight,
      notes: request.notes,
    },
    leftIsA,
  );
  const inserted = await db()
    .insert(imageIdentityPackTrialGrades)
    .values({
      runId,
      pairId: pair.pairId,
      cellAId: pair.cellAId,
      cellBId: pair.cellBId,
      leftIsA,
      gradesJson: grade,
      reviewedByUserId: ownerId,
    })
    .onConflictDoNothing({ target: [imageIdentityPackTrialGrades.runId, imageIdentityPackTrialGrades.pairId] })
    .returning({ id: imageIdentityPackTrialGrades.id });
  if (inserted.length === 0) {
    return {
      ok: false,
      refusal: refusal("grade_conflict", "this pair already has a grade", sink, { runId, pairId: pair.pairId }),
    };
  }
  const runStatus = await settleTrialRunStatus(runId, run.status, false, sink);
  return { ok: true, leftIsA, runStatus };
}

/* ------------------------------------------------------------------------ *
 * Summary and verdicts                                                      *
 * ------------------------------------------------------------------------ */

/**
 * The unblinded aggregates, every rendered (profile, strategy) combination, and
 * the verdicts recorded so far. Null when the run is not this owner's.
 * Unblinding happened at submission — the stored grades are already in
 * canonical A/B space — so this is a read: pairs from the rendered cells,
 * grades from the rows, math from the pure lib. `renderedCombos` rides along
 * because it is the verdict-slot list: comparisons alone cannot carry a
 * strategy whose counterpart cells all failed.
 *
 * `degradedCells` rides along for the mirror-image reason: it is the ONLY signal
 * on this wire for evidence that has been LOST. Everything else here counts what
 * survives, so a run whose degradation deleted the affected pair outright reads
 * as fully graded — exactly when {@link recordTrialVerdict} will refuse it
 * `review_incomplete`. The client needs the number to offer the override the
 * server is about to demand.
 */
export async function identityPackTrialSummary(
  runId: string,
  ownerId: string,
  sink?: DiagnosticSink,
): Promise<ImageIdentityPackTrialSummaryWire | null> {
  const run = await ownedTrialRun(runId, ownerId);
  if (!run) return null;
  const rows = await trialCellRows(runId);
  const { pairable, degraded } = reviewableTrialCells(rows, sink);
  const pairs: TrialCellPair[] = pairTrialCells(pairable);

  const gradeRows = await db()
    .select()
    .from(imageIdentityPackTrialGrades)
    .where(eq(imageIdentityPackTrialGrades.runId, runId));
  const grades: TrialGradeRecord[] = [];
  for (const row of gradeRows) {
    const grade = readJsonColumn(trialPairGradeSchema, row.gradesJson, sink, GRADES_JSON_PATH).value;
    if (grade) grades.push({ pairId: row.pairId, grade });
  }

  return {
    comparisons: aggregateTrialGrades(pairs, grades),
    // Only the NAMEABLE combos ride the wire. A rendered row whose spec no longer
    // parses has no slot to offer — it is counted where it matters (it blocks
    // completion, `verdictsCoverRenderedCombos`) rather than fabricated into a
    // verdict slot the reviewer could not act on.
    renderedCombos: withComboPairCounts(
      renderedTrialCombos(rows, sink).combos,
      pairs,
      new Set(grades.map((record) => record.pairId)),
    ),
    verdicts: await readTrialVerdicts(runId),
    // THE SAME NUMBER the verdict gate refuses on — `reviewableTrialCells`'
    // `degraded`, read from the same call that produced the pairs above, not
    // re-derived. Two derivations of "is this run's evidence intact?" would be
    // free to disagree, and the disagreement would surface as the UI insisting
    // review is complete while the server refuses the ruling.
    //
    // It also covers `renderedTrialCombos`' own degraded count, which completion
    // consults separately ({@link verdictsCoverRenderedCombos}): that one counts
    // rendered rows with an UNREADABLE SPEC, a strict subset of the rows counted
    // here (unreadable spec OR missing output image). So zero here is zero there,
    // and one number is the honest wire shape for one condition.
    degradedCells: degraded,
  };
}

/**
 * Attach each verdict slot's pairwise evidence: how many pairs it takes part in
 * on either side, and how many of those are graded.
 *
 * A slot showing 0 of 0 is the case worth surfacing — a strategy that rendered
 * but whose every counterpart cell failed has no comparative evidence at all,
 * and the reviewer must see that BEFORE promoting it. An empty comparison list
 * beside a populated verdict list does not say which slot is unsupported.
 */
function withComboPairCounts(
  combos: readonly RenderedComboTally[],
  pairs: readonly TrialCellPair[],
  gradedPairIdSet: ReadonlySet<string>,
): TrialRenderedCombo[] {
  return combos.map((combo): TrialRenderedCombo => {
    const involved = pairs.filter(
      (pair) =>
        pair.profileId === combo.profileId &&
        (pair.strategyA === combo.identityStrategy || pair.strategyB === combo.identityStrategy),
    );
    return {
      ...combo,
      totalPairs: involved.length,
      gradedPairs: involved.filter((pair) => gradedPairIdSet.has(pair.pairId)).length,
    };
  });
}

export interface RecordTrialVerdictInput {
  runId: string;
  ownerId: string;
  profileId: string;
  identityStrategy: IdentityReferenceStrategy;
  verdict: TrialVerdictValue;
  reason: string;
  /**
   * Rule anyway, with reviewable pairs still ungraded. An EXPLICIT, RECORDED
   * admin decision, never a silent bypass: without it the ruling is refused
   * `review_incomplete`, and with it the flag is persisted on the row so a
   * promotion made on partial evidence stays distinguishable from one made on
   * all of it. It cannot override the other two gates — a run still executing
   * has evidence in flight, and an unknown combo is a typo, not a judgment call.
   */
  overrideIncompleteReview?: boolean;
  sink?: DiagnosticSink;
}

export type RecordTrialVerdictResult =
  | { ok: true; runStatus: TrialRunStatus; verdicts: TrialVerdict[] }
  | { ok: false; refusal: IdentityPackTrialRefusal };

/**
 * Every (profile, strategy) any cell of the run carries, regardless of status.
 * Null-strategy cells contribute nothing: the no-pack baseline is not a verdict
 * slot, so a verdict naming it would have no combo to match.
 */
function runCellCombos(rows: readonly IdentityPackTrialCellRow[]): Set<string> {
  const combos = new Set<string>();
  for (const row of rows) {
    const parsed = trialCellComboSchema.safeParse(row.specJson);
    if (!parsed.success || parsed.data.identityStrategy === null) continue;
    combos.add(verdictComboKey(parsed.data.profileId, parsed.data.identityStrategy));
  }
  return combos;
}

/**
 * Why this run is in no position to be ruled on, or null when it is.
 *
 * Two separate things are being asserted, and both matter. A cell still
 * `planned` or `running` means evidence is in flight — a ruling recorded now
 * would be a judgment on a grid that is still growing, and the `running` half
 * is the sharper case: those renders may already have been PAID for, so their
 * outputs are coming. And a run that has not reached `review` has nothing to
 * rule on at all, whatever its cell counts say.
 *
 * `complete` is deliberately allowed: revising a ruling after the fact is the
 * upsert path, and a trial whose verdict can never be corrected is a trial
 * whose first mistake is permanent.
 */
function trialRunPositionBlocker(status: TrialRunStatus, counts: TrialCellCounts): string | null {
  const unexecuted = counts.planned + counts.running;
  if (unexecuted > 0) {
    return `the run is still executing: ${counts.planned} planned, ${counts.running} running cell(s) remain`;
  }
  switch (status) {
    case "draft":
      return "the run is in draft: nothing has been rendered to review";
    case "running":
      return "the run has not settled out of execution yet";
    case "review":
    case "complete":
      return null;
  }
}

/**
 * Upsert one (profile, strategy) verdict — the actor, reason and clock stamped
 * here, the policy version being the one in force — then settle the run's
 * status: when every combination present in the rendered cells is ruled AND
 * every reviewable pair is graded, `review` becomes `complete` with no separate
 * close action. Null when the run is not this owner's.
 *
 * Three gates, in this order, each refusing rather than storing:
 *
 * 1. **Position** ({@link trialRunPositionBlocker}) — `review_incomplete` while
 *    the run is in draft or has cells still planned or running.
 * 2. **Combo** — `verdict_unknown_combo` for a (profile, strategy) no cell of
 *    the run carries. A typo'd profile id would otherwise record a verdict
 *    nothing can surface, and enough of them would push the summary past its
 *    64-verdict wire cap.
 * 3. **Evidence** — `review_incomplete` while reviewable pairs are ungraded OR
 *    any rendered cell's evidence has been lost, unless the caller passes
 *    `overrideIncompleteReview`. This is the gate the whole blinded procedure
 *    exists to enforce: a ruling recorded over unseen comparisons is exactly the
 *    failure mode the grades were collected to prevent, and a ruling recorded
 *    over comparisons that no longer EXIST is the same failure wearing a full
 *    grade count. The override is honored, and RECORDED on the row.
 *
 * The write itself is a single-row upsert on `(run, profile, strategy)`, not a
 * rewrite of a verdict array. That is what makes two admins ruling on two
 * different slots at the same moment safe: each write touches only its own
 * ruling, so neither can erase the other.
 *
 * On ONE slot, though, the ledger is deliberately LAST-WRITE-WINS and keeps no
 * history. A revision replaces the whole row in place — verdict, reason, actor,
 * timestamp and override flag together — so the previous ruling is gone, not
 * superseded, and two admins ruling the same (profile, strategy) at the same
 * moment leave whichever landed last with no trace that the other happened. That
 * is the intended shape: this table answers "what is the current ruling on this
 * combination?", and the revision path exists precisely so a first mistake is not
 * permanent. A run needing an audit trail of who changed their mind and when
 * would need an append-only ledger, which this is not.
 */
export async function recordTrialVerdict(input: RecordTrialVerdictInput): Promise<RecordTrialVerdictResult | null> {
  const { runId, ownerId, sink } = input;
  const run = await ownedTrialRun(runId, ownerId);
  if (!run) return null;

  // Read the cells ONCE and share them across all three gates: re-reading
  // between gates would let a run change position underneath its own ruling.
  const rows = await trialCellRows(runId);

  const blocked = trialRunPositionBlocker(run.status, countTrialCells(rows));
  if (blocked !== null) {
    return {
      ok: false,
      refusal: refusal("review_incomplete", blocked, sink, { runId, runStatus: run.status }),
    };
  }

  if (!runCellCombos(rows).has(verdictComboKey(input.profileId, input.identityStrategy))) {
    return {
      ok: false,
      refusal: refusal(
        "verdict_unknown_combo",
        `no cell in this run tested profile ${input.profileId} under ${input.identityStrategy}`,
        sink,
        { runId, profileId: input.profileId, identityStrategy: input.identityStrategy },
      ),
    };
  }

  const { pairable, degraded } = reviewableTrialCells(rows, sink);
  const graded = await gradedPairIds(runId);
  const ungradedPairs = pairTrialCells(pairable).filter((pair) => !graded.has(pair.pairId)).length;
  const overrideRequested = input.overrideIncompleteReview === true;
  // Two ways the evidence can be short of complete, and they are the same fact
  // to a ruling: a pair nobody has graded, and a rendered cell whose image or
  // spec has vanished (taking its pairs with it, so "0 ungraded" would otherwise
  // read as full evidence precisely when there is less of it).
  //
  // `degraded` here and the summary wire's `degradedCells` are the SAME number
  // from the SAME derivation ({@link identityPackTrialSummary}) — deliberately,
  // because the client decides whether to offer the override from the wire and
  // this decides whether to demand it. A second derivation on either side would
  // let the UI report a complete review over evidence this gate refuses.
  const incompleteEvidence: string[] = [];
  if (ungradedPairs > 0) incompleteEvidence.push(`${ungradedPairs} reviewable pair(s) are still ungraded`);
  if (degraded > 0) incompleteEvidence.push(`${degraded} rendered cell(s) no longer carry reviewable evidence`);
  if (incompleteEvidence.length > 0 && !overrideRequested) {
    return {
      ok: false,
      refusal: refusal(
        "review_incomplete",
        `${incompleteEvidence.join("; ")} — complete the evidence or rule with an explicit override`,
        sink,
        { runId, ungradedPairs, degradedCells: degraded },
      ),
    };
  }

  // True only when the override actually carried the ruling past missing
  // evidence. Stamping it on a fully graded run would claim the evidence was
  // incomplete when it was not — a fabricated fact in the one field that exists
  // to keep partial-evidence promotions honest.
  const overrodeIncompleteReview = overrideRequested && incompleteEvidence.length > 0;
  const decidedAt = new Date();
  await db()
    .insert(imageIdentityPackTrialVerdicts)
    .values({
      id: newId(),
      runId,
      profileId: input.profileId,
      identityStrategy: input.identityStrategy,
      verdict: input.verdict,
      reason: input.reason,
      policyVersion: IDENTITY_PACK_POLICY_VERSION,
      overrideIncompleteReview: overrodeIncompleteReview,
      decidedByUserId: ownerId,
      decidedAt,
    })
    .onConflictDoUpdate({
      target: [
        imageIdentityPackTrialVerdicts.runId,
        imageIdentityPackTrialVerdicts.profileId,
        imageIdentityPackTrialVerdicts.identityStrategy,
      ],
      // A revision replaces the whole ruling, `updatedAt` included — drizzle's
      // `$onUpdate` fires for `.update()`, never for a conflict arm, so a
      // timestamp left implicit here would freeze at the original insert.
      set: {
        verdict: input.verdict,
        reason: input.reason,
        policyVersion: IDENTITY_PACK_POLICY_VERSION,
        overrideIncompleteReview: overrodeIncompleteReview,
        decidedByUserId: ownerId,
        decidedAt,
        updatedAt: new Date(),
      },
    });

  const runStatus = await settleTrialRunStatus(runId, run.status, false, sink);
  return { ok: true, runStatus, verdicts: await readTrialVerdicts(runId) };
}
