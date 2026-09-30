import {
  baseImageModelSlug,
  imageAspectInputField,
  type ImageInputBinding,
  type ImageModel,
  type ImageProviderInputDescriptor,
  type ImageResolutionTier,
  type ImageLora,
} from "@vesper/image-core";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { imageLoraOptionLabel } from "@/lib/image-model-option-label";
import { Textarea } from "@/components/ui/textarea";
import { NumberField } from "../image-admin-shared";
import {
  controlDefaultFacts,
  generatorControlLabels,
  offeredResolutionTiers,
  reservedFieldHint,
  type GeneratorModelView,
} from "./model";

/**
 * A numeric binding's declared range, as hint copy — absent means undeclared,
 * never unbounded. Worded "Range", not "Provider range": the band can be
 * Vesper's own cost rail rather than the provider's real ceiling (the Qwen
 * 2.1 `steps` binding's 1–60 is Vesper's, the provider's own schema allows
 * 1–150), and this function has no way to tell those apart.
 */
function bindingRangeHint(binding: ImageInputBinding, lead: string): string {
  if (binding.minimum === undefined && binding.maximum === undefined) return lead;
  const min = binding.minimum === undefined ? "…" : String(binding.minimum);
  const max = binding.maximum === undefined ? "…" : String(binding.maximum);
  return `${lead} Range ${min}–${max}.`;
}

/** Non-empty hint fragments, space-joined — used to assemble a control's final hint from pieces that may or may not apply. */
function joinHintParts(...parts: (string | null)[]): string {
  return parts.filter((part): part is string => part !== null && part !== "").join(" ");
}

/** Everything the provider schema said about one advanced field, as one hint line. */
function advancedInputHint(descriptor: ImageProviderInputDescriptor): string {
  const parts: string[] = [];
  if (descriptor.description !== undefined && descriptor.description.trim() !== "") {
    parts.push(descriptor.description.trim());
  }
  if (descriptor.default !== undefined) parts.push(`Default ${JSON.stringify(descriptor.default)}.`);
  if (descriptor.minimum !== undefined || descriptor.maximum !== undefined) {
    const min = descriptor.minimum === undefined ? "…" : String(descriptor.minimum);
    const max = descriptor.maximum === undefined ? "…" : String(descriptor.maximum);
    parts.push(`Range ${min}–${max}.`);
  }
  if (descriptor.required) parts.push("The provider marks it required.");
  return parts.length > 0 ? parts.join(" ") : "Described by the provider schema. Unset is omitted from the payload.";
}

/** One advanced field's editor, by declared type. Empty means unset — omitted, never defaulted here. */
export function AdvancedInputField({
  descriptor,
  value,
  error,
  onChange,
}: {
  descriptor: ImageProviderInputDescriptor;
  value: string;
  /** The strict-parse verdict on the current value; shown beside the field and holds the run. */
  error?: string;
  onChange: (value: string) => void;
}) {
  const hint = advancedInputHint(descriptor);
  if (descriptor.type === "boolean" || descriptor.type === "enum") {
    const options = descriptor.type === "boolean" ? ["true", "false"] : (descriptor.enumValues ?? []);
    return (
      <Field label={descriptor.field} hint={hint}>
        {(id) => (
          <Select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
            <option value="">— Default —</option>
            {options.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </Select>
        )}
      </Field>
    );
  }
  if (descriptor.type === "integer" || descriptor.type === "number") {
    return (
      <div className="flex flex-col gap-1">
        <NumberField
          label={descriptor.field}
          hint={hint}
          value={value}
          min={descriptor.minimum}
          max={descriptor.maximum}
          step={descriptor.type === "integer" ? 1 : undefined}
          placeholder="provider default"
          onChange={onChange}
        />
        {error !== undefined ? (
          <p className="text-xs text-danger-300" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    );
  }
  return (
    <Field label={descriptor.field} hint={hint}>
      {(id) => (
        <Input
          id={id}
          value={value}
          maxLength={2000}
          spellCheck={false}
          placeholder="provider default"
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </Field>
  );
}

export function GeneratorControls({
  selectedModel,
  bindings,
  resolutionTierOffered,
  shapeOptions,
  loraBound,
  seed,
  setSeed,
  guidance,
  setGuidance,
  steps,
  setSteps,
  editStrength,
  setEditStrength,
  aspect,
  setAspect,
  negativePrompt,
  setNegativePrompt,
  loraId,
  setLoraId,
  loraScale,
  setLoraScale,
  resolution,
  setResolution,
  thinkingMode,
  setThinkingMode,
  fastMode,
  setFastMode,
  seedError,
  guidanceError,
  stepsError,
  editStrengthError,
  loraScaleError,
  enabledLoras,
  registeredModels,
  loraPrefilled,
  selectedLora,
  loraModelMismatch,
  loraVersionMismatch,
  effectiveVersionId,
}: {
  selectedModel: ImageModel | null;
  bindings: GeneratorModelView["bindings"];
  resolutionTierOffered: boolean;
  shapeOptions: string[];
  loraBound: boolean;
  seed: string;
  setSeed: (value: string) => void;
  guidance: string;
  setGuidance: (value: string) => void;
  steps: string;
  setSteps: (value: string) => void;
  editStrength: string;
  setEditStrength: (value: string) => void;
  aspect: string;
  setAspect: (value: string) => void;
  negativePrompt: string;
  setNegativePrompt: (value: string) => void;
  loraId: string;
  setLoraId: (value: string) => void;
  loraScale: string;
  setLoraScale: (value: string) => void;
  resolution: ImageResolutionTier | "";
  setResolution: (value: ImageResolutionTier | "") => void;
  thinkingMode: boolean;
  setThinkingMode: (value: boolean) => void;
  fastMode: "" | "on" | "off";
  setFastMode: (value: "" | "on" | "off") => void;
  seedError: string | null;
  guidanceError: string | null;
  stepsError: string | null;
  editStrengthError: string | null;
  loraScaleError: string | null;
  enabledLoras: ImageLora[];
  registeredModels: ImageModel[];
  loraPrefilled: boolean;
  selectedLora: ImageLora | null;
  loraModelMismatch: boolean;
  loraVersionMismatch: boolean;
  effectiveVersionId: string | null;
}) {
  const labels = generatorControlLabels(bindings);

  // Each hint below answers "what does blank send" ONCE, then states it once:
  // `controlDefaultFacts` resolves Vesper's reviewed default (applied by
  // `withReviewedProfileDefaults`, which the Image Generator's own synthetic
  // bench profile goes through) ahead of the row's own descriptor default, and
  // whichever is known REPLACES the control's generic "blank is the provider
  // default" wording rather than sitting beside it — the self-contradiction a
  // reviewer caught on `qwen/qwen-image-edit-2511` (reviewed `fastMode: false`
  // beside a probed `go_fast` default of `true`) and on this lane's own
  // `steps` (Vesper's own 40 beside a naive "provider default" claim).
  const seedHint = (() => {
    const binding = bindings.seed;
    if (binding === undefined) return "";
    const facts = controlDefaultFacts(selectedModel, null, binding.field);
    return joinHintParts(
      facts.defaultClause ?? "Blank is random.",
      "A set seed is what makes a duplicate reproducible.",
      facts.note,
    );
  })();
  const guidanceHint = (() => {
    const binding = bindings.guidance;
    if (binding === undefined) return "";
    const facts = controlDefaultFacts(selectedModel, "guidance", binding.field);
    return joinHintParts(bindingRangeHint(binding, facts.defaultClause ?? "Blank is the provider default."), facts.note);
  })();
  const stepsHint = (() => {
    const binding = bindings.steps;
    if (binding === undefined) return "";
    const facts = controlDefaultFacts(selectedModel, "steps", binding.field);
    return joinHintParts(bindingRangeHint(binding, facts.defaultClause ?? "Blank is the provider default."), facts.note);
  })();
  const editStrengthHint = (() => {
    const binding = bindings.editStrength;
    if (binding === undefined) return "";
    const facts = controlDefaultFacts(selectedModel, null, binding.field);
    const lead = facts.defaultClause ?? "blank is the provider default.";
    return joinHintParts(bindingRangeHint(binding, `How far the render may move from its source; ${lead}`), facts.note);
  })();
  const thinkingModeHint = (() => {
    const binding = bindings.thinkingMode;
    if (binding === undefined) return "";
    const facts = controlDefaultFacts(selectedModel, null, binding.field);
    return joinHintParts(
      facts.defaultClause ?? "Unchecked is the provider default.",
      "The switch is only sent when ticked.",
      facts.note,
    );
  })();
  const fastModeHint = (() => {
    const binding = bindings.fastMode;
    if (binding === undefined) return "";
    const facts = controlDefaultFacts(selectedModel, "fastMode", binding.field);
    const lead =
      facts.defaultClause ??
      "Blank sends nothing, so whatever this model already runs with stands — the provider’s default, " +
        "or Vesper’s reviewed correction where one exists.";
    return joinHintParts(lead, "On asks for the accelerated sampling path; Off refuses it.", facts.note);
  })();
  const resolutionTierHint = (() => {
    const binding = bindings.resolutionTier;
    if (binding === undefined) return "";
    const facts = controlDefaultFacts(selectedModel, null, binding.field);
    return joinHintParts(facts.defaultClause ?? "Blank is the provider default tier.", facts.note);
  })();
  const negativePromptHint = (() => {
    const binding = bindings.negativePrompt;
    if (binding === undefined) return "";
    const facts = controlDefaultFacts(selectedModel, "negativePrompt", binding.field);
    return joinHintParts(
      "What the render should avoid.",
      facts.defaultClause ?? "Blank sends nothing.",
      "A model declaring this field is not a promise it acts on one — check the model’s page under " +
        "docs/image-models before trusting an exclusion.",
      facts.note,
    );
  })();
  const outputShapeHint =
    "Blank sends no shape at all — the model answers at its own default, and nothing is cropped afterwards." +
    (selectedModel === null ? "" : reservedFieldHint(selectedModel, null, imageAspectInputField(selectedModel)));

  return (
    <>
        {selectedModel !== null &&
        (bindings.seed !== undefined ||
          bindings.negativePrompt !== undefined ||
          bindings.guidance !== undefined ||
          bindings.steps !== undefined ||
          bindings.editStrength !== undefined ||
          resolutionTierOffered ||
          bindings.thinkingMode !== undefined ||
          bindings.fastMode !== undefined ||
          shapeOptions.length > 0 ||
          loraBound) ? (
          <div className="flex flex-col gap-3">
            <h3 className="text-xs font-medium tracking-wide text-paper-400 uppercase">Controls</h3>
            <p className="text-xs text-paper-500">
              {"Only what the active probed version binds is offered, and everything starts unset — the provider’s "}
              {"own defaults rule until you change a value. Each control below is labelled with the field it is "}
              {"bound to in the active version’s capability record — the normalized meaning lives in its hint "}
              {"instead. An explicitly set value that cannot be represented refuses the run before any spend "}
              {"rather than being dropped."}
            </p>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {bindings.seed !== undefined ? (
                <div className="flex flex-col gap-1">
                  <NumberField
                    label={labels.seed}
                    hint={seedHint}
                    value={seed}
                    min={0}
                    step={1}
                    placeholder="random"
                    onChange={setSeed}
                  />
                  {seedError !== null ? (
                    <p className="text-xs text-danger-300" role="alert">
                      {seedError}
                    </p>
                  ) : null}
                </div>
              ) : null}
              {bindings.guidance !== undefined ? (
                <div className="flex flex-col gap-1">
                  <NumberField
                    label={labels.guidance}
                    hint={guidanceHint}
                    value={guidance}
                    min={bindings.guidance.minimum}
                    max={bindings.guidance.maximum}
                    step={0.1}
                    placeholder="provider default"
                    onChange={setGuidance}
                  />
                  {guidanceError !== null ? (
                    <p className="text-xs text-danger-300" role="alert">
                      {guidanceError}
                    </p>
                  ) : null}
                </div>
              ) : null}
              {bindings.steps !== undefined ? (
                <div className="flex flex-col gap-1">
                  <NumberField
                    label={labels.steps}
                    hint={stepsHint}
                    value={steps}
                    min={bindings.steps.minimum ?? 1}
                    max={bindings.steps.maximum}
                    step={1}
                    placeholder="provider default"
                    onChange={setSteps}
                  />
                  {stepsError !== null ? (
                    <p className="text-xs text-danger-300" role="alert">
                      {stepsError}
                    </p>
                  ) : null}
                </div>
              ) : null}
              {bindings.editStrength !== undefined ? (
                <div className="flex flex-col gap-1">
                  <NumberField
                    label={labels.editStrength}
                    hint={editStrengthHint}
                    value={editStrength}
                    min={bindings.editStrength.minimum ?? 0}
                    max={bindings.editStrength.maximum ?? 1}
                    step={0.05}
                    placeholder="provider default"
                    onChange={setEditStrength}
                  />
                  {editStrengthError !== null ? (
                    <p className="text-xs text-danger-300" role="alert">
                      {editStrengthError}
                    </p>
                  ) : null}
                </div>
              ) : null}
              {bindings.thinkingMode !== undefined ? (
                <Field label={labels.thinkingMode} hint={thinkingModeHint}>
                  {(id) => (
                    <label htmlFor={id} className="flex items-center gap-2 text-sm text-paper-300">
                      <input
                        id={id}
                        type="checkbox"
                        checked={thinkingMode}
                        onChange={(e) => setThinkingMode(e.target.checked)}
                      />
                      {"Ask the model to reason before rendering"}
                    </label>
                  )}
                </Field>
              ) : null}
              {bindings.fastMode !== undefined ? (
                <Field label={labels.fastMode} hint={fastModeHint}>
                  {(id) => (
                    <Select
                      id={id}
                      value={fastMode}
                      onChange={(e) => setFastMode(e.target.value as "" | "on" | "off")}
                    >
                      <option value="">— Default —</option>
                      <option value="on">On</option>
                      <option value="off">Off</option>
                    </Select>
                  )}
                </Field>
              ) : null}
              {shapeOptions.length > 0 ? (
                <Field label="Output shape" hint={outputShapeHint}>
                  {(id) => (
                    <Select id={id} value={aspect} onChange={(e) => setAspect(e.target.value)}>
                      <option value="">— Model default —</option>
                      {shapeOptions.map((option) => (
                        <option key={option} value={option}>
                          {option}
                        </option>
                      ))}
                    </Select>
                  )}
                </Field>
              ) : null}
              {resolutionTierOffered && bindings.resolutionTier !== undefined ? (
                <Field label={labels.resolutionTier} hint={resolutionTierHint}>
                  {(id) => (
                    <Select
                      id={id}
                      value={resolution}
                      onChange={(e) => setResolution(e.target.value as ImageResolutionTier | "")}
                    >
                      <option value="">— Default —</option>
                      {offeredResolutionTiers(bindings.resolutionTier).map((tier) => (
                        <option key={tier} value={tier}>
                          {tier}
                        </option>
                      ))}
                    </Select>
                  )}
                </Field>
              ) : null}
              {/* No Width/Height here even where customWidth/customHeight are
                  bound — withheld until the shared custom-resolution path works
                  end to end (rationale on the request.ts). */}
            </div>
              {/* Stated unconditionally, and deliberately not narrowed to the
                  endpoints known to ignore the field. A slug test here is the
                  thing @vesper/image-models exists to keep out of shared code,
                  and the honest general warning is the same warning: a declared
                  input is a schema fact, and acting on it is a behavior fact the
                  schema cannot promise. Qwen Image 2512 is the measured case —
                  16 of 16 paired renders kept what the negative field excluded. */}
            {bindings.negativePrompt !== undefined ? (
              <Field label={labels.negativePrompt} hint={negativePromptHint}>
                {(id) => (
                  <Textarea
                    id={id}
                    rows={2}
                    value={negativePrompt}
                    maxLength={2000}
                    spellCheck={false}
                    onChange={(e) => setNegativePrompt(e.target.value)}
                  />
                )}
              </Field>
            ) : null}
            {loraBound ? (
              <>
                <div className="grid gap-4 sm:grid-cols-[1fr_9rem]">
                  <Field
                    label={labels.loraWeights}
                    hint={
                      (enabledLoras.length === 0
                        ? "None in the library yet. Curate one in the LoRA library on the Image models page — only enabled rows are offered here."
                        : loraPrefilled
                          ? "Pre-filled because this is the pairing intimate scenes run on in production. Change or clear it like any other pick."
                          : "Optional. Blends a curated weights file into this run — the library row decides which models and strengths it may run at.") +
                      reservedFieldHint(selectedModel, null, bindings.loraWeights?.field)
                    }
                  >
                    {(id) => (
                      <Select id={id} value={loraId} onChange={(e) => setLoraId(e.target.value)}>
                        <option value="">— None —</option>
                        {enabledLoras.map((lora) => (
                          <option key={lora.id} value={lora.id}>
                            {imageLoraOptionLabel(lora, registeredModels)}
                          </option>
                        ))}
                      </Select>
                    )}
                  </Field>
                  {selectedLora !== null ? (
                    <Field label={labels.loraScale} hint={reservedFieldHint(selectedModel, null, bindings.loraScale?.field).trim() || undefined}>
                      {(id) => (
                        <Input
                          id={id}
                          type="number"
                          step={0.05}
                          min={selectedLora.minimumScale}
                          max={selectedLora.maximumScale}
                          value={loraScale}
                          onChange={(e) => setLoraScale(e.target.value)}
                        />
                      )}
                    </Field>
                  ) : null}
                </div>
                {selectedLora !== null ? (
                  <p className="text-xs text-paper-500">
                    {`Curated range ${String(selectedLora.minimumScale)}–${String(selectedLora.maximumScale)}, default ${String(selectedLora.defaultScale)}. `}
                    {"A scale outside the band is refused before any spend rather than clamped — widen the row in the "}
                    {"LoRA library if the band is the thing that is wrong."}
                  </p>
                ) : null}
                {loraScaleError !== null ? (
                  <p className="text-xs text-danger-300" role="alert">
                    {loraScaleError}
                  </p>
                ) : null}
                {loraModelMismatch ? (
                  <p className="text-xs text-danger-300">
                    {`These weights are not curated for ${baseImageModelSlug(selectedModel.slug)} — as it stands the `}
                    {"run is refused before any spend. Pick a listed model, or widen the row in the LoRA library."}
                  </p>
                ) : null}
                {loraVersionMismatch ? (
                  <p className="text-xs text-danger-300">
                    {`These weights name the exact versions they were reviewed against, and ${effectiveVersionId ?? ""} `}
                    {"is not one of them — as it stands the run is refused before any spend. Pick a different LoRA, or "}
                    {"add this version to the row in the LoRA library."}
                  </p>
                ) : null}
              </>
            ) : null}
          </div>
        ) : null}

    </>
  );
}
