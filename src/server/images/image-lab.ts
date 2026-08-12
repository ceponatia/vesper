import { and, asc, desc, eq } from "drizzle-orm";
import { z } from "zod";
import {
  chooseAspect,
  effectiveImageLoraSelection,
  emptyImageLabSettings,
  imageLabControlMetaSchema,
  imageLabDiagnosticCode,
  imageLabFinishingRecipeProfile,
  imageLabFinishingVariantSchema,
  imageLabInputListSchema,
  imageLabOutcomeSchema,
  imageLabRecipeProfile,
  imageLabSettingsSchema,
  IMAGE_LAB_FINISHING_IDENTITY_STRATEGY,
  IMAGE_TARGET_ASPECT,
  isImageLabControlRole,
  isImageLabFinishableKind,
  isImageLabVerdictForKind,
  isImageLabVerdictKind,
  profileEligibility,
  referenceCapacity,
  type ImageLabControlledKind,
  type ImageLabCreateExperimentRequest,
  type ImageLabExperiment,
  type ImageLabFailureCode,
  type ImageLabFinishingVariant,
  type ImageLabInput,
  type ImageLabInputList,
  type ImageLabOutcome,
  type ImageLabRecordVerdictRequest,
  type ImageLabSettings,
  type ImageLoraRenderBinding,
  type ImageModel,
  type ImageModelProfile,
  type ImageProfileTask,
  type ImageReferenceRole,
  type ImageRenderControls,
  type ResolvedImageProfile,
} from "@/contracts";
import { diag, type DiagnosticSink } from "@/contracts/diagnostics";
import { imageLabFinishingInstruction } from "@/lib/images/image-lab-instruction";
import { parseOr, parseOrNull } from "@/lib/parse";
import {
  classifyImageFailure,
  imageFailureHealthOutcome,
  mapImageRenderControls,
  REPLICATE_DEFAULT_EDIT_MODEL,
  runRegistryImageModel,
} from "../ai";
import { characterChats, characters, chatParticipants, db, imageLabExperiments, images } from "../db";
import { createImageAsset, deleteOwnedImage, imageMeta, readImageBytes, saveImageBuffer, type ImageRow } from "./assets";
import { evaluateIdentityPackForProfile } from "./identity-pack-references";
import { resolveImageLoraForRender } from "./image-loras";
import { loadImageModels, type RenderWithModelResult } from "./models";
import { resolveImageProfileForTask } from "./model-profiles";
import { baseImageModelSlug, withReviewedImageQuality } from "./quality-presets";
import {
  planImageRender,
  renderImageIntent,
  type ImageRenderIntent,
  type ImageRenderReference,
  type PlannedImageRender,
} from "./render-intent";
import { pinnedImageModelVersion } from "./render-profile";

/**
 * The Advanced Image Lab's experiment service
 * (qwen-advanced-image-subsystem.spec.md §Algorithms, §Persistence).
 *
 * One experiment is one deliberate render whose every input, setting and outcome
 * is written down. The bench exists because a question nobody can answer from a
 * provider schema — "does this model actually honour a pose skeleton?" — gets
 * settled by evidence, and evidence needs a record of what was sent.
 *
 * THE ownership rule, which every function here keeps: the lab writes
 * `image_lab_experiments` rows and `lab_output` images and nothing else. It
 * never touches `characters`, `chats`, identity packs, or a non-lab image row,
 * and it never enqueues a lane's own job type. A lab run leaves the app exactly
 * as it found it, minus one hidden image and one row.
 *
 * Stage 0 renders bypass the render-intent path for `control_probe` (spec
 * §"Rulings this build settles"): the runner calls `runRegistryImageModel`
 * directly with an explicit ordered reference list and a pinned `versionId`,
 * a ruling made while the capabilities plan's role-aware selection did not
 * exist and kept for the probe because an exact ordered list is what a probe
 * IS. The two BASELINE kinds do the opposite on purpose — they go through the
 * very path their lane goes through, since a baseline that compiled its
 * settings some other way would not be a baseline. The two CONTROLLED kinds
 * ride that same intent path but pin the exact version and run a code-defined
 * recipe profile (`imageLabRecipeProfile`), because their question is whether
 * the control still holds when the request is production-shaped — and a
 * controlled comparison must be able to name what it executed. `finishing_pass`
 * runs the same way over a different pair of references: another experiment's
 * RESULT under the `before` role, plus the subject's identity-pack references,
 * under an instruction that forbids every change but the face.
 *
 * The job seam lives at the ROUTE, not here: `@/server/api` imports
 * `@/server/images`, so a `startJob` call from this module would close an import
 * cycle (`pnpm lint:cycles`). Every other image lane is arranged the same way —
 * the route starts the job, the service is the body of it. Which is also why
 * every run reports a {@link ImageLabProviderOutcome} in its payload rather than
 * calling the breaker itself: the breaker lives on the other side of that
 * boundary, and the route is where the two meet.
 */

export type ImageLabExperimentRow = typeof imageLabExperiments.$inferSelect;

/** A refusal reported to the admin as a 400: nothing was stored, nothing spent. */
export interface ImageLabRefusal {
  code: string;
  message: string;
}

/**
 * One refusal, in the shape the identity-pack trial settled: the envelope
 * carries the BARE code — the token a client narrows on — and the dotted
 * `image_lab.` spelling is the diagnostic sink's alone. A wire code a client had
 * to strip a namespace off would be a sink's spelling read off a wire.
 */
function labRefusal(
  code: string,
  message: string,
  sink: DiagnosticSink | undefined,
  context: Record<string, unknown>,
): ImageLabRefusal {
  sink?.push(diag("warn", `image_lab.${code}`, message, { context }));
  return { code, message };
}

/**
 * What one lab run proved about the image provider lane, in the circuit
 * breaker's vocabulary (`startJob`'s `reportProviderOutcome` →
 * `recordProviderOutcome`).
 *
 * `null` — say nothing — is the answer for most of this module, and the reason
 * the channel exists at all. Every stop here is a SETTLED ROW rather than a
 * throw, so the runner's promise resolves whether Replicate answered, refused,
 * or was never called; read as an outcome, that resolution would report a
 * healthy provider for a dead one and would close a tripped breaker on the
 * strength of a probe that only ever touched this database.
 */
export type ImageLabProviderOutcome = boolean | null;

/**
 * The record one lab run returns: the human-readable payload the `jobs` row
 * carries, plus what the run told the breaker. The route reports the second and
 * stores the whole thing, so the job row also says what was reported.
 */
export interface ImageLabRunPayload extends Record<string, unknown> {
  providerOutcome: ImageLabProviderOutcome;
}

/**
 * The codes this runner needs beyond {@link ImageLabFailureCode}'s own.
 *
 * The contract deliberately types `failureCode` as a bounded string rather than
 * that enum, "because it also carries codes from the render-failure classifier"
 * — the same reason applies here. Each of these names a state the contract's
 * codes cannot: a task the profile registry offers nothing for, and a runner
 * that died on something other than a provider call. Inventing another enum
 * member for each would freeze them into the wire contract, where a UI would
 * have to know about a state it can only display verbatim anyway.
 *
 * A third code, `image_lab.kind_unsupported`, is gone as of Stage 3: it existed
 * while `finishing_pass` was declared but unbuilt, and every declared kind now
 * has a runner arm, which the exhaustive dispatch below enforces at compile
 * time rather than at run time.
 *
 * Dotted, because every one of them is written to a settled ROW or a sink. A
 * refusal envelope spells its code bare — see {@link labRefusal}.
 */
const LAB_PROFILE_UNAVAILABLE = "image_lab.profile_unavailable";
const LAB_RUN_THREW = "image_lab.run_threw";

/** How many experiments the lab page lists. */
const EXPERIMENT_LIST_LIMIT = 50;

// ---------------------------------------------------------------------------
// The renderer seam
// ---------------------------------------------------------------------------

/**
 * What a lab render asks for, in the two shapes Stage 0 has.
 *
 * `direct` is the probe: an explicit ordered reference list, a pinned version,
 * and a payload the runner built itself. `intent` is a baseline: the lane's own
 * compiled intent, handed to the lane's own render entry point.
 *
 * ONE seam covers both so a test stubs one function and reaches every outcome —
 * two seams would mean an integration suite could stub the probe and still hit
 * Replicate on a baseline.
 */
export type ImageLabRenderRequest =
  | {
      mode: "direct";
      /** Post reviewed-quality overlay — what the provider really sees. */
      model: ImageModel;
      prompt: string;
      references: Buffer[];
      controlInput: Record<string, unknown>;
      aspect: string | null;
      versionId: string;
    }
  | { mode: "intent"; intent: ImageRenderIntent };

export type ImageLabRenderer = (request: ImageLabRenderRequest, sink?: DiagnosticSink) => Promise<RenderWithModelResult>;

/**
 * Test-only override; `null` restores the real render. Process-local — the
 * `setTrialRendererForTesting` seam shape, for the same reason: the integration
 * suite must drive every outcome without a provider call.
 */
let injectedRenderer: ImageLabRenderer | null = null;

export function setImageLabRendererForTesting(renderer: ImageLabRenderer | null): void {
  injectedRenderer = renderer;
}

/**
 * The real renderer maps each mode straight onto its transport, field for field.
 * That is deliberate: the moment this seam starts deciding anything, what a test
 * captures stops being evidence of what the provider was sent.
 */
function runRealLabRender(request: ImageLabRenderRequest, sink?: DiagnosticSink): Promise<RenderWithModelResult> {
  switch (request.mode) {
    case "direct":
      return runRegistryImageModel(
        request.model,
        {
          prompt: request.prompt,
          references: request.references,
          aspect: request.aspect,
          controlInput: request.controlInput,
          versionId: request.versionId,
        },
        sink,
      );
    case "intent":
      return renderImageIntent(request.intent, sink);
  }
}

function labRenderer(): ImageLabRenderer {
  return injectedRenderer ?? runRealLabRender;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * One stored row as the routes report it.
 *
 * Both jsonb columns cross `parseOr` (docs/resilience.md §1): a settings bag
 * that no longer parses costs the experiment its knobs in the display, never the
 * page. The enum columns need no parse — the database constrains them — and
 * `ownerId` is deliberately absent, because every lab surface is owner-scoped by
 * its route and the owner id would be a fact the client already knows travelling
 * where it can only leak.
 */
function toWireExperiment(row: ImageLabExperimentRow, sink?: DiagnosticSink): ImageLabExperiment {
  return {
    id: row.id,
    kind: row.kind,
    mode: row.mode,
    characterId: row.characterId,
    chatId: row.chatId,
    modelSlug: row.modelSlug,
    requestedVersionId: row.requestedVersionId,
    executedVersionId: row.executedVersionId,
    profileId: row.profileId,
    instruction: row.instruction,
    finalPrompt: row.finalPrompt,
    inputs: storedInputs(row, sink),
    controlImageId: row.controlImageId,
    controlKind: row.controlKind,
    settings: storedSettings(row, sink),
    resultImageId: row.resultImageId,
    outcome: storedOutcome(row, sink),
    sourceExperimentId: storedSourceExperimentId(row, sink),
    finishingVariant: storedFinishingVariant(row, sink),
    status: row.status,
    failureCode: row.failureCode,
    verdict: row.verdict,
    verdictNote: row.verdictNote,
    predictionId: row.predictionId,
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
  };
}

/**
 * The stored order, degraded to `[]`.
 *
 * Parsed with the STRICT list schema through `parseOr` rather than the
 * contract's `.catch`-carrying read-back schema, so a malformed order produces a
 * diagnostic as well as the empty default. The `.catch` variant is for a client
 * re-parsing a wire experiment, where there is nobody to tell.
 */
function storedInputs(row: ImageLabExperimentRow, sink?: DiagnosticSink): ImageLabInputList {
  return parseOr(imageLabInputListSchema, row.inputs, [], sink, "image_lab_experiments.inputs");
}

function storedSettings(row: ImageLabExperimentRow, sink?: DiagnosticSink): ImageLabSettings {
  return parseOr(imageLabSettingsSchema, row.settings, emptyImageLabSettings(), sink, "image_lab_experiments.settings");
}

/**
 * The recorded reference-plan outcome, read out of the row's meta bag — where
 * the runner writes it, beside `error` and `renderFailure`, rather than in a
 * column of its own: it is a per-run record like those, not a queryable fact.
 * Absent means the row predates the field (every Stage 0 row) and stays a quiet
 * null; a bag that no longer parses costs the field with a diagnostic, never
 * the row.
 */
function storedOutcome(row: ImageLabExperimentRow, sink?: DiagnosticSink): ImageLabOutcome | null {
  const raw = imageMeta(row.meta)["outcome"];
  if (raw === undefined || raw === null) return null;
  return parseOrNull(imageLabOutcomeSchema, raw, sink, "image_lab_experiments.meta.outcome");
}

const sourceExperimentIdSchema = z.string().min(1);

/**
 * The experiment a finishing pass refines, read out of the same meta bag.
 *
 * It lives there rather than in a column because the row already had a bag for
 * per-experiment facts and Stage 3 wanted no migration — but that put one
 * requirement on the runner, which {@link labMeta} carries: this key is written
 * at CREATE and every later write to the bag has to preserve it, or the pointer
 * would survive exactly until the run that used it settled.
 */
function storedSourceExperimentId(row: ImageLabExperimentRow, sink?: DiagnosticSink): string | null {
  const raw = imageMeta(row.meta)["sourceExperimentId"];
  if (raw === undefined || raw === null) return null;
  return parseOrNull(sourceExperimentIdSchema, raw, sink, "image_lab_experiments.meta.sourceExperimentId");
}

/**
 * The arm a finishing pass DECLARED, or null when it declared none — the wire
 * field, which reports the record rather than the runner's reading of it.
 *
 * Absent is a real state and is reported as one: every Stage 3 row predates the
 * vocabulary, and writing today's default into their display would claim they
 * chose an arm nobody offered them. {@link finishingPassVariant} is where that
 * absence becomes a decision, once, at the point the recipe is chosen.
 */
function storedFinishingVariant(row: ImageLabExperimentRow, sink?: DiagnosticSink): ImageLabFinishingVariant | null {
  const raw = imageMeta(row.meta)["finishingVariant"];
  if (raw === undefined || raw === null) return null;
  return parseOrNull(imageLabFinishingVariantSchema, raw, sink, "image_lab_experiments.meta.finishingVariant");
}

/**
 * The arm this pass RUNS: the declared one, or `identity` when the row declares
 * none — which is every row written before Stage 5, and every pass created
 * without asking for the isolating arm.
 *
 * An unreadable value degrades to `identity` rather than failing the run
 * (docs/resilience.md §1), and the degradation is honest rather than silent: the
 * recipe key recorded on the outcome is the identity arm's, so a reader of that
 * record sees the run it actually got. `storedFinishingVariant` has already
 * reported the unparseable value to the sink by the time the fallback applies.
 */
function finishingPassVariant(row: ImageLabExperimentRow, sink?: DiagnosticSink): ImageLabFinishingVariant {
  return storedFinishingVariant(row, sink) ?? "identity";
}

/**
 * One meta write, over whatever the bag already held.
 *
 * Every settle in this module writes `meta` as a whole value, so an assignment
 * would silently drop the create-time keys — which was harmless while the bag
 * held nothing but the settle's own record, and is not harmless now that a
 * finishing pass's `sourceExperimentId` rides in it. Merging costs nothing for
 * the kinds that write no create-time meta (their stored bag is `{}`) and keeps
 * the pointer readable after the row settles, which is when the detail screen
 * asks for it.
 */
function labMeta(row: ImageLabExperimentRow, written: Record<string, unknown>): Record<string, unknown> {
  return { ...imageMeta(row.meta), ...written };
}

/** One experiment, matched on `(id, owner)` — the authorization root. */
async function ownedExperiment(experimentId: string, ownerId: string): Promise<ImageLabExperimentRow | null> {
  const [row] = await db()
    .select()
    .from(imageLabExperiments)
    .where(and(eq(imageLabExperiments.id, experimentId), eq(imageLabExperiments.ownerId, ownerId)))
    .limit(1);
  return row ?? null;
}

/** This admin's experiments, newest first. */
export async function listImageLabExperiments(ownerId: string, sink?: DiagnosticSink): Promise<ImageLabExperiment[]> {
  const rows = await db()
    .select()
    .from(imageLabExperiments)
    .where(eq(imageLabExperiments.ownerId, ownerId))
    .orderBy(desc(imageLabExperiments.createdAt))
    .limit(EXPERIMENT_LIST_LIMIT);
  return rows.map((row) => toWireExperiment(row, sink));
}

/**
 * One experiment. Null when it is not this owner's — indistinguishable from
 * never having existed, so the route never confirms a foreign experiment.
 */
export async function getImageLabExperimentDetail(
  experimentId: string,
  ownerId: string,
  sink?: DiagnosticSink,
): Promise<ImageLabExperiment | null> {
  const row = await ownedExperiment(experimentId, ownerId);
  return row ? toWireExperiment(row, sink) : null;
}

// ---------------------------------------------------------------------------
// Creating
// ---------------------------------------------------------------------------

export interface CreateImageLabExperimentInput {
  ownerId: string;
  request: ImageLabCreateExperimentRequest;
  sink?: DiagnosticSink;
}

export type CreateImageLabExperimentResult =
  | { ok: true; experiment: ImageLabExperiment }
  | { ok: false; refusal: ImageLabRefusal };

/**
 * Record one experiment. The ROUTE starts the job that runs it (see the module
 * note), so a created experiment is `pending` until that job claims it.
 *
 * Two things are checked here and nowhere else, both because they are
 * authorization rather than configuration: a named character and a named chat
 * must be THIS owner's. `image_lab_experiments` has plain foreign keys with no
 * owner constraint, so without these an admin could point a baseline at someone
 * else's chat and have the runner read its look anchor.
 *
 * Deliberately NOT checked: that a probe carries any particular inputs, that it
 * names a control at all, or that the control it names is a real fixture. Those
 * are the runner's recorded refusals (spec §Algorithms steps 1 and 3) — a 400
 * there would leave no trace of the attempt, and the whole point of the bench is
 * that attempts leave traces. (The request SCHEMA does refuse a declaration that
 * contradicts its own inputs, which is a client bug rather than an attempt, and
 * the runner re-checks it anyway for rows that predate the rule.)
 */
export async function createImageLabExperiment(
  input: CreateImageLabExperimentInput,
): Promise<CreateImageLabExperimentResult> {
  const { ownerId, request, sink } = input;
  if (request.characterId !== undefined && !(await ownsCharacter(request.characterId, ownerId))) {
    return {
      ok: false,
      refusal: labRefusal("character_not_found", "character not found", sink, { characterId: request.characterId }),
    };
  }
  if (request.chatId !== undefined && !(await ownsChat(request.chatId, ownerId))) {
    return { ok: false, refusal: labRefusal("chat_not_found", "chat not found", sink, { chatId: request.chatId }) };
  }

  // A finishing pass is defined by the run it refines, so the source is resolved
  // BEFORE the row exists: its subject is inherited from that run, and an
  // experiment stored against a source that cannot be finished would be a queued
  // render that can only fail. The runner re-checks all of it anyway (rows
  // outlive their sources), so this is speed of feedback, not the authority.
  const source = request.sourceExperimentId === undefined ? null : await ownedExperiment(request.sourceExperimentId, ownerId);
  if (request.sourceExperimentId !== undefined) {
    const refusal = sourceRefusal(request.sourceExperimentId, source, sink);
    if (refusal) return { ok: false, refusal };
  }

  const [row] = await db()
    .insert(imageLabExperiments)
    .values({
      ownerId,
      kind: request.kind,
      mode: request.mode ?? null,
      // Inherited from the source on a finishing pass (the request carries
      // neither, per the create schema): the two arms of one comparison must file
      // against the same subject, and a client that could name a third would be
      // able to file the finished render under someone else entirely.
      characterId: request.characterId ?? source?.characterId ?? null,
      chatId: request.chatId ?? source?.chatId ?? null,
      // The model the plan is about. A named slug is how the fallback connector
      // gets probed if the first verdict reads `ignores_control`.
      modelSlug: request.modelSlug ?? REPLICATE_DEFAULT_EDIT_MODEL,
      instruction: request.instruction,
      inputs: request.inputs,
      controlImageId: request.controlImageId ?? null,
      controlKind: request.controlKind ?? null,
      settings: request.settings ?? emptyImageLabSettings(),
      // The create-time meta keys, both a finishing pass's: the run it refines
      // and the arm it runs. Written here and preserved by every later write
      // through `labMeta`.
      ...createMeta(request),
      status: "pending",
    })
    .returning();
  if (!row) throw new Error("image_lab_experiments insert returned no row");
  return { ok: true, experiment: toWireExperiment(row, sink) };
}

/**
 * The `meta` column a create writes, or nothing at all.
 *
 * Only a finishing pass has create-time meta (the create schema refuses both keys
 * on every other kind), so most inserts contribute no `meta` key whatsoever and
 * take the column's own `{}` default. Spread rather than assigned for that
 * reason: writing `meta: {}` on every kind would be an empty bag standing where
 * "this row never had create-time facts" is the truth.
 *
 * The variant is stored EXACTLY as sent, including an explicit `"identity"`. A
 * request that names its arm is a request that made a choice, and flattening the
 * chosen default into an absence would lose the one fact distinguishing a Stage 5
 * identity arm from a Stage 3 pass that predates the question.
 */
function createMeta(request: ImageLabCreateExperimentRequest): { meta?: Record<string, unknown> } {
  const meta: Record<string, unknown> = {};
  if (request.sourceExperimentId !== undefined) meta.sourceExperimentId = request.sourceExperimentId;
  if (request.finishingVariant !== undefined) meta.finishingVariant = request.finishingVariant;
  return Object.keys(meta).length === 0 ? {} : { meta };
}

/**
 * Why this experiment cannot be finished — or `null` when it can.
 *
 * Three separate answers rather than one, because they ask three different
 * things of the admin: find the right id, pick a different experiment, or wait
 * for (and fix) a run that has not produced an image. One shared "invalid
 * source" would tell them none of that.
 *
 * A source that is not this owner's is reported as missing, exactly as the
 * detail route reports a foreign experiment: the refusal must not confirm that
 * someone else's id exists.
 */
function sourceRefusal(
  sourceExperimentId: string,
  source: ImageLabExperimentRow | null,
  sink: DiagnosticSink | undefined,
): ImageLabRefusal | null {
  const context = { sourceExperimentId };
  if (!source) {
    return labRefusal("source_not_found", "the experiment this pass would refine was not found", sink, context);
  }
  if (!isImageLabFinishableKind(source.kind)) {
    return labRefusal(
      "source_kind_unsupported",
      `a ${source.kind} cannot be finished; a finishing pass refines a baseline or a controlled run`,
      sink,
      { ...context, sourceKind: source.kind },
    );
  }
  if (source.status !== "succeeded" || source.resultImageId === null) {
    return labRefusal(
      "source_not_rendered",
      "that experiment has no result image to refine yet",
      sink,
      { ...context, sourceStatus: source.status },
    );
  }
  return null;
}

async function ownsCharacter(characterId: string, ownerId: string): Promise<boolean> {
  const [row] = await db()
    .select({ id: characters.id })
    .from(characters)
    .where(and(eq(characters.id, characterId), eq(characters.ownerId, ownerId)))
    .limit(1);
  return row !== undefined;
}

async function ownsChat(chatId: string, ownerId: string): Promise<boolean> {
  const [row] = await db()
    .select({ id: characterChats.id })
    .from(characterChats)
    .where(and(eq(characterChats.id, chatId), eq(characterChats.ownerId, ownerId)))
    .limit(1);
  return row !== undefined;
}

// ---------------------------------------------------------------------------
// Verdict, deletion
// ---------------------------------------------------------------------------

export type RecordImageLabVerdictResult =
  | { ok: true; experiment: ImageLabExperiment }
  | { ok: false; refusal: ImageLabRefusal };

/**
 * Record the reviewing admin's ruling.
 *
 * Verdict kinds only (`isImageLabVerdictKind`) — the kinds that ask a question a
 * reviewer can answer — and that restriction is the point of the whole protocol:
 * the verdict answers "did the output obey the skeleton?", which is a judgment
 * made by looking at an image, and a baseline has no control to obey. A ruling
 * recorded against one would be a fact about nothing.
 *
 * The ruling must also belong to THIS kind's vocabulary
 * (`isImageLabVerdictForKind`). The wire request speaks the whole union because
 * it does not know the kind, so this is the one place both facts are in hand —
 * and without the check a finishing pass could be filed `honours_control`,
 * recording a control judgment against a run that sent no control.
 *
 * The verdict is INDEPENDENT of `status`: a `succeeded` render can still be
 * ruled `ignores_control`, which is the most informative outcome the bench can
 * produce. Null when the experiment is not this owner's.
 */
export async function recordImageLabVerdict(
  experimentId: string,
  ownerId: string,
  request: ImageLabRecordVerdictRequest,
  sink?: DiagnosticSink,
): Promise<RecordImageLabVerdictResult | null> {
  const row = await ownedExperiment(experimentId, ownerId);
  if (!row) return null;
  if (!isImageLabVerdictKind(row.kind)) {
    return {
      ok: false,
      refusal: labRefusal("verdict_not_applicable", `a ${row.kind} experiment has nothing to rule on`, sink, {
        experimentId,
        kind: row.kind,
      }),
    };
  }
  if (!isImageLabVerdictForKind(row.kind, request.verdict)) {
    return {
      ok: false,
      refusal: labRefusal(
        "verdict_not_in_vocabulary",
        `${request.verdict} is not a ruling a ${row.kind} experiment can record`,
        sink,
        { experimentId, kind: row.kind, verdict: request.verdict },
      ),
    };
  }
  const [updated] = await db()
    .update(imageLabExperiments)
    .set({ verdict: request.verdict, verdictNote: request.note })
    .where(and(eq(imageLabExperiments.id, experimentId), eq(imageLabExperiments.ownerId, ownerId)))
    .returning();
  if (!updated) return null;
  return { ok: true, experiment: toWireExperiment(updated, sink) };
}

export interface DeleteImageLabExperimentResult {
  deleted: boolean;
  outputImagesRemoved: number;
}

/**
 * Hard-delete one experiment and the render it produced.
 *
 * The OUTPUT goes first, exactly as the trial's delete sweep does: the row is
 * the only pointer to its hidden image, so deleting the row first and crashing
 * would orphan a `lab_output` nothing can find again. Output-first fails safe —
 * a crash leaves the experiment intact with an FK-nulled pointer, and the delete
 * can simply be run again.
 *
 * Control FIXTURES are deliberately untouched. A fixture is shared bench
 * equipment: several experiments cite one skeleton, and deleting the experiment
 * that happened to be deleted last would take the skeleton with it.
 *
 * A `pending` or `running` experiment is deletable, and that is deliberate: a
 * deploy that killed its job leaves a row stuck `running` forever, and refusing
 * to delete one would make that row permanent. The render still in flight
 * settles against nothing and discards its own output (see `storeLabRender`), so
 * the race costs one wasted render rather than one invisible image.
 */
export async function deleteImageLabExperiment(
  experimentId: string,
  ownerId: string,
): Promise<DeleteImageLabExperimentResult> {
  const row = await ownedExperiment(experimentId, ownerId);
  if (!row) return { deleted: false, outputImagesRemoved: 0 };

  const outputRemoved =
    row.resultImageId === null ? false : await deleteOwnedImage(row.resultImageId, ownerId, { kind: "lab_output" });
  await db()
    .delete(imageLabExperiments)
    .where(and(eq(imageLabExperiments.id, experimentId), eq(imageLabExperiments.ownerId, ownerId)));
  return { deleted: true, outputImagesRemoved: outputRemoved ? 1 : 0 };
}

// ---------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------

/**
 * Run one experiment — the body of the `lab_image` job the route starts.
 *
 * NOTHING here throws through the job runner. Every stop is a settled row
 * carrying its reason, because a lab experiment that threw would leave an admin
 * staring at a `pending` record with nothing on it, which is precisely the
 * outcome a bench exists to prevent.
 *
 * The returned record becomes the job row's payload: it is read by a human
 * looking at `jobs`, and by the route for one field — `providerOutcome`, which
 * the settled promise cannot carry, precisely because settling is what this
 * runner does instead of throwing.
 */
export async function runImageLabExperiment(
  experimentId: string,
  ownerId: string,
  sink?: DiagnosticSink,
): Promise<ImageLabRunPayload> {
  const row = await ownedExperiment(experimentId, ownerId);
  if (!row) return { experimentId, skipped: "not_found", providerOutcome: null };
  // A settled experiment is never re-run: its evidence already exists, and a
  // second render under the same id would replace an output the verdict may
  // already be about. A rerun is a new experiment.
  if (row.status !== "pending") return { experimentId, skipped: row.status, providerOutcome: null };

  await db()
    .update(imageLabExperiments)
    .set({ status: "running", startedAt: new Date() })
    .where(and(eq(imageLabExperiments.id, experimentId), eq(imageLabExperiments.ownerId, ownerId)));

  try {
    return await runExperimentOfKind(row, sink);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return await settleFailed(row, LAB_RUN_THREW, message, sink);
  }
}

/**
 * The kind dispatch, EXHAUSTIVE over {@link ImageLabExperimentKind} — so a
 * seventh kind is a compile error here rather than a silent fall-through to
 * whatever the last arm did.
 */
function runExperimentOfKind(row: ImageLabExperimentRow, sink?: DiagnosticSink): Promise<ImageLabRunPayload> {
  switch (row.kind) {
    case "control_probe":
      return runControlProbe(row, sink);
    case "baseline_portrait":
      return runBaseline(row, "variant", sink);
    case "baseline_scene":
      return runBaseline(row, "scene", sink);
    case "controlled_portrait":
    case "controlled_scene":
      return runControlled(row, row.kind, sink);
    case "finishing_pass":
      return runFinishingPass(row, sink);
  }
}

/** Extra columns and extra `meta` members one settle contributes. */
interface SettleExtras {
  columns?: Partial<typeof imageLabExperiments.$inferInsert>;
  /** Joined to the recorded `error`; never replaces it. */
  meta?: Record<string, unknown>;
  /**
   * What this failure proved about the provider lane. Absent means `null` —
   * nothing — which is right for every refusal that stops before the call, and
   * is why the default is silence rather than a guess.
   */
  providerOutcome?: ImageLabProviderOutcome;
}

/**
 * Settle one experiment `failed`, with its reason on the row and a diagnostic
 * beside it.
 *
 * `meta` is MERGED rather than assigned, so a caller contributing the render
 * classifier's reading does not overwrite the message that explains it — the
 * two together are the whole record of why this experiment stopped.
 */
async function settleFailed(
  row: ImageLabExperimentRow,
  failureCode: string,
  message: string,
  sink?: DiagnosticSink,
  extras: SettleExtras = {},
): Promise<ImageLabRunPayload> {
  sink?.push(
    diag("warn", failureCode, message.slice(0, 300), {
      context: { experimentId: row.id, kind: row.kind },
    }),
  );
  await db()
    .update(imageLabExperiments)
    .set({
      ...extras.columns,
      status: "failed",
      failureCode,
      finishedAt: new Date(),
      meta: labMeta(row, { error: message.slice(0, 2000), ...extras.meta }),
    })
    .where(and(eq(imageLabExperiments.id, row.id), eq(imageLabExperiments.ownerId, row.ownerId)));
  return { experimentId: row.id, status: "failed", failureCode, providerOutcome: extras.providerOutcome ?? null };
}

/** The contract's own codes, spelled through the contract's own helper. */
function labFailure(code: ImageLabFailureCode): string {
  return imageLabDiagnosticCode(code);
}

// --- control_probe ---------------------------------------------------------

/**
 * The Stage 0 probe, spec §Algorithms steps 1–6.
 *
 * Step order is load-bearing rather than incidental: the version pin is checked
 * BEFORE any byte is read and long before any provider call, because a run
 * against an unidentifiable version answers no question and must not be paid
 * for. Production is deliberately unaffected by that rule — an ordinary render
 * happily follows a floating latest, since a portrait that came out well is
 * still a portrait, whereas evidence rendered against an unknown version is not
 * evidence.
 */
async function runControlProbe(row: ImageLabExperimentRow, sink?: DiagnosticSink): Promise<ImageLabRunPayload> {
  const inputs = storedInputs(row, sink);
  if (inputs.length === 0) {
    return await settleFailed(row, labFailure("input_missing"), "the experiment records no ordered inputs", sink);
  }

  const resolved = await resolvePinnedLabModel(row.modelSlug, "a probe", sink);
  if (!resolved.ok) {
    return await settleFailed(row, labFailure("version_unpinned"), resolved.message, sink);
  }
  const { model, versionId } = resolved;

  // The quality overlay is applied HERE, before the capacity check, because it
  // is the model the provider is actually handed and the check has to be about
  // that one. (It only merges `extraInput`, so capacity is unchanged — reading
  // capacity off the effective model is what keeps that true if it ever stops
  // being.)
  const effectiveModel = withReviewedImageQuality(model);
  // Capacity is refused, never TRIMMED. `runRegistryImageModel` fits an overlong
  // reference list to the model's arity, so an experiment ordering more images
  // than the version accepts would render happily while its record claimed a
  // control was sent that the provider never received — the one failure mode a
  // bench cannot survive, since the verdict would be about an image nobody saw.
  const capacity = referenceCapacity(effectiveModel);
  if (inputs.length > capacity.max) {
    return await settleFailed(
      row,
      labFailure("capacity_exceeded"),
      `${effectiveModel.slug} accepts ${String(capacity.max)} reference image(s); this experiment orders ${String(inputs.length)}`,
      sink,
      { columns: { requestedVersionId: versionId } },
    );
  }

  const read = await readOrderedInputBytes(inputs, row.ownerId);
  if (!read.ok) {
    return await settleFailed(row, labFailure("input_missing"), read.message, sink, {
      columns: { requestedVersionId: versionId },
    });
  }
  const references = read.ordered.map((entry) => entry.buffer);

  const controlRefusal = await checkControlBinding(row, inputs, sink);
  if (controlRefusal) {
    return await settleFailed(row, labFailure(controlRefusal.code), controlRefusal.message, sink, {
      columns: { requestedVersionId: versionId },
    });
  }

  // The admin's instruction VERBATIM. The numbered-role template is pre-filled
  // in the UI, where the admin can read and edit it, never assembled silently
  // here — a probe whose prompt the runner rewrote would be evidence about the
  // runner.
  const finalPrompt = row.instruction;
  const settings = storedSettings(row, sink);
  const mapped = mapImageRenderControls({ controls: settings.controls, capabilities: effectiveModel.advancedCapabilities });
  if (mapped.dropped.length > 0) {
    sink?.push(
      diag("info", "image_lab.controls_dropped", "some normalized controls have no binding on this version", {
        context: { experimentId: row.id, slug: effectiveModel.slug, dropped: mapped.dropped },
      }),
    );
  }
  // The raw provider-shaped bag merges LAST, per the contract's own layering:
  // it is the escape hatch the lab needs and production does not, and settling
  // whether a model honours an undocumented input cannot be asked through a
  // vocabulary that predates the answer.
  const controlInput = { ...mapped.input, ...settings.controlInput };

  await db()
    .update(imageLabExperiments)
    .set({ requestedVersionId: versionId, finalPrompt })
    .where(and(eq(imageLabExperiments.id, row.id), eq(imageLabExperiments.ownerId, row.ownerId)));

  const rendered = await labRenderer()(
    {
      mode: "direct",
      model: effectiveModel,
      prompt: finalPrompt,
      references,
      controlInput,
      aspect: chooseAspect(effectiveModel).value,
      versionId,
    },
    sink,
  );
  return await storeLabRender(row, rendered, {
    finalPrompt,
    sourceImageId: inputs[0]?.imageId,
    columns: { requestedVersionId: versionId },
    sink,
  });
}

/** Why a named control fixture cannot be run against — the code and its reason. */
interface ControlFixtureRefusal {
  code: ImageLabFailureCode;
  message: string;
}

function controlInvalid(message: string): ControlFixtureRefusal {
  return { code: "control_invalid", message };
}

/**
 * Whether this probe SENDS the control it is a ruling on, whether that fixture
 * is one, and whether anyone has LOOKED at it — the reason when any answer is
 * no.
 *
 * The binding checks come first, and they exist because the runner validates the
 * DECLARED fixture and renders the ORDERED INPUTS. Nothing else ties the two
 * together, so without these a probe could declare a reviewed pose skeleton,
 * send a depth map (or send nothing but an identity portrait), and record a
 * `honours_control` verdict against an image the provider never received. Three
 * rules make the record and the render the same thing:
 *
 * - a probe DECLARES a control. Its whole question is "did the output obey this
 *   fixture?", and a probe with no fixture asks nothing — the render would still
 *   happen, and its verdict would be unfileable.
 * - the declared fixture appears EXACTLY ONCE among the ordered inputs. Absent
 *   means it was never sent; twice means the numbered instruction ("the pose
 *   drawn in Image 2") names one of two slots and nobody can say which.
 * - it is sent under a role a control may occupy (`imageLabControlRoles`: the
 *   three kinds' own roles, plus the generic `control` that edge fixtures rode
 *   before `edge` was a reference role). A skeleton ordered under `identity` is a
 *   probe asking the model to copy a face from a stick figure, which answers a
 *   question nobody asked.
 *
 * Then the fixture itself. A control that is not a `lab_control`, or whose meta
 * will not parse, means nothing can say what the fixture IS, and a probe verdict
 * about an unidentified fixture is worthless. The declared kind is checked
 * against the stored one for the same reason: an experiment recording "pose"
 * while pointing at a depth map would produce a verdict filed under the wrong
 * control.
 *
 * The SOURCE gate is a different failure wearing the same shape. A fixture
 * EXTRACTED from a render is that render's own structure, so the render carries
 * the control's answer in its own pixels: order it alongside the fixture and an
 * output matching the skeleton shows only that the model copied a reference it
 * was handed — `honours_control` would be a pass the probe never earned, and
 * nothing afterwards could tell it apart from one that was. ALL ordered inputs
 * are scanned rather than the identity slot alone, because it is the pixels that
 * carry the answer and they carry it under whatever role they arrive as. A
 * fixture drawn from nothing records no source and is exempt by construction:
 * there is no render holding the answer to copy.
 *
 * The REVIEW gate is the same argument one step further, and it is the Stage 0
 * protocol's own rule ("extract a pose skeleton and a depth map … review both in
 * the fixtures panel"). A probe that comes back `ignores_control` has to be able
 * to eliminate "the fixture was wrong" before it says anything about the model,
 * and an unreviewed skeleton makes that elimination impossible — so the run is
 * refused before any spend rather than producing evidence nobody can read.
 * `control_unreviewed` is kept SEPARATE from `control_invalid` because the two
 * ask different things of the admin: one throws the fixture away, the other
 * spends a minute looking at it.
 */
async function checkControlBinding(
  row: ImageLabExperimentRow,
  inputs: ImageLabInputList,
  sink?: DiagnosticSink,
): Promise<ControlFixtureRefusal | null> {
  const controlImageId = row.controlImageId;
  if (controlImageId === null) {
    return controlInvalid("a control probe is a ruling on one named fixture, and this experiment declares none");
  }

  const ordered = inputs.filter((input) => input.imageId === controlImageId);
  const sent = ordered.length === 1 ? ordered[0] : undefined;
  if (!sent) {
    return controlInvalid(
      ordered.length === 0
        ? `control image ${controlImageId} is not among the ${String(inputs.length)} image(s) this experiment sends, so its verdict would be about a fixture the provider never saw`
        : `control image ${controlImageId} is ordered ${String(ordered.length)} times; a probe sends its control exactly once, because the instruction names one numbered slot`,
    );
  }
  if (!isImageLabControlRole(sent.role)) {
    return controlInvalid(
      `control image ${controlImageId} is sent at position ${String(sent.position)} under the ${sent.role} role; a control fixture is sent as pose, depth, edge, or control`,
    );
  }

  const control = await ownedImageRow(controlImageId, row.ownerId);
  if (!control) return controlInvalid(`control image ${controlImageId} is not an image this owner has`);
  if (control.kind !== "lab_control") {
    return controlInvalid(`control image ${controlImageId} is a ${control.kind}, not a lab control fixture`);
  }
  const meta = parseOrNull(imageLabControlMetaSchema, control.meta, sink, "images.meta.lab_control");
  if (!meta) return controlInvalid(`control image ${controlImageId} has no readable fixture metadata`);
  if (row.controlKind !== null && meta.controlKind !== row.controlKind) {
    return controlInvalid(
      `control image ${controlImageId} is a ${meta.controlKind} fixture, not the ${row.controlKind} this experiment records`,
    );
  }
  if (meta.sourceImageId !== undefined && inputs.some((input) => input.imageId === meta.sourceImageId)) {
    return {
      code: "control_source_sent",
      message: `control image ${controlImageId} was extracted from image ${meta.sourceImageId}, which this experiment also sends; the output could match the fixture by copying that reference instead of obeying it`,
    };
  }
  if (meta.reviewedAt === undefined) {
    return {
      code: "control_unreviewed",
      message: `control image ${controlImageId} has not been reviewed; review the fixture in the panel before spending a probe on it`,
    };
  }
  return null;
}

// --- controlled recipes ----------------------------------------------------

/**
 * A controlled run: the render-intent path, wearing a pinned version and a
 * code-defined recipe profile (`imageLabRecipeProfile`).
 *
 * The probe above deliberately BYPASSES `renderImageIntent`; this runner
 * deliberately goes through it, because its question is different. A probe asks
 * "does the model obey a control at all?", answered best by handing the
 * provider an exact ordered list. A controlled experiment asks "does the
 * control still hold when the request is production-shaped?" — policy-driven
 * selection, compose-strategy wording, capacity handled the way a lane handles
 * it. Running that any other way would prove something production never does.
 *
 * Two consequences of that choice are deliberate:
 *
 * - Capacity TRIMS here instead of refusing; `capacity_exceeded` stays a probe
 *   code. The intent path fits an overlong list exactly as every lane does,
 *   and the run stays honest because what went and what did not is recorded on
 *   the row as its `outcome` — the record keeps the render honest, where the
 *   probe needed a refusal.
 * - The raw `controlInput` bag is REFUSED (`settings_unsupported`), never
 *   merged and never silently stripped. It is a probe tool; production has no
 *   raw bag, so a run carrying one would not be the production-shaped evidence
 *   this kind exists to produce — and stripping it would render something
 *   other than what the admin recorded.
 *
 * The Stage 0 fixture gates are reused unchanged (`checkControlBinding`): a
 * controlled run still declares its control, sends it exactly once under a
 * control role, and refuses an unreviewed fixture or the fixture's own source
 * render — all before any spend.
 */
async function runControlled(
  row: ImageLabExperimentRow,
  kind: ImageLabControlledKind,
  sink?: DiagnosticSink,
): Promise<ImageLabRunPayload> {
  const inputs = storedInputs(row, sink);
  if (inputs.length === 0) {
    return await settleFailed(row, labFailure("input_missing"), "the experiment records no ordered inputs", sink);
  }
  const controlKind = row.controlKind;
  if (controlKind === null) {
    return await settleFailed(
      row,
      labFailure("control_invalid"),
      "a controlled experiment records the control kind it runs",
      sink,
    );
  }

  const resolved = await resolvePinnedLabModel(row.modelSlug, "a controlled experiment", sink);
  if (!resolved.ok) {
    return await settleFailed(row, labFailure("version_unpinned"), resolved.message, sink);
  }
  const { model, versionId } = resolved;
  // Recorded on every settle from here on: the pin and the model are resolved
  // facts about this run whether or not it reaches the provider.
  const columns = { requestedVersionId: versionId, modelSlug: model.slug };

  const controlRefusal = await checkControlBinding(row, inputs, sink);
  if (controlRefusal) {
    return await settleFailed(row, labFailure(controlRefusal.code), controlRefusal.message, sink, { columns });
  }

  const settings = storedSettings(row, sink);
  if (carriesRawProviderBag(settings)) {
    return await settleFailed(row, labFailure("settings_unsupported"), RAW_BAG_REFUSAL, sink, { columns });
  }

  const read = await readOrderedInputBytes(inputs, row.ownerId);
  if (!read.ok) {
    return await settleFailed(row, labFailure("input_missing"), read.message, sink, { columns });
  }
  // Identity and the declared control are REQUIRED so the plan refuses rather
  // than renders when either is pushed out; everything else may be trimmed and
  // recorded. No priority — the recipe's roleOrder and the admin's own order
  // decide, and a second ranking would let the two disagree.
  const references: ImageRenderReference[] = read.ordered.map(({ input, buffer }) => ({
    role: input.role,
    buffer,
    sourceImageId: input.imageId,
    required: input.role === "identity" || input.imageId === row.controlImageId,
  }));

  return await runRecipeIntent(row, {
    model,
    versionId,
    recipeProfile: imageLabRecipeProfile(kind, controlKind, model.id),
    references,
    prompt: row.instruction,
    controls: settings.controls,
    columns,
    provenanceRole: "identity",
    fallbackSourceImageId: inputs[0]?.imageId,
    sink,
  });
}

/**
 * The refusal both recipe kinds share, and the reason it is one sentence in one
 * place: the raw bag is a PROBE tool, and a recipe run exists to prove a
 * production-shaped request. Two spellings of that would let one kind start
 * stripping the bag while the other refused it.
 */
const RAW_BAG_REFUSAL =
  "a recipe experiment runs the production shape, which has no raw provider bag; clear controlInput or run a control probe";

function carriesRawProviderBag(settings: ImageLabSettings): boolean {
  return Object.keys(settings.controlInput).length > 0;
}

/** Everything one recipe run needs past its own preconditions. */
interface RecipeIntentRun {
  model: ImageModel;
  versionId: string;
  recipeProfile: ImageModelProfile;
  /** In the order the caller wants them offered; the policy's `roleOrder` decides the send order. */
  references: ImageRenderReference[];
  /** The base prompt the strategy prefixes its numbered bindings to. */
  prompt: string;
  controls: ImageRenderControls;
  /** Resolved pre-render and re-applied on every settle, so a stop cannot drop them. */
  columns: Partial<typeof imageLabExperiments.$inferInsert>;
  /** Which SENT reference the stored output records as its provenance. */
  provenanceRole: ImageReferenceRole;
  /** Used when the plan sent no reference of that role. */
  fallbackSourceImageId?: string;
  sink?: DiagnosticSink;
}

/**
 * Eligibility, plan, record, render, settle — the half of a recipe run that is
 * identical for every recipe.
 *
 * One function for the controlled kinds and the finishing pass because the
 * honesty-critical steps live here: the recorded outcome, the compiled prompt
 * written down BEFORE the provider call, and the pinned version riding inside
 * the intent. A second copy would be a second place for a recipe to start
 * recording something other than what it sent.
 *
 * What the callers keep is exactly what differs: which references exist at all,
 * which preconditions must hold before spending, and what the base prompt says.
 */
async function runRecipeIntent(row: ImageLabExperimentRow, input: RecipeIntentRun): Promise<ImageLabRunPayload> {
  const { model, recipeProfile, columns, sink } = input;
  const eligibility = profileEligibility(recipeProfile, model);
  if (!eligibility.ok) {
    return await settleFailed(
      row,
      LAB_PROFILE_UNAVAILABLE,
      `${model.slug} cannot run the ${recipeProfile.key} recipe: ${eligibility.reason}`,
      sink,
      { columns },
    );
  }

  // Resolved HERE rather than left to the renderer, for the reason every other
  // lab precondition is checked here: a LoRA the pinned model cannot take must
  // settle onto the row with its own code, pre-spend, where an admin reading the
  // experiment can see why it stopped. The shared helper decides which LoRA is
  // being asked for so the lab and the render path can never disagree about the
  // request/default merge (recipes carry no control defaults today, which is
  // exactly why deriving the answer twice would go unnoticed).
  const selection = effectiveImageLoraSelection(recipeProfile.controlDefaults, input.controls);
  let resolvedLora: ImageLoraRenderBinding | undefined;
  if (selection) {
    const resolved = await resolveImageLoraForRender(
      selection,
      { model, versionId: input.versionId, task: recipeProfile.task },
      sink,
    );
    if (!resolved.ok) {
      // The `image_lora.*` code lands verbatim, exactly as `image_profile.*` codes
      // do: the failure vocabulary belongs to the layer that refused.
      return await settleFailed(row, resolved.code, resolved.message, sink, { columns });
    }
    resolvedLora = resolved.binding;
  }

  // The aspect matches the baselines' so the two arms of a comparison stay
  // same-shaped; the versionId rides INSIDE the intent, so the renderer seam
  // keeps its shape and the real renderer needs no lab-specific arm.
  const intent: ImageRenderIntent = {
    profile: { profile: recipeProfile, model },
    prompt: input.prompt,
    references: input.references,
    target: { aspectRatio: IMAGE_TARGET_ASPECT },
    controls: input.controls,
    versionId: input.versionId,
    // Passed along so the renderer does not read the library a second time.
    ...(resolvedLora ? { resolvedLora } : {}),
  };
  const planned = planImageRender(intent);
  if (!planned.ok) {
    return await settleFailed(row, planned.refusal.code, planned.refusal.message, sink, { columns });
  }

  const outcome = planOutcome(planned.plan, recipeProfile.key);
  const finalPrompt = planned.plan.prompt;
  const columnsWithPrompt = { ...columns, finalPrompt };
  await db()
    .update(imageLabExperiments)
    .set(columnsWithPrompt)
    .where(and(eq(imageLabExperiments.id, row.id), eq(imageLabExperiments.ownerId, row.ownerId)));

  const rendered = await labRenderer()({ mode: "intent", intent }, sink);
  const provenance = planned.plan.sentReferences.find((reference) => reference.role === input.provenanceRole);
  return await storeLabRender(row, rendered, {
    finalPrompt,
    sourceImageId: provenance?.sourceImageId ?? input.fallbackSourceImageId,
    columns: columnsWithPrompt,
    sink,
    outcome,
  });
}

// --- finishing pass --------------------------------------------------------

/**
 * The finishing pass: another experiment's RESULT, re-edited under an instruction
 * that forbids every change but the face (plan §"Stage 3 — optional identity
 * finishing", extended by §"Stage 5 — one character LoRA pilot").
 *
 * It is the one kind whose ordered inputs the RUNNER resolves rather than the
 * admin. Both of them are facts the client cannot supply honestly: the base is
 * whatever the source experiment actually rendered (which may have changed, or
 * been deleted, since the form listed it), and the identity references come from
 * the pack, whose selection is a versioned policy decision — an admin choosing
 * the "identity reference" by hand would be running a different experiment under
 * this one's name. So they are read here and WRITTEN BACK onto the row, because
 * a record that only says what the runner intended is not a record of what it
 * sent.
 *
 * TWO ARMS as of Stage 5, differing only in what accompanies the base render:
 * the `identity` arm sends the pack's references, and the `lora_only` arm sends
 * nothing beside it and leans on a character LoRA instead. Everything else here
 * is shared deliberately — same source validation, same version pin, same
 * raw-bag refusal, same LoRA pre-resolution inside `runRecipeIntent`, same
 * recorded outcome — because a difference anywhere else would show up in the
 * comparison as if it were the LoRA's doing.
 *
 * The pack gate (`imageIdentityPackReferencesEnabled`) is deliberately NOT
 * consulted, on the identity-pack trial's own precedent: that flag governs
 * whether production LANES send pack references, and a bench measuring what the
 * references are worth cannot be gated on the decision it exists to inform.
 * Nothing here is player-visible, and every render still lands as a hidden
 * `lab_output`.
 */
async function runFinishingPass(row: ImageLabExperimentRow, sink?: DiagnosticSink): Promise<ImageLabRunPayload> {
  const variant = finishingPassVariant(row, sink);
  const sourceExperimentId = storedSourceExperimentId(row, sink);
  if (sourceExperimentId === null) {
    return await settleFailed(
      row,
      labFailure("source_invalid"),
      "a finishing pass records the experiment it refines, and this row names none",
      sink,
    );
  }
  // Re-checked at run time even though the create path checked it: a source can
  // be deleted, or its output swept, between the queue and the render — and the
  // service is authoritative for rows that predate any of these rules.
  const source = await ownedExperiment(sourceExperimentId, row.ownerId);
  const refusal = sourceRefusal(sourceExperimentId, source, sink);
  const baseImageId = source?.resultImageId ?? null;
  if (refusal !== null || source === null || baseImageId === null) {
    return await settleFailed(row, labFailure("source_invalid"), refusal?.message ?? "the source experiment is gone", sink);
  }

  const resolved = await resolvePinnedLabModel(row.modelSlug, "a finishing pass", sink);
  if (!resolved.ok) {
    return await settleFailed(row, labFailure("version_unpinned"), resolved.message, sink);
  }
  const { model, versionId } = resolved;
  const columns = { requestedVersionId: versionId, modelSlug: model.slug };

  const settings = storedSettings(row, sink);
  if (carriesRawProviderBag(settings)) {
    return await settleFailed(row, labFailure("settings_unsupported"), RAW_BAG_REFUSAL, sink, { columns });
  }

  const base = await readOwnedImageBytes(baseImageId, row.ownerId);
  if (!base) {
    return await settleFailed(
      row,
      labFailure("input_missing"),
      `the source experiment's result image ${baseImageId} could not be read`,
      sink,
      { columns },
    );
  }

  const recipeProfile = imageLabFinishingRecipeProfile(model.id, variant);
  const accompanying = await finishingAccompanyingReferences(row, variant, settings, recipeProfile, sink);
  if (!accompanying.ok) {
    return await settleFailed(row, labFailure(accompanying.code), accompanying.message, sink, { columns });
  }

  // Written down as the ordered inputs the run actually sends, so the detail
  // screen shows every reference as a thumbnail exactly as it does for a
  // hand-ordered kind, and a verdict written weeks later can see them. On the
  // LoRA-only arm that list is one entry long, which is the arm's whole claim.
  const inputs: ImageLabInputList = [
    { position: 1, role: "before", imageId: baseImageId },
    ...accompanying.identity.map((reference, index) => ({
      position: index + 2,
      role: "identity" as const,
      imageId: reference.imageId,
    })),
  ];
  const references: ImageRenderReference[] = [
    { role: "before", buffer: base, sourceImageId: baseImageId, required: true },
    ...accompanying.identity.map((reference) => ({
      role: "identity" as const,
      buffer: reference.buffer,
      sourceImageId: reference.imageId,
      required: true,
    })),
  ];

  return await runRecipeIntent(row, {
    model,
    versionId,
    recipeProfile,
    references,
    // The rule the run is judged by IS the prompt; the admin's own text narrows
    // it and never replaces it (`imageLabFinishingInstruction`). The arm decides
    // one sentence of it — the one naming what the face is corrected toward,
    // which on the LoRA-only arm cannot be a reference nothing sent.
    prompt: imageLabFinishingInstruction(row.instruction, variant),
    controls: settings.controls,
    columns: { ...columns, inputs },
    // The base render, not the identity reference: this output is that image
    // with one thing changed, and provenance should say so.
    provenanceRole: "before",
    fallbackSourceImageId: baseImageId,
    sink,
  });
}

/** One identity reference the pack authorized, beside its bytes. */
interface FinishingIdentityReference {
  imageId: string;
  buffer: Buffer;
}

type FinishingIdentityResult =
  | { ok: true; references: FinishingIdentityReference[] }
  | { ok: false; message: string };

/**
 * What one finishing arm sends BESIDE the base render, or the reason it cannot
 * run — the only place the two arms diverge before `runRecipeIntent`.
 *
 * Exhaustive over the variant, so a third arm is a compile error here rather than
 * a silent fall-through into whichever arm happened to be written last — the
 * failure mode that would matter most, since a mislabelled arm poisons the
 * comparison rather than breaking the run.
 */
type FinishingAccompanyingResult =
  | { ok: true; identity: FinishingIdentityReference[] }
  | { ok: false; code: ImageLabFailureCode; message: string };

/**
 * The refusal that keeps the LoRA-only arm honest.
 *
 * The create schema already refuses a `lora_only` request with no LoRA, so this
 * catches exactly two things: a row stored before that rule existed, and a caller
 * that reached the service around the request schema. Both settle pre-spend,
 * because a run with neither weights nor references would return the source image
 * with a fresh id and file it as a comparison arm — the most expensive kind of
 * nothing this bench can produce.
 */
const LORA_ONLY_WITHOUT_LORA =
  "a LoRA-only pass measures the LoRA alone and this row names none; with no weights and no identity reference " +
  "the pass would only re-render the source image";

async function finishingAccompanyingReferences(
  row: ImageLabExperimentRow,
  variant: ImageLabFinishingVariant,
  settings: ImageLabSettings,
  recipeProfile: ImageModelProfile,
  sink?: DiagnosticSink,
): Promise<FinishingAccompanyingResult> {
  switch (variant) {
    case "identity": {
      const identity = await finishingIdentityReferences(row, sink);
      return identity.ok
        ? { ok: true, identity: identity.references }
        : { ok: false, code: "identity_unavailable", message: identity.message };
    }
    case "lora_only": {
      // The pack is never asked — not asked and discarded, not asked and refused.
      // `identity_unavailable` is unreachable on this arm by construction, which
      // is what makes it a measurement of the weights instead of a measurement of
      // whatever the pack happened to offer.
      //
      // The selection is read through the shared helper so the LoRA this arm
      // checks for is the same one `runRecipeIntent` then resolves; deriving it
      // twice is how a pass could pass this gate and resolve a different LoRA.
      const selection = effectiveImageLoraSelection(recipeProfile.controlDefaults, settings.controls);
      return selection === undefined
        ? { ok: false, code: "input_missing", message: LORA_ONLY_WITHOUT_LORA }
        : { ok: true, identity: [] };
    }
  }
}

/**
 * The identity references a finishing pass improves the face TOWARD, drawn from
 * the subject's identity pack.
 *
 * The pack is asked rather than the character row, because "which image is this
 * character's identity" is a versioned, measured decision the pack machinery
 * already owns — reference size, face size, policy version and provenance
 * included. Re-deriving it here would be a second answer to a settled question,
 * and the two would drift the first time either moved.
 *
 * The SUBJECT is the experiment's own character, falling back to the primary
 * character of its chat, because a finishing pass inherits its subject from a
 * source that may have been a scene (which files against a chat, not a
 * character). A pass with no subject at all is refused: there is no pack to ask.
 *
 * Every refusal carries the pack's own blocking code into the recorded message,
 * so "no usable face" and "the source portrait changed" stay tellable apart on
 * the row without the lab restating a vocabulary it does not own.
 */
async function finishingIdentityReferences(
  row: ImageLabExperimentRow,
  sink?: DiagnosticSink,
): Promise<FinishingIdentityResult> {
  const characterId = row.characterId ?? (row.chatId === null ? null : await primaryChatCharacterId(row.chatId));
  if (characterId === null) {
    return { ok: false, message: "this experiment names no character, so no identity pack can be asked for references" };
  }

  const evaluated = await evaluateIdentityPackForProfile({
    ownerId: row.ownerId,
    characterId,
    strategy: IMAGE_LAB_FINISHING_IDENTITY_STRATEGY,
    // The bench's own purpose, shared with the identity-pack trial: this is
    // measurement, not a player-visible render.
    purpose: "admin_trial",
    sink,
  });
  if (!evaluated.eligible) {
    return { ok: false, message: `the identity pack offered no reference (${evaluated.code}: ${evaluated.messageKey})` };
  }

  const references: FinishingIdentityReference[] = [];
  for (const candidate of evaluated.candidates) {
    const buffer = await readOwnedImageBytes(candidate.imageId, row.ownerId);
    if (buffer) references.push({ imageId: candidate.imageId, buffer });
  }
  if (references.length === 0) {
    return { ok: false, message: "the identity pack's references could not be read for this owner" };
  }
  return { ok: true, references };
}

// --- baselines -------------------------------------------------------------

/**
 * A baseline re-runs an ordinary lane's own CONFIGURATION so a later comparison
 * has a same-settings control to sit beside (spec §"Baseline runs").
 *
 * Settings parity is achieved by construction rather than by copying numbers:
 * the same `resolveImageProfileForTask` call the lane makes, the same reference
 * choice, and the same `renderImageIntent` entry point — which is where the
 * profile's controls, prompt strategy, negative, aspect negotiation and
 * provider overrides are all compiled. Anything the lane sends, this sends,
 * because it is the same code compiling the same profile.
 *
 * ONE deliberate difference: the PROMPT is the admin's instruction, not the
 * lane's composed text. A variant prompt is built from a variant kind and an
 * age anchor; a scene prompt is composed by an agent out of live chat state,
 * meters and wardrobe. Reproducing either would drag the bench into the chat
 * pipeline and make the baseline's text depend on state that moved since. The
 * admin types the text both arms of a comparison share, which is what makes it
 * a comparison. Recorded as `finalPrompt` post-compile, so the record says what
 * was actually sent.
 *
 * Neither baseline enqueues the lane's own job type, and neither writes a
 * lane-visible asset: the output is a hidden `lab_output`, so no portrait
 * variant or chat scene ever appears from lab activity.
 */
async function runBaseline(
  row: ImageLabExperimentRow,
  task: Extract<ImageProfileTask, "variant" | "scene">,
  sink?: DiagnosticSink,
): Promise<ImageLabRunPayload> {
  const resolvedSubject = await resolveBaselineSubject(row, task, sink);
  if (!resolvedSubject.ok) return await settleFailed(row, resolvedSubject.code, resolvedSubject.message, sink);

  const subject = resolvedSubject.subject;
  const resolved = subject.profile;
  const intent: ImageRenderIntent = {
    profile: resolved,
    prompt: row.instruction,
    references: subject.references,
    target: { aspectRatio: IMAGE_TARGET_ASPECT },
  };
  // Planned first purely to CAPTURE the compiled prompt: `renderImageIntent`
  // does not report it, and a baseline whose recorded text is the admin's raw
  // instruction would claim parity it cannot show. The compile is pure and its
  // prompt preparation is idempotent, so the plan built here is byte-identical
  // to the one the render builds a line later.
  const planned = planImageRender(intent);
  if (!planned.ok) return await settleFailed(row, LAB_PROFILE_UNAVAILABLE, planned.refusal.message, sink);

  const finalPrompt = planned.plan.prompt;
  const columns = {
    profileId: resolved.profile.id,
    // The resolved model, overwriting whatever slug the request carried: a
    // baseline runs what the LANE runs, and recording the request's guess would
    // describe a render that did not happen.
    modelSlug: resolved.model.slug,
    // Deliberately no `requestedVersionId`: `renderImageIntent` pins nothing,
    // because production does not, and a baseline that pinned would stop being
    // a baseline. What actually ran arrives as the provider's own echo.
    finalPrompt,
  };
  await db()
    .update(imageLabExperiments)
    .set(columns)
    .where(and(eq(imageLabExperiments.id, row.id), eq(imageLabExperiments.ownerId, row.ownerId)));

  const rendered = await labRenderer()({ mode: "intent", intent }, sink);
  return await storeLabRender(row, rendered, {
    finalPrompt,
    sourceImageId: subject.references[0]?.sourceImageId,
    columns,
    sink,
    // Recorded for baselines too — no recipe key, but the same "what was sent,
    // what was dropped" honesty, so the two arms of a comparison read alike.
    outcome: planOutcome(planned.plan),
  });
}

interface BaselineSubject {
  profile: ResolvedImageProfile;
  references: ImageRenderReference[];
}

type BaselineSubjectResult = { ok: true; subject: BaselineSubject } | { ok: false; code: string; message: string };

/**
 * The resolved profile and references, or the message saying what is missing.
 *
 * The SUBJECT is resolved before the profile, deliberately. A baseline whose
 * character has no canonical avatar has nothing to re-run whatever the registry
 * offers, and resolving a profile for a subject that is not there would report
 * the registry's state as the reason a missing avatar failed.
 */
async function resolveBaselineSubject(
  row: ImageLabExperimentRow,
  task: Extract<ImageProfileTask, "variant" | "scene">,
  sink?: DiagnosticSink,
): Promise<BaselineSubjectResult> {
  const references = task === "scene" ? await sceneBaselineReferences(row) : await portraitBaselineReferences(row);
  if (references.length === 0) {
    return {
      ok: false,
      code: labFailure("input_missing"),
      message: "the lane's reference anchor could not be read for this subject",
    };
  }

  const stored = task === "scene" ? await chatSceneSelection(row.chatId) : null;
  const profile = await resolveImageProfileForTask(task, stored, sink);
  if (!profile) {
    return { ok: false, code: LAB_PROFILE_UNAVAILABLE, message: `no image model profile is offered for ${task} renders` };
  }
  return { ok: true, subject: { profile, references } };
}

/**
 * The variant lane's reference choice: the canonical avatar, always re-rolled
 * from rather than chained off a previous edit.
 */
async function portraitBaselineReferences(row: ImageLabExperimentRow): Promise<ImageRenderReference[]> {
  if (row.characterId === null) return [];
  const [character] = await db()
    .select({ avatarImageId: characters.avatarImageId })
    .from(characters)
    .where(and(eq(characters.id, row.characterId), eq(characters.ownerId, row.ownerId)))
    .limit(1);
  if (!character?.avatarImageId) return [];
  const bytes = await readOwnedImageBytes(character.avatarImageId, row.ownerId);
  if (!bytes) return [];
  return [{ role: "identity", required: true, buffer: bytes, sourceImageId: character.avatarImageId }];
}

/**
 * The scene lane's reference choice: the chat's current look anchor, falling
 * back to the character's canonical avatar, plus the chat's place shot when one
 * exists — the same `chat_look` → avatar → `+ chat_place` ladder
 * `renderCharacterSceneImage` climbs.
 *
 * ONE simplification, and it is worth stating: the lane additionally requires
 * the look's cache KEY to match the chat's current wardrobe state, and the bench
 * has no wardrobe state to derive a key from. So it anchors on the newest look
 * the chat actually holds — the same image the lane uses whenever the wardrobe
 * has not moved since, and an honestly-labelled anchor when it has.
 */
async function sceneBaselineReferences(row: ImageLabExperimentRow): Promise<ImageRenderReference[]> {
  if (row.chatId === null) return [];
  const references: ImageRenderReference[] = [];

  const look = await newestChatAsset(row.chatId, row.ownerId, "chat_look");
  const anchorId = look ?? (await baselineChatAvatarId(row));
  if (!anchorId) return [];
  const anchor = await readOwnedImageBytes(anchorId, row.ownerId);
  if (!anchor) return [];
  references.push({ role: "identity", required: true, buffer: anchor, sourceImageId: anchorId });

  const place = await newestChatAsset(row.chatId, row.ownerId, "chat_place");
  if (place) {
    const bytes = await readOwnedImageBytes(place, row.ownerId);
    if (bytes) references.push({ role: "location", buffer: bytes, sourceImageId: place });
  }
  return references;
}

/** The character a scene baseline is about: the experiment's, else the chat's first. */
async function baselineChatAvatarId(row: ImageLabExperimentRow): Promise<string | null> {
  const characterId = row.characterId ?? (row.chatId === null ? null : await primaryChatCharacterId(row.chatId));
  if (!characterId) return null;
  const [character] = await db()
    .select({ avatarImageId: characters.avatarImageId })
    .from(characters)
    .where(and(eq(characters.id, characterId), eq(characters.ownerId, row.ownerId)))
    .limit(1);
  return character?.avatarImageId ?? null;
}

async function primaryChatCharacterId(chatId: string): Promise<string | null> {
  const [participant] = await db()
    .select({ characterId: chatParticipants.characterId })
    .from(chatParticipants)
    .where(eq(chatParticipants.chatId, chatId))
    .orderBy(asc(chatParticipants.sort))
    .limit(1);
  return participant?.characterId ?? null;
}

/** The chat's stored scene-model pick, resolved by the profile registry exactly as the lane resolves it. */
async function chatSceneSelection(chatId: string | null): Promise<string | null> {
  if (chatId === null) return null;
  const [chat] = await db()
    .select({ sceneModel: characterChats.sceneModel })
    .from(characterChats)
    .where(eq(characterChats.id, chatId))
    .limit(1);
  return chat?.sceneModel ?? null;
}

async function newestChatAsset(
  chatId: string,
  ownerId: string,
  kind: "chat_look" | "chat_place",
): Promise<string | null> {
  const [row] = await db()
    .select({ id: images.id })
    .from(images)
    .where(
      and(eq(images.chatId, chatId), eq(images.ownerId, ownerId), eq(images.kind, kind), eq(images.status, "ready")),
    )
    .orderBy(desc(images.createdAt))
    .limit(1);
  return row?.id ?? null;
}

// --- shared render settlement ---------------------------------------------

/**
 * The recorded outcome of one reference plan, in the contract's shape.
 *
 * One builder for the controlled runner and the baselines because the mapping
 * is the honesty-critical part: a second copy that read `dropped` differently
 * would let two experiment kinds record two versions of the same decision.
 * `recipeKey` is the controlled runner's alone — a baseline runs the lane's
 * resolved profile, not a recipe.
 */
function planOutcome(plan: PlannedImageRender, recipeKey?: string): ImageLabOutcome {
  return {
    ...(recipeKey === undefined ? {} : { recipeKey }),
    sentRoles: plan.sentReferences.map((reference) => reference.role),
    dropped: plan.dropped.map((entry) => ({
      role: entry.reference.role,
      reason: entry.reason,
      ...(entry.reference.sourceImageId ? { sourceImageId: entry.reference.sourceImageId } : {}),
    })),
    renumbered: plan.referencesRenumbered,
  };
}

interface StoreLabRenderInput {
  finalPrompt: string;
  /** Provenance for the output row — the first reference this render was built from. */
  sourceImageId?: string;
  /** Columns already written pre-render, re-applied so a settle cannot drop them. */
  columns: Partial<typeof imageLabExperiments.$inferInsert>;
  sink?: DiagnosticSink;
  /** The reference plan's recorded decisions — intent-path runs only. Written
   * into the row's meta on success AND on a render failure, because what was
   * sent is a fact about the attempt, not about how it ended. */
  outcome?: ImageLabOutcome;
}

/**
 * Settle one experiment against what the renderer returned.
 *
 * Provenance is recorded on EVERY outcome from the moment it exists — a failed
 * prediction has an id too, and that id is the only handle tying this row back
 * to the provider's own record of what went wrong.
 *
 * A save that does not reach `ready` REMOVES the pending image row rather than
 * leaving it `failed`: the experiment's pointer is only ever written on success,
 * so a straggler would be a hidden row nothing points at, outliving even the
 * experiment's own delete.
 *
 * The same reasoning covers the settle itself MATCHING NOTHING — the experiment
 * was deleted while its render was in flight. The output is discarded, because
 * the alternative is a hidden asset no row points at and no sweep of the lab's
 * own tables can reach.
 */
async function storeLabRender(
  row: ImageLabExperimentRow,
  rendered: RenderWithModelResult,
  input: StoreLabRenderInput,
): Promise<ImageLabRunPayload> {
  const { sink } = input;
  const provenance = {
    predictionId: rendered.predictionId ?? null,
    executedVersionId: rendered.executedVersionId ?? null,
  };

  if (!rendered.ok || !rendered.image) {
    const message = rendered.error ?? `${row.modelSlug} returned no image`;
    // The ONE place in this module a provider failure is reported as one, and
    // only for the classifications that are evidence about the upstream: the
    // renderer was reached, so its answer is the lane's own news.
    const renderFailure = classifyImageFailure(message);
    return await settleFailed(row, labFailure("render_failed"), message, sink, {
      columns: { ...input.columns, ...provenance },
      meta: { renderFailure, ...(input.outcome ? { outcome: input.outcome } : {}) },
      providerOutcome: imageFailureHealthOutcome(renderFailure),
    });
  }

  const asset = await createImageAsset({
    ownerId: row.ownerId,
    kind: "lab_output",
    ...(row.characterId ? { entityKind: "character" as const, entityId: row.characterId } : {}),
    ...(row.chatId ? { chatId: row.chatId } : {}),
    prompt: input.finalPrompt,
    ...(input.sourceImageId ? { sourceImageId: input.sourceImageId } : {}),
    meta: { hidden: true, imageLabExperimentId: row.id, imageLabKind: row.kind },
  });
  const saved = await saveImageBuffer(asset.id, rendered.image, sink);
  if (saved?.status !== "ready") {
    await deleteOwnedImage(asset.id, row.ownerId, { kind: "lab_output" });
    return await settleFailed(row, labFailure("render_failed"), "the lab output could not be written", sink, {
      columns: { ...input.columns, ...provenance },
      ...(input.outcome ? { meta: { outcome: input.outcome } } : {}),
      // The provider rendered; OUR disk did not take it. Reporting that as a
      // lane failure would shed everyone's work over a local write.
      providerOutcome: true,
    });
  }

  const [settled] = await db()
    .update(imageLabExperiments)
    .set({
      ...input.columns,
      ...provenance,
      // Written only when a plan produced one, so probe rows — whose meta this
      // update never touched before — keep exactly the meta they had. Merged,
      // never assigned, so a create-time key survives its own run.
      ...(input.outcome ? { meta: labMeta(row, { outcome: input.outcome }) } : {}),
      resultImageId: saved.id,
      status: "succeeded",
      failureCode: null,
      finishedAt: new Date(),
    })
    .where(and(eq(imageLabExperiments.id, row.id), eq(imageLabExperiments.ownerId, row.ownerId)))
    .returning({ id: imageLabExperiments.id });

  // The experiment was deleted while its render was in flight — an admin
  // clearing a row a deploy left `running`, which stays allowed on purpose. The
  // settle matched nothing, so the pointer that would have made this output
  // findable was never written, and the image is already an orphan: it survives
  // its own experiment's delete sweep, rides storage forever, and appears in no
  // panel. Delete it here, through the same owned deleter the experiment's own
  // delete uses, so the row and its bytes go together.
  if (!settled) {
    const removed = await deleteOwnedImage(saved.id, row.ownerId, { kind: "lab_output" });
    sink?.push(
      diag("info", "image_lab.output_orphaned", "the experiment was deleted mid-render; its output was discarded", {
        context: { experimentId: row.id, imageId: saved.id, removed },
      }),
    );
    return {
      experimentId: row.id,
      status: "discarded",
      outputImagesRemoved: removed ? 1 : 0,
      // The render happened and the provider answered; the row it belonged to
      // simply stopped existing. That is still a working lane.
      providerOutcome: true,
      ...provenance,
    };
  }
  return { experimentId: row.id, status: "succeeded", resultImageId: saved.id, providerOutcome: true, ...provenance };
}

// --- shared reads ----------------------------------------------------------

/**
 * Resolve a slug to a registered model. An exact match wins; otherwise the
 * pinned and unpinned spellings of one slug are treated as the same model, so an
 * admin typing `qwen/qwen-image-edit-2511` still finds a row stored with its
 * version suffix.
 */
async function resolveLabModel(slug: string, sink?: DiagnosticSink): Promise<ImageModel | null> {
  const models = await loadImageModels(sink);
  const base = baseImageModelSlug(slug);
  return (
    models.find((model) => model.slug === slug) ??
    models.find((model) => baseImageModelSlug(model.slug) === base) ??
    null
  );
}

type PinnedLabModelResult = { ok: true; model: ImageModel; versionId: string } | { ok: false; message: string };

/**
 * The model a lab run executes and the exact version it pins, or the reason it
 * cannot. One helper for the probe and the controlled runner because the rule
 * is one rule — evidence rendered against an unidentifiable version answers no
 * question, so the run is refused before any spend — and the refusal message
 * differs only in `subject`, the run's own name for itself.
 */
async function resolvePinnedLabModel(slug: string, subject: string, sink?: DiagnosticSink): Promise<PinnedLabModelResult> {
  const model = await resolveLabModel(slug, sink);
  if (!model) return { ok: false, message: `no registered image model matches ${slug}` };
  const versionId = pinnedImageModelVersion(model);
  if (!versionId) {
    return {
      ok: false,
      message: `${model.slug} has no exact provider version to pin; ${subject} cannot run against a floating latest`,
    };
  }
  return { ok: true, model, versionId };
}

/** One ordered input beside its bytes, so a caller never re-pairs parallel arrays. */
interface OrderedLabInput {
  input: ImageLabInput;
  buffer: Buffer;
}

type ReadOrderedInputsResult = { ok: true; ordered: OrderedLabInput[] } | { ok: false; message: string };

/**
 * Every ordered input's bytes, in recorded order, or the message naming the
 * first one that could not be read. Shared by the probe and the controlled
 * runner: both refuse `input_missing` on the same message shape, and both must
 * read owner-scoped — a foreign or unready image is indistinguishable from a
 * missing one on purpose.
 */
async function readOrderedInputBytes(inputs: ImageLabInputList, ownerId: string): Promise<ReadOrderedInputsResult> {
  const ordered: OrderedLabInput[] = [];
  for (const input of inputs) {
    const bytes = await readOwnedImageBytes(input.imageId, ownerId);
    if (!bytes) {
      return { ok: false, message: `image ${input.imageId} at position ${String(input.position)} could not be read` };
    }
    ordered.push({ input, buffer: bytes });
  }
  return { ok: true, ordered };
}

async function ownedImageRow(imageId: string, ownerId: string): Promise<ImageRow | null> {
  const [row] = await db()
    .select()
    .from(images)
    .where(and(eq(images.id, imageId), eq(images.ownerId, ownerId)))
    .limit(1);
  return row ?? null;
}

/** Bytes for one owned, ready image; null for missing, foreign, unready or file-less. */
async function readOwnedImageBytes(imageId: string, ownerId: string): Promise<Buffer | null> {
  const row = await ownedImageRow(imageId, ownerId);
  if (!row || row.status !== "ready") return null;
  return await readImageBytes(row);
}
