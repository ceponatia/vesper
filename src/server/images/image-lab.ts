import { and, asc, desc, eq } from "drizzle-orm";
import {
  chooseAspect,
  emptyImageLabSettings,
  imageLabControlMetaSchema,
  imageLabDiagnosticCode,
  imageLabInputListSchema,
  imageLabSettingsSchema,
  IMAGE_TARGET_ASPECT,
  isImageLabControlRole,
  referenceCapacity,
  type ImageLabCreateExperimentRequest,
  type ImageLabExperiment,
  type ImageLabExperimentKind,
  type ImageLabFailureCode,
  type ImageLabInputList,
  type ImageLabRecordVerdictRequest,
  type ImageLabSettings,
  type ImageModel,
  type ImageProfileTask,
  type ResolvedImageProfile,
} from "@/contracts";
import { diag, type DiagnosticSink } from "@/contracts/diagnostics";
import { parseOr, parseOrNull } from "@/lib/parse";
import {
  classifyImageFailure,
  imageFailureHealthOutcome,
  mapImageRenderControls,
  REPLICATE_DEFAULT_EDIT_MODEL,
  runRegistryImageModel,
} from "../ai";
import { characterChats, characters, chatParticipants, db, imageLabExperiments, images } from "../db";
import { createImageAsset, deleteOwnedImage, readImageBytes, saveImageBuffer, type ImageRow } from "./assets";
import { loadImageModels, type RenderWithModelResult } from "./models";
import { resolveImageProfileForTask } from "./model-profiles";
import { baseImageModelSlug, withReviewedImageQuality } from "./quality-presets";
import { planImageRender, renderImageIntent, type ImageRenderIntent, type ImageRenderReference } from "./render-intent";
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
 * because the capabilities plan's role-aware selection does not exist yet and
 * half-consuming an unfinished vocabulary would smear the boundary. The two
 * BASELINE kinds do the opposite on purpose — they go through the very path
 * their lane goes through, since a baseline that compiled its settings some
 * other way would not be a baseline.
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
 * The three kinds Stage 0 can actually run.
 *
 * The other three (`controlled_portrait`, `controlled_scene`, `finishing_pass`)
 * are declared in the contract NOW so the record shape survives Stages 1–3
 * without a migration — but they name recipes that do not exist yet, and
 * accepting one would store an experiment nothing can ever settle.
 */
const STAGE_0_KINDS = ["control_probe", "baseline_portrait", "baseline_scene"] as const satisfies readonly ImageLabExperimentKind[];

function isStage0Kind(kind: ImageLabExperimentKind): boolean {
  return STAGE_0_KINDS.some((stage0) => stage0 === kind);
}

/**
 * The codes Stage 0's runner needs beyond {@link ImageLabFailureCode}'s own.
 *
 * The contract deliberately types `failureCode` as a bounded string rather than
 * that enum, "because it also carries codes from the render-failure classifier"
 * — the same reason applies here. Each of these names a state the contract's
 * codes cannot:
 * a kind with no recipe, a task the profile registry offers nothing for, and a
 * runner that died on something other than a provider call. Inventing another
 * enum member for each would freeze them into the wire contract, where a UI
 * would have to know about a state it can only display verbatim anyway.
 *
 * Dotted, because every one of them is written to a settled ROW or a sink. A
 * refusal envelope spells its code bare — see {@link labRefusal}.
 */
const LAB_KIND_UNSUPPORTED = "image_lab.kind_unsupported";
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
  if (!isStage0Kind(request.kind)) {
    return {
      ok: false,
      refusal: labRefusal(
        "kind_unsupported",
        `${request.kind} experiments arrive with a later stage; Stage 0 runs ${STAGE_0_KINDS.join(", ")}`,
        sink,
        { kind: request.kind },
      ),
    };
  }
  if (request.characterId !== undefined && !(await ownsCharacter(request.characterId, ownerId))) {
    return {
      ok: false,
      refusal: labRefusal("character_not_found", "character not found", sink, { characterId: request.characterId }),
    };
  }
  if (request.chatId !== undefined && !(await ownsChat(request.chatId, ownerId))) {
    return { ok: false, refusal: labRefusal("chat_not_found", "chat not found", sink, { chatId: request.chatId }) };
  }

  const [row] = await db()
    .insert(imageLabExperiments)
    .values({
      ownerId,
      kind: request.kind,
      mode: request.mode ?? null,
      characterId: request.characterId ?? null,
      chatId: request.chatId ?? null,
      // The model the plan is about. A named slug is how the fallback connector
      // gets probed if the first verdict reads `ignores_control`.
      modelSlug: request.modelSlug ?? REPLICATE_DEFAULT_EDIT_MODEL,
      instruction: request.instruction,
      inputs: request.inputs,
      controlImageId: request.controlImageId ?? null,
      controlKind: request.controlKind ?? null,
      settings: request.settings ?? emptyImageLabSettings(),
      status: "pending",
    })
    .returning();
  if (!row) throw new Error("image_lab_experiments insert returned no row");
  return { ok: true, experiment: toWireExperiment(row, sink) };
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
 * `control_probe` only, and that restriction is the point of the whole
 * protocol: the verdict answers "did the output obey the skeleton?", which is a
 * judgment made by looking at an image, and a baseline has no control to obey.
 * A ruling recorded against one would be a fact about nothing.
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
  if (row.kind !== "control_probe") {
    return {
      ok: false,
      refusal: labRefusal("verdict_not_applicable", `a ${row.kind} experiment has no control to rule on`, sink, {
        experimentId,
        kind: row.kind,
      }),
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
    case "finishing_pass":
      // Unreachable through `createImageLabExperiment`, which refuses these
      // kinds outright. Kept as a settled refusal rather than a throw so a row
      // that reached here some other way still records a reason.
      return settleFailed(row, LAB_KIND_UNSUPPORTED, `${row.kind} has no Stage 0 recipe`, sink);
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
      meta: { error: message.slice(0, 2000), ...extras.meta },
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

  const model = await resolveLabModel(row.modelSlug, sink);
  if (!model) {
    return await settleFailed(row, labFailure("version_unpinned"), `no registered image model matches ${row.modelSlug}`, sink);
  }
  const versionId = pinnedImageModelVersion(model);
  if (!versionId) {
    return await settleFailed(
      row,
      labFailure("version_unpinned"),
      `${model.slug} has no exact provider version to pin; a probe cannot run against a floating latest`,
      sink,
    );
  }

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

  const references: Buffer[] = [];
  for (const input of inputs) {
    const bytes = await readOwnedImageBytes(input.imageId, row.ownerId);
    if (!bytes) {
      return await settleFailed(
        row,
        labFailure("input_missing"),
        `image ${input.imageId} at position ${String(input.position)} could not be read`,
        sink,
        { columns: { requestedVersionId: versionId } },
      );
    }
    references.push(bytes);
  }

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
 * - it is sent under a role a control may occupy (pose, depth, or the generic
 *   `control` an edge map rides — `imageLabControlRole`'s own image). A skeleton
 *   ordered under `identity` is a probe asking the model to copy a face from a
 *   stick figure, which answers a question nobody asked.
 *
 * Then the fixture itself. A control that is not a `lab_control`, or whose meta
 * will not parse, means nothing can say what the fixture IS, and a probe verdict
 * about an unidentified fixture is worthless. The declared kind is checked
 * against the stored one for the same reason: an experiment recording "pose"
 * while pointing at a depth map would produce a verdict filed under the wrong
 * control.
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
      `control image ${controlImageId} is sent at position ${String(sent.position)} under the ${sent.role} role; a control fixture is sent as pose, depth, or control`,
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
  if (meta.reviewedAt === undefined) {
    return {
      code: "control_unreviewed",
      message: `control image ${controlImageId} has not been reviewed; review the fixture in the panel before spending a probe on it`,
    };
  }
  return null;
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

interface StoreLabRenderInput {
  finalPrompt: string;
  /** Provenance for the output row — the first reference this render was built from. */
  sourceImageId?: string;
  /** Columns already written pre-render, re-applied so a settle cannot drop them. */
  columns: Partial<typeof imageLabExperiments.$inferInsert>;
  sink?: DiagnosticSink;
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
      meta: { renderFailure },
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
