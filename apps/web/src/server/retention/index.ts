// Database retention: bounded deletes of rows whose own data says they have
// expired (old telemetry, finished jobs, expired auth rows). Runs on the image
// sweep's maintenance tick (`kickImageSweep` in `images/assets.ts`), which is
// the one request-driven periodic tick the app has; this module owns only the
// passes, never the scheduling.
import { log } from "@/server/log";
import type { RetentionPass } from "./pass";
import { jobsExpired } from "./jobs";

export { RETENTION_BATCH_SIZE, type RetentionPass } from "./pass";
export { JOB_RETENTION_DAYS, jobsExpired } from "./jobs";

/** Every pass the tick runs, in order. A new rule is one file here plus one entry. */
const PASSES: readonly RetentionPass[] = [jobsExpired];

/**
 * Run every retention pass once, each isolated: a failing pass is logged with
 * its diagnostic code and the rest still run, so one table's trouble never
 * blocks another's cleanup (docs/resilience.md — degraded defaults over failed
 * turns). Never throws. Returns `{ [pass.name]: rowsDeleted }` for the sweep's
 * summary; a failed pass reports 0.
 */
export async function runRetentionPasses(now: Date): Promise<Record<string, number>> {
  const summary: Record<string, number> = {};
  for (const pass of PASSES) {
    try {
      summary[pass.name] = await pass.run(now);
    } catch (err) {
      summary[pass.name] = 0;
      log.warn("retention", `retention pass ${pass.name} failed`, {
        code: "retention.pass_failed",
        pass: pass.name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return summary;
}
