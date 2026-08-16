/**
 * Pure economics helpers for the composer-model A/B.
 *
 * `answered` is a quality check; it is intentionally NOT the fallback trigger.
 * Production retries only when `generateChecked` returns `degraded: true`, so the
 * ladder economics must be calculated from that signal instead of from the grader.
 */

/** Share of primary compositions that would invoke the production fallback rung. */
export function fallbackInvocationRate(degradedRuns: number, totalRuns: number): number | null {
  if (!Number.isInteger(degradedRuns) || !Number.isInteger(totalRuns)) {
    throw new Error("fallback counts must be integers");
  }
  if (totalRuns < 0 || degradedRuns < 0 || degradedRuns > totalRuns) {
    throw new Error(`invalid fallback counts: ${degradedRuns}/${totalRuns}`);
  }
  if (totalRuns === 0) return null;
  return degradedRuns / totalRuns;
}

/**
 * Expected dollars per 1000 requested compositions for the two-rung ladder.
 *
 * The primary is always paid. The fallback is paid only on the measured degraded
 * fraction. A zero fallback rate therefore needs no fallback-cost measurement; a
 * positive rate with an unmeasured fallback cost is intentionally unknown.
 */
export function effectiveLadderCostPerThousand(
  primaryCostPerThousand: number | null,
  fallbackRate: number | null,
  fallbackCostPerThousand: number | null,
): number | null {
  if (primaryCostPerThousand === null || fallbackRate === null) return null;
  if (fallbackRate === 0) return primaryCostPerThousand;
  if (fallbackCostPerThousand === null) return null;
  return primaryCostPerThousand + fallbackRate * fallbackCostPerThousand;
}
