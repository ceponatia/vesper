"use client";
import { generatorModelView } from "./image-generator-form/model";
import { GeneratorReferences, toPurposeOption, type PrimaryRow } from "./image-generator-form/references";
import { GeneratorControls, AdvancedInputField } from "./image-generator-form/controls";
import {
  assembleGeneratorRequest,
  generatorRequestReady,
  generatorRequestBody,
} from "./image-generator-form/request";
import {
  reconcileGeneratorPrefill,
  generatorLoraSelection,
  type ImageGeneratorPrefill,
} from "./image-generator-form/prefill";
import { useState } from "react";
import { baseImageModelSlug, pinnedImageModelVersion, type ImageResolutionTier } from "@vesper/image-core";
import {
  IMAGE_GENERATOR_MAX_IMAGE_COUNT,
  IMAGE_GENERATOR_PROMPT_MAX,
  type ImageGeneratorDedicatedRole,
  type ImageGeneratorVersionPolicy,
} from "@/contracts/images/image-generator";
import { INTIMATE_SCENE_LORA_ID, INTIMATE_SCENE_LORA_PREFILL_SLUG } from "@/contracts/images/intimate-scene-lora";
import { adminImageModelsApi, imageGeneratorApi, imageLorasApi } from "@/lib/client/api";
import { useAsyncData } from "@/components/hooks/use-async";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import { imageGeneratorRoleLabel } from "./image-generator-copy";

/**
 * The new-run form: one raw prompt against one explicitly chosen registered
 * model, with every input and control written down before the render is paid for.
 *
 * The form is CAPABILITY-DRIVEN, never model-slug-driven — that is its acceptance
 * test. The chosen row's probed `advancedCapabilities` decide everything past the
 * prompt: primary references appear only on a model that can edit, dedicated
 * structural slots only where the capability record declares them, each
 * normalized control only where the active version binds a field for it, and
 * advanced inputs only for described non-reserved provider
 * fields. Registering a new model changes this form through its capability
 * record, with no edit here.
 *
 * Controls start UNSET unless the reviewed capability record expresses exactly
 * the 1K/2K tier pair, whose owner-approved bench default is 1K. Other controls
 * still leave the provider's own defaults in charge until the admin explicitly
 * changes a value, and a value that cannot be represented at run time refuses
 * the run rather than being dropped — a silently trimmed request would make
 * every A/B built on it dishonest.
 *
 * A duplicate mounts this form seeded from a settled run (values only; nothing
 * runs until submitted). The page remounts the form per prefill — the lab's
 * key idiom — so the form owns its state after mount. The prefill names its
 * model by SLUG (the run record's snapshot); the form adopts the matching
 * registry row once the registry answers, and says so plainly when the slug no
 * longer resolves or its pin has moved since the original ran — comparison
 * honesty is a warning the admin reads before spending, never a silent
 * substitution.
 */

export type { ImageGeneratorPrefill } from "./image-generator-form/prefill";

export interface ImageGeneratorFormProps {
  prefill?: ImageGeneratorPrefill | null;
  /** The accepted run's id — the caller opens it and remounts this form blank. */
  onCreated: (runId: string) => void;
}

export function ImageGeneratorForm({ prefill = null, onCreated }: ImageGeneratorFormProps) {
  const toast = useToast();
  const models = useAsyncData(() => adminImageModelsApi.list(), []);
  const loras = useAsyncData(() => imageLorasApi.list(), []);

  const [modelId, setModelId] = useState("");
  const [prompt, setPrompt] = useState(prefill?.prompt ?? "");
  const [primaryRows, setPrimaryRows] = useState<PrimaryRow[]>(() =>
    (prefill?.inputs.primary ?? []).map((input, index) => ({
      key: index,
      imageId: input.imageId,
      purpose: toPurposeOption(input.purpose),
    })),
  );
  const [nextRowKey, setNextRowKey] = useState((prefill?.inputs.primary ?? []).length);
  const [dedicated, setDedicated] = useState<Partial<Record<ImageGeneratorDedicatedRole, string>>>(() => {
    const initial: Partial<Record<ImageGeneratorDedicatedRole, string>> = {};
    for (const input of prefill?.inputs.dedicated ?? []) initial[input.role] = input.imageId;
    return initial;
  });
  const [openPicker, setOpenPicker] = useState<string | null>(null);

  const [seed, setSeed] = useState(prefill?.controls.seed !== undefined ? String(prefill.controls.seed) : "");
  const [negativePrompt, setNegativePrompt] = useState(prefill?.controls.negativePrompt ?? "");
  const [guidance, setGuidance] = useState(
    prefill?.controls.guidance !== undefined ? String(prefill.controls.guidance) : "",
  );
  const [steps, setSteps] = useState(prefill?.controls.steps !== undefined ? String(prefill.controls.steps) : "");
  const [editStrength, setEditStrength] = useState(
    prefill?.controls.editStrength !== undefined ? String(prefill.controls.editStrength) : "",
  );
  const [resolution, setResolution] = useState<ImageResolutionTier | "">(prefill?.controls.resolution ?? "");
  const [aspect, setAspect] = useState(prefill?.controls.aspect ?? "");
  const [imageCount, setImageCount] = useState(String(prefill?.controls.imageCount ?? 1));
  const [thinkingMode, setThinkingMode] = useState(prefill?.controls.thinkingMode ?? false);
  const [fastMode, setFastMode] = useState<"" | "on" | "off">(
    prefill?.controls.fastMode === undefined ? "" : prefill.controls.fastMode ? "on" : "off",
  );
  const [versionPolicy, setVersionPolicy] = useState<ImageGeneratorVersionPolicy>("current");
  const [loraId, setLoraId] = useState(prefill?.controls.lora?.id ?? "");
  const [loraScale, setLoraScale] = useState(
    prefill?.controls.lora?.scale !== undefined ? String(prefill.controls.lora.scale) : "",
  );

  const [providerValues, setProviderValues] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {};
    for (const [field, value] of Object.entries(prefill?.providerInputs ?? {})) initial[field] = String(value);
    return initial;
  });

  const [submitting, setSubmitting] = useState(false);
  const registeredModels = models.data?.models ?? [];
  const [prevModelId, setPrevModelId] = useState(modelId);
  const [loraPrefilledForModelId, setLoraPrefilledForModelId] = useState("");

  const [prefillModelResolved, setPrefillModelResolved] = useState(prefill === null);
  if (!prefillModelResolved && models.data !== null) {
    setPrefillModelResolved(true);
    const match = registeredModels.find((model) => model.slug === prefill?.modelSlug);
    if (match !== undefined) {
      setModelId(match.id);
      setPrevModelId(match.id);
      setLoraPrefilledForModelId(match.id);
    }
  }

  const selectedModel = registeredModels.find((model) => model.id === modelId) ?? null;

  if (modelId !== prevModelId) {
    setPrevModelId(modelId);
    setDedicated({});
    setProviderValues({});
    setSeed("");
    setNegativePrompt("");
    setGuidance("");
    setSteps("");
    setEditStrength("");
    const resolutionOptions = selectedModel?.advancedCapabilities.controls.resolutionTier?.enumValues ?? [];
    setResolution(
      resolutionOptions.length === 2 && resolutionOptions[0] === "1K" && resolutionOptions[1] === "2K" ? "1K" : "",
    );
    setAspect("");
    setThinkingMode(false);
    setFastMode("");
    setLoraId("");
    setLoraScale("");
    setVersionPolicy("current");
  }

  const {
    modelCanEdit,
    capabilities,
    bindings,
    dedicatedSlots,
    advancedInputs,
    reservedFields,
    shapeOptions,
    resolutionTierOffered,
    pinnedVersion,
    modelCapacity,
    capacity,
    capabilitySummary,
  } = generatorModelView({ selectedModel });

  if (selectedModel !== null && !modelCanEdit && primaryRows.length > 0) {
    setPrimaryRows([]);
  }

  const loraBound = bindings.loraWeights !== undefined && bindings.loraScale !== undefined;
  const enabledLoras = (loras.data ?? []).filter((lora) => lora.enabled);
  const selectedLora = loraId === "" ? null : (enabledLoras.find((lora) => lora.id === loraId) ?? null);
  const [prevLoraId, setPrevLoraId] = useState(loraId);
  if (loras.data !== null && loraId !== "" && selectedLora === null) {
    setLoraId("");
  } else if (loraId !== prevLoraId) {
    setPrevLoraId(loraId);
    setLoraScale(selectedLora === null ? "" : String(selectedLora.defaultScale));
  }

  if (
    loras.data !== null &&
    selectedModel !== null &&
    modelId === prevModelId &&
    modelId !== loraPrefilledForModelId
  ) {
    setLoraPrefilledForModelId(modelId);
    if (
      loraBound &&
      loraId === "" &&
      baseImageModelSlug(selectedModel.slug) === INTIMATE_SCENE_LORA_PREFILL_SLUG &&
      enabledLoras.some((lora) => lora.id === INTIMATE_SCENE_LORA_ID)
    ) {
      setLoraId(INTIMATE_SCENE_LORA_ID);
    }
  }
  const { requestedScale, loraScaleError, loraReady, loraPrefilled, loraModelMismatch } = generatorLoraSelection({
    loraScale,
    selectedLora,
    selectedModel,
  });

  const {
    assembledControls,
    controlLines,
    seedError,
    effectiveImageCount,
    imageCountError,
    guidanceError,
    stepsError,
    editStrengthError,
    assembledProviderInputs,
    advancedLines,
    advancedErrors,
    primaryCount,
    primaryComplete,
    overCapacity,
    filledDedicated,
    missingRequiredDedicated,
    operation,
    operationSupported,
    promptRequired,
  } = assembleGeneratorRequest({
    seed,
    imageCount,
    negativePrompt,
    guidance,
    steps,
    editStrength,
    aspect,
    resolution,
    thinkingMode,
    fastMode,
    bindings,
    resolutionTierOffered,
    selectedModel,
    loraBound,
    selectedLora,
    requestedScale,
    advancedInputs,
    providerValues,
    primaryRows,
    capacity,
    dedicatedSlots,
    dedicated,
    modelCanEdit,
    capabilities,
  });

  const { prefillModelMissing, versionDrift, effectiveVersionId, loraVersionMismatch, prefillDrift } =
    reconcileGeneratorPrefill({
      prefill,
      prefillModelResolved,
      modelsLoaded: models.data !== null,
      modelId,
      registeredModels,
      selectedModel,
      pinnedVersion,
      versionPolicy,
      selectedLora,
      bindings,
      resolutionTierOffered,
      loraBound,
      advancedInputs,
      dedicatedSlots,
    });

  const { ready } = generatorRequestReady({
    selectedModel,
    pinnedVersion,
    promptRequired,
    prompt,
    primaryComplete,
    overCapacity,
    missingRequiredDedicated,
    operationSupported,
    loraReady,
    seedError,
    imageCountError,
    guidanceError,
    stepsError,
    editStrengthError,
    advancedErrors,
  });

  const submit = async () => {
    if (!ready || selectedModel === null) return;
    const { body } = generatorRequestBody({
      selectedModel,
      prompt,
      primaryRows,
      dedicatedSlots,
      dedicated,
      assembledControls,
      assembledProviderInputs,
      sourceRunId: prefill?.sourceRunId ?? null,
      versionDrift,
      versionPolicy,
    });
    setSubmitting(true);
    const result = await imageGeneratorApi.runs.create(body);
    setSubmitting(false);
    if (!result.ok) {
      toast.push({ title: "Couldn’t start that run", description: result.error.message, tone: "error" });
      return;
    }
    toast.push({
      title: "Run queued",
      description:
        effectiveImageCount === 1
          ? "One render, charged against the daily image budget."
          : `${String(effectiveImageCount)} renders, charged ${String(effectiveImageCount)} against the daily image budget.`,
      tone: "success",
    });
    onCreated(result.data.run.id);
  };

  const modelHint = ((): string => {
    const base = "Required — the registered row that actually runs, pinned to an exact provider version before any spend.";
    if (models.error !== null) return `${base} The registered list could not be loaded — retry below.`;
    return registeredModels.some((model) => pinnedImageModelVersion(model) === null)
      ? `${base} A row with no pinned version cannot run here.`
      : base;
  })();

  return (
    <section className="rounded-card border border-ink-600 bg-ink-850 p-5">
      <h2 className="prose-display text-lg">New run</h2>
      <p className="mt-1 mb-4 text-sm text-paper-400">
        One raw prompt against one registered model, with every input and control recorded. Submitting spends real render budget.
      </p>
      {prefill !== null ? (
        <p className="mb-4 rounded-card border border-accent-500/40 bg-ink-950/40 px-3 py-2 text-xs text-paper-400">
          {"Duplicated from run "}<code className="break-all">{prefill.sourceRunId}</code>
          {" — the same request, seed included. Change one thing; nothing runs until you submit."}
        </p>
      ) : null}
      {prefillModelMissing ? (
        <p className="mb-4 text-xs text-danger-300" role="alert">
          {`The original ran ${prefill?.modelSlug ?? ""}, which is no longer registered — choose a model to run this request at all, and read the result as a different arm.`}
        </p>
      ) : null}
      {versionDrift ? (
        <div className="mb-4 flex flex-col gap-2 rounded-card border border-danger-500/40 bg-ink-950/40 px-3 py-2">
          <p className="text-xs text-danger-300" role="alert">
            {`The original pinned version ${prefill?.requestedVersionId ?? ""}, but this model now pins ${pinnedVersion ?? ""} — running the current one is a different arm, not a same-model comparison.`}
          </p>
          <Field label="Provider version" hint="Replay needs the original run's recorded capability record; without it the run refuses rather than guessing.">
            {(id) => (
              <Select id={id} value={versionPolicy} onChange={(e) => setVersionPolicy(e.target.value as ImageGeneratorVersionPolicy)}>
                <option value="current">Use the current registered version</option>
                <option value="captured">Replay the captured version</option>
              </Select>
            )}
          </Field>
        </div>
      ) : null}
      {prefillDrift.length > 0 ? (
        <p className="mb-4 text-xs text-danger-300" role="alert">
          {`These duplicated values no longer apply on the current version, so they will not be sent: ${prefillDrift.join(", ")}.`}
        </p>
      ) : null}

      <div className="flex flex-col gap-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Model" hint={modelHint}>
            {(id) => (
              <>
                <Select id={id} value={modelId} onChange={(e) => setModelId(e.target.value)}>
                  <option value="">— Choose a model —</option>
                  {registeredModels.map((model) => {
                    const runnable = pinnedImageModelVersion(model) !== null;
                    return (
                      <option key={model.id} value={model.id} disabled={!runnable}>
                        {`${model.label} — ${baseImageModelSlug(model.slug)}${runnable ? "" : " · no pinned version"}`}
                      </option>
                    );
                  })}
                </Select>
                {selectedModel?.operatorWarning ? <p className="text-xs text-paper-500">{selectedModel.operatorWarning}</p> : null}
                {models.error !== null ? (
                  <div className="flex items-center gap-2">
                    <p className="text-xs text-danger-300" role="alert">{models.error.message}</p>
                    <Button size="sm" variant="quiet" onClick={() => models.reload()}>Retry</Button>
                  </div>
                ) : null}
              </>
            )}
          </Field>
          {selectedModel !== null ? (
            <Field label="What this model can take" hint="Probed capability facts — they decide which sections appear below.">
              <p className="text-sm text-paper-300">{capabilitySummary}</p>
            </Field>
          ) : null}
        </div>

        <Field
          label="Prompt"
          hint={
            promptRequired
              ? `The whole positive prompt, sent as written (up to ${String(IMAGE_GENERATOR_PROMPT_MAX)} characters) — nothing is prepended or compiled around it. This model’s schema requires it.`
              : `The whole positive prompt, sent as written (up to ${String(IMAGE_GENERATOR_PROMPT_MAX)} characters) — nothing is prepended or compiled around it. This model does not require one; left blank, no prompt field is sent at all.`
          }
        >
          {(id) => (
            <Textarea id={id} rows={6} value={prompt} maxLength={IMAGE_GENERATOR_PROMPT_MAX} spellCheck={false} onChange={(e) => setPrompt(e.target.value)} placeholder="Exactly what the model should be asked for." />
          )}
        </Field>

        <GeneratorReferences
          modelCanEdit={modelCanEdit}
          capacity={capacity}
          modelCapacity={modelCapacity}
          primaryRows={primaryRows}
          setPrimaryRows={setPrimaryRows}
          nextRowKey={nextRowKey}
          setNextRowKey={setNextRowKey}
          dedicatedSlots={dedicatedSlots}
          dedicated={dedicated}
          setDedicated={setDedicated}
          openPicker={openPicker}
          setOpenPicker={setOpenPicker}
          overCapacity={overCapacity}
          missingRequiredDedicated={missingRequiredDedicated}
        />

        <GeneratorControls
          selectedModel={selectedModel}
          bindings={bindings}
          resolutionTierOffered={resolutionTierOffered}
          shapeOptions={shapeOptions}
          loraBound={loraBound}
          seed={seed}
          setSeed={setSeed}
          guidance={guidance}
          setGuidance={setGuidance}
          steps={steps}
          setSteps={setSteps}
          editStrength={editStrength}
          setEditStrength={setEditStrength}
          aspect={aspect}
          setAspect={setAspect}
          negativePrompt={negativePrompt}
          setNegativePrompt={setNegativePrompt}
          loraId={loraId}
          setLoraId={setLoraId}
          loraScale={loraScale}
          setLoraScale={setLoraScale}
          resolution={resolution}
          setResolution={setResolution}
          thinkingMode={thinkingMode}
          setThinkingMode={setThinkingMode}
          fastMode={fastMode}
          setFastMode={setFastMode}
          seedError={seedError}
          guidanceError={guidanceError}
          stepsError={stepsError}
          editStrengthError={editStrengthError}
          loraScaleError={loraScaleError}
          enabledLoras={enabledLoras}
          loraPrefilled={loraPrefilled}
          selectedLora={selectedLora}
          loraModelMismatch={loraModelMismatch}
          loraVersionMismatch={loraVersionMismatch}
          effectiveVersionId={effectiveVersionId}
        />

        {selectedModel !== null ? (
          <div className="flex flex-col gap-3">
            <h3 className="text-xs font-medium tracking-wide text-paper-400 uppercase">Images per run</h3>
            <div className="grid gap-4 sm:grid-cols-[9rem_1fr]">
              <Field label="Images">
                {(id) => (
                  <Select id={id} value={imageCount} onChange={(e) => setImageCount(e.target.value)}>
                    {Array.from({ length: IMAGE_GENERATOR_MAX_IMAGE_COUNT }, (_, index) => index + 1).map((count) => (
                      <option key={count} value={String(count)}>{count}</option>
                    ))}
                  </Select>
                )}
              </Field>
              <p className="self-center text-xs text-paper-500">
                {"No registered model returns more than one image per prediction, so this is a loop, not a provider setting: one plan is compiled and one pre-spend gate runs, then that request is sent this many times. Each image is billed separately. Predictions run in order, and a run that stores at least one image succeeds — a failure part-way through is recorded against its own image, not the run."}
              </p>
            </div>
            {imageCountError !== null ? <p className="text-xs text-danger-300" role="alert">{imageCountError}</p> : null}
          </div>
        ) : null}

        {advancedInputs.length > 0 ? (
          <div className="flex flex-col gap-3">
            <h3 className="text-xs font-medium tracking-wide text-paper-400 uppercase">Advanced model inputs</h3>
            <p className="text-xs text-paper-500">
              {"Provider-specific fields the probe described that Vesper does not normalize. Unset is omitted from the payload; an unknown or reserved value is refused before any spend rather than passed through."}
            </p>
            <div className="grid gap-4 sm:grid-cols-2">
              {advancedInputs.map((descriptor) => (
                <AdvancedInputField
                  key={descriptor.field}
                  descriptor={descriptor}
                  value={providerValues[descriptor.field] ?? ""}
                  error={advancedErrors[descriptor.field]}
                  onChange={(value) => setProviderValues((current) => ({ ...current, [descriptor.field]: value }))}
                />
              ))}
            </div>
          </div>
        ) : null}
        {reservedFields.length > 0 ? (
          <details className="text-xs text-paper-500">
            <summary className="cursor-pointer">{`${String(reservedFields.length)} field(s) reserved by the render path`}</summary>
            <p className="mt-1">{`${reservedFields.join(", ")} — owned by prompt, reference, aspect, control, or dedicated-input plumbing, so they are not editable here.`}</p>
          </details>
        ) : null}

        <div className="rounded-card border border-ink-700 bg-ink-950/40 px-3 py-2">
          <p className="text-[11px] tracking-wide text-paper-500 uppercase">Effective request</p>
          {selectedModel === null ? (
            <p className="mt-1 text-xs text-paper-500">Choose a model to see what would be sent.</p>
          ) : (
            <ul className="mt-1 flex flex-col gap-0.5 text-xs text-paper-300">
              <li>
                <span className="text-paper-500">Model —</span>{" "}
                {`${selectedModel.label} (${baseImageModelSlug(selectedModel.slug)}), `}
                {pinnedVersion !== null ? <span>{`pinned to ${pinnedVersion}`}</span> : <span className="text-danger-300">no pinned version — refused before any spend</span>}
              </li>
              <li>
                <span className="text-paper-500">Operation —</span>{" "}
                {operation === "generate" ? "prompt-only (text to image)" : `edit, ${String(primaryCount)} of ${String(capacity ?? 0)} primary reference slot(s)`}
                {!operationSupported ? (
                  <span className="text-danger-300">
                    {operation === "generate" ? " — this model cannot generate from text alone; add a primary reference" : " — this model takes no primary reference image"}
                  </span>
                ) : null}
              </li>
              {filledDedicated.length > 0 ? (
                <li><span className="text-paper-500">Dedicated —</span>{" "}{filledDedicated.map((slot) => imageGeneratorRoleLabel(slot.role)).join(", ")}</li>
              ) : null}
              <li><span className="text-paper-500">Shape —</span>{" "}{aspect === "" ? "the model’s own default; nothing is cropped afterwards" : aspect}</li>
              <li><span className="text-paper-500">Images —</span>{" "}{effectiveImageCount === 1 ? "1 · one unit of today’s image budget" : `${String(effectiveImageCount)}, sent one at a time · ${String(effectiveImageCount)} units of today’s image budget`}</li>
              <li><span className="text-paper-500">Controls —</span>{" "}{controlLines.length > 0 ? controlLines.join(" · ") : "none set; the model’s own defaults"}</li>
              {advancedLines.length > 0 ? <li><span className="text-paper-500">Advanced —</span> {advancedLines.join(" · ")}</li> : null}
              {prefill !== null ? <li><span className="text-paper-500">Variant of —</span>{" "}<code className="break-all">{prefill.sourceRunId}</code></li> : null}
            </ul>
          )}
        </div>

        <div className="flex items-center gap-3">
          <Button variant="primary" busy={submitting} disabled={!ready} onClick={() => void submit()}>Run</Button>
          <p className="text-[11px] text-paper-500">The run is refused before any spend if the model’s exact provider version cannot be pinned.</p>
        </div>
      </div>
    </section>
  );
}
