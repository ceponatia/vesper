import { and, asc, count, eq, inArray, lt } from "drizzle-orm";
import {
  compareTrialCellKeys,
  type ImageIdentityPackTrialCellSpec,
  imageIdentityPackTrialDiagnosticCode,
  MAX_TRIAL_PREDICTION_MS,
  type TrialRunStatus,
} from "@vesper/image-core";
import { OUTPUT_TIMEOUT_MS, REQUEST_TIMEOUT_MS } from "@vesper/image-replicate";
import { diag, type DiagnosticSink } from "@/contracts/diagnostics";
import { newId } from "@/lib/ids";
import { db, imageIdentityPackTrialCells } from "../db";
// Direct module path for the reason `./identity-pack-ensure.ts` records on ITS
// import of this file: the `@/server/engine` barrel re-exports
// `chat-pipeline.ts`, which imports `@/server/images` — naming the barrel here
// would close a real import cycle. `keyed-lock.ts` itself imports nothing.
import { tryKeyedLock } from "../engine/keyed-lock";
import { loadImageModels } from "./models";
import { loadImageModelProfiles } from "./model-profiles";
import {
  type ExecuteCellContext,
  executeTrialCellContained,
  readRunnableTrialSpec,
  refuseTrialCell,
  trialRenderer,
} from "./identity-pack-trial-render";
import {
  type ExecutedTrialCell,
  type IdentityPackTrialCellRow,
  identityPackTrialLockKey,
  type IdentityPackTrialRefusal,
  ownedTrialRun,
  refusal,
  settleTrialRunStatus,
} from "./identity-pack-trial-store";

/**
 * Execution: the bounded pass — claim cells durably, charge the budget for
 * exactly what was claimed, drain the queue with a heartbeat, settle the run.
 *
 * One cell's render lives in `./identity-pack-trial-render.ts`; this module owns
 * the batch, the claims and the money.
 */

/* ------------------------------------------------------------------------ *
 * Execution                                                                 *
 * ------------------------------------------------------------------------ */

/** Default and ceiling for one execute pass — the wire schema's numbers. */
const EXECUTE_DEFAULT_MAX_RENDERS = 5;
const EXECUTE_MAX_RENDERS_CAP = 20;


/**
 * How long a claim may sit before a later pass may take it back.
 *
 * It must EXCEED the longest ONE CELL SPAN can legitimately take — a render plus
 * its settle — and NOT the longest a queued cell can wait, because
 * {@link beatTrialQueueClaims} re-stamps `claimed_at` on the pass's WHOLE
 * REMAINING QUEUE at every cell boundary. A queued claim is therefore never
 * older than the cell currently in flight, whatever its position in a 20-cell
 * batch; without that heartbeat this window would have to cover an entire batch,
 * and a 20-render pass would age its own tail claims into recovery while they
 * queued — while it was still alive, still rendering, and about to pay for them.
 *
 * Derived rather than guessed, from the four things that actually elapse:
 *
 *     900_000  the prediction budget ceiling (MAX_TRIAL_PREDICTION_MS, itself
 *              `imageModelProfileSchema.timeoutMs`'s `.max(900_000)` bound, and
 *              what Replicate's own `Cancel-After` carries)
 *   + 300_000  4 × REQUEST_TIMEOUT_MS — three reference uploads plus the poll GET
 *              that observes the settled prediction
 *   +  60_000  OUTPUT_TIMEOUT_MS — downloading the produced image
 *   + 300_000  margin for the rest of one cell span — storing the output, the
 *              settle write, the next cell's pack resolution and reference
 *              reads — plus retries and clock skew between two machines
 *   ---------
 *   1_560_000  (26 minutes)
 *
 * Recovering too early hands a live render to a second worker and pays twice;
 * never recovering wedges a run short of `review` forever. Sizing it off the
 * real bounds is what keeps that trade an engineering decision rather than a
 * number that silently stopped covering the thing it was chosen for.
 */
export const STALE_CLAIM_MS = MAX_TRIAL_PREDICTION_MS + 4 * REQUEST_TIMEOUT_MS + OUTPUT_TIMEOUT_MS + 5 * 60_000;

export interface ExecuteIdentityPackTrialCellsInput<TReject> {
  runId: string;
  ownerId: string;
  /** Clamped to the wire schema's 1–20; defaults to 5. */
  maxRenders?: number;
  /**
   * Charge the daily render budget for exactly `count` cells; `null` means the
   * charge succeeded. Called INSIDE the run lock, after this pass has picked
   * its planned cells and can no longer be refused `run_locked` — so a refused
   * pass never leaves charged units behind. Never called with 0. A non-null
   * rejection is returned to the caller uninterpreted (`budgetRejected`); the
   * route's rejection is already the house 429/503 response.
   */
  chargeBudget: (count: number) => Promise<TReject | null>;
  sink?: DiagnosticSink;
}


export type ExecuteIdentityPackTrialCellsResult<TReject> =
  | { ok: true; executed: ExecutedTrialCell[]; remainingPlanned: number; runStatus: TrialRunStatus }
  | { ok: false; refusal: IdentityPackTrialRefusal }
  | { ok: false; budgetRejected: TReject };

/**
 * Run up to `maxRenders` planned cells.
 *
 * TWO layers guard against paying twice for one cell's evidence, and they guard
 * different things:
 *
 * - The keyed lock is the SAME-PROCESS double-click guard. A second caller meets
 *   `run_locked` instead of queueing, because a second click while a pass is
 *   rendering means the operator cannot see the first pass yet, and stacking
 *   passes would spend budget nobody asked for. It is in-memory and dies with
 *   the process, which is exactly why it is not the correctness layer.
 * - The DURABLE CLAIM inside the pass is the cross-process one. Cells move to
 *   `running` with a token in the database BEFORE the provider is called, so a
 *   second machine — or this machine after a restart — sees the claim rather
 *   than a `planned` cell it is free to re-render. The claim is taken for the
 *   whole batch at once and RE-ASSERTED over the whole remaining queue at every
 *   cell boundary, which is what keeps a lost race free (no provider call) and
 *   keeps a queued cell from aging past the stale window while cells ahead of it
 *   render — the claims of a LIVE pass are never older than its current cell.
 *
 * Null when the run is not this owner's.
 *
 * Cells settle in `cellKey` order — deterministic, so "run 5 more" walks the
 * grid the same way every time, and comparison-group-adjacent, because that key
 * layout puts one comparison's arms next to each other. A `failed` cell stays
 * failed: a rerun is a new run, never a silent retry of a cell whose evidence
 * already exists.
 */
export async function executeIdentityPackTrialCells<TReject>(
  input: ExecuteIdentityPackTrialCellsInput<TReject>,
): Promise<ExecuteIdentityPackTrialCellsResult<TReject> | null> {
  const { runId, ownerId, sink } = input;
  const run = await ownedTrialRun(runId, ownerId);
  if (!run) return null;

  const held = tryKeyedLock(identityPackTrialLockKey(runId), () => runTrialExecutionPass(input), "trial_execute");
  if (held === null) {
    return {
      ok: false,
      refusal: refusal("run_locked", "another execution pass holds this run", sink, { runId }),
    };
  }
  return held;
}

/**
 * The post-lock pass, exposed so a test can race TWO of them against one run.
 *
 * Production always enters through {@link executeIdentityPackTrialCells}; this
 * door exists because the in-process lock would serialize the very contention
 * the durable claim exists to survive, and a concurrency guarantee nothing can
 * exercise is a guarantee nobody knows is broken.
 */
export function runTrialExecutionPassForTesting<TReject>(
  input: ExecuteIdentityPackTrialCellsInput<TReject>,
): Promise<ExecuteIdentityPackTrialCellsResult<TReject> | null> {
  return runTrialExecutionPass(input);
}

async function runTrialExecutionPass<TReject>(
  input: ExecuteIdentityPackTrialCellsInput<TReject>,
): Promise<ExecuteIdentityPackTrialCellsResult<TReject> | null> {
  const { runId, ownerId, sink } = input;
  // Re-read under the lock: the pre-lock row may predate another pass's settle.
  const run = await ownedTrialRun(runId, ownerId);
  if (!run) return null;
  const maxRenders = Math.min(
    Math.max(1, Math.floor(input.maxRenders ?? EXECUTE_DEFAULT_MAX_RENDERS)),
    EXECUTE_MAX_RENDERS_CAP,
  );

  await recoverStaleTrialClaims(runId, sink);

  // Comparison-group-adjacent by construction: `cellKey` is
  // `character:profile:fixture:strategy:variant`, so plain ascending order runs
  // every arm of one comparison back to back. Nothing seeds the provider, so
  // renders drift with whatever the model was doing between them; adjacency is
  // the only lever the harness has to keep that drift SHARED by a group rather
  // than becoming the difference being measured.
  const picked = await db()
    .select({ id: imageIdentityPackTrialCells.id })
    .from(imageIdentityPackTrialCells)
    .where(and(eq(imageIdentityPackTrialCells.runId, runId), eq(imageIdentityPackTrialCells.status, "planned")))
    .orderBy(asc(imageIdentityPackTrialCells.cellKey))
    .limit(maxRenders);

  const claimToken = newId();
  const claimed: IdentityPackTrialCellRow[] =
    picked.length === 0 ? [] : await claimTrialCells(runId, picked.map((row) => row.id), claimToken);
  // Re-sorted after the claim: `UPDATE … RETURNING` hands rows back in whatever
  // order it touched them, and the group adjacency the key layout buys is worth
  // nothing if the execution loop then walks the claims in storage order.
  claimed.sort((a, b) => compareTrialCellKeys(a.cellKey, b.cellKey));

  const [models, profiles] = await Promise.all([loadImageModels(sink), loadImageModelProfiles(sink)]);
  const context: ExecuteCellContext = {
    runId,
    ownerId,
    claimToken,
    modelsBySlug: new Map(models.map((model) => [model.slug, model])),
    profilesById: new Map(profiles.map((profile) => [profile.id, profile])),
    render: trialRenderer(),
    sink,
  };

  // A row this pass picked but did not claim was taken by another machine
  // between the select and the update. That is the durable claim working, not an
  // error: proceed with what this pass actually holds.
  //
  // Every claimed cell is settled or admitted HERE, before the charge, and both
  // gates are free. A malformed spec is one; a spec that parses but names a
  // fixture, model or profile that no longer exists is the other, and it is the
  // registry maps loaded just above that make it answerable this early. A cell
  // that cannot reach a provider must never be billed for the attempt — the
  // post-charge re-checks in `executeOneTrialCell` still run, because a row can
  // vanish between these two moments, but a run left stale by a deleted profile
  // no longer burns a budget unit per cell per pass to rediscover it.
  const executed: ExecutedTrialCell[] = [];
  const valid: ClaimedTrialCell[] = [];
  for (const cell of claimed) {
    const read = readRunnableTrialSpec(cell, context);
    if (read.ok) {
      valid.push({ cell, spec: read.spec });
      continue;
    }
    const status = await refuseTrialCell(cell, context, read.code, read.message);
    executed.push({ cellId: cell.id, cellKey: cell.cellKey, status });
  }

  // Charge for exactly the cells this pass will attempt, and only once they are
  // claimed: a pass with nothing to run costs nothing (reviewing a finished grid
  // must keep working after the daily budget is spent), and an unrunnable cell —
  // settled terminally above, never sent anywhere — is never billed. Charged
  // slots are a reservation: a cell that then conflicts or fails mid-batch does
  // not refund its unit, deliberately, because the pass was admitted at this size.
  if (valid.length > 0) {
    const claimedIds = valid.map((entry) => entry.cell.id);
    let rejected: TReject | null;
    try {
      rejected = await input.chargeBudget(claimedIds.length);
    } catch (error) {
      // A guard that THREW decided nothing, and its claims are as unspent as a
      // refusal's. Leaving them `running` would wedge the grid for the whole
      // stale window over a fault that never touched a provider, so they go back
      // before the throw continues to the caller.
      await releaseTrialClaims(claimedIds, claimToken);
      throw error;
    }
    if (rejected !== null) {
      // Hand the claims back immediately. A refused pass that left its cells
      // `running` would wedge them until the stale window elapsed, turning a
      // budget refusal into half an hour of a frozen grid.
      await releaseTrialClaims(claimedIds, claimToken);
      sink?.push(
        diag("warn", imageIdentityPackTrialDiagnosticCode("budget_refused"), "the render budget refused this pass", {
          context: { runId, cells: claimedIds.length },
        }),
      );
      return { ok: false, budgetRejected: rejected };
    }
  }

  // The execution queue, drained head-first with a WHOLE-QUEUE heartbeat at
  // every cell boundary ({@link beatTrialQueueClaims}). The queue is a mutable
  // list rather than an index walk because the heartbeat can remove entries: a
  // cell whose claim was taken over while it waited is dropped here and settled
  // by nobody, since another worker now owns it.
  let queue = valid;
  while (queue.length > 0) {
    const held = await beatTrialQueueClaims(queue, context);
    const holding: ClaimedTrialCell[] = [];
    for (const entry of queue) {
      if (held.has(entry.cell.id)) {
        holding.push(entry);
        continue;
      }
      // Zero provider calls for it, and no settle either — the row belongs to
      // whoever took it, and writing an outcome onto it would overwrite theirs.
      executed.push({ cellId: entry.cell.id, cellKey: entry.cell.cellKey, status: "skipped" });
    }
    queue = holding;
    const head = queue.shift();
    // Even the head lost its claim, so this pass holds nothing at all.
    if (head === undefined) break;

    const status = await executeTrialCellContained(head.cell, head.spec, context);
    if (status === null) {
      // The containment settle itself failed, so this pass stops. The cells it
      // has not REACHED were charged but never sent anywhere, and returning an
      // untouched claim costs nothing — so they go back to `planned` rather than
      // waiting out the stale window. Their charge stays spent: a charged slot is
      // a reservation for a pass admitted at that size, exactly as for a cell that
      // conflicted mid-batch.
      await releaseTrialClaims(queue.map((remaining) => remaining.cell.id), claimToken);
      break;
    }
    executed.push({ cellId: head.cell.id, cellKey: head.cell.cellKey, status });
  }

  const runStatus = await settleTrialRunStatus(runId, run.status, true, sink);
  const [remaining] = await db()
    .select({ planned: count() })
    .from(imageIdentityPackTrialCells)
    .where(and(eq(imageIdentityPackTrialCells.runId, runId), eq(imageIdentityPackTrialCells.status, "planned")));
  return { ok: true, executed, remainingPlanned: remaining?.planned ?? 0, runStatus };
}

/** A cell this pass holds, with its spec already parsed once at the boundary. */
interface ClaimedTrialCell {
  cell: IdentityPackTrialCellRow;
  spec: ImageIdentityPackTrialCellSpec;
}

/**
 * Take the picked cells by compare-and-set from `planned` to `running`, stamping
 * this pass's token and the clock.
 *
 * The returned rows are the ones this pass owns — fewer than were picked means
 * another writer won those, which is the whole point. Nothing is rendered before
 * this write lands, so a crash between claim and provider call costs a cell's
 * evidence but never a double charge.
 *
 * The clock stamped here dates the CLAIM, and it is the only stamp a cell would
 * ever carry if nothing re-stamped it — which is why {@link beatTrialQueueClaims}
 * re-stamps the pass's whole remaining queue at every cell boundary. A batch's
 * last cell may sit here for the length of nineteen renders, and none of that
 * waiting is evidence the worker died.
 */
async function claimTrialCells(
  runId: string,
  cellIds: readonly string[],
  claimToken: string,
): Promise<IdentityPackTrialCellRow[]> {
  return db()
    .update(imageIdentityPackTrialCells)
    .set({ status: "running", claimToken, claimedAt: new Date() })
    .where(
      and(
        eq(imageIdentityPackTrialCells.runId, runId),
        inArray(imageIdentityPackTrialCells.id, [...cellIds]),
        eq(imageIdentityPackTrialCells.status, "planned"),
      ),
    )
    .returning();
}

/**
 * Hand claims back to `planned`, token-guarded so a pass can only release its
 * OWN.
 *
 * Every caller shares one precondition: the cells being released were NEVER
 * SENT ANYWHERE. That is what makes returning them free of the double-pay risk
 * recovery carries — there is no in-flight render to collide with. Three cases
 * qualify: a budget guard that refused, a budget guard that threw, and the cells
 * a pass never reached because its containment settle failed. A cell whose
 * provider call has begun is never released; it settles, or it goes stale.
 */
async function releaseTrialClaims(cellIds: readonly string[], claimToken: string): Promise<void> {
  if (cellIds.length === 0) return;
  await db()
    .update(imageIdentityPackTrialCells)
    .set({ status: "planned", claimToken: null, claimedAt: null })
    .where(
      and(
        inArray(imageIdentityPackTrialCells.id, [...cellIds]),
        eq(imageIdentityPackTrialCells.status, "running"),
        eq(imageIdentityPackTrialCells.claimToken, claimToken),
      ),
    );
}

/**
 * Re-stamp this pass's claim on the WHOLE REMAINING QUEUE — the cell about to
 * render and every cell still waiting behind it — and report which ids the pass
 * still holds.
 *
 * Called at every cell boundary, and that scope is the correctness property.
 * The pass claims and charges its whole batch up front, so a per-cell heartbeat
 * left cell 10's `claimed_at` dated at batch start while cells 1–9 rendered: it
 * could age past {@link STALE_CLAIM_MS} purely by QUEUE POSITION, be recovered by
 * another worker, and be paid for twice while this pass was perfectly alive. With
 * the queue-wide beat, a queued claim's age is bounded by ONE cell span (the
 * previous render plus its settle), which the stale window already exceeds with
 * margin — so staleness measures pass DEATH, never queue depth.
 *
 * Two further jobs, both about money:
 *
 * - **The head cell must be in the returned set to render.** The compare-and-set
 *   is the same one every settle uses, so a claim already taken over costs ZERO
 *   provider calls instead of one paid render whose settle then loses and has to
 *   delete the image it just bought. Only the head's own pre-render reads — its
 *   pack resolution and reference bytes — separate this beat from the spend, and
 *   a claim lost inside that gap is caught at the settle as it always was.
 * - **A queued cell that lost its claim is dropped, not settled.** Another worker
 *   owns that row now; writing an outcome onto it would overwrite theirs.
 *
 * Every cell whose claim is gone gets its own warn, because a live pass losing
 * claims is either a second worker racing it or a stale recovery that fired too
 * early — both worth seeing.
 */
async function beatTrialQueueClaims(
  queue: readonly ClaimedTrialCell[],
  context: ExecuteCellContext,
): Promise<Set<string>> {
  const beat = await db()
    .update(imageIdentityPackTrialCells)
    .set({ claimedAt: new Date() })
    .where(
      and(
        eq(imageIdentityPackTrialCells.runId, context.runId),
        inArray(imageIdentityPackTrialCells.id, queue.map((entry) => entry.cell.id)),
        eq(imageIdentityPackTrialCells.status, "running"),
        eq(imageIdentityPackTrialCells.claimToken, context.claimToken),
      ),
    )
    .returning({ id: imageIdentityPackTrialCells.id });
  const held = new Set(beat.map((row) => row.id));
  for (const entry of queue) {
    if (held.has(entry.cell.id)) continue;
    context.sink?.push(
      diag("warn", "images.identity_pack.trial.cell_degraded", "the claim was taken over before the render started", {
        context: { runId: context.runId, cellId: entry.cell.id, cellKey: entry.cell.cellKey },
      }),
    );
  }
  return held;
}

/**
 * Return claims abandoned by a dead worker to the grid.
 *
 * The trade this makes is real and worth stating: a claim older than
 * {@link STALE_CLAIM_MS} MIGHT belong to a render that was paid for and whose
 * result was lost with the process that started it. Recovering it can therefore
 * pay a second time. The alternative is worse — a cell stuck `running` forever
 * wedges its run short of `review` and can never be graded or ruled on — so
 * recovery happens, on a clock long enough that no live render can be inside it,
 * and loudly enough that an operator sees it happened.
 *
 * `claimed_at` is a HEARTBEAT, not a queue timestamp: {@link beatTrialQueueClaims}
 * re-stamps it on the owning pass's WHOLE REMAINING QUEUE at every cell boundary,
 * so what this cutoff measures is "how long has the pass holding this cell been
 * silent", not "how long since that pass started". That distinction is what lets
 * the window be sized against one cell span (see {@link STALE_CLAIM_MS}) instead
 * of against a full 20-cell batch, and it is why a cell waiting its turn behind
 * nineteen others cannot age itself into recovery while the pass holding it is
 * perfectly alive.
 *
 * A `running` row with NO `claimed_at` is deliberately not recovered: it records
 * a claim nothing can date, and resetting an undateable claim on sight is
 * exactly the double-pay these columns exist to prevent.
 */
async function recoverStaleTrialClaims(runId: string, sink: DiagnosticSink | undefined): Promise<void> {
  const cutoff = new Date(Date.now() - STALE_CLAIM_MS);
  const recovered = await db()
    .update(imageIdentityPackTrialCells)
    .set({ status: "planned", claimToken: null, claimedAt: null })
    .where(
      and(
        eq(imageIdentityPackTrialCells.runId, runId),
        eq(imageIdentityPackTrialCells.status, "running"),
        lt(imageIdentityPackTrialCells.claimedAt, cutoff),
      ),
    )
    .returning({ cellKey: imageIdentityPackTrialCells.cellKey });
  if (recovered.length === 0) return;
  sink?.push(
    diag("warn", "images.identity_pack.trial.claim_recovered", "recovered execution claims left behind by a dead pass", {
      context: { runId, cells: recovered.length, cellKeys: recovered.map((row) => row.cellKey).slice(0, 10) },
    }),
  );
}
