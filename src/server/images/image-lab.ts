import { and, asc, desc, eq } from "drizzle-orm";
import {
  chooseAspect,
  emptyImageLabSettings,
  imageLabControlMetaSchema,
  imageLabDiagnosticCode,
  imageLabInputListSchema,
  imageLabSettingsSchema,
  IMAGE_TARGET_ASPECT,
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
 * the route starts the job, the service is the body of it.
 */

export type ImageLabExperimentRow = typeof imageLabExperiments.$inferSelect;

/** A refusal reported to the admin as a 400: nothing was stored, nothing spent. */
export interface ImageLabRefusal {
  code: string;
  message: string;
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
 * The codes Stage 0's runner needs beyond {@link ImageLabFailureCode}'s five.
 *
 * The contract deliberately types `failureCode` as a bounded string rather than
 * that enum, "because it also carries codes from the render-failure classifier"
 * — the same reason applies here. Each of these names a state the five cannot:
 * a kind with no recipe, a task the profile registry offers nothing for, and a
 * runner that died on something other than a provider call. Inventing a sixth
 * enum member for each would freeze them into the wire contract, where a UI
 * would have to know about a state it can only display verbatim anyway.
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
 * Deliberately NOT checked: that a probe carries any particular inputs, or that
 * its control image is a real fixture. Those are the runner's recorded refusals
 * (spec §Algorithms steps 1 and 3) — a 400 there would leave no trace of the
 * attempt, and the whole point of the bench is that attempts leave traces.
 */
export async function createImageLabExperiment(
  input: CreateImageLabExperimentInput,
): Promise<CreateImageLabExperimentResult> {
  const { ownerId, request } = input;
  if (!isStage0Kind(request.kind)) {
    return {
      ok: false,
      refusal: {
        code: LAB_KIND_UNSUPPORTED,
        message: `${request.kind} experiments arrive with a later stage; Stage 0 runs ${STAGE_0_KINDS.join(", ")}`,
      },
    };
  }
  if (request.characterId !== undefined && !(await ownsCharacter(request.characterId, ownerId))) {
    return { ok: false, refusal: { code: "image_lab.character_not_found", message: "character not found" } };
  }
  if (request.chatId !== undefined && !(await ownsChat(request.chatId, ownerId))) {
    return { ok: false, refusal: { code: "image_lab.chat_not_found", message: "chat not found" } };
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
  return { ok: true, experiment: toWireExperiment(row, input.sink) };
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
      refusal: {
        code: "image_lab.verdict_not_applicable",
        message: `a ${row.kind} experiment has no control to rule on`,
      },
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
 * looking at `jobs`, never by code.
 */
export async function runImageLabExperiment(
  experimentId: string,
  ownerId: string,
  sink?: DiagnosticSink,
): Promise<Record<string, unknown>> {
  const row = await ownedExperiment(experimentId, ownerId);
  if (!row) return { experimentId, skipped: "not_found" };
  // A settled experiment is never re-run: its evidence already exists, and a
  // second render under the same id would replace an output the verdict may
  // already be about. A rerun is a new experiment.
  if (row.status !== "pending") return { experimentId, skipped: row.status };

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
function runExperimentOfKind(row: ImageLabExperimentRow, sink?: DiagnosticSink): Promise<Record<string, unknown>> {
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
): Promise<Record<string, unknown>> {
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
  return { experimentId: row.id, status: "failed", failureCode };
}

/** The five contract codes, spelled through the contract's own helper. */
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
async function runControlProbe(row: ImageLabExperimentRow, sink?: DiagnosticSink): Promise<Record<string, unknown>> {
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

  const controlRefusal = await checkControlFixture(row, sink);
  if (controlRefusal) {
    return await settleFailed(row, labFailure("control_invalid"), controlRefusal, sink, {
      columns: { requestedVersionId: versionId },
    });
  }

  // The admin's instruction VERBATIM. The numbered-role template is pre-filled
  // in the UI, where the admin can read and edit it, never assembled silently
  // here — a probe whose prompt the runner rewrote would be evidence about the
  // runner.
  const finalPrompt = row.instruction;
  const settings = storedSettings(row, sink);
  const effectiveModel = withReviewedImageQuality(model);
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

/**
 * Whether the named control fixture is one — the message when it is not.
 *
 * A control that is not a `lab_control`, or whose meta will not parse, means
 * nothing can say what the fixture IS, and a probe verdict about an unidentified
 * fixture is worthless. The declared kind is checked against the stored one for
 * the same reason: an experiment recording "pose" while pointing at a depth map
 * would produce a verdict filed under the wrong control.
 */
async function checkControlFixture(row: ImageLabExperimentRow, sink?: DiagnosticSink): Promise<string | null> {
  if (row.controlImageId === null) return null;
  const control = await ownedImageRow(row.controlImageId, row.ownerId);
  if (!control) return `control image ${row.controlImageId} is not an image this owner has`;
  if (control.kind !== "lab_control") return `control image ${row.controlImageId} is a ${control.kind}, not a lab control fixture`;
  const meta = parseOrNull(imageLabControlMetaSchema, control.meta, sink, "images.meta.lab_control");
  if (!meta) return `control image ${row.controlImageId} has no readable fixture metadata`;
  if (row.controlKind !== null && meta.controlKind !== row.controlKind) {
    return `control image ${row.controlImageId} is a ${meta.controlKind} fixture, not the ${row.controlKind} this experiment records`;
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
): Promise<Record<string, unknown>> {
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
 */
async function storeLabRender(
  row: ImageLabExperimentRow,
  rendered: RenderWithModelResult,
  input: StoreLabRenderInput,
): Promise<Record<string, unknown>> {
  const { sink } = input;
  const provenance = {
    predictionId: rendered.predictionId ?? null,
    executedVersionId: rendered.executedVersionId ?? null,
  };

  if (!rendered.ok || !rendered.image) {
    const message = rendered.error ?? `${row.modelSlug} returned no image`;
    return await settleFailed(row, labFailure("render_failed"), message, sink, {
      columns: { ...input.columns, ...provenance },
      meta: { renderFailure: classifyImageFailure(message) },
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
    });
  }

  await db()
    .update(imageLabExperiments)
    .set({
      ...input.columns,
      ...provenance,
      resultImageId: saved.id,
      status: "succeeded",
      failureCode: null,
      finishedAt: new Date(),
    })
    .where(and(eq(imageLabExperiments.id, row.id), eq(imageLabExperiments.ownerId, row.ownerId)));
  return { experimentId: row.id, status: "succeeded", resultImageId: saved.id, ...provenance };
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
