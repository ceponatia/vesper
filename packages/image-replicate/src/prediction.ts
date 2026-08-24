import { z } from "zod";
import type { ProviderExecutionPolicy } from "@vesper/image-core";
import { POLL_INTERVAL_MS, predictionTimeoutMs, REQUEST_TIMEOUT_MS, type ReplicateConfig } from "./config";
import { errorText, type ReplicateHttp, responseError, sleep } from "./http";
import { downloadReplicateOutput, outputUrl } from "./outputs";
import type { ProviderInputViolation, UnsentReferenceReport } from "./strict-request";

/**
 * The prediction shell: create, poll, cancel, and read the answer. Every render
 * and every preprocessor run in Vesper goes through this one function, which is
 * why there is exactly one place that talks to `api.replicate.com/v1/predictions`.
 *
 * A prediction spends its life in two completely different phases, and for most
 * of this shell's history it had one budget covering both. That is the defect
 * this module now answers: a render that waited out a cold-boot queue and was
 * abandoned before it ever executed came back looking exactly like a model that
 * ran and failed. A caller may hand in a `ProviderExecutionPolicy`
 * (`@vesper/image-core`) to split the budget in two — queue time and render
 * time — and to allow a prediction that died IN the queue to be created again.
 * Hand in nothing and this is byte-for-byte the shell it always was, which is
 * deliberately what production lanes keep doing (plan §8, owner ruling
 * 2026-08-24).
 */

export interface ReplicateImageResult {
  ok: boolean;
  image?: Buffer;
  error?: string;
  /**
   * The provider's prediction id, present on EVERY outcome from the moment one
   * exists — success, provider failure, timeout, poll error alike — because it
   * is the only handle that ties a stored render back to the provider's own
   * record of it. Absent only when the POST itself never produced a prediction
   * (transport failure, a non-2xx create), where there is genuinely no id and
   * inventing one would be worse than admitting none.
   */
  predictionId?: string;
  /**
   * The version Replicate says it ACTUALLY ran, echoed off the prediction body.
   *
   * A pinned request states what should run; only this states what did. The two
   * can differ — a bare `owner/name` slug resolves `latest_version` server-side,
   * and a pinned id can be re-pointed by the provider — and a controlled
   * comparison that cannot tell those apart is grading whatever Replicate
   * shipped that hour under a pin's name. Absent when the response carries no
   * `version` field, which is the honest answer rather than echoing the request
   * back as if it were confirmation.
   */
  executedVersionId?: string;
  /**
   * How many PRIMARY references actually traveled with the prediction — after
   * `fitReferences` and, on the `data_url` transport, the inline byte budget
   * (the `file` transport sends every fitted reference). Set only by
   * `runRegistryImageModel`, and only once a prediction was posted: a caller
   * recording which reference roles were sent truncates its list to this count,
   * so a budget-trimmed reference is never claimed as sent. Absent means the
   * run never reached the transport (or predates the field), never "zero".
   */
  sentReferenceCount?: number;
  /**
   * Under the strict reference policy: the explicitly selected references this
   * request could not carry, and why. Present ONLY on that refusal, and its
   * presence is the signal that no prediction was created — a caller settling
   * the run reads it as "nothing was spent", not as a provider failure.
   */
  unsentReferences?: UnsentReferenceReport[];
  /**
   * Under the strict provider-input policy: the ways the finished payload
   * contradicted the version's probed schema. Same rule — present only on that
   * pre-spend refusal.
   */
  providerInputViolations?: ProviderInputViolation[];
  /**
   * Every prediction this run created, oldest first — present ONLY when the
   * caller supplied an `executionPolicy`, because only then can one run create
   * more than one prediction. The provenance fields above keep describing the
   * FINAL attempt, so a caller that never reads this reads exactly what it
   * always did (plan §8, owner ruling 2026-08-24).
   */
  attempts?: ReplicatePredictionAttempt[];
}

/**
 * How ONE created prediction ended.
 *
 * The vocabulary exists to separate the two things a single failure code used
 * to conflate: a model that RAN and failed, and a prediction that never got to
 * run at all. `aborted_before_start` and `startup_timeout` are the second kind
 * — nothing was rendered and nothing was learned about the model — while
 * `failed` and `render_timeout` are the first.
 *
 * - `succeeded` — the provider produced an output. A download failure after
 *   that is this process's errand, not the attempt's.
 * - `failed` — the provider settled it as failed, or the poll could not be
 *   completed and the run gave up on it.
 * - `canceled` — cancelled by somebody: the dashboard, or an operator.
 * - `aborted_before_start` — terminal with no evidence it ever executed and no
 *   error explaining why: the provider abandoning a queued prediction.
 * - `startup_timeout` — this client's own startup budget expired while the
 *   prediction was still queued, so it was cancelled here.
 * - `render_timeout` — it began executing and outran the render budget.
 */
export type ReplicatePredictionOutcome =
  | "succeeded"
  | "failed"
  | "canceled"
  | "aborted_before_start"
  | "startup_timeout"
  | "render_timeout";

/** One created prediction, as a run record keeps it. */
export interface ReplicatePredictionAttempt {
  predictionId: string;
  outcome: ReplicatePredictionOutcome;
  /**
   * Creation → execution start. For an attempt that never started this is how
   * long it waited before it was abandoned, which is the number that says
   * whether a startup budget was too tight.
   */
  queuedMs?: number;
  /** Execution start → settle. Absent when the prediction never executed at all. */
  renderMs?: number;
}

const predictionSchema = z.object({
  id: z.string().min(1),
  status: z.string(),
  /**
   * The version Replicate resolved for this prediction. Optional because the
   * model-endpoint form (`/models/owner/name/predictions`) has been observed
   * without it, and a missing echo must degrade to "unconfirmed" rather than
   * failing the parse of an otherwise perfectly good prediction.
   */
  version: z.string().optional(),
  output: z.unknown().optional().nullable(),
  error: z.unknown().optional().nullable(),
  /**
   * The lifecycle timestamps and the evidence of WORK, every one of them
   * optional and nullable: each is absent for part of a prediction's life, and
   * the parse of an otherwise perfectly good record must never fail over a
   * field this shell reads only to judge which phase the prediction is in.
   *
   * `metrics` is read as an open map rather than a typed object on purpose —
   * the provider adds keys to it, and only `predict_time` means anything here,
   * so a new sibling key must not be able to break a render.
   */
  created_at: z.string().nullish(),
  started_at: z.string().nullish(),
  completed_at: z.string().nullish(),
  logs: z.string().nullish(),
  metrics: z.record(z.string(), z.unknown()).nullish(),
});

type ReplicatePrediction = z.infer<typeof predictionSchema>;

/**
 * The run-shaping fields the prediction shell owns — never the payload, which
 * its callers have already built and merged.
 *
 * A structural interface rather than a `Pick<RegistryModelRequest, …>` because
 * two different callers share the shell: a registry render, whose request
 * happens to carry these fields among many others, and the preprocessor, which
 * has no prompt, no references and no aspect to speak of. `outputField` exists
 * for the second: a preprocessor may answer with an OBJECT of several maps
 * (Depth Anything v2 returns `grey_depth` and `color_depth`), and the caller is
 * the only party that knows which of them it asked for.
 */
export interface PredictionRunOptions {
  timeoutMs?: number;
  versionId?: string;
  /** Read the image URL off THIS field when the output is an object. */
  outputField?: string;
  /**
   * Two-phase budgets and startup retries for THIS run
   * (`ProviderExecutionPolicy`, `@vesper/image-core`).
   *
   * Absent is the production answer and leaves the legacy shell untouched: one
   * prediction, one `timeoutMs`-derived deadline, no retry. Present, it
   * REPLACES `timeoutMs` for this run — the provider is told the sum of the two
   * budgets, and the queue and the render are watched separately here — and
   * makes the result report its `attempts`.
   *
   * Keeping the totals sane is the application's job, not the transport's: the
   * bench lanes resolve the numbers and an adapter's execution hints may narrow
   * them, so clamping here would silently overrule a caller that had already
   * decided.
   */
  executionPolicy?: ProviderExecutionPolicy;
}

/**
 * Resolve a registry slug to the endpoint that runs it. Three forms are
 * accepted: `owner/name` (runs whatever Replicate currently calls
 * `latest_version`), `owner/name:version` (pinned in the slug), and either of
 * those plus an EXPLICIT `versionId` from the caller.
 *
 * Pinning matters more here than it looks: Replicate can change a model's input
 * schema underneath a bare slug, which is exactly the failure the registry's
 * stored capability columns would not notice. `/predictions` is the only
 * endpoint that accepts a version, so any pin routes there.
 *
 * An explicit `versionId` WINS over a slug pin. It is the caller stating what it
 * verified and hashed — the identity trial refuses to plan a cell at all when
 * the probed and slug-pinned versions disagree (`pinnedImageModelVersion`), so
 * a conflict cannot reach here from that path, and any other caller passing one
 * is asserting the same thing.
 */
export function replicatePredictionTarget(model: string, versionId?: string): { path: string; version?: string } {
  const [path, version, ...rest] = model.split(":");
  if (rest.length > 0) throw new Error(`invalid Replicate model id: ${model}`);
  const [owner, name, extra] = (path ?? "").split("/");
  if (!owner || !name || extra) throw new Error(`invalid Replicate model id: ${model}`);
  if (versionId) return { path: "/predictions", version: versionId };
  if (version) return { path: "/predictions", version };
  return { path: `/models/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/predictions` };
}

/**
 * Run one prediction to completion. `input` is already built and merged by the
 * caller, so nothing here can change WHAT is sent — only where, for how long,
 * and which part of the answer is the image.
 *
 * Without an `executionPolicy` this creates exactly one prediction and watches
 * it against one deadline, as it always has. With one it becomes a small loop:
 * each pass creates a prediction and watches it against the two-phase deadline,
 * and the loop only goes round again when the prediction died in the QUEUE —
 * the single failure class where re-sending the same input is not paying twice
 * for the same answer. However it settles, the provenance fields describe the
 * FINAL attempt and `attempts` records all of them.
 */
export async function runPrediction(
  http: ReplicateHttp,
  config: ReplicateConfig,
  model: string,
  input: Record<string, unknown>,
  request: PredictionRunOptions,
): Promise<ReplicateImageResult> {
  // One binding of the caller's output shape, used by every read below: the
  // poll loop, the terminal check and the download must all agree on what
  // counts as "an image arrived", or a settled prediction whose map sits under
  // a named field reads as an empty output.
  const pickOutput = (output: unknown): string | null => outputUrl(output, request.outputField);
  const budget = resolvePredictionBudget(config, request);
  const maxAttempts = budget.kind === "phased" ? budget.maxStartupRetries + 1 : 1;
  const attempts: ReplicatePredictionAttempt[] = [];
  // Attempts are reported only under a policy. A lane that passed none gets one
  // prediction by construction, and handing it a one-element list would put a
  // new field into results the application already stores.
  const settle = (result: ReplicateImageResult): ReplicateImageResult =>
    budget.kind === "phased" && attempts.length > 0 ? { ...result, attempts: [...attempts] } : result;

  for (let attemptNumber = 1; ; attemptNumber += 1) {
    const attempt = await attemptPrediction(http, model, input, request, budget, pickOutput);
    if (attempt.record) attempts.push(attempt.record);
    if (!attempt.startupFailure) return settle(attempt.result);
    if (attemptNumber < maxAttempts) continue;
    // Out of retries, and every one of them died queued: say so in the message
    // the caller stores, because "the queue never let it start" and "the model
    // failed" are different facts about different things.
    return settle({ ...attempt.result, error: neverStartedMessage(attempt.startupFailure, attempts.length) });
  }
}

/**
 * One created prediction, watched to its end.
 *
 * Split out of {@link runPrediction} because a startup retry has to do this
 * twice: the loop above decides whether there is another attempt, and this
 * decides what THIS attempt was.
 */
async function attemptPrediction(
  http: ReplicateHttp,
  model: string,
  input: Record<string, unknown>,
  request: PredictionRunOptions,
  budget: PredictionBudget,
  pickOutput: (output: unknown) => string | null,
): Promise<PredictionAttemptEnd> {
  // The provider's queue clock starts when the create request is SENT, and so
  // does `Cancel-After` — so the startup phase is measured from here rather
  // than from whenever a `Prefer: wait=60` create finally returns.
  const createdAtMs = Date.now();
  let prediction: ReplicatePrediction;
  try {
    // An explicit `versionId` pins the run outright. Otherwise a pinned
    // `owner/name:version` posts to the version-agnostic `/predictions`
    // endpoint carrying the version id, and a bare `owner/name` posts to the
    // model's own endpoint and takes whatever `latest_version` is.
    const target = replicatePredictionTarget(model, request.versionId);
    const response = await http.apiFetch(target.path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Prefer: "wait=60",
        // One resolution for every deadline: the provider-side `Cancel-After`
        // and this client's own cutoffs must agree, or raising a budget only
        // lengthens the polling while Replicate still kills the prediction at
        // the old bound. Under a policy the provider is told the WHOLE budget —
        // it has no notion of Vesper's two phases — and the split is enforced
        // here, where the prediction record can say which phase it is in.
        "Cancel-After": cancelAfterHeader(budgetTotalMs(budget)),
      },
      body: JSON.stringify(target.version ? { version: target.version, input } : { input }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) return { result: { ok: false, error: await responseError(response) } };
    prediction = predictionSchema.parse(await response.json());
  } catch (err) {
    // No prediction exists, so there is no attempt to record and no id to
    // report — inventing either would be worse than admitting none.
    return { result: { ok: false, error: errorText(err) } };
  }

  // When execution was first OBSERVED, on this process's clock. Null means the
  // prediction is, as far as anything seen so far goes, still queued — and it is
  // what switches the deadline from the startup phase to the render phase.
  let observedStartMs: number | null = hasStartedExecuting(prediction) ? Date.now() : null;
  // The legacy deadline has always started when the create RETURNED, and a
  // `Prefer: wait=60` create can hold that for a minute. Left exactly as it was
  // rather than re-based on `createdAtMs`, because shortening a production
  // lane's effective budget is not a refactor.
  const pollFrom = Date.now();
  const deadlineMs = (): number => {
    if (budget.kind === "single") return pollFrom + budget.totalMs;
    return observedStartMs === null ? createdAtMs + budget.startupBudgetMs : observedStartMs + budget.renderBudgetMs;
  };

  while (!isTerminal(prediction.status) && pickOutput(prediction.output) === null) {
    if (Date.now() >= deadlineMs()) {
      // Render-timeout and single-budget cutoffs never retry, so a best-effort
      // cancel is sufficient there — the worst a lost cancel costs is the
      // provider's own Cancel-After backstop. The startup cutoff is different:
      // its caller may CREATE A SECOND PREDICTION, so "it never started" must
      // be a confirmed fact, not the last polled state. `cancelPrediction`
      // suppresses errors, and execution can begin between the last poll and
      // the cancel — either way an unconfirmed retry pays for two renders.
      if (budget.kind !== "phased" || observedStartMs !== null) {
        await cancelPrediction(http, prediction.id);
        return timedOutAttempt(prediction, budget, createdAtMs, observedStartMs);
      }
      const confirmation = await confirmStartupCancellation(http, prediction.id);
      if (confirmation.kind === "executing") {
        // It started under the wire. The render is paid for either way, so the
        // honest move is to switch to the render phase and keep watching — if
        // the cancel also landed, the next iteration sees the terminal record
        // and settles it as the non-retryable cancel it was.
        prediction = confirmation.prediction;
        observedStartMs = Date.now();
        continue;
      }
      if (confirmation.kind === "dead_unstarted") {
        return timedOutAttempt(confirmation.prediction, budget, createdAtMs, null);
      }
      // Unconfirmed: the record could not be re-read, or the prediction was
      // still live after the confirmation window. Refusing the retry is the
      // only answer that cannot double-bill; the message says why no second
      // attempt follows.
      return {
        result: {
          ok: false,
          predictionId: prediction.id,
          error: `replicate prediction ${prediction.id} timed out in the provider queue and its cancellation could not be confirmed (${confirmation.detail}); no retry was attempted, because a second prediction beside an unconfirmed first could pay for two renders`,
        },
        record: attemptRecord(prediction, "startup_timeout", createdAtMs, null),
      };
    }
    await sleep(POLL_INTERVAL_MS);
    try {
      const response = await http.apiFetch(`/predictions/${encodeURIComponent(prediction.id)}`, {
        method: "GET",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!response.ok) {
        return {
          result: { ok: false, predictionId: prediction.id, error: await responseError(response) },
          record: attemptRecord(prediction, "failed", createdAtMs, observedStartMs),
        };
      }
      prediction = predictionSchema.parse(await response.json());
      // Stamped once and never revised: the render phase is measured from the
      // first sighting of execution, not from the latest poll that confirms it.
      if (observedStartMs === null && hasStartedExecuting(prediction)) observedStartMs = Date.now();
    } catch (err) {
      return {
        result: { ok: false, predictionId: prediction.id, error: errorText(err) },
        record: attemptRecord(prediction, "failed", createdAtMs, observedStartMs),
      };
    }
  }

  // The provenance the SETTLED prediction carries. Spread rather than assigned
  // so a response without a `version` echo reports no field at all instead of an
  // explicit undefined — absent means "the provider did not say", which is a
  // different fact from "it ran an empty version".
  const provenance = {
    predictionId: prediction.id,
    ...(prediction.version ? { executedVersionId: prediction.version } : {}),
  };

  if (prediction.status !== "succeeded" && pickOutput(prediction.output) === null) {
    const unstarted = isUnstartedAbort(prediction, observedStartMs);
    const outcome: ReplicatePredictionOutcome = unstarted
      ? "aborted_before_start"
      : prediction.status === "canceled"
        ? "canceled"
        : "failed";
    return {
      result: { ok: false, ...provenance, error: `replicate ${prediction.status}: ${predictionError(prediction.error)}` },
      record: attemptRecord(prediction, outcome, createdAtMs, observedStartMs),
      // Retryable only under a policy: with no policy this shell has never
      // recreated anything, and production lanes are keeping it that way.
      ...(unstarted && budget.kind === "phased"
        ? {
            startupFailure: {
              predictionId: prediction.id,
              detail: "the provider aborted it before it began executing",
            },
          }
        : {}),
    };
  }

  // Recorded BEFORE the download: the render budget is about the model working,
  // and fetching the produced bytes afterwards is this process's own errand.
  const record = attemptRecord(prediction, "succeeded", createdAtMs, observedStartMs);
  const url = pickOutput(prediction.output);
  if (!url) return { result: { ok: false, ...provenance, error: "replicate returned no image" }, record };
  try {
    return { result: { ok: true, ...provenance, image: await downloadReplicateOutput(http, url) }, record };
  } catch (err) {
    return { result: { ok: false, ...provenance, error: errorText(err) }, record };
  }
}

/**
 * What one attempt ended as, and what the loop that owns it may do about it.
 */
interface PredictionAttemptEnd {
  /** The result the whole run settles as if this attempt is the last one. */
  result: ReplicateImageResult;
  /** This attempt's record — absent only when the create never produced a prediction. */
  record?: ReplicatePredictionAttempt;
  /**
   * Set only when the prediction never began executing AND a policy allows
   * recreations. `detail` is the plain-English half of the message the caller
   * finally reads, so the same wording explains one attempt or five.
   */
  startupFailure?: { predictionId: string; detail: string };
}

/**
 * The budget one attempt is watched against: a single number, or two phases.
 *
 * A discriminated union rather than an optional policy field because every
 * decision below — which deadline applies, whether a queue death may be
 * retried, whether attempts are reported — turns on the same question, and one
 * `kind` keeps them from drifting apart.
 */
type PredictionBudget =
  | { kind: "single"; totalMs: number }
  | { kind: "phased"; startupBudgetMs: number; renderBudgetMs: number; maxStartupRetries: number };

/**
 * Which budget this run gets.
 *
 * A policy whose numbers are unusable degrades to the legacy single budget
 * instead of failing the render (docs/resilience.md): the phases are a
 * refinement of how a render is watched, never a precondition for running one,
 * and a caller that passed nonsense still deserves its picture.
 */
function resolvePredictionBudget(config: ReplicateConfig, request: PredictionRunOptions): PredictionBudget {
  const policy = request.executionPolicy;
  const startupBudgetMs = usableBudgetMs(policy?.startupBudgetMs);
  const renderBudgetMs = usableBudgetMs(policy?.renderBudgetMs);
  if (startupBudgetMs === null || renderBudgetMs === null) {
    return { kind: "single", totalMs: predictionTimeoutMs(config, request.timeoutMs) };
  }
  const retries = policy?.maxStartupRetries;
  return {
    kind: "phased",
    startupBudgetMs,
    renderBudgetMs,
    maxStartupRetries: typeof retries === "number" && Number.isFinite(retries) ? Math.max(0, Math.trunc(retries)) : 0,
  };
}

function usableBudgetMs(value: number | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : null;
}

/** What the PROVIDER is told: one deadline covering both phases. */
function budgetTotalMs(budget: PredictionBudget): number {
  return budget.kind === "single" ? budget.totalMs : budget.startupBudgetMs + budget.renderBudgetMs;
}

/**
 * A deadline this client enforced itself — called after the cancel is sent.
 */
function timedOutAttempt(
  prediction: ReplicatePrediction,
  budget: PredictionBudget,
  createdAtMs: number,
  observedStartMs: number | null,
): PredictionAttemptEnd {
  const unstarted = observedStartMs === null;
  const record = attemptRecord(
    prediction,
    unstarted ? "startup_timeout" : "render_timeout",
    createdAtMs,
    observedStartMs,
  );
  // The legacy single budget keeps its exact message: one deadline covering a
  // queue and a render cannot honestly name either of them.
  if (budget.kind === "single") {
    return {
      result: { ok: false, predictionId: prediction.id, error: `replicate prediction ${prediction.id} timed out` },
      record,
    };
  }
  if (unstarted) {
    const failure = {
      predictionId: prediction.id,
      detail: `it sat in the provider queue for the whole ${seconds(budget.startupBudgetMs)}s startup budget without beginning execution`,
    };
    return {
      result: { ok: false, predictionId: prediction.id, error: neverStartedMessage(failure, 1) },
      record,
      startupFailure: failure,
    };
  }
  return {
    result: {
      ok: false,
      predictionId: prediction.id,
      error: `replicate prediction ${prediction.id} timed out while rendering: it began executing and then exceeded the ${seconds(budget.renderBudgetMs)}s render budget`,
    },
    record,
  };
}

/**
 * The message a run gets when every attempt died in the QUEUE.
 *
 * It has to read as two different things at once. A person reads "never
 * started" and knows the model was never asked to do anything, so the run says
 * nothing about the model. The failure classifier
 * (`classifyImageFailureMessage`, `@vesper/image-core`) reads "timed out" and
 * keeps calling it transient — which is the whole point: a cold-boot queue must
 * not be recorded as evidence against a model, and must stay retryable.
 */
function neverStartedMessage(failure: { predictionId: string; detail: string }, attemptCount: number): string {
  const tries = attemptCount === 1 ? "1 attempt" : `${attemptCount} attempts`;
  return `replicate prediction ${failure.predictionId} never started: ${failure.detail} — startup timed out after ${tries}, and no render was attempted`;
}

/**
 * One attempt, as the caller will store it.
 *
 * Durations come from the PROVIDER's own timestamps when it published them and
 * from this process's clock when it did not: a poll-resolution reading of a
 * queue measured in minutes is worth far more than an absent field, and both
 * readings are honest about the phase they describe.
 */
function attemptRecord(
  prediction: ReplicatePrediction,
  outcome: ReplicatePredictionOutcome,
  createdAtMs: number,
  observedStartMs: number | null,
): ReplicatePredictionAttempt {
  const started = observedStartMs !== null || hasStartedExecuting(prediction);
  const queuedMs =
    (started
      ? spanMs(prediction.created_at, prediction.started_at)
      : spanMs(prediction.created_at, prediction.completed_at)) ??
    Math.max(0, (started ? (observedStartMs ?? Date.now()) : Date.now()) - createdAtMs);
  // No execution, no render duration. An abort stamps `started_at` equal to
  // `completed_at`, and reporting that zero-length window would claim a render
  // happened when the container never ran.
  const renderMs = started
    ? (predictTimeMs(prediction.metrics) ??
      spanMs(prediction.started_at, prediction.completed_at) ??
      (observedStartMs === null ? undefined : Math.max(0, Date.now() - observedStartMs)))
    : undefined;
  return {
    predictionId: prediction.id,
    outcome,
    queuedMs,
    ...(renderMs === undefined ? {} : { renderMs }),
  };
}

/**
 * Did this prediction's container actually RUN?
 *
 * `started_at` deliberately does NOT count as proof. Replicate stamps it at the
 * moment it gives up, too: prediction `psme0ern9nrnt0d06h8b3zx01c` came back
 * `status: "aborted"`, `error: null`, `logs: ""`, `metrics: null`, with
 * `started_at` equal to `completed_at` — a prediction that never executed,
 * wearing a start time. What a queued prediction cannot have is EVIDENCE of
 * work: `metrics.predict_time`, which the provider fills in only once the model
 * predicted; log output; or a status that means "executing right now".
 */
function hasStartedExecuting(prediction: ReplicatePrediction): boolean {
  if (prediction.status === "processing" || prediction.status === "succeeded") return true;
  if (predictTimeMs(prediction.metrics) !== undefined) return true;
  return (prediction.logs ?? "").trim().length > 0;
}

/**
 * A provider-terminal `aborted` that never executed and never said why — the
 * provider abandoning something it had queued, which is the one thing worth
 * recreating. This is exactly the observed incident shape, and the class stays
 * that narrow on purpose (owner ruling 2026-08-24): a silent `failed` is NOT
 * assumed unstarted, because nothing from the provider documents that reading,
 * and recreating an ambiguous failure risks rebilling a render that ran.
 *
 * Two further exclusions carry weight. A prediction carrying an `error` is the
 * model or the payload ANSWERING, and re-sending the same input would buy the
 * same answer a second time. A `canceled` prediction is somebody's decision —
 * an operator's, or this client's own startup cutoff (which re-reads the
 * record and retries through its own confirmed path) — and quietly recreating
 * it here would overrule whoever cancelled.
 */
function isUnstartedAbort(prediction: ReplicatePrediction, observedStartMs: number | null): boolean {
  if (observedStartMs !== null || hasStartedExecuting(prediction)) return false;
  if (prediction.status !== "aborted") return false;
  return !hasErrorDetail(prediction.error);
}

function hasErrorDetail(error: unknown): boolean {
  if (typeof error === "string") return error.trim().length > 0;
  return error !== null && error !== undefined;
}

/** `metrics.predict_time` in milliseconds — seconds on the wire, when it is a number at all. */
function predictTimeMs(metrics: Record<string, unknown> | null | undefined): number | undefined {
  const value = metrics?.predict_time;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value * 1_000) : undefined;
}

/** The gap between two of the provider's ISO timestamps, when both are readable. */
function spanMs(from: string | null | undefined, to: string | null | undefined): number | undefined {
  const start = timestampMs(from);
  const end = timestampMs(to);
  if (start === undefined || end === undefined || end < start) return undefined;
  return end - start;
}

function timestampMs(value: string | null | undefined): number | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function seconds(ms: number): number {
  return Math.round(ms / 1_000);
}

/**
 * How many post-cancel reads may confirm a startup death before the client
 * stops guessing. Three polls is ~4.5s — enough for Replicate's cancel to
 * settle the record in the observed cases, short enough that a wedged
 * confirmation does not eat the retry's own startup budget.
 */
const CANCEL_CONFIRMATION_READS = 3;

type StartupCancellationConfirmation =
  | { kind: "dead_unstarted"; prediction: ReplicatePrediction }
  | { kind: "executing"; prediction: ReplicatePrediction }
  | { kind: "unconfirmed"; detail: string };

/**
 * Cancel a queued prediction and CONFIRM what became of it, because the caller
 * is deciding whether to buy a replacement. Three honest answers:
 *
 * - `dead_unstarted`: the record is terminal with no execution evidence — the
 *   only state a startup retry may follow.
 * - `executing`: the record shows execution evidence — the render is being paid
 *   for whatever the cancel did, so the caller must keep watching it, never
 *   duplicate it.
 * - `unconfirmed`: the record could not be re-read, or stayed non-terminal past
 *   the confirmation window. The caller must NOT retry on this answer.
 */
async function confirmStartupCancellation(
  http: ReplicateHttp,
  predictionId: string,
): Promise<StartupCancellationConfirmation> {
  await cancelPrediction(http, predictionId);
  for (let read = 1; read <= CANCEL_CONFIRMATION_READS; read += 1) {
    try {
      const response = await http.apiFetch(`/predictions/${encodeURIComponent(predictionId)}`, {
        method: "GET",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!response.ok) return { kind: "unconfirmed", detail: await responseError(response) };
      const prediction = predictionSchema.parse(await response.json());
      // Execution evidence outranks terminality: a canceled prediction that DID
      // start is a paid render that died, not a queue death, and reporting it
      // as retryable would re-bill the work.
      if (hasStartedExecuting(prediction)) return { kind: "executing", prediction };
      if (isTerminal(prediction.status)) return { kind: "dead_unstarted", prediction };
    } catch (err) {
      return { kind: "unconfirmed", detail: errorText(err) };
    }
    if (read < CANCEL_CONFIRMATION_READS) await sleep(POLL_INTERVAL_MS);
  }
  return { kind: "unconfirmed", detail: "the prediction was still live after the cancellation window" };
}

async function cancelPrediction(http: ReplicateHttp, predictionId: string): Promise<void> {
  if (!http.configured) return;
  await http
    .apiFetch(`/predictions/${encodeURIComponent(predictionId)}/cancel`, {
      method: "POST",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    .catch(() => undefined);
}

function isTerminal(status: string): boolean {
  return status === "succeeded" || status === "failed" || status === "canceled" || status === "aborted";
}

function predictionError(error: unknown): string {
  if (typeof error === "string" && error.trim()) return error.slice(0, 500);
  if (error === null || error === undefined) return "prediction failed";
  try {
    return JSON.stringify(error).slice(0, 500);
  } catch {
    return String(error).slice(0, 500);
  }
}

/**
 * Replicate's prediction deadline header: an integer of seconds (or a
 * unit-suffixed duration), valid from 5s to 24h. `predictionTimeoutMs()` is
 * already clamped to 30s–30m, so the single-budget value is always in range;
 * a policy's summed budgets are the application's to keep sane, and the bench
 * numbers it passes (minutes, not hours) sit well inside the same window.
 */
function cancelAfterHeader(timeoutMs: number): string {
  return `${Math.round(timeoutMs / 1_000)}s`;
}
