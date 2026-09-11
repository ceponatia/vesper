import { and, eq } from "drizzle-orm";
import {
  chooseDimensions,
  controlReferenceTransport,
  effectiveImageLoraSelection,
  imageAspectInputField,
  type ImageModel,
  type ImageModelProfile,
  type ImageProviderInputDescriptor,
  type ImageReferenceRole,
  type ImageRenderIntent,
  type ImageRenderReference,
  parseAspectValue,
  pinnedImageModelVersion,
  withReviewedImageQuality,
  planImageRender,
  type PlannedImageRender,
  profileEligibility,
  providerDefaultDimensions,
  referenceCapacity,
  TRIAL_FALLBACK_PREDICTION_MS,
} from "@vesper/image-core";
import {
  IMAGE_GENERATOR_MAX_PRIMARY,
  imageGeneratorCapabilitySnapshotSchema,
  type ImageGeneratorFailureCode,
  imageGeneratorControlsSchema,
  imageGeneratorDiagnosticCode,
  imageGeneratorImageCount,
  imageGeneratorProviderInputsSchema,
  imageGeneratorRenderControls,
  imageGeneratorRunInputsSchema,
  type ImageGeneratorRunInputs,
} from "@/contracts/images/image-generator";
import { providerInputViolations } from "@vesper/image-replicate";
import type { DiagnosticSink } from "@/contracts/diagnostics";
import { parseOrNull } from "@/lib/parse";
import { previewImageModelRequest } from "../ai";
import { db, imageGeneratorRuns } from "../db";
import { imageMeta } from "./asset-storage";
import {
  generatorRunMeta,
  type ImageGeneratorRunPayload,
  type ImageGeneratorRunRow,
  type ImageGeneratorVersionRequest,
  ownedGeneratorRun,
  settleGeneratorRunFailed,
  storedVersionRequest,
} from "./image-generator-store";
import { resolveImageLoraForRender } from "./image-loras";
import { adapterRequestRefusals, benchExecutionPolicy, imageRenderRuntimeFacts } from "./model-adapters";
import { loadImageModels } from "./models";
import { readOwnedImageBytes } from "./owned-image-reads";
import { capabilitySnapshotOf, effectiveRequestRecord, type PlannedShape } from "./image-generator-provenance";
import type { GeneratorFanOut } from "./image-generator-settle";

/**
 * How strictly a Generator run is sent, and why both halves are the strict arm.
 *
 * `require_all`: every reference on a Generator run is an operator-authored
 * request input. A render that quietly sent four of the five selected images is
 * a DIFFERENT experiment under the same run id, and a comparison read weeks
 * later cannot tell. Production keeps `allow_trim` — a scene missing its third
 * image still beats no scene — which is exactly why the difference is an
 * explicit policy rather than a rule inside the transport.
 *
 * `strict`: the version's probed descriptors already say which fields are
 * required, what type each takes, which enum members exist and what range
 * applies. Holding the finished payload against them turns a certain provider
 * rejection into a refusal that costs nothing.
 */
const IMAGE_GENERATOR_RENDER_POLICY = {
  references: "require_all",
  providerInputs: "strict",
  // Only ever reached when the version's own descriptor said a prompt is not
  // required, so an absent key means the version's declared default applies —
  // never an empty string standing in for one.
  emptyPrompt: "omit",
} as const;

export type PreparedGeneratorRequest =
  | {
      ok: true;
      row: ImageGeneratorRunRow;
      request: GeneratorFanOut;
      columns: Partial<typeof imageGeneratorRuns.$inferInsert>;
    }
  | { ok: false; result: ImageGeneratorRunPayload };

export async function prepareGeneratorRequest(
  row: ImageGeneratorRunRow,
  sink?: DiagnosticSink,
): Promise<PreparedGeneratorRequest> {
  const refuse = async (
    ...args: Parameters<typeof settleGeneratorRunFailed>
  ): Promise<Extract<PreparedGeneratorRequest, { ok: false }>> => ({
    ok: false,
    result: await settleGeneratorRunFailed(...args),
  });
  // 1. The stored bags, fail-closed. A bag that no longer parses must REFUSE
  // rather than degrade to empty: an empty-because-failed inputs bag would run
  // prompt-only as if the admin selected nothing, and an empty controls bag
  // would silently drop every explicitly chosen knob (docs/resilience.md §1 —
  // a fallback must never read as a positive claim). Each parse failure has
  // already pushed its own `parse.boundary_failed` diagnostic by the time the
  // settle names the consequence.
  const inputs = parseOrNull(imageGeneratorRunInputsSchema, row.inputs, sink, "image_generator_runs.inputs");
  if (!inputs) {
    return await refuse(
      row,
      imageGeneratorDiagnosticCode("input_missing"),
      "the stored input selection could not be read",
      sink,
    );
  }
  const controls = parseOrNull(imageGeneratorControlsSchema, row.controls, sink, "image_generator_runs.controls");
  if (!controls) {
    return await refuse(
      row,
      imageGeneratorDiagnosticCode("control_refused"),
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
    return await refuse(
      row,
      imageGeneratorDiagnosticCode("provider_input_rejected"),
      "the stored provider inputs could not be read",
      sink,
    );
  }

  // 1b. How many images this run asks for, and the one contradiction that is
  // knowable from the request alone.
  //
  // A count above one is a FAN-OUT — N sequential predictions from one compiled
  // plan — because every registered model renders exactly one image per
  // prediction. The synthetic profile's `seedPolicy: "caller"` sends an explicit
  // seed verbatim, so it would reach all N of them and the provider would answer
  // with the same picture N times over. Refused rather than dropping the seed or
  // trimming the count: either substitution would charge for N renders and leave
  // a row describing a request nobody made. Judged here, before a version is
  // resolved or a byte is read, because nothing about the model can change it.
  const imageCount = imageGeneratorImageCount(controls);
  if (imageCount > 1 && controls.seed !== undefined) {
    return await refuse(
      row,
      imageGeneratorDiagnosticCode("control_refused"),
      `seed ${String(controls.seed)} would render the same image ${String(imageCount)} times; clear the seed, or ask for one image`,
      sink,
    );
  }

  // 2. Re-resolve the snapshot slug — EXACT match only. The Lab's resolver also
  // accepts the base-slug spelling for typed input; a Generator row snapshots
  // the registry's own spelling at create, so anything but an exact hit means
  // the registration is gone.
  const models = await loadImageModels(sink);
  const registered = models.find((candidate) => candidate.slug === row.modelSlug);
  if (!registered) {
    return await refuse(
      row,
      imageGeneratorDiagnosticCode("model_missing"),
      `no registered image model matches ${row.modelSlug}`,
      sink,
    );
  }

  // 3. Settle which version runs — the registry's current pin, or the exact one
  // a source run captured — and put it on the record BEFORE anything can spend:
  // a failed attempt must still say what weights it asked for. A captured
  // replay ALSO replaces the capability facts with the ones that run recorded,
  // because today's field bindings describe today's version.
  const versionRequest = storedVersionRequest(row);
  const resolved = resolveRunVersion(registered, versionRequest, await replaySource(row, versionRequest));
  if (!resolved.ok) {
    return await refuse(row, imageGeneratorDiagnosticCode(resolved.code), resolved.message, sink);
  }
  const model = resolved.model;
  const versionId = resolved.versionId;
  const columns = { requestedVersionId: versionId };
  await db()
    .update(imageGeneratorRuns)
    .set(columns)
    .where(and(eq(imageGeneratorRuns.id, row.id), eq(imageGeneratorRuns.ownerId, row.ownerId)));

  // 4. The operation the model is being asked to perform.
  //
  // A DEDICATED structural field is not the ordinary primary-reference binding,
  // so selecting one does not by itself make the request an edit: a model that
  // generates from a prompt and takes a required `pose_image` is a generator
  // with a structural input, and calling that "editing" made it impossible to
  // run at all — without the pose the required-input gate refused, and with it
  // the operation flipped to `edit` on a model whose `canEdit` is false.
  // Only a model that cannot generate at all reads its structural input as the
  // thing being edited.
  const operation = generatorOperation(model, inputs);
  if (operation === "generate" && !model.canGenerate) {
    return await refuse(
      row,
      imageGeneratorDiagnosticCode("operation_unsupported"),
      `${model.slug} cannot generate from text alone; select a primary reference`,
      sink,
      { columns },
    );
  }
  if (operation === "edit" && !model.canEdit) {
    return await refuse(
      row,
      imageGeneratorDiagnosticCode("operation_unsupported"),
      `${model.slug} takes no primary reference image; remove the selected references`,
      sink,
      { columns },
    );
  }

  // 4b. An empty prompt is legal only where the version says so. The probed
  // descriptor for the prompt field carries the schema's own `required` flag;
  // a record probed before descriptors existed says nothing, and silence is
  // refused rather than guessed at.
  if (row.prompt.length === 0) {
    const promptRefusal = emptyPromptRefusal(model);
    if (promptRefusal) {
      return await refuse(row, imageGeneratorDiagnosticCode("prompt_required"), promptRefusal, sink, { columns });
    }
  }

  // 5. Capacity, before any byte is read: explicit references are never
  // trimmed, so a selection that cannot all go refuses instead.
  const primaryCapacity = Math.min(referenceCapacity(model).max, IMAGE_GENERATOR_MAX_PRIMARY);
  if (inputs.primary.length > primaryCapacity) {
    return await refuse(
      row,
      imageGeneratorDiagnosticCode("capacity_exceeded"),
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
      return await refuse(
        row,
        imageGeneratorDiagnosticCode("dedicated_input_unbound"),
        `${model.slug} declares no dedicated ${dedicated.role} input on its active version`,
        sink,
        { columns },
      );
    }
  }

  // 6b. The advanced bag may not reach a field another path owns, and a value
  // the probe can type-check must be right BEFORE spend. The shared
  // `validateProviderOverrides` inside the compile only knows reserved-set and
  // known-field membership; the checks here close what it cannot see — the
  // transport writes the bag LAST, so a collision it let through would silently
  // overwrite the admin's own dedicated image or a reviewed pin.
  const rejectedInput = rejectedProviderInput(model, providerInputs);
  if (rejectedInput) {
    return await refuse(row, imageGeneratorDiagnosticCode("provider_input_rejected"), rejectedInput, sink, {
      columns,
    });
  }

  // 7. Bytes, owner-scoped; any unreadable selection refuses — never substitute.
  const references = await readGeneratorReferences(inputs, row.ownerId);
  if (!references.ok) {
    return await refuse(row, imageGeneratorDiagnosticCode("input_missing"), references.message, sink, { columns });
  }

  // 8. The synthetic profile and the intent. `profileEligibility` runs against
  // it like any other profile — with the nominal non-identity task, that is
  // exactly the model's own mechanical flags saying the operation cannot run.
  const profile = imageGeneratorProfile(model, operation, providerInputs);
  const eligibility = profileEligibility(profile, model);
  if (!eligibility.ok) {
    return await refuse(
      row,
      imageGeneratorDiagnosticCode("operation_unsupported"),
      `${model.slug} cannot run this request: ${eligibility.reason}`,
      sink,
      { columns },
    );
  }

  // 8b. The shape. A Generator run asks for the MODEL's own shape unless the
  // admin explicitly picked one of this version's declared aspects: writing
  // Vesper's 3:4 production target here would bucket the request toward a
  // portrait size the admin never chose and then crop whatever came back to
  // match — reporting Vesper's opinion as the model's answer. An explicit pick
  // travels as its own ratio, which `chooseAspect` resolves straight back to the
  // member that was picked, so the one shape mapper stays the one shape mapper.
  const shape = resolveGeneratorShape(model, controls.aspect);
  if (!shape.ok) {
    return await refuse(row, imageGeneratorDiagnosticCode("control_refused"), shape.message, sink, { columns });
  }
  // On a size-mode model the declared shapes ARE the sizes, so a resolution
  // tier and an output shape are two spellings of one request — and the tier's
  // spelling loses: the render path reserves the `size` key for the shape, then
  // drops the mapped tier out of the payload. Refused here, in words the
  // operator can act on, rather than surfacing later as a rejected provider
  // field they can neither see nor set.
  if (model.aspectMode === "size" && controls.resolution !== undefined) {
    return await refuse(
      row,
      imageGeneratorDiagnosticCode("control_refused"),
      `${model.slug} expresses resolution through its own shape list; pick an output shape instead of a resolution tier`,
      sink,
      { columns },
    );
  }

  // 9. Resolve the LoRA FIRST when one is asked for, so a library refusal
  // settles pre-spend under the layer's own verbatim `image_lora.*` code.
  const renderControls = imageGeneratorRenderControls(controls);
  const selection = effectiveImageLoraSelection(profile.controlDefaults, renderControls);

  // 8c. The family adapter's own objections, pre-spend. Wired HERE because the
  // bench's facts are final before planning — `require_all` never trims, so the
  // reference count and the LoRA choice judged are exactly what would be sent.
  // A model with no adapter objects to nothing, like every other adapter hook.
  const adapterRefusals = adapterRequestRefusals(model, {
    referenceCount: inputs.primary.length,
    usesLora: selection !== null && selection !== undefined,
  });
  if (adapterRefusals.length > 0) {
    return await refuse(
      row,
      imageGeneratorDiagnosticCode("operation_unsupported"),
      `${model.slug} cannot run this request: ${adapterRefusals.join("; ")}`,
      sink,
      { columns },
    );
  }

  let intent: ImageRenderIntent = {
    profile: { profile, model },
    prompt: row.prompt,
    references: references.list,
    target: { aspectRatio: shape.aspectRatio },
    policy: IMAGE_GENERATOR_RENDER_POLICY,
    controls: renderControls,
    versionId,
    // Two-phase budgets and one startup retry, narrowed by whatever this
    // model's adapter has observed. A bench can afford to wait out a cold-boot
    // queue and a player-facing lane cannot, which is why the policy is put on
    // the intent HERE rather than defaulted anywhere shared: production lanes
    // pass none and keep today's single budget.
    executionPolicy: benchExecutionPolicy(model),
  };
  if (selection) {
    // `generator_bench`, and this is the change that makes a LoRA runnable here
    // at all. The bench serves no player-facing job, so the row's `allowedTasks`
    // curation does not apply — before contexts existed this call had to borrow
    // the synthetic profile's nominal `item` task, and a mechanically perfect
    // LoRA was refused `image_lora.incompatible` for failing a curation rule
    // about a lane the bench is not in. The mechanical checks — model,
    // version, scale, bindings, locator — still all run.
    const resolved = await resolveImageLoraForRender(
      selection,
      { model, versionId, execution: { kind: "generator_bench" } },
      sink,
    );
    if (!resolved.ok) {
      return await refuse(row, resolved.code, resolved.message, sink, { columns });
    }
    intent = { ...intent, resolvedLora: resolved.binding };
  }

  // 10. Plan, and refuse ANY planner refusal verbatim — the `image_profile.*`
  // vocabulary belongs to the layer that refused.
  const planned = planImageRender(intent, imageRenderRuntimeFacts(model));
  if (!planned.ok) {
    return await refuse(row, planned.refusal.code, planned.refusal.message, sink, { columns });
  }
  const plan = planned.plan;

  // Every reference was marked `required`, so the planner refuses a drop
  // itself; this net catches only a planner whose drop vocabulary widened.
  if (plan.dropped.length > 0) {
    return await refuse(
      row,
      imageGeneratorDiagnosticCode("capacity_exceeded"),
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
    return await refuse(
      row,
      imageGeneratorDiagnosticCode("dedicated_input_unbound"),
      `the ${structural.role} input would ride the numbered reference array instead of its dedicated field`,
      sink,
      { columns },
    );
  }
  const refusedControl = refusedDroppedControl(plan);
  if (refusedControl) {
    return await refuse(row, imageGeneratorDiagnosticCode(refusedControl.code), refusedControl.message, sink, {
      columns,
    });
  }

  // THE model the provider will actually be handed. `plan.model` is the row as
  // stored — the planner says so itself — and the transport wrapper applies the
  // reviewed-quality seam on the way out, which merges pinned fields
  // (`width`/`height` on the SDXL rows, `method` on PuLID, `go_fast` on Qwen
  // Edit) into `extraInput`. A pre-spend view built from the unmerged row would
  // report a reviewed pin as a missing required field, refuse an advanced value
  // that collides with one, and — worst — record an effective request that does
  // not mention values the provider was sent.
  const sentModel = withReviewedImageQuality(plan.model);
  const plannedShape = plannedShapeInput(sentModel, shape, plan);
  // An explicitly chosen shape must be the shape that goes. `chooseAspect`
  // resolves a RATIO, and several declared members can share one — Wan offers
  // three 3:4 sizes — so the largest-area tie-break would quietly answer a
  // request for the small one with the huge one. For production that is a
  // sensible resolution; for a bench it is the operator's choice being replaced.
  if (shape.requested !== null && plannedShape.value !== shape.requested) {
    return await refuse(
      row,
      imageGeneratorDiagnosticCode("control_refused"),
      `the shape ${shape.requested} resolves to ${plannedShape.value ?? "no shape at all"} on this version; pick that one instead`,
      sink,
      { columns },
    );
  }

  // 11. The record BEFORE the spend: the compiled prompt as it will be sent,
  // what the plan decided, the sanitized provider-facing request, and the
  // capability facts this run executed under. A stop after this point can no
  // longer make the row claim it sent something else — and a re-probe months
  // from now cannot make the row's own account of itself misleading, because
  // the account no longer depends on today's capability record.
  const finalPrompt = plan.prompt;
  const columnsWithPrompt = { ...columns, finalPrompt };
  const snapshot = capabilitySnapshotOf(model);
  // The payload this request WILL become, assembled by the provider package's
  // own builder rather than predicted here. It is both what the pre-spend gate
  // judges and what the record reports, so the two can never describe different
  // requests.
  const preview = previewImageModelRequest({
    model: sentModel,
    prompt: finalPrompt,
    referenceCount: plan.references.length,
    controlReferences: plan.controlReferences.map((control) => ({
      field: control.field,
      arity: control.arity,
      count: control.buffers.length,
    })),
    aspect: plannedShape.value,
    controlInput: plan.controlInput,
    policy: IMAGE_GENERATOR_RENDER_POLICY,
  });
  const sentRequest = preview.request;
  const recordedShape: PlannedShape = {
    ...plannedShape,
    field: preview.sentShape.field ?? plannedShape.field,
    value: preview.sentShape.value,
  };
  const outcome = {
    sentRoles: plan.sentReferences.map((reference) => reference.role),
    dedicatedFields: plan.controlReferences.map((reference) => reference.field),
    renumbered: plan.referencesRenumbered,
  };
  const metaWithOutcome = generatorRunMeta(row, {
    outcome,
    effectiveRequest: effectiveRequestRecord({
      model: sentModel,
      versionId,
      versionRequest,
      inputs,
      plan,
      planReferences: references.list,
      shape,
      plannedShape: recordedShape,
      sentRequest,
      finalPrompt,
      policy: IMAGE_GENERATOR_RENDER_POLICY,
    }),
    ...(snapshot ? { capabilitySnapshot: snapshot } : {}),
  });
  await db()
    .update(imageGeneratorRuns)
    .set({ ...columnsWithPrompt, meta: metaWithOutcome })
    .where(and(eq(imageGeneratorRuns.id, row.id), eq(imageGeneratorRuns.ownerId, row.ownerId)));
  // Every later settle re-derives meta from this row object; carrying the
  // written bag forward is what keeps the pre-spend outcome record from being
  // erased by the settle's own assignment.
  const rowWithOutcome: ImageGeneratorRunRow = { ...row, meta: metaWithOutcome };

  // 11b. THE final pre-spend gate: the payload this request will actually
  // become, held against the version's own declared schema.
  //
  // Assembled by the provider package's own builder rather than approximated
  // here — the moment the application starts predicting what the payload looks
  // like, there are two copies of Replicate's field rules and one of them is
  // wrong. It catches what the raw-bag gate structurally cannot: a REQUIRED
  // field that is reserved to a normalized control and has no provider default,
  // which the bag may not fill and the render path did not.
  const violations = providerInputViolations(sentModel, sentRequest, [
    ...plan.controlReferences.map((control) => control.field),
    // Typed semantic-control fields share the dedicated fields' trust: a
    // curated LoRA's probed weights field may carry its URI here, while the
    // same shape arriving through the raw advanced bag stays refused.
    ...plan.typedControlFields,
  ]);
  if (violations.length > 0) {
    return await refuse(
      rowWithOutcome,
      imageGeneratorDiagnosticCode("provider_input_rejected"),
      `${sentModel.slug} would reject this request: ${violations.map((violation) => violation.detail).join("; ")}`,
      sink,
      { columns: columnsWithPrompt, meta: { result: { spent: false, providerInputViolations: violations } } },
    );
  }

  return {
    ok: true,
    row: rowWithOutcome,
    request: { intent, imageCount, finalPrompt, plannedPrimaryCount: plan.references.length },
    columns: columnsWithPrompt,
  };
}

// ---------------------------------------------------------------------------
// Operation, prompt, version and shape
// ---------------------------------------------------------------------------

/**
 * Which operation this request is, from the model's own capability semantics.
 *
 * A primary reference is the ordinary edit source, so one present means `edit`.
 * A DEDICATED structural field is a different thing entirely — its own provider
 * input, declared beside a prompt-driven generator — so selecting one does not
 * make the request an edit. Only a model that cannot generate at all is reading
 * that structural image as the thing being edited.
 *
 * The rule this replaces ("any image means edit") made an entire, legitimate
 * class of model impossible to run: prompt-based generation, no primary
 * reference binding, one REQUIRED `pose_image`. Without the pose the planner
 * refused the required input; with it the operation flipped to `edit` and the
 * model's `canEdit: false` refused that instead.
 */
function generatorOperation(model: ImageModel, inputs: ImageGeneratorRunInputs): "generate" | "edit" {
  if (inputs.primary.length > 0) return "edit";
  if (inputs.dedicated.length > 0 && !model.canGenerate && model.canEdit) return "edit";
  return "generate";
}

/**
 * Why an empty prompt is refused on this model, or null when it is allowed.
 *
 * Capability-driven: the probed descriptor for the prompt field carries the
 * schema's own `required` flag, and a declared default means the provider has
 * its own answer. A record with no descriptor for the prompt field says
 * nothing, and silence is refused rather than guessed at — a bench that sent an
 * empty prompt on a hunch would buy a rejection.
 */
function emptyPromptRefusal(model: ImageModel): string | null {
  const field = model.advancedCapabilities.prompt?.field ?? "prompt";
  const descriptor = model.advancedCapabilities.providerInputs.find((entry) => entry.field === field);
  if (!descriptor) {
    return `${model.slug} has not been probed for whether it runs without prompt text; write a prompt or re-probe the model`;
  }
  if (descriptor.required && descriptor.default === undefined) return `${model.slug} requires prompt text`;
  return null;
}

type ResolvedRunVersion =
  | { ok: true; model: ImageModel; versionId: string; replayedFromRunId: string | null }
  | { ok: false; code: ImageGeneratorFailureCode; message: string };

/** The settled source run a captured replay names, or null for every other run. */
async function replaySource(
  row: ImageGeneratorRunRow,
  request: ImageGeneratorVersionRequest,
): Promise<ImageGeneratorRunRow | null> {
  if (request.mode !== "captured" || request.sourceRunId === null) return null;
  return await ownedGeneratorRun(request.sourceRunId, row.ownerId);
}

/**
 * The version this run executes, and the capability facts it executes under.
 *
 * `current` is the ordinary answer: the registry's own pin, described by the
 * registry's own capability record.
 *
 * `captured` replays an exact historical version, and it is allowed ONLY when
 * the source run's stored snapshot can still describe that version. Vesper keeps
 * one capability record per model and replaces it on re-probe, so after a
 * promotion nothing in the registry knows how the old version bound its fields —
 * and sending today's bindings to yesterday's weights would produce a request
 * neither version ever described. Every gap here therefore refuses rather than
 * substituting the current version, which is the one outcome the operator
 * explicitly said they did not want.
 */
function resolveRunVersion(
  registered: ImageModel,
  request: ImageGeneratorVersionRequest,
  source: ImageGeneratorRunRow | null,
): ResolvedRunVersion {
  if (request.mode === "current") {
    const versionId = pinnedImageModelVersion(registered);
    if (!versionId) {
      return {
        ok: false,
        code: "version_unpinned",
        message: `${registered.slug} has no exact provider version to pin; a run cannot execute a floating latest`,
      };
    }
    return { ok: true, model: registered, versionId, replayedFromRunId: null };
  }

  const unsafe = (why: string): ResolvedRunVersion => ({
    ok: false,
    code: "version_replay_unsafe",
    message: `the captured version cannot be replayed safely: ${why}`,
  });
  if (!source) return unsafe("the run it was captured from is gone");
  if (source.modelSlug !== registered.slug) {
    return unsafe(`it belongs to ${source.modelSlug}, not ${registered.slug}`);
  }
  const capturedVersion = source.requestedVersionId;
  if (!capturedVersion) return unsafe("that run never recorded the version it pinned");
  const snapshot = imageGeneratorCapabilitySnapshotSchema.safeParse(imageMeta(source.meta)["capabilitySnapshot"]);
  if (!snapshot.success) {
    return unsafe("that run recorded no usable capability record for the version it ran");
  }
  if (snapshot.data.probedVersionId !== capturedVersion) {
    return unsafe(
      `that run's capability record describes ${snapshot.data.probedVersionId}, not the ${capturedVersion} it pinned`,
    );
  }
  return {
    ok: true,
    model: { ...registered, ...snapshot.data },
    versionId: capturedVersion,
    replayedFromRunId: source.id,
  };
}

type GeneratorShape =
  | { ok: true; mode: "provider_default"; aspectRatio: null; requested: null }
  | { ok: true; mode: "explicit"; aspectRatio: number; requested: string }
  | { ok: false; message: string };

/**
 * The shape this run asks for.
 *
 * No explicit choice means the MODEL's own shape — no aspect/size key, no
 * bucket chosen for being nearest a Vesper target, no crop. An explicit choice
 * must be a member of this version's declared shapes, and a member that no
 * longer exists refuses rather than falling back to the nearest one: an A/B
 * comparison whose shape silently moved is not a comparison.
 */
function resolveGeneratorShape(model: ImageModel, aspect: string | undefined): GeneratorShape {
  if (aspect === undefined) return { ok: true, mode: "provider_default", aspectRatio: null, requested: null };
  if (!model.supportedAspects.includes(aspect)) {
    return { ok: false, message: `${model.slug} does not offer the shape ${aspect} on this version` };
  }
  const ratio = parseAspectValue(aspect);
  if (ratio === null) return { ok: false, message: `the shape ${aspect} cannot be read as a ratio` };
  return { ok: true, mode: "explicit", aspectRatio: ratio, requested: aspect };
}

/**
 * The shape entry this request will write, resolved from the SAME pure resolver
 * the transport wrapper uses, on the same plan facts — so the pre-spend record
 * and the pre-spend gate cannot describe a different payload than the one that
 * goes. A native request resolves to no key at all.
 */
function plannedShapeInput(
  model: ImageModel,
  shape: Extract<GeneratorShape, { ok: true }>,
  plan: PlannedImageRender,
): PlannedShape<string | null> {
  const dimensions =
    shape.aspectRatio === null
      ? providerDefaultDimensions()
      : chooseDimensions(model, { targetRatio: shape.aspectRatio, ...plan.dimensionFacts });
  const field = imageAspectInputField(model);
  const value = dimensions.input[field];
  return { field, value: typeof value === "string" ? value : null, dimensions };
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
 *   for). `item` is the neutral pick. It is deliberately NOT the answer the
 *   LoRA library is asked — that call passes `generator_bench`, so the row's
 *   `allowedTasks` curation is skipped rather than judged against a task this
 *   bench invented for itself.
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
  plan: PlannedImageRender,
): { code: Extract<ImageGeneratorFailureCode, "control_refused" | "provider_input_rejected">; message: string } | null {
  for (const entry of plan.droppedControls) {
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
 * The pre-spend gate over the raw provider bag. Three layers, all
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
  registered: ImageModel,
  providerInputs: Record<string, string | number | boolean>,
): string | null {
  // The REVIEWED model, because the transport sends that one: the quality seam
  // merges its pins into `extraInput` on the way out, and a bag key naming one
  // of them would overlay LAST and quietly undo a reviewed correction.
  const model = withReviewedImageQuality(registered);
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
  // A record with no descriptors cannot say what SHAPE any field takes, and the
  // rule for an unprobed field is to reject it. `knownInputFields`
  // is not a substitute: it lists every declared property, URI inputs included,
  // so accepting the bag here would let a direct API caller hand the provider an
  // arbitrary address on any model registered before descriptors existed. The
  // form already offers no advanced editor on such a row, so this only closes
  // the API path — and a re-probe reopens it properly.
  if (descriptors.size === 0) {
    const first = keys[0];
    return first === undefined
      ? null
      : `${model.slug} has no probed provider-input descriptors, so ${first} cannot be set safely — re-probe the model first`;
  }
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
  // reference, control bindings) and are not the bag's to fill — whether the
  // render path ACTUALLY filled them is asked once, authoritatively, over the
  // assembled payload just before the seam (`providerInputViolations`). Asking
  // it here would mean guessing at a payload that does not exist yet.
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

/**
 * A declared-type/enum/range violation the probe can prove, or null.
 *
 * "Prove" now includes proving that a shape has no scalar spelling at all —
 * `uri`, `array` and `unknown` are refused rather than waved through, because
 * the alternative is handing a provider a value Vesper cannot describe.
 */
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
    // The bag is scalars only, so a field whose declared shape is an ADDRESS, a
    // LIST, or something the probe could not read has no honest scalar
    // spelling. It fails closed rather than open: the form withholds an editor
    // for these types, and the server — not React — is what makes that a rule.
    // A URI field in particular must never be reachable by typing a string:
    // the owner-scoped image picker is the only path to an image, and an
    // arbitrary address is how an admin API caller would smuggle one in.
    case "uri":
      return `${descriptor.field} takes an image address — select an image for it rather than typing a value`;
    case "array":
      return `${descriptor.field} takes a list, which Advanced Model Inputs cannot express`;
    case "unknown":
      return `${descriptor.field} has a shape this version's schema did not describe, so Vesper will not send a value for it`;
  }
}
