import { describe, expect, it } from "vitest";
import { MAX_JOB_ATTEMPTS } from "./constants";
import { jobExceedsAttemptCap } from "./jobs";

/**
 * Poison-job attempt cap (security Cluster I6). `jobs.attempts` increments
 * atomically on every claim, so the predicate sees the post-claim count; once it
 * exceeds MAX_JOB_ATTEMPTS the runner abandons the job instead of re-running it.
 * The boundary matters: a job on its MAX_JOB_ATTEMPTS-th run still executes (so a
 * transient failure gets its full retry budget), and only the run *past* the cap
 * is refused — the chokepoint that bounds re-execution however the row got
 * re-claimed (drain loop, detached run, or a recovery re-kick).
 */
describe("jobExceedsAttemptCap (poison-job guard)", () => {
  it("allows runs up to and including the cap", () => {
    expect(MAX_JOB_ATTEMPTS).toBe(3);
    expect(jobExceedsAttemptCap(0)).toBe(false);
    expect(jobExceedsAttemptCap(1)).toBe(false);
    expect(jobExceedsAttemptCap(MAX_JOB_ATTEMPTS)).toBe(false);
  });

  it("abandons the run past the cap", () => {
    expect(jobExceedsAttemptCap(MAX_JOB_ATTEMPTS + 1)).toBe(true);
    expect(jobExceedsAttemptCap(MAX_JOB_ATTEMPTS + 10)).toBe(true);
  });
});
