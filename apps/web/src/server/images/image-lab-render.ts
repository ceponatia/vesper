import { and, eq } from "drizzle-orm";
import {
  baseImageModelSlug,
  effectiveImageLoraSelection,
  IMAGE_TARGET_ASPECT,
  imageFailureHealthOutcome,
  imageLabControlMetaSchema,
  imageLabDiagnosticCode,
  type ImageLabFailureCode,
  type ImageLabInput,
  type ImageLabInputList,
  type ImageLabOutcome,
  type ImageLabSettings,
  type ImageLoraRenderBinding,
  type ImageModel,
  type ImageModelProfile,
  type ImageReferenceRole,
  type ImageRenderControls,
  type ImageRenderIntent,
  type ImageRenderReference,
  type ImageRenderRuntimeFacts,
  isImageLabControlRole,
  pinnedImageModelVersion,
  planImageRender,
  type PlannedImageRender,
  profileEligibility,
} from "@vesper/image-core";
import { diag, type DiagnosticSink } from "@/contracts/diagnostics";
import { parseOrNull } from "@/lib/parse";
import { classifyImageFailure, disableSafetyChecker, replicateClient } from "../ai";
import { db, imageLabExperiments, images } from "../db";
import { createImageAsset, deleteOwnedImage, type ImageRow, readImageBytes, saveImageBuffer } from "./assets";
import { resolveImageLoraForRender } from "./image-loras";
import { loadImageModels, type RenderWithModelResult } from "./models";
import { renderImageIntent } from "./render-intent";
import {
  type ImageLabExperimentRow,
  type ImageLabProviderOutcome,
  type ImageLabRunPayload,
  LAB_PROFILE_UNAVAILABLE,
  labMeta,
} from "./image-lab-store";

/**
 * The lab's render kernel: the one renderer seam every kind goes through, the
 * settle-a-failed-row helper, the shared control-fixture gates, the recipe-shaped
 * intent run, output storage and the shared model/input reads.
 *
 * Everything here is shared by two or more experiment kinds — that is the
 * admission rule. A helper only one lane uses lives with that lane.
 */

/**
 * The deployment facts the lab's own planning paths hand the pure planner.
 *
 * The lab plans directly rather than through `renderImageIntent` — it needs the
 * compiled prompt before it renders, so the experiment row records what actually
 * ran — which means it also owns reading the setting the planner may not read.
 * Same value, same moment as the production path (monorepo-image-core.spec.render-kernel.md
 * §"The remaining inversions").
 */
export function labRuntimeFacts(): ImageRenderRuntimeFacts {
  return { safetyCheckerDisabled: disableSafetyChecker() };
}

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
      return replicateClient().runRegistryImageModel(
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

export function labRenderer(): ImageLabRenderer {
  return injectedRenderer ?? runRealLabRender;
}


// ---------------------------------------------------------------------------
// Settling a failed run
// ---------------------------------------------------------------------------

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
export async function settleFailed(
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
export function labFailure(code: ImageLabFailureCode): string {
  return imageLabDiagnosticCode(code);
}

// --- shared control-fixture gates ------------------------------------------


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
export async function checkControlBinding(
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


// --- shared recipe-shaped run ----------------------------------------------

/**
 * The refusal both recipe kinds share, and the reason it is one sentence in one
 * place: the raw bag is a PROBE tool, and a recipe run exists to prove a
 * production-shaped request. Two spellings of that would let one kind start
 * stripping the bag while the other refused it.
 */
export const RAW_BAG_REFUSAL =
  "a recipe experiment runs the production shape, which has no raw provider bag; clear controlInput or run a control probe";

export function carriesRawProviderBag(settings: ImageLabSettings): boolean {
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
export async function runRecipeIntent(row: ImageLabExperimentRow, input: RecipeIntentRun): Promise<ImageLabRunPayload> {
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
  const planned = planImageRender(intent, labRuntimeFacts());
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
export function planOutcome(plan: PlannedImageRender, recipeKey?: string): ImageLabOutcome {
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
export async function storeLabRender(
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
export async function resolvePinnedLabModel(slug: string, subject: string, sink?: DiagnosticSink): Promise<PinnedLabModelResult> {
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
export async function readOrderedInputBytes(inputs: ImageLabInputList, ownerId: string): Promise<ReadOrderedInputsResult> {
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
export async function readOwnedImageBytes(imageId: string, ownerId: string): Promise<Buffer | null> {
  const row = await ownedImageRow(imageId, ownerId);
  if (!row || row.status !== "ready") return null;
  return await readImageBytes(row);
}
