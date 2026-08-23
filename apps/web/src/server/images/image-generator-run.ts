import { and, eq } from "drizzle-orm";
import {
  controlReferenceTransport,
  effectiveImageLoraSelection,
  IMAGE_TARGET_ASPECT,
  imageFailureHealthOutcome,
  type ImageModel,
  type ImageModelProfile,
  type ImageProviderInputDescriptor,
  type ImageReferenceRole,
  type ImageRenderIntent,
  type ImageRenderReference,
  pinnedImageModelVersion,
  planImageRender,
  profileEligibility,
  referenceCapacity,
  TRIAL_FALLBACK_PREDICTION_MS,
} from "@vesper/image-core";
import {
  IMAGE_GENERATOR_MAX_PRIMARY,
  type ImageGeneratorFailureCode,
  imageGeneratorControlsSchema,
  imageGeneratorDiagnosticCode,
  imageGeneratorProviderInputsSchema,
  imageGeneratorRunInputsSchema,
  type ImageGeneratorRunInputs,
} from "@/contracts/images/image-generator";
import { diag, type DiagnosticSink } from "@/contracts/diagnostics";
import { parseOrNull } from "@/lib/parse";
import { classifyImageFailure, disableSafetyChecker } from "../ai";
import { db, imageGeneratorRuns } from "../db";
import { createImageAsset, deleteOwnedImage, saveImageBuffer } from "./assets";
import { generatorRenderer } from "./image-generator-render";
import {
  generatorRunMeta,
  IMAGE_GENERATOR_RUN_THREW,
  type ImageGeneratorRunPayload,
  type ImageGeneratorRunRow,
  ownedGeneratorRun,
  settleGeneratorRunFailed,
} from "./image-generator-store";
import { resolveImageLoraForRender } from "./image-loras";
import { loadImageModels } from "./models";
import { readOwnedImageBytes } from "./owned-image-reads";
import type { RenderImageIntentResult } from "./render-intent";

/**
 * The Image Generator's runner (image-lab-general-model-trials.spec.md
 * §"Generator runner"): the body of the `generator_image` job the route starts.
 *
 * NOTHING here throws through the job runner — every stop is a settled row
 * carrying its reason, because a raw-testing bench that threw would leave the
 * admin staring at a `pending` record with nothing on it. And everything that
 * can refuse does so BEFORE provider spend: the failed attempt is a stable
 * `image_generator.*` code (or a verbatim shared-layer code) on the row, never
 * a silently trimmed request.
 *
 * Deliberately parallel to — never importing — the Lab's render kernel: the
 * two benches share the pure planner, the LoRA resolver, and the byte readers,
 * and nothing else.
 */

/** The contract's own codes, spelled through the contract's own helper. */
function generatorFailure(code: ImageGeneratorFailureCode): string {
  return imageGeneratorDiagnosticCode(code);
}

/**
 * Run one Generator run. A settled run is never re-run — its evidence already
 * exists, and a second render under the same id would replace an output the
 * admin may already be comparing. A rerun is a new row via `sourceRunId`.
 */
export async function runImageGeneratorRun(
  runId: string,
  ownerId: string,
  sink?: DiagnosticSink,
): Promise<ImageGeneratorRunPayload> {
  const row = await ownedGeneratorRun(runId, ownerId);
  if (!row) return { runId, skipped: "not_found", providerOutcome: null };
  if (row.status !== "pending") return { runId, skipped: row.status, providerOutcome: null };

  await db()
    .update(imageGeneratorRuns)
    .set({ status: "running", startedAt: new Date() })
    .where(and(eq(imageGeneratorRuns.id, runId), eq(imageGeneratorRuns.ownerId, ownerId)));

  try {
    return await runGeneratorBody(row, sink);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return await settleGeneratorRunFailed(row, IMAGE_GENERATOR_RUN_THREW, message, sink);
  }
}

async function runGeneratorBody(row: ImageGeneratorRunRow, sink?: DiagnosticSink): Promise<ImageGeneratorRunPayload> {
  // 1. The stored bags, fail-closed. A bag that no longer parses must REFUSE
  // rather than degrade to empty: an empty-because-failed inputs bag would run
  // prompt-only as if the admin selected nothing, and an empty controls bag
  // would silently drop every explicitly chosen knob (docs/resilience.md §1 —
  // a fallback must never read as a positive claim). Each parse failure has
  // already pushed its own `parse.boundary_failed` diagnostic by the time the
  // settle names the consequence.
  const inputs = parseOrNull(imageGeneratorRunInputsSchema, row.inputs, sink, "image_generator_runs.inputs");
  if (!inputs) {
    return await settleGeneratorRunFailed(
      row,
      generatorFailure("input_missing"),
      "the stored input selection could not be read",
      sink,
    );
  }
  const controls = parseOrNull(imageGeneratorControlsSchema, row.controls, sink, "image_generator_runs.controls");
  if (!controls) {
    return await settleGeneratorRunFailed(
      row,
      generatorFailure("control_refused"),
      "the stored controls could not be read",
      sink,
    );
  }
  const providerInputs = parseOrNull(
    imageGeneratorProviderInputsSchema,
    row.providerInputs,
    sink,
    "image_generator_runs.provider_inputs",
  );
  if (!providerInputs) {
    return await settleGeneratorRunFailed(
      row,
      generatorFailure("provider_input_rejected"),
      "the stored provider inputs could not be read",
      sink,
    );
  }

  // 2. Re-resolve the snapshot slug — EXACT match only. The Lab's resolver also
  // accepts the base-slug spelling for typed input; a Generator row snapshots
  // the registry's own spelling at create, so anything but an exact hit means
  // the registration is gone.
  const models = await loadImageModels(sink);
  const model = models.find((candidate) => candidate.slug === row.modelSlug);
  if (!model) {
    return await settleGeneratorRunFailed(
      row,
      generatorFailure("model_missing"),
      `no registered image model matches ${row.modelSlug}`,
      sink,
    );
  }

  // 3. Pin the exact version, and put it on the record BEFORE anything can
  // spend: a failed attempt must still say what weights it asked for.
  const versionId = pinnedImageModelVersion(model);
  if (!versionId) {
    return await settleGeneratorRunFailed(
      row,
      generatorFailure("version_unpinned"),
      `${model.slug} has no exact provider version to pin; a run cannot execute a floating latest`,
      sink,
    );
  }
  const columns = { requestedVersionId: versionId };
  await db()
    .update(imageGeneratorRuns)
    .set(columns)
    .where(and(eq(imageGeneratorRuns.id, row.id), eq(imageGeneratorRuns.ownerId, row.ownerId)));

  // 4. The operation is derived from what the admin actually sent.
  const referencesSelected = inputs.primary.length + inputs.dedicated.length > 0;
  const operation = referencesSelected ? "edit" : "generate";
  if (operation === "generate" && !model.canGenerate) {
    return await settleGeneratorRunFailed(
      row,
      generatorFailure("operation_unsupported"),
      `${model.slug} cannot generate from text alone; select at least one reference`,
      sink,
      { columns },
    );
  }
  if (operation === "edit" && !model.canEdit) {
    return await settleGeneratorRunFailed(
      row,
      generatorFailure("operation_unsupported"),
      `${model.slug} takes no image input; remove the selected references`,
      sink,
      { columns },
    );
  }

  // 5. Capacity, before any byte is read: explicit references are never
  // trimmed, so a selection that cannot all go refuses instead.
  const primaryCapacity = Math.min(referenceCapacity(model).max, IMAGE_GENERATOR_MAX_PRIMARY);
  if (inputs.primary.length > primaryCapacity) {
    return await settleGeneratorRunFailed(
      row,
      generatorFailure("capacity_exceeded"),
      `${String(inputs.primary.length)} primary references were selected and ${model.slug} can carry ${String(primaryCapacity)}`,
      sink,
      { columns },
    );
  }

  // 6. Every explicitly dedicated role must have a dedicated provider field on
  // this model — never a fallback to the numbered array, which would send the
  // control as ordinary content and render a picture OF a skeleton.
  for (const dedicated of inputs.dedicated) {
    if (!hasDedicatedInputBinding(model, dedicated.role)) {
      return await settleGeneratorRunFailed(
        row,
        generatorFailure("dedicated_input_unbound"),
        `${model.slug} declares no dedicated ${dedicated.role} input on its active version`,
        sink,
        { columns },
      );
    }
  }

  // 6b. The advanced bag may not reach a field another path owns, and a value
  // the probe can type-check must be right BEFORE spend (plan §13). The shared
  // `validateProviderOverrides` inside the compile only knows reserved-set and
  // known-field membership; the checks here close what it cannot see — the
  // transport writes the bag LAST, so a collision it let through would silently
  // overwrite the admin's own dedicated image or a reviewed pin.
  const rejectedInput = rejectedProviderInput(model, providerInputs);
  if (rejectedInput) {
    return await settleGeneratorRunFailed(row, generatorFailure("provider_input_rejected"), rejectedInput, sink, {
      columns,
    });
  }

  // 7. Bytes, owner-scoped; any unreadable selection refuses — never substitute.
  const references = await readGeneratorReferences(inputs, row.ownerId);
  if (!references.ok) {
    return await settleGeneratorRunFailed(row, generatorFailure("input_missing"), references.message, sink, { columns });
  }

  // 8. The synthetic profile and the intent. `profileEligibility` runs against
  // it like any other profile — with the nominal non-identity task, that is
  // exactly the model's own mechanical flags saying the operation cannot run.
  const profile = imageGeneratorProfile(model, operation, providerInputs);
  const eligibility = profileEligibility(profile, model);
  if (!eligibility.ok) {
    return await settleGeneratorRunFailed(
      row,
      generatorFailure("operation_unsupported"),
      `${model.slug} cannot run this request: ${eligibility.reason}`,
      sink,
      { columns },
    );
  }

  // 9. Resolve the LoRA FIRST when one is asked for, so a library refusal
  // settles pre-spend under the layer's own verbatim `image_lora.*` code.
  const selection = effectiveImageLoraSelection(profile.controlDefaults, controls);
  let intent: ImageRenderIntent = {
    profile: { profile, model },
    prompt: row.prompt,
    references: references.list,
    target: { aspectRatio: IMAGE_TARGET_ASPECT },
    controls,
    versionId,
  };
  if (selection) {
    const resolved = await resolveImageLoraForRender(selection, { model, versionId, task: profile.task }, sink);
    if (!resolved.ok) {
      return await settleGeneratorRunFailed(row, resolved.code, resolved.message, sink, { columns });
    }
    intent = { ...intent, resolvedLora: resolved.binding };
  }

  // 10. Plan, and refuse ANY planner refusal verbatim — the `image_profile.*`
  // vocabulary belongs to the layer that refused.
  const planned = planImageRender(intent, { safetyCheckerDisabled: disableSafetyChecker() }, sink);
  if (!planned.ok) {
    return await settleGeneratorRunFailed(row, planned.refusal.code, planned.refusal.message, sink, { columns });
  }
  const plan = planned.plan;

  // Every reference was marked `required`, so the planner refuses a drop
  // itself; this net catches only a planner whose drop vocabulary widened.
  if (plan.dropped.length > 0) {
    return await settleGeneratorRunFailed(
      row,
      generatorFailure("capacity_exceeded"),
      `the plan would not send ${String(plan.dropped.length)} of the selected references`,
      sink,
      { columns },
    );
  }
  // Primary references all travel as `reference`; a structural role among the
  // SENT numbered references means a dedicated selection fell back to the
  // numbered array — the fallback this runner exists to refuse.
  const structural = plan.sentReferences.find((reference) => reference.role !== "reference");
  if (structural) {
    return await settleGeneratorRunFailed(
      row,
      generatorFailure("dedicated_input_unbound"),
      `the ${structural.role} input would ride the numbered reference array instead of its dedicated field`,
      sink,
      { columns },
    );
  }
  const refusedControl = refusedDroppedControl(plan.droppedControls);
  if (refusedControl) {
    return await settleGeneratorRunFailed(row, generatorFailure(refusedControl.code), refusedControl.message, sink, {
      columns,
    });
  }

  // 11. The record BEFORE the spend: the compiled prompt as it will be sent,
  // and what the plan decided. A stop after this point can no longer make the
  // row claim it sent something else.
  const finalPrompt = plan.prompt;
  const columnsWithPrompt = { ...columns, finalPrompt };
  const outcome = {
    sentRoles: plan.sentReferences.map((reference) => reference.role),
    dedicatedFields: plan.controlReferences.map((reference) => reference.field),
    renumbered: plan.referencesRenumbered,
  };
  const metaWithOutcome = generatorRunMeta(row, { outcome });
  await db()
    .update(imageGeneratorRuns)
    .set({ ...columnsWithPrompt, meta: metaWithOutcome })
    .where(and(eq(imageGeneratorRuns.id, row.id), eq(imageGeneratorRuns.ownerId, row.ownerId)));
  // Every later settle re-derives meta from this row object; carrying the
  // written bag forward is what keeps the pre-spend outcome record from being
  // erased by the settle's own assignment.
  const rowWithOutcome: ImageGeneratorRunRow = { ...row, meta: metaWithOutcome };

  // 12. Render through the seam, then settle against what came back.
  const rendered = await generatorRenderer()({ mode: "intent", intent }, sink);
  return await settleGeneratorRender(rowWithOutcome, rendered, finalPrompt, columnsWithPrompt, plan.references.length, sink);
}

/**
 * Settle the run against the renderer's answer. Provider failure and local
 * persistence failure stay DISTINCT — `render_failed` reports the classifier's
 * health reading, while `output_store_failed` reports `providerOutcome: true`,
 * because the provider rendered and charging the lane for this disk would shed
 * everyone's work over a local write.
 */
async function settleGeneratorRender(
  row: ImageGeneratorRunRow,
  rendered: RenderImageIntentResult,
  finalPrompt: string,
  columns: Partial<typeof imageGeneratorRuns.$inferInsert>,
  plannedPrimaryCount: number,
  sink?: DiagnosticSink,
): Promise<ImageGeneratorRunPayload> {
  const provenance = {
    predictionId: rendered.predictionId ?? null,
    executedVersionId: rendered.executedVersionId ?? null,
  };
  // The transport's inline byte budget can drop tail references after the
  // plan settled — post-spend, so unrefusable, but a comparison read weeks
  // later must not mistake the run for one that sent everything.
  const trimmed =
    rendered.sentReferenceCount !== undefined && rendered.sentReferenceCount < plannedPrimaryCount
      ? { trimmedPrimaries: { planned: plannedPrimaryCount, sent: rendered.sentReferenceCount } }
      : {};
  if ("trimmedPrimaries" in trimmed) {
    sink?.push(
      diag("warn", "image_generator.references_trimmed", "the transport sent fewer primary references than planned", {
        context: { runId: row.id, ...trimmed.trimmedPrimaries },
      }),
    );
  }
  const attemptMeta = { ...(rendered.attempt ? { attempt: rendered.attempt } : {}), ...trimmed };

  if (!rendered.ok || !rendered.image) {
    const message = rendered.error ?? `${row.modelSlug} returned no image`;
    const renderFailure = classifyImageFailure(message);
    return await settleGeneratorRunFailed(row, generatorFailure("render_failed"), message, sink, {
      columns: { ...columns, ...provenance },
      meta: { renderFailure, ...attemptMeta },
      providerOutcome: imageFailureHealthOutcome(renderFailure),
    });
  }

  const asset = await createImageAsset({
    ownerId: row.ownerId,
    kind: "generator_output",
    prompt: finalPrompt,
    meta: { hidden: true, imageGeneratorRunId: row.id },
  });
  const saved = await saveImageBuffer(asset.id, rendered.image, sink);
  if (saved?.status !== "ready") {
    await deleteOwnedImage(asset.id, row.ownerId, { kind: "generator_output" });
    return await settleGeneratorRunFailed(
      row,
      generatorFailure("output_store_failed"),
      "the provider rendered but the output could not be written locally",
      sink,
      { columns: { ...columns, ...provenance }, meta: attemptMeta, providerOutcome: true },
    );
  }

  const [settled] = await db()
    .update(imageGeneratorRuns)
    .set({
      ...columns,
      ...provenance,
      resultImageId: saved.id,
      status: "succeeded",
      failureCode: null,
      error: null,
      finishedAt: new Date(),
      meta: generatorRunMeta(row, attemptMeta),
    })
    .where(and(eq(imageGeneratorRuns.id, row.id), eq(imageGeneratorRuns.ownerId, row.ownerId)))
    .returning({ id: imageGeneratorRuns.id });

  // The run was deleted while its render was in flight — allowed on purpose,
  // so a deploy-stranded row can be cleared. The settle matched nothing, which
  // means the pointer making this output findable was never written; the image
  // is already an orphan and goes through the same owned deleter the run's own
  // delete uses.
  if (!settled) {
    const removed = await deleteOwnedImage(saved.id, row.ownerId, { kind: "generator_output" });
    sink?.push(
      diag("info", "image_generator.output_orphaned", "the run was deleted mid-render; its output was discarded", {
        context: { runId: row.id, imageId: saved.id, removed },
      }),
    );
    return { runId: row.id, status: "discarded", outputImagesRemoved: removed ? 1 : 0, providerOutcome: true, ...provenance };
  }
  return { runId: row.id, status: "succeeded", resultImageId: saved.id, providerOutcome: true, ...provenance };
}

// ---------------------------------------------------------------------------
// The synthetic profile and its inputs
// ---------------------------------------------------------------------------

/**
 * The in-memory `ImageModelProfile`-shaped object one run executes — never a
 * database row, never resolved from production configuration.
 *
 * - Pass-through prompt strategies (`instruction_edit` with references,
 *   `text_to_image_description` without): the admin-authored prompt is the
 *   whole positive prompt, and only the shared model-dialect boundary may
 *   touch it.
 * - Open reference policy: an empty `allowedRoles` allows everything, and the
 *   caller's own order is the send order.
 * - `seedPolicy: "caller"` — an explicit seed is honoured verbatim; an
 *   unseeded run stays honestly unseeded, never a hidden dice roll.
 * - The run's advanced values travel as `providerOverrides`, so
 *   `validateProviderOverrides` (known/reserved, fail-closed on an empty
 *   `knownInputFields`) applies unchanged.
 * - The task is NOMINAL: `ImageProfileTask` has no bench member, and this
 *   profile never resolves from production, so the constraint on the choice is
 *   only that it must not be identity-critical (`variant`/`scene`/`chat_look`
 *   would let identity screening refuse the raw testing this bench exists
 *   for). `item` is the neutral pick. One real consequence: a curated LoRA
 *   must list this task in its `allowedTasks` to run here.
 */
function imageGeneratorProfile(
  model: ImageModel,
  operation: "generate" | "edit",
  providerInputs: Record<string, string | number | boolean>,
): ImageModelProfile {
  return {
    id: "image-generator/run",
    imageModelId: model.id,
    key: "image-generator",
    label: "Image Generator",
    task: "item",
    operation,
    promptStrategy: operation === "edit" ? "instruction_edit" : "text_to_image_description",
    referencePolicy: { allowedRoles: [], requiredRoles: [], roleOrder: [], identityStrategy: "canonical_only" },
    controlDefaults: { seedPolicy: "caller" },
    providerOverrides: providerInputs,
    timeoutMs: TRIAL_FALLBACK_PREDICTION_MS,
    enabled: true,
    isDefault: false,
    builtin: false,
    sort: 0,
  };
}

/**
 * Whether this model's active version gives `role` a dedicated provider field —
 * the planner's own `controlReferenceTransport` decision, asked pre-spend. The
 * planner remains authoritative for what is actually sent; the post-plan
 * structural-role check above refuses if the two ever disagree.
 */
function hasDedicatedInputBinding(model: ImageModel, role: ImageReferenceRole): boolean {
  return controlReferenceTransport(model, role).kind === "dedicated_input";
}

type GeneratorReferences = { ok: true; list: ImageRenderReference[] } | { ok: false; message: string };

/**
 * The intent's reference list: primaries under the neutral `reference` role in
 * caller order, then dedicated inputs under their structural roles. Everything
 * is `required` — the Generator never lets the planner quietly trim an
 * explicit selection. The stored `purpose` is provenance only and deliberately
 * does not travel here.
 */
async function readGeneratorReferences(inputs: ImageGeneratorRunInputs, ownerId: string): Promise<GeneratorReferences> {
  const list: ImageRenderReference[] = [];
  const selections: { role: ImageReferenceRole; imageId: string }[] = [
    ...inputs.primary.map((input) => ({ role: "reference" as const, imageId: input.imageId })),
    ...inputs.dedicated.map((input) => ({ role: input.role, imageId: input.imageId })),
  ];
  for (const selection of selections) {
    const buffer = await readOwnedImageBytes(selection.imageId, ownerId);
    if (!buffer) return { ok: false, message: `image ${selection.imageId} could not be read` };
    list.push({ role: selection.role, buffer, required: true, sourceImageId: selection.imageId });
  }
  return { ok: true, list };
}

/**
 * The refusal one dropped control maps to, or null for the profile's own
 * scaffolding. Classified by the DROP REASON, not by name membership in the
 * provider bag: normalized-control drops are named by normalized name
 * ("guidance", "steps"), which collides with real provider keys, so a name
 * test would file a missing-binding control under the wrong bucket.
 * `unknown_field`/`reserved` can only come from `validateProviderOverrides`
 * over the bag; everything else is a normalized control the version cannot
 * represent.
 */
function refusedDroppedControl(
  droppedControls: readonly { control: string; reason: string }[],
): { code: Extract<ImageGeneratorFailureCode, "control_refused" | "provider_input_rejected">; message: string } | null {
  for (const entry of droppedControls) {
    // The synthetic profile's own `seedPolicy: "caller"` records a drop on
    // every unseeded run; nobody selected it, so it refuses nothing. The
    // controls schema cannot express `seedPolicy`, so this can never mask an
    // admin's choice.
    if (entry.control === "seedPolicy") continue;
    if (entry.reason === "unknown_field" || entry.reason === "reserved") {
      return {
        code: "provider_input_rejected",
        message: `provider input ${entry.control} was rejected: ${entry.reason}`,
      };
    }
    return {
      code: "control_refused",
      message: `the ${entry.control} control cannot be represented on this version: ${entry.reason}`,
    };
  }
  return null;
}

/**
 * The pre-spend gate over the raw provider bag (plan §13). Three layers, all
 * derivable without spend:
 *
 * 1. Fields another path owns on EVERY capability record — the curated LoRA
 *    transport, dedicated structural inputs, and reviewed `extraInput` pins.
 *    The transport overlays the bag last, so a collision here would silently
 *    replace the admin's own selection or a reviewed value.
 * 2. Descriptor `reserved` flags, when the record carries descriptors — the
 *    same rule the form uses to withhold an editor.
 * 3. Descriptor type/enum/range facts, when declared — a value the probe can
 *    prove wrong must refuse here, not settle as a provider validation error
 *    after spend.
 *
 * Records probed before descriptors existed simply skip layers 2–3.
 */
function rejectedProviderInput(
  model: ImageModel,
  providerInputs: Record<string, string | number | boolean>,
): string | null {
  // No empty-bag early return: the required-descriptor sweep at the bottom
  // must run even when the admin set nothing at all.
  const keys = Object.keys(providerInputs);

  const loraFields = new Set(
    [model.advancedCapabilities.controls.loraWeights?.field, model.advancedCapabilities.controls.loraScale?.field].filter(
      (field): field is string => field !== undefined,
    ),
  );
  const dedicatedFields = new Set(model.advancedCapabilities.additionalImageInputs.map((input) => input.binding.field));
  const pinnedFields = new Set(Object.keys(model.extraInput));
  for (const key of keys) {
    if (loraFields.has(key)) {
      return `${key} belongs to the curated LoRA library — select a library LoRA instead of a raw provider value`;
    }
    if (dedicatedFields.has(key)) {
      return `${key} is a dedicated image input — select an image for it instead of a raw provider value`;
    }
    if (pinnedFields.has(key)) {
      return `${key} is pinned by the model's reviewed configuration and cannot be overridden here`;
    }
  }

  const descriptors = new Map(
    model.advancedCapabilities.providerInputs.map((descriptor) => [descriptor.field, descriptor]),
  );
  if (descriptors.size === 0) return null;
  for (const key of keys) {
    const descriptor = descriptors.get(key);
    const value = providerInputs[key];
    if (!descriptor || value === undefined) continue; // unknown fields are validateProviderOverrides' refusal
    if (descriptor.reserved) {
      return `${key} is owned by the render path on this version and cannot be set as an advanced value`;
    }
    const violation = providerInputTypeViolation(descriptor, value);
    if (violation) return violation;
  }
  // A required non-reserved field with no declared default can only come from
  // the bag; omitting it would spend a prediction the provider is certain to
  // reject. Reserved required fields are the render path's own job (prompt,
  // reference, control bindings) and are not the bag's to fill.
  for (const descriptor of descriptors.values()) {
    if (
      descriptor.required &&
      !descriptor.reserved &&
      descriptor.default === undefined &&
      providerInputs[descriptor.field] === undefined
    ) {
      return `${descriptor.field} is required by this version and has no default — set it under Advanced Model Inputs`;
    }
  }
  return null;
}

/** A declared-type/enum/range violation the probe can prove, or null. */
function providerInputTypeViolation(
  descriptor: ImageProviderInputDescriptor,
  value: string | number | boolean,
): string | null {
  const range = (numeric: number): string | null => {
    if (descriptor.minimum !== undefined && numeric < descriptor.minimum) {
      return `${descriptor.field} must be at least ${String(descriptor.minimum)}`;
    }
    if (descriptor.maximum !== undefined && numeric > descriptor.maximum) {
      return `${descriptor.field} must be at most ${String(descriptor.maximum)}`;
    }
    return null;
  };
  switch (descriptor.type) {
    case "boolean":
      return typeof value === "boolean" ? null : `${descriptor.field} expects a boolean`;
    case "integer":
      if (typeof value !== "number" || !Number.isInteger(value)) return `${descriptor.field} expects an integer`;
      return range(value);
    case "number":
      if (typeof value !== "number") return `${descriptor.field} expects a number`;
      return range(value);
    case "string":
      return typeof value === "string" ? null : `${descriptor.field} expects a string`;
    case "enum": {
      if (typeof value !== "string") return `${descriptor.field} expects one of its declared options`;
      if (descriptor.enumValues && !descriptor.enumValues.includes(value)) {
        return `${descriptor.field} must be one of: ${descriptor.enumValues.join(", ")}`;
      }
      return null;
    }
    // `uri`, `array`, and `unknown` carry no provable primitive shape here.
    case "uri":
    case "array":
    case "unknown":
      return null;
  }
}
