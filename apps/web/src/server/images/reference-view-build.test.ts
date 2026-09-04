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
 * Two claims, both invisible in a passing render and both cheap to lose again:
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
 *
 * The build of a single view is not re-proven here; `buildOneReferenceView`
 * owns that, and its never-throwing contract is what this fan-out relies on.
 */

/** A build that hangs until the test releases it, so "started" and "settled" are distinguishable. */
function deferred(): { promise: Promise<boolean>; resolve: (ok: boolean) => void } {
  let resolve: (ok: boolean) => void = () => undefined;
  const promise = new Promise<boolean>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
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
});
