import { eq } from "drizzle-orm";
import { db, jobs } from "@/server/db";
import { log } from "@/server/log";
import { errorText } from "./respond";
import { claimJobSlot, type JobSlotClaim } from "./concurrency";
import { recordProviderOutcome, type ProviderLane } from "./backpressure";
import type { ApiJobType } from "./job-types";

/**
 * Which provider lane a job's failure is evidence about. The job runner is the
 * honest place to feed the circuit breaker: a settled job is a real provider
 * outcome, and it lives on the `@/server/api` side of the boundary that forbids
 * `@/server/ai` from importing back.
 *
 * Jobs that touch no provider map to null and report nothing — their failures say
 * something about this app, not about an upstream. That is `image_sweep` (file
 * reconciliation) and `identity_pack` (local decode/crop/measure/write).
 *
 * A lane here only says which breaker a job COULD be evidence about. Whether one
 * particular run was is a second question, and a runner that settles its own
 * failures answers it through {@link JobRunContext}.
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
    // The Advanced Image Lab's two jobs. `lab_control_extract` computes an edge
    // map in-process, but pose and depth go to a Replicate preprocessor, so its
    // failures are evidence about the same upstream the render lane rides. Both
    // lab runners settle their own failures, so both report through
    // `reportProviderOutcome` — including "nothing happened here" for the runs
    // that never left this process.
    case "lab_image":
    case "lab_control_extract":
    // The Image Generator's run job: a raw registry-model render, so its
    // failures are evidence about the same upstream. The runner settles its
    // own failures too, so it reports through `reportProviderOutcome` —
    // including "nothing happened here" for pre-spend refusals.
    case "generator_image":
    // The reference-view build: every view it makes is a provider render, so a
    // failed build is evidence about the same upstream — unlike `identity_pack`
    // below, whose work is local decode/crop/measure/write.
    case "reference_views":
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

/**
 * What a job's body can tell the circuit breaker that the runner cannot work out
 * for itself.
 *
 * The default rule — resolved means the provider answered, threw means it did
 * not — is right for a lane whose work IS the provider call, and wrong twice for
 * a runner that records its own outcomes. The Advanced Image Lab settles a dead
 * Replicate call into an experiment row and resolves, which the default reads as
 * a healthy provider; it also resolves for work no provider ever saw (a
 * precondition refusal, an edge map computed in process), which the default
 * reads as a successful call that would close a tripped breaker. Such a runner
 * says what actually happened here instead.
 */
export interface JobRunContext {
  /**
   * `true` records one successful provider call, `false` one failed call, and
   * `null` records NOTHING — the honest report for a run that reached no
   * provider, or one whose failure says something about the request rather than
   * about the upstream.
   *
   * A run that never calls this keeps the default rule, which is why every
   * existing lane could stay a zero-argument closure. Last call wins; a run is
   * expected to report once.
   */
  readonly reportProviderOutcome: (outcome: boolean | null) => void;
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
  /**
   * The conversation this work belongs to, as a first-class column rather than a
   * payload key — the database relationship that takes the row down with its chat
   * (`ON DELETE CASCADE`). Chat-lane callers pass it IN ADDITION to keeping
   * `chatId` in the payload, which is where handlers still read it. Omitted by
   * library, image-lab, generator and system work that belongs to no
   * conversation; those rows age out through retention instead.
   *
   * A chat deleted between the caller's read and this insert makes the insert
   * fail the foreign key. That is correct — the work has no subject — and the
   * chat-lane callers already wrap the call in their own catch-and-warn, so it
   * costs a logged no-op rather than a thrown turn.
   */
  chatId?: string;
  /**
   * Background work; its resolved value is merged into the job payload. The
   * context is optional to take — a closure ignoring it reports nothing and
   * keeps the default provider-outcome rule.
   */
  run: (job: JobRunContext) => Promise<Record<string, unknown>>;
}

export type StartJobResult =
  | { readonly ok: true; readonly jobId: string }
  | { readonly ok: false; readonly active: number; readonly limit: number };

/**
 * Result for a job whose caller has an admission guard that must run only after
 * concurrency capacity is secured. An admission refusal never starts the job and
 * carries the caller's own refusal value back unchanged.
 */
export type StartJobAfterAdmissionResult<T> = StartJobResult | { readonly ok: false; readonly admission: T };

/** Returns the new job id, or the refusal to hand back to the caller. */
async function insertJobRow(opts: StartJobOptions): Promise<string | Extract<StartJobResult, { ok: false }>> {
  if (opts.ownerId !== undefined) {
    const claim: JobSlotClaim = await claimJobSlot({
      ownerId: opts.ownerId,
      type: opts.type,
      payload: opts.payload,
      ...(opts.chatId === undefined ? {} : { chatId: opts.chatId }),
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
      chatId: opts.chatId ?? null,
    })
    .returning({ id: jobs.id });
  if (!row) throw new Error("jobs insert returned no row");
  return row.id;
}

/**
 * Run work for a job row that has already been inserted. Keeping the runner
 * separate from admission lets a caller reserve an atomic per-user slot, run a
 * spend guard, and only then release provider work — without claiming a second
 * slot or charging for a job the cap subsequently refuses.
 */
function launchInsertedJob(jobId: string, opts: StartJobOptions): void {
  const lane = providerLaneFor(opts.type);
  // `undefined` while the run has said nothing, which is what keeps every lane
  // that never took the channel on the settled-promise rule below.
  let reported: boolean | null | undefined;
  const context: JobRunContext = {
    reportProviderOutcome: (outcome) => {
      reported = outcome;
    },
  };
  const laneOutcome = (settled: boolean): boolean | null => (reported === undefined ? settled : reported);

  void opts
    .run(context)
    .then(async (result) => {
      const outcome = laneOutcome(true);
      if (lane && outcome !== null) recordProviderOutcome(lane, outcome);
      await db()
        .update(jobs)
        .set({ status: "done", payload: { ...opts.payload, ...result }, finishedAt: new Date() })
        .where(eq(jobs.id, jobId));
    })
    .catch(async (err: unknown) => {
      // A run that reported a success and then threw is telling the truth twice:
      // the provider answered, and something after it did not.
      const outcome = laneOutcome(false);
      if (lane && outcome !== null) recordProviderOutcome(lane, outcome);
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
}

/**
 * Claim capacity first, then run a caller-owned admission guard before provider
 * work is released.
 *
 * The claimed row is a short-lived reservation. If admission refuses, it is
 * deleted before this function returns; the job body never runs and no provider
 * outcome is recorded. If the guard throws, the reservation is likewise removed
 * and the original failure propagates. This is the ordering needed by guards
 * that CHARGE on success: a saturated per-user queue must be known before that
 * charge is consumed.
 */
export async function startJobAfterAdmission<T>(
  opts: StartJobOptions,
  admit: () => Promise<T | null>,
): Promise<StartJobAfterAdmissionResult<T>> {
  const jobId = await insertJobRow(opts);
  if (typeof jobId !== "string") return jobId;

  let admission: T | null;
  try {
    admission = await admit();
  } catch (err) {
    await db().delete(jobs).where(eq(jobs.id, jobId));
    throw err;
  }

  if (admission !== null) {
    await db().delete(jobs).where(eq(jobs.id, jobId));
    return { ok: false, admission };
  }

  launchInsertedJob(jobId, opts);
  return { ok: true, jobId };
}

/**
 * Fire-and-forget job runner for library-side work (avatar, portrait_variant,
 * embed_refresh): inserts a running `jobs` row, kicks off the work, records
 * done/failed when it settles. The route returns the job id immediately; the
 * UI polls the affected rows (e.g. the image row status, docs/images/asset-registry.md).
 * Failures never propagate to the caller.
 *
 * When `ownerId` is set the insert goes through the per-user concurrency cap
 * and may be refused. The background work is
 * **not** started in that case, so callers must branch on the result rather
 * than assume a job exists.
 *
 * The settled promise is what feeds this type's provider lane by default —
 * resolved reports a working provider, thrown a failing one. A run that knows
 * better overrides it through {@link JobRunContext}, including with "say
 * nothing", which is the only way a job that reached no provider can avoid
 * reporting health nobody probed.
 */
export async function startJob(opts: StartJobOptions): Promise<StartJobResult> {
  const jobId = await insertJobRow(opts);
  if (typeof jobId !== "string") return jobId;
  launchInsertedJob(jobId, opts);
  return { ok: true, jobId };
}
