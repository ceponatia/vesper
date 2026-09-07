import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import {
  emptyImageGeneratorControls,
  emptyImageGeneratorProviderInputs,
  emptyImageGeneratorRunInputs,
  type ImageGeneratorControls,
  type ImageGeneratorCreateRunRequest,
  imageGeneratorControlsSchema,
  imageGeneratorProviderInputsSchema,
  type ImageGeneratorRun,
  imageGeneratorRunInputsSchema,
  type ImageGeneratorRunInputs,
  type ImageGeneratorVersionPolicy,
  imageGeneratorVersionPolicySchema,
} from "@/contracts/images/image-generator";
import {
  imageGeneratorRunOutputImageIds,
  imageGeneratorRunOutputs,
} from "@/contracts/images/image-generator-outputs";
import { diag, type DiagnosticSink } from "@/contracts/diagnostics";
import { parseOr, parseOrNull } from "@/lib/parse";
import { db, imageGeneratorRuns } from "../db";
import { deleteOwnedImages } from "./asset-deletion";
import { imageMeta } from "./asset-storage";
import { loadImageModel } from "./models";

/**
 * The Image Generator's run service: row↔wire, create, list, detail,
 * delete, and the failed-settle helper the runner shares.
 *
 * One run id identifies ONE immutable attempt — variants create new rows via
 * `sourceRunId`, and nothing here mutates or reruns a settled row. The service
 * writes `image_generator_runs` rows and `generator_output` images and nothing
 * else; like every image lane, the job seam lives at the ROUTE, because
 * `@/server/api` imports `@/server/images` and a `startJob` call from here
 * would close that cycle. Which is also why each run reports its
 * {@link ImageGeneratorProviderOutcome} in the payload instead of touching the
 * breaker itself.
 */

export type ImageGeneratorRunRow = typeof imageGeneratorRuns.$inferSelect;

/**
 * What one run proved about the image provider lane, in the circuit breaker's
 * vocabulary. `null` — say nothing — is the answer for every pre-spend
 * refusal: the runner settles rows instead of throwing, so a resolved run
 * read as "provider healthy" would close a tripped breaker on the strength of
 * a refusal that never left this database.
 */
export type ImageGeneratorProviderOutcome = boolean | null;

/** The record one run returns — the `jobs` payload, plus what it told the breaker. */
export interface ImageGeneratorRunPayload extends Record<string, unknown> {
  providerOutcome: ImageGeneratorProviderOutcome;
}

/**
 * The one code this runner needs beyond the contract's vocabulary: a runner
 * that died on something other than a provider call. Kept out of the wire enum
 * for the reason the Lab keeps `image_lab.run_threw` out of its own — the
 * column is a bounded string, and a UI can only display this verbatim anyway.
 */
export const IMAGE_GENERATOR_RUN_THREW = "image_generator.run_threw";

const RUN_LIST_DEFAULT_LIMIT = 50;
const RUN_LIST_MAX_LIMIT = 200;

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** The loose attempt record, exactly as the Gallery reads `meta.render`. */
const storedAttemptSchema = z.record(z.string(), z.unknown());

/** The provider attempt history — the same loose record, once per prediction. */
const storedAttemptListSchema = z.array(storedAttemptSchema);

/**
 * One stored row as the routes report it. Every jsonb column crosses `parseOr`
 * (docs/resilience.md §1): a bag that no longer parses costs the display its
 * content with a diagnostic, never the page. `ownerId` deliberately does not
 * travel — every Generator surface is owner-scoped by its route.
 */
export function toWireImageGeneratorRun(row: ImageGeneratorRunRow, sink?: DiagnosticSink): ImageGeneratorRun {
  return {
    id: row.id,
    status: row.status,
    modelSlug: row.modelSlug,
    requestedVersionId: row.requestedVersionId,
    executedVersionId: row.executedVersionId,
    prompt: row.prompt,
    finalPrompt: row.finalPrompt,
    inputs: storedRunInputs(row, sink),
    controls: storedRunControls(row, sink),
    providerInputs: storedRunProviderInputs(row, sink),
    sourceRunId: row.sourceRunId,
    versionPolicy: storedVersionRequest(row).mode,
    effectiveRequest: storedMetaRecord(row, "effectiveRequest", sink),
    result: storedRunResult(row, sink),
    providerAttempts: storedProviderAttempts(row, sink),
    resultImageId: row.resultImageId,
    failureCode: row.failureCode,
    error: row.error,
    predictionId: row.predictionId,
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
    attempt: storedRunAttempt(row, sink),
  };
}

export function storedRunInputs(row: ImageGeneratorRunRow, sink?: DiagnosticSink): ImageGeneratorRunInputs {
  return parseOr(
    imageGeneratorRunInputsSchema,
    row.inputs,
    emptyImageGeneratorRunInputs(),
    sink,
    "image_generator_runs.inputs",
  );
}

export function storedRunControls(row: ImageGeneratorRunRow, sink?: DiagnosticSink): ImageGeneratorControls {
  return parseOr(
    imageGeneratorControlsSchema,
    row.controls,
    emptyImageGeneratorControls(),
    sink,
    "image_generator_runs.controls",
  );
}

export function storedRunProviderInputs(
  row: ImageGeneratorRunRow,
  sink?: DiagnosticSink,
): Record<string, string | number | boolean> {
  return parseOr(
    imageGeneratorProviderInputsSchema,
    row.providerInputs,
    emptyImageGeneratorProviderInputs(),
    sink,
    "image_generator_runs.provider_inputs",
  );
}

/**
 * The attempt provenance, read out of the meta bag where the runner writes it
 * beside `outcome` and `renderFailure` — a per-run record, not a queryable
 * fact. Absent stays a quiet null; unparseable costs the field, never the row.
 */
function storedRunAttempt(row: ImageGeneratorRunRow, sink?: DiagnosticSink): Record<string, unknown> | null {
  return storedMetaRecord(row, "attempt", sink);
}

/**
 * The provider attempt history, out of the same meta bag.
 *
 * A LIST rather than a record, and read with its own parse for that reason
 * alone — everything else about it follows `attempt`: absent (every run that
 * created one prediction) is a quiet null, and a bag that no longer parses costs
 * the field rather than the row.
 */
function storedProviderAttempts(
  row: ImageGeneratorRunRow,
  sink?: DiagnosticSink,
): Record<string, unknown>[] | null {
  const raw = imageMeta(row.meta)["providerAttempts"];
  if (raw === undefined || raw === null) return null;
  return parseOrNull(storedAttemptListSchema, raw, sink, "image_generator_runs.meta.providerAttempts");
}

/**
 * What came back, with the run's per-prediction outcomes folded in.
 *
 * `outputs` is stored at the TOP of the meta bag, beside `attempt` and
 * `providerAttempts`, because it is the run's own account of its passes rather
 * than a detail of any one of them. It travels to the client inside `result`
 * for one reason: `result` is a loose `z.record` on the wire and a first-class
 * field would be a contract change, while the record itself is exactly "what
 * came back". Promoting it to its own wire member later moves this one line.
 */
function storedRunResult(row: ImageGeneratorRunRow, sink?: DiagnosticSink): Record<string, unknown> | null {
  const result = storedMetaRecord(row, "result", sink);
  const outputs = imageGeneratorRunOutputs(imageMeta(row.meta)["outputs"]);
  if (outputs.length === 0) return result;
  return { ...result, outputs };
}

/** One loose per-run record out of the meta bag, on the same forgiving terms. */
function storedMetaRecord(
  row: ImageGeneratorRunRow,
  key: string,
  sink?: DiagnosticSink,
): Record<string, unknown> | null {
  const raw = imageMeta(row.meta)[key];
  if (raw === undefined || raw === null) return null;
  return parseOrNull(storedAttemptSchema, raw, sink, `image_generator_runs.meta.${key}`);
}

/**
 * The version request recorded at create.
 *
 * Absent means `current` — every run written before the choice existed followed
 * the registry's pin, which is exactly what `current` names. A bag that cannot
 * be read degrades the same way rather than inventing a replay.
 */
export function storedVersionRequest(row: ImageGeneratorRunRow): ImageGeneratorVersionRequest {
  const parsed = versionRequestSchema.safeParse(imageMeta(row.meta)["versionRequest"]);
  return parsed.success ? parsed.data : { mode: "current", sourceRunId: null };
}

export interface ImageGeneratorVersionRequest {
  mode: ImageGeneratorVersionPolicy;
  /** The run whose captured version is being replayed, as the client named it. */
  sourceRunId: string | null;
}

const versionRequestSchema = z.object({
  mode: imageGeneratorVersionPolicySchema,
  sourceRunId: z.string().min(1).nullable().default(null),
});

/**
 * One meta write, over whatever the bag already held — merged, never assigned,
 * so a settle cannot drop the pre-spend outcome record written moments before.
 */
export function generatorRunMeta(row: ImageGeneratorRunRow, written: Record<string, unknown>): Record<string, unknown> {
  return { ...imageMeta(row.meta), ...written };
}

/** One run, matched on `(id, owner)` — the authorization root. */
export async function ownedGeneratorRun(runId: string, ownerId: string): Promise<ImageGeneratorRunRow | null> {
  const [row] = await db()
    .select()
    .from(imageGeneratorRuns)
    .where(and(eq(imageGeneratorRuns.id, runId), eq(imageGeneratorRuns.ownerId, ownerId)))
    .limit(1);
  return row ?? null;
}

/** This admin's runs, newest first. */
export async function listImageGeneratorRuns(
  ownerId: string,
  limit = RUN_LIST_DEFAULT_LIMIT,
  sink?: DiagnosticSink,
): Promise<ImageGeneratorRun[]> {
  const bounded = Math.min(Math.max(1, limit), RUN_LIST_MAX_LIMIT);
  const rows = await db()
    .select()
    .from(imageGeneratorRuns)
    .where(eq(imageGeneratorRuns.ownerId, ownerId))
    .orderBy(desc(imageGeneratorRuns.createdAt))
    .limit(bounded);
  return rows.map((row) => toWireImageGeneratorRun(row, sink));
}

/**
 * One run. Null when it is not this owner's — indistinguishable from never
 * having existed, so the route never confirms a foreign run.
 */
export async function getImageGeneratorRunDetail(
  runId: string,
  ownerId: string,
  sink?: DiagnosticSink,
): Promise<ImageGeneratorRun | null> {
  const row = await ownedGeneratorRun(runId, ownerId);
  return row ? toWireImageGeneratorRun(row, sink) : null;
}

// ---------------------------------------------------------------------------
// Creating
// ---------------------------------------------------------------------------

export interface CreateImageGeneratorRunInput {
  ownerId: string;
  request: ImageGeneratorCreateRunRequest;
  sink?: DiagnosticSink;
}

export type CreateImageGeneratorRunResult =
  | { ok: true; run: ImageGeneratorRunRow }
  | { ok: false; refusal: { code: string; message: string } };

/**
 * Record one pending run. The MODEL is resolved here — by registry id, the
 * only create-time fact the row cannot exist without, because `model_slug` is
 * a snapshot and there is nothing to snapshot from a row that is not there.
 * Every other fact (pin, capacity, bindings, readable inputs) is deliberately
 * a runner check so the failed attempt lands on the run row.
 *
 * A `sourceRunId` that is not this owner's degrades to null with a diagnostic
 * rather than refusing: lineage is provenance metadata, and a stale prefill
 * must not cost the admin the run — but a foreign id must never be written
 * where the FK would confirm it exists.
 */
export async function createImageGeneratorRun(
  input: CreateImageGeneratorRunInput,
): Promise<CreateImageGeneratorRunResult> {
  const { ownerId, request, sink } = input;
  const model = await loadImageModel(request.modelId);
  if (!model) {
    sink?.push(
      diag("warn", "image_generator.model_missing", "no registered image model matches the requested id", {
        context: { modelId: request.modelId },
      }),
    );
    return { ok: false, refusal: { code: "model_missing", message: "no registered image model matches that id" } };
  }

  let sourceRunId: string | null = null;
  if (request.sourceRunId !== undefined) {
    const source = await ownedGeneratorRun(request.sourceRunId, ownerId);
    if (source) {
      sourceRunId = source.id;
    } else {
      sink?.push(
        diag("info", "image_generator.source_run_missing", "the run this one duplicates no longer exists; lineage dropped", {
          context: { sourceRunId: request.sourceRunId },
        }),
      );
    }
  }

  // The version choice is recorded as REQUESTED, not as resolved: whether the
  // captured version can still be replayed safely depends on the source run's
  // stored capability snapshot, and that is a runtime fact the runner settles
  // onto the row. Writing the requested id even when the lineage FK dropped it
  // keeps the refusal able to name what was asked for.
  const versionRequest = {
    mode: request.versionPolicy ?? "current",
    sourceRunId: request.sourceRunId ?? null,
  } satisfies ImageGeneratorVersionRequest;

  const [row] = await db()
    .insert(imageGeneratorRuns)
    .values({
      ownerId,
      modelSlug: model.slug,
      prompt: request.prompt,
      inputs: request.inputs ?? emptyImageGeneratorRunInputs(),
      controls: request.controls ?? emptyImageGeneratorControls(),
      providerInputs: request.providerInputs ?? emptyImageGeneratorProviderInputs(),
      sourceRunId,
      meta: { versionRequest },
    })
    .returning();
  if (!row) throw new Error("image_generator_runs insert returned no row");
  return { ok: true, run: row };
}

// ---------------------------------------------------------------------------
// Settling and deleting
// ---------------------------------------------------------------------------

/**
 * Claim one pending run for THIS worker, atomically.
 *
 * A conditional `UPDATE … WHERE status = 'pending'` with a returning row, not a
 * read-then-write: two deliveries of the same job would both read `pending`
 * under READ COMMITTED and both go on to buy a prediction, and one immutable
 * run must never be charged twice. Postgres serializes the two updates on the
 * row, so exactly one of them sees a `pending` row to change and the loser gets
 * nothing back.
 *
 * Returns the row AS CLAIMED, so the caller works from the same values the
 * claim wrote rather than from a pre-claim read.
 */
export async function claimGeneratorRun(runId: string, ownerId: string): Promise<ImageGeneratorRunRow | null> {
  const [claimed] = await db()
    .update(imageGeneratorRuns)
    .set({ status: "running", startedAt: new Date() })
    .where(
      and(
        eq(imageGeneratorRuns.id, runId),
        eq(imageGeneratorRuns.ownerId, ownerId),
        eq(imageGeneratorRuns.status, "pending"),
      ),
    )
    .returning();
  return claimed ?? null;
}

/** Extra columns, extra meta members, and the breaker report one settle contributes. */
export interface GeneratorSettleExtras {
  columns?: Partial<typeof imageGeneratorRuns.$inferInsert>;
  meta?: Record<string, unknown>;
  /** Absent means `null` — the right report for every refusal that stops before the call. */
  providerOutcome?: ImageGeneratorProviderOutcome;
}

/**
 * Settle one run `failed`: the dotted code on the row, the detail in `error`,
 * and a diagnostic beside both. `meta` merges over the stored bag so the
 * pre-spend outcome record survives the settle that follows it.
 */
export async function settleGeneratorRunFailed(
  row: ImageGeneratorRunRow,
  failureCode: string,
  message: string,
  sink?: DiagnosticSink,
  extras: GeneratorSettleExtras = {},
): Promise<ImageGeneratorRunPayload> {
  sink?.push(diag("warn", failureCode, message.slice(0, 300), { context: { runId: row.id } }));
  // Guarded on `running`, like the success settle's own returning check: only
  // the worker holding the claim may settle, and a row already settled (or
  // deleted mid-flight) is left exactly as it is. A settled run is immutable
  // evidence, and the guard is what makes that true in the database rather than
  // only in the absence of a route that would rewrite it.
  await db()
    .update(imageGeneratorRuns)
    .set({
      ...extras.columns,
      status: "failed",
      failureCode,
      error: message.slice(0, 2000),
      finishedAt: new Date(),
      ...(extras.meta ? { meta: generatorRunMeta(row, extras.meta) } : {}),
    })
    .where(
      and(
        eq(imageGeneratorRuns.id, row.id),
        eq(imageGeneratorRuns.ownerId, row.ownerId),
        eq(imageGeneratorRuns.status, "running"),
      ),
    );
  return { runId: row.id, status: "failed", failureCode, providerOutcome: extras.providerOutcome ?? null };
}

export interface DeleteImageGeneratorRunResult {
  deleted: boolean;
  outputImagesRemoved: number;
}

export interface DeleteImageGeneratorRunsResult {
  /** Rows actually removed — ids that were never this admin's are simply absent. */
  deleted: number;
  outputImagesRemoved: number;
}

/**
 * Every image one run stored: the column that names the first, plus the
 * siblings a fan-out recorded in `meta.outputs`.
 *
 * The column alone is not enough once a run can produce several images. It
 * names the FIRST — the thumbnail, the lineage pointer, the FK-SET-NULL
 * target — and the rest are ordinary `generator_output` rows whose only pointer
 * is the run's own record of its passes. Read leniently: a meta bag too damaged
 * to describe itself costs the sweep those ids, and the periodic image sweep
 * reconciles what is left rather than the delete refusing.
 */
function runOutputImageIds(row: { resultImageId: string | null; meta: unknown }): string[] {
  const siblings = imageGeneratorRunOutputImageIds(imageGeneratorRunOutputs(imageMeta(row.meta)["outputs"]));
  return row.resultImageId === null ? siblings : [row.resultImageId, ...siblings];
}

/**
 * Hard-delete a set of runs and the renders they produced — outputs FIRST,
 * exactly as the Lab's delete orders it: a row is the only pointer to its
 * hidden images, so a crash between the two steps leaves an FK-nulled pointer
 * that a re-run cleans, never an orphaned `generator_output` nothing can find.
 * `pending`/`running` rows stay deletable on purpose (a deploy can strand one);
 * an in-flight settle matches nothing and discards its own outputs.
 *
 * Owner-scoped in both statements, so a crafted list of ids reaches only the
 * caller's own rows — a foreign id is not an error, it is simply not there.
 * Ids are de-duplicated, because a repeated id would otherwise be counted twice
 * against the number of rows the caller is told went away.
 */
export async function deleteImageGeneratorRuns(
  runIds: readonly string[],
  ownerId: string,
): Promise<DeleteImageGeneratorRunsResult> {
  const ids = [...new Set(runIds)];
  if (ids.length === 0) return { deleted: 0, outputImagesRemoved: 0 };

  // `meta` rides along in the same SELECT rather than a second read: the
  // sibling outputs of a fan-out live nowhere else, and a run deleted between
  // two reads would take them with it as orphans.
  const owned = await db()
    .select({
      id: imageGeneratorRuns.id,
      resultImageId: imageGeneratorRuns.resultImageId,
      meta: imageGeneratorRuns.meta,
    })
    .from(imageGeneratorRuns)
    .where(and(inArray(imageGeneratorRuns.id, ids), eq(imageGeneratorRuns.ownerId, ownerId)));
  if (owned.length === 0) return { deleted: 0, outputImagesRemoved: 0 };

  const ownedIds = owned.map((row) => row.id);
  const seenOutputs = [...new Set(owned.flatMap(runOutputImageIds))];
  const outputsRemoved = await deleteOwnedImages(seenOutputs, ownerId, { kind: "generator_output" });

  const removed = await db()
    .delete(imageGeneratorRuns)
    .where(and(inArray(imageGeneratorRuns.id, ownedIds), eq(imageGeneratorRuns.ownerId, ownerId)))
    .returning({ resultImageId: imageGeneratorRuns.resultImageId, meta: imageGeneratorRuns.meta });

  // A render that settled BETWEEN the read above and this delete attached
  // outputs the read could not see, and its own settle succeeded (the row was
  // still `running`), so it kept them. The delete's own RETURNING is the only
  // view of the rows as they finally stood; without this those images would
  // survive with nothing pointing at them, invisible to every listing and to the
  // sweep, which only reconciles rows whose file vanished.
  const known = new Set(seenOutputs);
  const late = [...new Set(removed.flatMap(runOutputImageIds))].filter((id) => !known.has(id));
  const lateRemoved = await deleteOwnedImages(late, ownerId, { kind: "generator_output" });
  return { deleted: removed.length, outputImagesRemoved: outputsRemoved + lateRemoved };
}

/** One run and the render it produced — {@link deleteImageGeneratorRuns} of one. */
export async function deleteImageGeneratorRun(runId: string, ownerId: string): Promise<DeleteImageGeneratorRunResult> {
  const { deleted, outputImagesRemoved } = await deleteImageGeneratorRuns([runId], ownerId);
  return { deleted: deleted > 0, outputImagesRemoved };
}
