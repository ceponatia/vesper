import { eq } from "drizzle-orm";
import { db, jobs } from "@/server/db";
import { log } from "@/server/log";
import { errorText } from "./respond";
import { claimJobSlot, type JobSlotClaim } from "./concurrency";
import { recordProviderOutcome, type ProviderLane } from "./backpressure";
import type { ApiJobType } from "./job-types";

/**
 * Which provider lane a job's failure is evidence about (rate-limits.plan.md
 * slice 6). The job runner is the honest place to feed the circuit breaker: a
 * settled job is a real provider outcome, and it lives on the `@/server/api`
 * side of the boundary that forbids `@/server/ai` from importing back.
 *
 * Jobs that touch no provider map to null and report nothing — their failures say
 * something about this app, not about an upstream. That is `image_sweep` (file
 * reconciliation) and `identity_pack` (local decode/crop/measure/write).
 */
function providerLaneFor(type: ApiJobType): ProviderLane | null {
  switch (type) {
    case "avatar":
    case "portrait_variant":
    case "entity_image":
    case "scene_image":
    case "chat_scene_image":
    case "chat_look_image":
    case "chat_place_image":
      return "image";
    case "embed_refresh":
      return "embedding";
    case "post_turn":
    case "reconcile":
    case "inner_note":
    case "chat_summary":
    case "chat_scene_sketch":
    case "chat_meanwhile":
    case "item_classify":
      return "text";
    case "image_sweep":
    case "identity_pack":
      return null;
  }
}

export interface StartJobOptions {
  type: ApiJobType;
  /**
   * Who the work is for. The per-user concurrency cap counts over this, so a
   * call that omits it submits uncapped work — reserved for system and
   * engine-internal jobs that no request drives.
   */
  ownerId?: string;
  payload: Record<string, unknown>;
  /** Background work; its resolved value is merged into the job payload. */
  run: () => Promise<Record<string, unknown>>;
}

export type StartJobResult =
  | { readonly ok: true; readonly jobId: string }
  | { readonly ok: false; readonly active: number; readonly limit: number };

/** Returns the new job id, or the refusal to hand back to the caller. */
async function insertJobRow(opts: StartJobOptions): Promise<string | Extract<StartJobResult, { ok: false }>> {
  if (opts.ownerId !== undefined) {
    const claim: JobSlotClaim = await claimJobSlot({
      ownerId: opts.ownerId,
      type: opts.type,
      payload: opts.payload,
    });
    return claim.ok ? claim.jobId : { ok: false, active: claim.active, limit: claim.limit };
  }

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
  return row.id;
}

/**
 * Fire-and-forget job runner for library-side work (avatar, portrait_variant,
 * embed_refresh): inserts a running `jobs` row, kicks off the work, records
 * done/failed when it settles. The route returns the job id immediately; the
 * UI polls the affected rows (e.g. the image row status, docs/images.md).
 * Failures never propagate to the caller.
 *
 * When `ownerId` is set the insert goes through the per-user concurrency cap
 * (rate-limits.plan.md slice 5) and may be refused. The background work is
 * **not** started in that case, so callers must branch on the result rather
 * than assume a job exists.
 */
export async function startJob(opts: StartJobOptions): Promise<StartJobResult> {
  const jobId = await insertJobRow(opts);
  if (typeof jobId !== "string") return jobId;

  const lane = providerLaneFor(opts.type);

  void opts
    .run()
    .then(async (result) => {
      if (lane) recordProviderOutcome(lane, true);
      await db()
        .update(jobs)
        .set({ status: "done", payload: { ...opts.payload, ...result }, finishedAt: new Date() })
        .where(eq(jobs.id, jobId));
    })
    .catch(async (err: unknown) => {
      if (lane) recordProviderOutcome(lane, false);
      const message = errorText(err).slice(0, 500);
      log.warn("api.jobs", `${opts.type} job failed`, { jobId, error: message });
      try {
        await db()
          .update(jobs)
          .set({ status: "failed", error: message, finishedAt: new Date() })
          .where(eq(jobs.id, jobId));
      } catch (updateErr) {
        log.error("api.jobs", "failed to record job failure", { jobId, error: errorText(updateErr) });
      }
    });

  return { ok: true, jobId };
}
