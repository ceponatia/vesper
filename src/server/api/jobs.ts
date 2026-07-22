import { eq } from "drizzle-orm";
import { db, jobs } from "@/server/db";
import { log } from "@/server/log";
import { errorText } from "./respond";

type JobInsert = typeof jobs.$inferInsert;
export type ApiJobType = JobInsert["type"];

export interface StartJobOptions {
  type: ApiJobType;
  payload: Record<string, unknown>;
  /** Background work; its resolved value is merged into the job payload. */
  run: () => Promise<Record<string, unknown>>;
}

/**
 * Fire-and-forget job runner for library-side work (avatar, portrait_variant,
 * embed_refresh): inserts a running `jobs` row, kicks off the work, records
 * done/failed when it settles. The route returns the job id immediately; the
 * UI polls the affected rows (e.g. the image row status, docs/images.md).
 * Failures never propagate to the caller.
 */
export async function startJob(opts: StartJobOptions): Promise<string> {
  const [row] = await db()
    .insert(jobs)
    .values({
      type: opts.type,
      status: "running",
      payload: opts.payload,
      attempts: 1,
      startedAt: new Date(),
    })
    .returning({ id: jobs.id });
  if (!row) throw new Error("jobs insert returned no row");

  void opts
    .run()
    .then(async (result) => {
      await db()
        .update(jobs)
        .set({ status: "done", payload: { ...opts.payload, ...result }, finishedAt: new Date() })
        .where(eq(jobs.id, row.id));
    })
    .catch(async (err: unknown) => {
      const message = errorText(err).slice(0, 500);
      log.warn("api.jobs", `${opts.type} job failed`, { jobId: row.id, error: message });
      try {
        await db()
          .update(jobs)
          .set({ status: "failed", error: message, finishedAt: new Date() })
          .where(eq(jobs.id, row.id));
      } catch (updateErr) {
        log.error("api.jobs", "failed to record job failure", { jobId: row.id, error: errorText(updateErr) });
      }
    });

  return row.id;
}
