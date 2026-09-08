import { describe, expect, it } from "vitest";
import { allReferenceViews } from "@/contracts";
import { runReferenceViewBuilds } from "./reference-view-build";

/**
 * **One admitted batch renders all at once.**
 *
 * The build used to walk its target list with two workers on a shared cursor,
 * so an eight-view sheet reached the provider in four waves and the owner
 * watched a grid fill two tiles at a time. Nothing about spend was being
 * protected — the daily image budget, backpressure and the per-user job cap all
 * decide that upstream, and the batch is admitted and charged once before this
 * function is reached — so the only thing the throttle bought was latency.
 *
 * Three claims, all invisible in a passing render and cheap to lose again:
 *
 * 1. **Every target starts before any target settles.** The deferred builds
 *    below never resolve until the assertion has run, so a worker pool of any
 *    fixed width fails: it can only have its own width in flight. This is the
 *    concurrency proof the outcome asks for, stated against the fan-out rather
 *    than against a database.
 * 2. **Settlement stays per-slot.** A refusal — a moderated `bare` view is the
 *    expected instance — is one `false` among the results. It may not cancel,
 *    delay or miscount the targets beside it, because each one has already
 *    settled its own row.
 * 3. **A thrown defect fails only after sibling settlement.** Fulfilled workers
 *    must finish their finalization and lease release before the batch reports
 *    the rejection to its shared job.
 *
 * The build of a single view is not re-proven here; `buildOneReferenceView`
 * owns expected failures. The rejection case pins the batch cleanup boundary
 * when a defect breaches that never-throwing contract.
 */

/** A build that hangs until the test releases it, so "started" and "settled" are distinguishable. */
function deferred(): { promise: Promise<boolean>; resolve: (ok: boolean) => void; reject: (reason: unknown) => void } {
  let resolve: (ok: boolean) => void = () => undefined;
  let reject: (reason: unknown) => void = () => undefined;
  const promise = new Promise<boolean>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe("runReferenceViewBuilds", () => {
  it("starts every target before any of them settles, and counts what each one returned", async () => {
    const targets = allReferenceViews();
    const started: string[] = [];
    const pending: Array<ReturnType<typeof deferred>> = [];

    const run = runReferenceViewBuilds(targets, (target) => {
      started.push(`${target.angle}:${target.wardrobe}`);
      const gate = deferred();
      pending.push(gate);
      return gate.promise;
    });

    // Nothing has been allowed to finish yet: a two-worker cursor would show 2.
    expect(started).toHaveLength(targets.length);
    expect(new Set(started).size).toBe(targets.length);

    // The refusal lands first and alone. The rest are still in flight, which is
    // the failure mode worth pinning: one moderated view may not take the sheet.
    pending[0]?.resolve(false);
    for (const gate of pending.slice(1)) gate.resolve(true);

    await expect(run).resolves.toEqual({ built: targets.length - 1, failed: 1 });
  });

  it("waits for every worker to settle before propagating a rejection", async () => {
    const targets = allReferenceViews().slice(0, 2);
    const rejected = deferred();
    const sibling = deferred();
    const finalized: string[] = [];
    let call = 0;
    const failure = new Error("worker defect");

    const run = runReferenceViewBuilds(targets, () => {
      if (call++ === 0) return rejected.promise;
      return sibling.promise.then((ok) => {
        finalized.push("sibling");
        return ok;
      });
    });
    let propagated: unknown;
    const observed = run.then(
      () => "resolved" as const,
      (error: unknown) => { propagated = error; return "rejected" as const; },
    );
    const rejectionObserved = rejected.promise.catch(() => undefined);

    rejected.reject(failure);
    // Wait through the rejected worker and the batch's own reaction turn. A
    // fail-fast Promise.all has propagated by now; this batch must stay pending
    // because its sibling has not finalized yet.
    await rejectionObserved;
    await Promise.resolve();
    expect(propagated).toBeUndefined();
    expect(finalized).toEqual([]);

    sibling.resolve(true);
    await expect(observed).resolves.toBe("rejected");
    expect(finalized).toEqual(["sibling"]);
    expect(propagated).toBe(failure);
  });
});
