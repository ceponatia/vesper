"use client";

import { useState } from "react";
import {
  baseImageModelSlug,
  chooseAspect,
  imageResolutionTiers,
  isImageControlReferenceRole,
  parseAspectValue,
  pinnedImageModelVersion,
  referenceCapacity,
  type ImageInputBinding,
  type ImageModel,
  type ImageProviderInputDescriptor,
  type ImageReferenceRole,
  type ImageResolutionTier,
  type ImageUriBinding,
} from "@vesper/image-core";
import {
  IMAGE_GENERATOR_MAX_PRIMARY,
  IMAGE_GENERATOR_PROMPT_MAX,
  type ImageGeneratorControls,
  type ImageGeneratorCreateRunRequest,
  type ImageGeneratorDedicatedRole,
  type ImageGeneratorProviderInputs,
  type ImageGeneratorRunInputs,
  type ImageGeneratorVersionPolicy,
} from "@/contracts/images/image-generator";
import { adminImageModelsApi, imageGeneratorApi, imageLorasApi, imageUrl } from "@/lib/client/api";
import { useAsyncData } from "@/components/hooks/use-async";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Tag } from "@/components/ui/tag";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import { NumberField } from "./image-admin-shared";
import { imageGeneratorRoleLabel } from "./image-generator-copy";
import { OwnedImagePicker } from "./owned-image-picker";

/**
 * The new-run form (image-lab-general-model-trials.plan.md §14): one raw
 * prompt against one explicitly chosen registered model, with every input and
 * control written down before the render is paid for.
 *
 * The form is CAPABILITY-DRIVEN, never model-slug-driven — that is the plan's
 * acceptance test (§20). The chosen row's probed `advancedCapabilities` decide
 * everything past the prompt: primary references appear only on a model that
 * can edit, dedicated structural slots only where the capability record
 * declares them, each normalized control only where the active version binds a
 * field for it, and advanced inputs only for described non-reserved provider
 * fields. Registering a new model changes this form through its capability
 * record, with no edit here.
 *
 * Everything starts UNSET (plan §8): the provider's own defaults rule until the
 * admin explicitly changes a value, and a value that cannot be represented at
 * run time refuses the run rather than being dropped — a silently trimmed
 * request would make every A/B built on it dishonest.
 *
 * A duplicate mounts this form seeded from a settled run (values only; nothing
 * runs until submitted). The page remounts the form per prefill — the lab's
 * key idiom — so the form owns its state after mount. The prefill names its
 * model by SLUG (the run record's snapshot); the form adopts the matching
 * registry row once the registry answers, and says so plainly when the slug no
 * longer resolves or its pin has moved since the original ran — comparison
 * honesty (plan §12) is a warning the admin reads before spending, never a
 * silent substitution.
 */

/** A settled run's request, re-seeded into a fresh form. Values only. */
export interface ImageGeneratorPrefill {
  /** The original's model snapshot — resolved back against the registry here. */
  modelSlug: string;
  /** The pin the original ran on; a drifted current pin is warned about. */
  requestedVersionId: string | null;
  prompt: string;
  inputs: ImageGeneratorRunInputs;
  controls: ImageGeneratorControls;
  providerInputs: ImageGeneratorProviderInputs;
  /** Lineage — sent as `sourceRunId` so the new row cites what it varies. */
  sourceRunId: string;
}

export interface ImageGeneratorFormProps {
  prefill?: ImageGeneratorPrefill | null;
  /** The accepted run's id — the caller opens it and remounts this form blank. */
  onCreated: (runId: string) => void;
}

/**
 * The purposes the form offers: the CONTENT roles only. The structural roles
 * are deliberately absent — a structural image belongs in a dedicated slot or
 * an ordinary numbered position, and letting an admin file one as a "pose
 * purpose" would look like routing while changing nothing. A stored purpose
 * outside this set (possible via the API) is dropped from a duplicate's seed
 * rather than silently remapped.
 */
const PURPOSE_ROLES = [
  "identity",
  "location",
  "style",
  "object",
  "outfit",
  "product",
  "before",
  "after_example",
] as const satisfies readonly ImageReferenceRole[];
type PurposeRole = (typeof PURPOSE_ROLES)[number];

function toPurposeOption(purpose: ImageReferenceRole | undefined): PurposeRole | "" {
  return PURPOSE_ROLES.find((role) => role === purpose) ?? "";
}

interface PrimaryRow {
  key: number;
  imageId: string | null;
  purpose: PurposeRole | "";
}

/**
 * The model's dedicated structural slots, one per role, first declaration
 * winning — the same tie-break `controlReferenceTransport` applies, so what
 * the form offers is what the runner would route.
 */
function dedicatedSlotsOf(model: ImageModel | null): { role: ImageGeneratorDedicatedRole; binding: ImageUriBinding }[] {
  if (model === null) return [];
  const slots: { role: ImageGeneratorDedicatedRole; binding: ImageUriBinding }[] = [];
  const seen = new Set<string>();
  for (const entry of model.advancedCapabilities.additionalImageInputs) {
    if (!isImageControlReferenceRole(entry.roleHint) || seen.has(entry.roleHint)) continue;
    seen.add(entry.roleHint);
    // A binding that names the PRIMARY reference field is the numbered array
    // described twice, not a dedicated input — `controlReferenceTransport`
    // demotes exactly this entry, and an explicitly dedicated selection never
    // falls back to the numbered references, so offering the slot here would
    // offer a route the runner refuses.
    if (entry.binding.field === model.referenceField) continue;
    slots.push({ role: entry.roleHint, binding: entry.binding });
  }
  return slots;
}

/**
 * Whether this version would actually send `option` if it were asked for.
 *
 * Membership in `supportedAspects` is not enough. Several declared members can
 * share one ratio — Wan lists five pixel pairs that each lose their ratio group
 * to a larger sibling — and the shared mapper resolves a ratio to the largest,
 * so asking for one of the others is a guaranteed refusal. One predicate for
 * the select, the request, and the drift warning, so the three cannot disagree
 * about what "supported" means.
 */
function shapeIsReachable(model: ImageModel | null, option: string): boolean {
  if (model === null) return false;
  const ratio = parseAspectValue(option);
  return ratio !== null && chooseAspect(model, ratio).value === option;
}

/** The provider-input types the advanced editor can offer a control for. */
const EDITABLE_PROVIDER_TYPES = ["string", "integer", "number", "boolean", "enum"] as const;

function editableProviderInputs(model: ImageModel | null): ImageProviderInputDescriptor[] {
  if (model === null) return [];
  return model.advancedCapabilities.providerInputs.filter(
    (descriptor) => !descriptor.reserved && EDITABLE_PROVIDER_TYPES.some((type) => type === descriptor.type),
  );
}

/** One numeric box, read strictly: blank, unreadable, or the number it names in full. */
type StrictNumber = { kind: "unset" } | { kind: "invalid" } | { kind: "value"; value: number };

/**
 * Strict numeric read — `Number`, never `parseInt`/`parseFloat`, so a typed
 * value can never be silently rewritten into a request the admin did not make:
 * "3.7" or "12abc" in an integer box is INVALID rather than truncated to 3 or
 * 12, and "1e10" means ten billion rather than 1. The caller renders invalid
 * as a visible per-field error that holds the run — withheld-but-typed would
 * be the same lie as silently trimmed (plan §8).
 */
function parseStrictNumber(raw: string, mode: "integer" | "number"): StrictNumber {
  const text = raw.trim();
  if (text === "") return { kind: "unset" };
  const value = Number(text);
  if (!Number.isFinite(value)) return { kind: "invalid" };
  if (mode === "integer" && !Number.isInteger(value)) return { kind: "invalid" };
  return { kind: "value", value };
}

/** A numeric binding's declared range, as hint copy — absent means undeclared, never unbounded. */
function bindingRangeHint(binding: ImageInputBinding, lead: string): string {
  if (binding.minimum === undefined && binding.maximum === undefined) return lead;
  const min = binding.minimum === undefined ? "…" : String(binding.minimum);
  const max = binding.maximum === undefined ? "…" : String(binding.maximum);
  return `${lead} Provider range ${min}–${max}.`;
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
function AdvancedInputField({
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
            <option value="">— Provider default —</option>
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
  // Which slot's picker is open — one at a time, so six reference rows are six
  // thumbnails and one grid rather than six grids.
  const [openPicker, setOpenPicker] = useState<string | null>(null);

  // Normalized controls, each as the box's own text. Empty means UNSET — the
  // provider default — and only a parseable non-empty value enters the request.
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
  // Blank is the MODEL's own shape, not a Vesper default — the Generator sends
  // no aspect/size key unless this names one of the version's own members.
  const [aspect, setAspect] = useState(prefill?.controls.aspect ?? "");
  const [thinkingMode, setThinkingMode] = useState(prefill?.controls.thinkingMode ?? false);
  // A duplicate whose model has been re-probed can either replay the exact
  // version the source ran, or run today's. Neither is a safe default to pick
  // silently, so the choice is only offered when the two actually differ.
  const [versionPolicy, setVersionPolicy] = useState<ImageGeneratorVersionPolicy>("current");
  const [loraId, setLoraId] = useState(prefill?.controls.lora?.id ?? "");
  const [loraScale, setLoraScale] = useState(
    prefill?.controls.lora?.scale !== undefined ? String(prefill.controls.lora.scale) : "",
  );

  // Advanced provider values, keyed by field, as text. Empty means unset.
  const [providerValues, setProviderValues] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {};
    for (const [field, value] of Object.entries(prefill?.providerInputs ?? {})) initial[field] = String(value);
    return initial;
  });

  const [submitting, setSubmitting] = useState(false);

  const registeredModels = models.data?.models ?? [];

  // The model-change reset's latch, declared before the prefill adoption below
  // so the adoption can advance it in the same pass and keep its seeded values.
  const [prevModelId, setPrevModelId] = useState(modelId);

  // A duplicate names its model by slug; adopt the matching registry row once
  // the registry answers (render-adjust with a latch, never a setState inside
  // an effect). No match leaves the select unchosen, with the warning below.
  const [prefillModelResolved, setPrefillModelResolved] = useState(prefill === null);
  if (!prefillModelResolved && models.data !== null) {
    setPrefillModelResolved(true);
    const match = registeredModels.find((model) => model.slug === prefill?.modelSlug);
    if (match !== undefined) {
      setModelId(match.id);
      setPrevModelId(match.id);
    }
  }

  const selectedModel = registeredModels.find((model) => model.id === modelId) ?? null;

  // A different model is a different capability record, so every model-specific
  // section returns to unset: bindings, descriptors, and their defaults are
  // per-model facts, and "the provider's defaults rule until explicitly
  // changed" must hold for the row now in the box. The prompt and the primary
  // references survive — words and pixels carry across models, and keeping them
  // is what makes "same request, different model" a one-change comparison.
  if (modelId !== prevModelId) {
    setPrevModelId(modelId);
    setDedicated({});
    setProviderValues({});
    setSeed("");
    setNegativePrompt("");
    setGuidance("");
    setSteps("");
    setEditStrength("");
    setResolution("");
    setAspect("");
    setThinkingMode(false);
    setLoraId("");
    setLoraScale("");
    setVersionPolicy("current");
  }

  // The edit gate mirrors `profileEligibility`: `canEdit` AND a reviewed
  // `editKind` other than "none" — a row rated unable to actually edit must
  // not offer reference slots whose run the planner refuses.
  const modelCanEdit = selectedModel !== null && selectedModel.canEdit && selectedModel.editKind !== "none";

  // A model with no image input cannot take the rows, and holding them unseen
  // would send a request the runner refuses — cleared, not hidden (no latch:
  // clearing extinguishes the condition).
  if (selectedModel !== null && !modelCanEdit && primaryRows.length > 0) {
    setPrimaryRows([]);
  }

  const capabilities = selectedModel?.advancedCapabilities ?? null;
  const bindings = capabilities?.controls ?? {};
  const dedicatedSlots = dedicatedSlotsOf(selectedModel);
  const advancedInputs = editableProviderInputs(selectedModel);
  const reservedFields = (capabilities?.providerInputs ?? [])
    .filter((descriptor) => descriptor.reserved)
    .map((descriptor) => descriptor.field);

  // The version's OWN declared shapes, narrowed to the ones actually
  // reachable. Blank stays the model's default: the Generator writes no
  // aspect/size key unless one of these is picked, so a raw run is never
  // bucketed toward a Vesper target or cropped to reach one.
  //
  // The filter matters on size-mode models, where several members share one
  // ratio (Wan's three 3:4 sizes) and the shared mapper resolves a ratio to the
  // largest of them. The server refuses a pick it would have to substitute, so
  // offering the unreachable members here would only sell a guaranteed refusal.
  const shapeOptions = (selectedModel?.supportedAspects ?? []).filter((option) =>
    shapeIsReachable(selectedModel, option),
  );

  // On a size-mode model the declared shapes ARE the sizes, so the tier and the
  // Output shape select would be two controls for one request — and the render
  // path reserves that key for the shape, so a tier picked here would be
  // refused pre-spend. Offer the shape only.
  const resolutionTierOffered =
    bindings.resolutionTier !== undefined && selectedModel !== null && selectedModel.aspectMode !== "size";

  const pinnedVersion = selectedModel === null ? null : pinnedImageModelVersion(selectedModel);
  const modelCapacity = selectedModel === null ? null : referenceCapacity(selectedModel).max;
  const capacity = modelCapacity === null ? null : Math.min(modelCapacity, IMAGE_GENERATOR_MAX_PRIMARY);

  // The LoRA control, offered only when the active version binds BOTH the
  // weights and the scale field — the resolver requires the pair (a locator
  // with no scale field would run at the model's own default strength, a
  // different render from the one recorded), so a weights-only version gets no
  // select whose every use refuses. Same rails as the lab: enabled rows only,
  // the row's own band, a vanished pick cleared (guarded on the fetch having
  // answered), and a change of row returning the scale to that row's default.
  const loraBound = bindings.loraWeights !== undefined && bindings.loraScale !== undefined;
  const enabledLoras = (loras.data ?? []).filter((lora) => lora.enabled);
  const selectedLora = loraId === "" ? null : (enabledLoras.find((lora) => lora.id === loraId) ?? null);
  const [prevLoraId, setPrevLoraId] = useState(loraId);
  if (loras.data !== null && loraId !== "" && selectedLora === null) {
    // A row that left the library must not ride into a request as an id
    // nothing matches; the latch below then clears the stranded scale.
    setLoraId("");
  } else if (loraId !== prevLoraId) {
    // A different row is a different curated band, so the scale returns to
    // that row's own default (render-adjust with a latch).
    setPrevLoraId(loraId);
    setLoraScale(selectedLora === null ? "" : String(selectedLora.defaultScale));
  }
  const parsedLoraScale = parseStrictNumber(loraScale, "number");
  const requestedScale = parsedLoraScale.kind === "value" ? parsedLoraScale.value : Number.NaN;
  const effectiveLoraScale =
    selectedLora === null ? null : Number.isFinite(requestedScale) ? requestedScale : selectedLora.defaultScale;
  const loraReady =
    selectedLora === null ||
    (effectiveLoraScale !== null &&
      effectiveLoraScale >= selectedLora.minimumScale &&
      effectiveLoraScale <= selectedLora.maximumScale);
  const loraModelMismatch =
    selectedLora !== null &&
    selectedModel !== null &&
    !selectedLora.compatibleModelSlugs.some(
      (compatible) => baseImageModelSlug(compatible) === baseImageModelSlug(selectedModel.slug),
    );

  // The request as it stands: explicit controls assembled beside their summary
  // lines, so the panel below and the POST can never disagree. Each numeric box
  // is read by `parseStrictNumber`; a value it calls invalid gets a per-field
  // error below and holds the run, never a silent rewrite or withhold.
  //
  // Width/Height are deliberately NOT offered (spec §"Rulings the build
  // settled"): the compile honors explicit dimensions only under
  // `resolution: "custom"`, which this form cannot produce — the tier select
  // filters `imageResolutionTiers` by the provider's own enumValues, which
  // never include "custom" — so any set dimension was a guaranteed pre-spend
  // `control_refused`. Withheld until the shared custom-resolution path works
  // end to end; the contract keeps `width`/`height` for API callers.
  const assembledControls: ImageGeneratorControls = {};
  const controlLines: string[] = [];
  const parsedSeed = parseStrictNumber(seed, "integer");
  const seedError =
    bindings.seed !== undefined &&
    (parsedSeed.kind === "invalid" || (parsedSeed.kind === "value" && parsedSeed.value < 0))
      ? "A seed is a whole number of 0 or more — fix or clear it to run."
      : null;
  if (bindings.seed !== undefined && parsedSeed.kind === "value" && parsedSeed.value >= 0) {
    assembledControls.seed = parsedSeed.value;
    controlLines.push(`seed ${String(parsedSeed.value)}`);
  }
  if (bindings.negativePrompt !== undefined && negativePrompt.trim() !== "") {
    assembledControls.negativePrompt = negativePrompt.trim();
    controlLines.push("negative prompt");
  }
  const parsedGuidance = parseStrictNumber(guidance, "number");
  const guidanceError =
    bindings.guidance !== undefined && parsedGuidance.kind === "invalid"
      ? "Guidance is a number — fix or clear it to run."
      : null;
  if (bindings.guidance !== undefined && parsedGuidance.kind === "value") {
    assembledControls.guidance = parsedGuidance.value;
    controlLines.push(`guidance ${String(parsedGuidance.value)}`);
  }
  const parsedSteps = parseStrictNumber(steps, "integer");
  const stepsError =
    bindings.steps !== undefined &&
    (parsedSteps.kind === "invalid" || (parsedSteps.kind === "value" && parsedSteps.value < 1))
      ? "Steps is a whole number of 1 or more — fix or clear it to run."
      : null;
  if (bindings.steps !== undefined && parsedSteps.kind === "value" && parsedSteps.value >= 1) {
    assembledControls.steps = parsedSteps.value;
    controlLines.push(`steps ${String(parsedSteps.value)}`);
  }
  const parsedStrength = parseStrictNumber(editStrength, "number");
  const editStrengthError =
    bindings.editStrength !== undefined && parsedStrength.kind === "invalid"
      ? "Edit strength is a number — fix or clear it to run."
      : null;
  if (bindings.editStrength !== undefined && parsedStrength.kind === "value") {
    assembledControls.editStrength = parsedStrength.value;
    controlLines.push(`edit strength ${String(parsedStrength.value)}`);
  }
  if (resolutionTierOffered && resolution !== "") {
    assembledControls.resolution = resolution;
    controlLines.push(`resolution ${resolution}`);
  }
  // Only a member the current version still declares AND still resolves to
  // travels. Reachability rather than mere membership, because the two differ:
  // a declared-but-unreachable member is not in the select, so sending it would
  // submit a value the operator cannot see and the runner is certain to refuse.
  if (aspect !== "" && shapeIsReachable(selectedModel, aspect)) {
    assembledControls.aspect = aspect;
    controlLines.push(`shape ${aspect}`);
  }
  if (bindings.thinkingMode !== undefined && thinkingMode) {
    assembledControls.thinkingMode = true;
    controlLines.push("thinking mode");
  }
  if (loraBound && selectedLora !== null) {
    assembledControls.lora = {
      id: selectedLora.id,
      ...(Number.isFinite(requestedScale) ? { scale: requestedScale } : {}),
    };
    controlLines.push(
      `LoRA ${selectedLora.label}${Number.isFinite(requestedScale) ? ` @ ${String(requestedScale)}` : ""}`,
    );
  }

  const assembledProviderInputs: ImageGeneratorProviderInputs = {};
  const advancedLines: string[] = [];
  const advancedErrors: Record<string, string> = {};
  for (const descriptor of advancedInputs) {
    const raw = (providerValues[descriptor.field] ?? "").trim();
    if (raw === "") continue;
    let value: string | number | boolean;
    if (descriptor.type === "boolean") value = raw === "true";
    else if (descriptor.type === "integer" || descriptor.type === "number") {
      const parsed = parseStrictNumber(raw, descriptor.type);
      if (parsed.kind !== "value") {
        advancedErrors[descriptor.field] =
          descriptor.type === "integer"
            ? "A whole number — fix or clear it to run."
            : "A number — fix or clear it to run.";
        continue;
      }
      value = parsed.value;
    } else value = raw;
    assembledProviderInputs[descriptor.field] = value;
    advancedLines.push(`${descriptor.field} = ${String(value)}`);
  }

  const primaryCount = primaryRows.filter((row) => row.imageId !== null).length;
  const primaryComplete = primaryRows.every((row) => row.imageId !== null);
  const overCapacity = capacity !== null && primaryRows.length > capacity;
  const filledDedicated = dedicatedSlots.filter((slot) => dedicated[slot.role] !== undefined);
  const missingRequiredDedicated = dedicatedSlots.filter(
    (slot) => slot.binding.required && dedicated[slot.role] === undefined,
  );
  // The runner's own rule (spec §Generator runner, step 4): a PRIMARY reference
  // makes this an edit. A dedicated structural input does not — it is its own
  // provider field, and a model that generates from a prompt while taking a
  // required pose map is still generating. Only a model that cannot generate at
  // all reads its structural image as the thing being edited.
  const operation: "edit" | "generate" =
    primaryCount > 0
      ? "edit"
      : filledDedicated.length > 0 && selectedModel !== null && !selectedModel.canGenerate && modelCanEdit
        ? "edit"
        : "generate";
  const operationSupported =
    selectedModel === null || (operation === "edit" ? modelCanEdit : selectedModel.canGenerate);

  // Whether this version needs prompt text at all, from its own probed
  // descriptor. A record with no descriptor for the prompt field says nothing,
  // and silence means "required" — the server refuses on the same rule, so an
  // enabled button here would only buy a refusal.
  const promptDescriptor = (capabilities?.providerInputs ?? []).find(
    (descriptor) => descriptor.field === (capabilities?.prompt?.field ?? "prompt"),
  );
  const promptRequired =
    selectedModel === null || promptDescriptor === undefined || (promptDescriptor.required && promptDescriptor.default === undefined);

  // A duplicate whose model has drifted — comparison honesty (plan §12): the
  // fact is surfaced BEFORE submit, never silently run on different weights.
  const prefillModelMissing =
    prefill !== null &&
    prefillModelResolved &&
    models.data !== null &&
    modelId === "" &&
    !registeredModels.some((model) => model.slug === prefill.modelSlug);
  const versionDrift =
    prefill !== null &&
    prefill.requestedVersionId !== null &&
    selectedModel !== null &&
    selectedModel.slug === prefill.modelSlug &&
    pinnedVersion !== null &&
    pinnedVersion !== prefill.requestedVersionId;

  // Capability drift on a duplicate — the same honesty rule one level down: a
  // prefill seeded from an older capability record can carry values the
  // CURRENT record has no binding, descriptor, or slot for. The submit already
  // omits each one (every control above is gated on the current record), so
  // this list is the warning's job — the admin reads what the duplicate will
  // NOT re-send before spending, not after comparing outputs.
  const prefillDrift: string[] = [];
  if (prefill !== null && selectedModel !== null && selectedModel.slug === prefill.modelSlug) {
    if (prefill.controls.seed !== undefined && bindings.seed === undefined) prefillDrift.push("seed");
    if (prefill.controls.negativePrompt !== undefined && bindings.negativePrompt === undefined) {
      prefillDrift.push("negative prompt");
    }
    if (prefill.controls.guidance !== undefined && bindings.guidance === undefined) prefillDrift.push("guidance");
    if (prefill.controls.steps !== undefined && bindings.steps === undefined) prefillDrift.push("steps");
    if (prefill.controls.editStrength !== undefined && bindings.editStrength === undefined) {
      prefillDrift.push("edit strength");
    }
    if (prefill.controls.resolution !== undefined && !resolutionTierOffered) {
      prefillDrift.push("resolution");
    }
    // Explicit dimensions are withheld by this form outright (see the Controls
    // assembly above), so a duplicated width/height never re-sends whatever
    // the current version binds.
    if (prefill.controls.width !== undefined) prefillDrift.push("width");
    if (prefill.controls.height !== undefined) prefillDrift.push("height");
    if (prefill.controls.aspect !== undefined && !shapeIsReachable(selectedModel, prefill.controls.aspect)) {
      prefillDrift.push("output shape");
    }
    if (prefill.controls.thinkingMode !== undefined && bindings.thinkingMode === undefined) {
      prefillDrift.push("thinking mode");
    }
    // Multi-image controls the one-output policy makes unreachable here, so a
    // duplicate that carried one says so rather than dropping it silently.
    if (prefill.controls.coherentSet !== undefined) prefillDrift.push("coherent set");
    if (prefill.controls.outputCount !== undefined) prefillDrift.push("output count");
    if (prefill.controls.lora !== undefined && !loraBound) prefillDrift.push("LoRA");
    for (const field of Object.keys(prefill.providerInputs)) {
      if (!advancedInputs.some((descriptor) => descriptor.field === field)) prefillDrift.push(field);
    }
    for (const input of prefill.inputs.dedicated) {
      if (!dedicatedSlots.some((slot) => slot.role === input.role)) {
        prefillDrift.push(`${imageGeneratorRoleLabel(input.role)} input`);
      }
    }
  }

  const ready =
    selectedModel !== null &&
    pinnedVersion !== null &&
    (!promptRequired || prompt.trim() !== "") &&
    primaryComplete &&
    !overCapacity &&
    missingRequiredDedicated.length === 0 &&
    operationSupported &&
    loraReady &&
    seedError === null &&
    guidanceError === null &&
    stepsError === null &&
    editStrengthError === null &&
    Object.keys(advancedErrors).length === 0;

  const addRow = () => {
    setPrimaryRows((rows) => [...rows, { key: nextRowKey, imageId: null, purpose: "" }]);
    setNextRowKey((key) => key + 1);
    setOpenPicker(`primary:${String(nextRowKey)}`);
  };
  const removeRow = (key: number) => {
    setPrimaryRows((rows) => rows.filter((row) => row.key !== key));
  };
  const moveRow = (index: number, delta: -1 | 1) => {
    setPrimaryRows((rows) => {
      const target = index + delta;
      if (target < 0 || target >= rows.length) return rows;
      const next = [...rows];
      const [moved] = next.splice(index, 1);
      if (moved === undefined) return rows;
      next.splice(target, 0, moved);
      return next;
    });
  };
  const setRowImage = (key: number, imageId: string | null) => {
    setPrimaryRows((rows) => rows.map((row) => (row.key === key ? { ...row, imageId } : row)));
    if (imageId !== null) setOpenPicker(null);
  };
  const setRowPurpose = (key: number, purpose: PurposeRole | "") => {
    setPrimaryRows((rows) => rows.map((row) => (row.key === key ? { ...row, purpose } : row)));
  };
  const setDedicatedImage = (role: ImageGeneratorDedicatedRole, imageId: string | null) => {
    setDedicated((current) => {
      const next = { ...current };
      if (imageId === null) delete next[role];
      else next[role] = imageId;
      return next;
    });
    if (imageId !== null) setOpenPicker(null);
  };

  const submit = async () => {
    if (!ready || selectedModel === null) return;
    const primary = primaryRows.flatMap((row) =>
      row.imageId === null ? [] : [{ imageId: row.imageId, ...(row.purpose === "" ? {} : { purpose: row.purpose }) }],
    );
    const dedicatedInputs = dedicatedSlots.flatMap((slot) => {
      const imageId = dedicated[slot.role];
      return imageId === undefined ? [] : [{ role: slot.role, imageId }];
    });
    const body: ImageGeneratorCreateRunRequest = {
      modelId: selectedModel.id,
      prompt: prompt.trim(),
      ...(primary.length > 0 || dedicatedInputs.length > 0
        ? { inputs: { primary, dedicated: dedicatedInputs } }
        : {}),
      ...(Object.keys(assembledControls).length > 0 ? { controls: assembledControls } : {}),
      ...(Object.keys(assembledProviderInputs).length > 0 ? { providerInputs: assembledProviderInputs } : {}),
      ...(prefill === null ? {} : { sourceRunId: prefill.sourceRunId }),
      // Only sent when the operator actually chose the replay, and only while
      // the drift that offered the choice is real.
      ...(versionDrift && versionPolicy === "captured" ? { versionPolicy: "captured" as const } : {}),
    };
    setSubmitting(true);
    const result = await imageGeneratorApi.runs.create(body);
    setSubmitting(false);
    if (!result.ok) {
      toast.push({ title: "Couldn’t start that run", description: result.error.message, tone: "error" });
      return;
    }
    toast.push({
      title: "Run queued",
      description: "One render, charged against the daily image budget.",
      tone: "success",
    });
    onCreated(result.data.run.id);
  };

  /** One image slot's thumbnail — or an honest "nothing yet". */
  const slotThumb = (imageId: string | null, alt: string) =>
    imageId !== null ? (
      // eslint-disable-next-line @next/next/no-img-element -- local asset route at thumbnail size; next/image adds nothing here
      <img
        src={imageUrl(imageId)}
        alt={alt}
        className="h-14 w-14 rounded-card border border-ink-600 bg-ink-950 object-cover"
      />
    ) : (
      <span className="text-xs text-paper-600">no image chosen</span>
    );

  // What the chosen row can take, in one line — the capability record's own
  // facts, restated where the admin chooses rather than after a refusal.
  const capabilityParts: string[] = [];
  if (selectedModel !== null) {
    if (selectedModel.canGenerate) capabilityParts.push("prompt-only");
    if (modelCanEdit && modelCapacity !== null && modelCapacity > 0) {
      capabilityParts.push(`up to ${String(modelCapacity)} reference image${modelCapacity === 1 ? "" : "s"}`);
    }
    if (dedicatedSlots.length > 0) {
      capabilityParts.push(
        `dedicated ${dedicatedSlots.map((slot) => imageGeneratorRoleLabel(slot.role)).join(" / ")} input${dedicatedSlots.length === 1 ? "" : "s"}`,
      );
    }
  }
  const capabilitySummary = capabilityParts.length > 0 ? capabilityParts.join(" · ") : "—";

  const modelHint = ((): string => {
    const base =
      "Required — the registered row that actually runs, pinned to an exact provider version before any spend.";
    if (models.error !== null) return `${base} The registered list could not be loaded — retry below.`;
    return registeredModels.some((model) => pinnedImageModelVersion(model) === null)
      ? `${base} A row with no pinned version cannot run here.`
      : base;
  })();

  return (
    <section className="rounded-card border border-ink-600 bg-ink-850 p-5">
      <h2 className="prose-display text-lg">New run</h2>
      <p className="mt-1 mb-4 text-sm text-paper-400">
        One raw prompt against one registered model, with every input and control recorded. Submitting spends real
        render budget.
      </p>
      {prefill !== null ? (
        <p className="mb-4 rounded-card border border-accent-500/40 bg-ink-950/40 px-3 py-2 text-xs text-paper-400">
          {"Duplicated from run "}
          <code className="break-all">{prefill.sourceRunId}</code>
          {" — the same request, seed included. Change one thing; nothing runs until you submit."}
        </p>
      ) : null}
      {prefillModelMissing ? (
        <p className="mb-4 text-xs text-danger-300" role="alert">
          {`The original ran ${prefill?.modelSlug ?? ""}, which is no longer registered — choose a model to run this `}
          {"request at all, and read the result as a different arm."}
        </p>
      ) : null}
      {versionDrift ? (
        <div className="mb-4 flex flex-col gap-2 rounded-card border border-danger-500/40 bg-ink-950/40 px-3 py-2">
          <p className="text-xs text-danger-300" role="alert">
            {`The original pinned version ${prefill?.requestedVersionId ?? ""}, but this model now pins `}
            {`${pinnedVersion ?? ""} — running the current one is a different arm, not a same-model comparison.`}
          </p>
          <Field label="Provider version" hint="Replay needs the original run's recorded capability record; without it the run refuses rather than guessing.">
            {(id) => (
              <Select
                id={id}
                value={versionPolicy}
                onChange={(e) => setVersionPolicy(e.target.value as ImageGeneratorVersionPolicy)}
              >
                <option value="current">Use the current registered version</option>
                <option value="captured">Replay the captured version</option>
              </Select>
            )}
          </Field>
        </div>
      ) : null}
      {prefillDrift.length > 0 ? (
        <p className="mb-4 text-xs text-danger-300" role="alert">
          {`These duplicated values no longer apply on the current version, so they will not be sent: `}
          {`${prefillDrift.join(", ")}.`}
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
                {selectedModel?.operatorWarning ? (
                  <p className="text-xs text-paper-500">{selectedModel.operatorWarning}</p>
                ) : null}
                {models.error !== null ? (
                  <div className="flex items-center gap-2">
                    <p className="text-xs text-danger-300" role="alert">
                      {models.error.message}
                    </p>
                    <Button size="sm" variant="quiet" onClick={() => models.reload()}>
                      Retry
                    </Button>
                  </div>
                ) : null}
              </>
            )}
          </Field>
          {selectedModel !== null ? (
            <Field
              label="What this model can take"
              hint="Probed capability facts — they decide which sections appear below."
            >
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
            <Textarea
              id={id}
              rows={6}
              value={prompt}
              maxLength={IMAGE_GENERATOR_PROMPT_MAX}
              spellCheck={false}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Exactly what the model should be asked for."
            />
          )}
        </Field>

        {modelCanEdit && capacity !== null && capacity > 0 ? (
          <div className="flex flex-col gap-2">
            <h3 className="text-xs font-medium tracking-wide text-paper-400 uppercase">Primary references</h3>
            <p className="text-xs text-paper-500">
              {`Ordered images sent through the model’s numbered reference input — up to ${String(capacity)} here `}
              {`(the model takes ${String(modelCapacity ?? 0)}; the app caps freeform runs at ${String(IMAGE_GENERATOR_MAX_PRIMARY)}). `}
              {"The optional purpose is recorded on the run for provenance only: every primary reference is sent "}
              {"under the neutral reference role, and a purpose changes nothing about the request."}
            </p>
            {primaryRows.map((row, index) => (
              <div key={row.key} className="flex flex-col gap-2 rounded-card border border-ink-700 bg-ink-950/40 p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[11px] tracking-wide text-paper-500 uppercase">
                    Image {index + 1}
                  </span>
                  {slotThumb(row.imageId, `Reference ${String(index + 1)}`)}
                  <Select
                    value={row.purpose}
                    onChange={(e) => setRowPurpose(row.key, e.target.value as PurposeRole | "")}
                    className="w-52"
                    aria-label={`Recorded purpose for reference ${String(index + 1)}`}
                  >
                    <option value="">— No recorded purpose —</option>
                    {PURPOSE_ROLES.map((role) => (
                      <option key={role} value={role}>
                        {imageGeneratorRoleLabel(role)}
                      </option>
                    ))}
                  </Select>
                  <div className="ml-auto flex items-center gap-1">
                    <Button size="sm" variant="quiet" disabled={index === 0} onClick={() => moveRow(index, -1)}>
                      Up
                    </Button>
                    <Button
                      size="sm"
                      variant="quiet"
                      disabled={index === primaryRows.length - 1}
                      onClick={() => moveRow(index, 1)}
                    >
                      Down
                    </Button>
                    <Button
                      size="sm"
                      variant="quiet"
                      onClick={() =>
                        setOpenPicker(openPicker === `primary:${String(row.key)}` ? null : `primary:${String(row.key)}`)
                      }
                    >
                      {row.imageId === null ? "Choose image" : "Change image"}
                    </Button>
                    <Button size="sm" variant="quiet" onClick={() => removeRow(row.key)}>
                      Remove
                    </Button>
                  </div>
                </div>
                {openPicker === `primary:${String(row.key)}` ? (
                  <OwnedImagePicker
                    label={`Reference ${String(index + 1)} image`}
                    hint="Any of your ready images. Clicking the chosen tile again clears it."
                    value={row.imageId}
                    onChange={(imageId) => setRowImage(row.key, imageId)}
                  />
                ) : null}
              </div>
            ))}
            {primaryRows.length < capacity ? (
              <div>
                <Button size="sm" onClick={addRow}>
                  Add reference
                </Button>
              </div>
            ) : null}
            {overCapacity ? (
              <p className="text-xs text-danger-300" role="alert">
                {`${String(primaryRows.length)} references exceed this model’s capacity of ${String(capacity)}. `}
                {"Nothing is trimmed for you — remove rows until the request fits."}
              </p>
            ) : null}
          </div>
        ) : null}

        {dedicatedSlots.length > 0 ? (
          <div className="flex flex-col gap-2">
            <h3 className="text-xs font-medium tracking-wide text-paper-400 uppercase">Dedicated structural inputs</h3>
            <p className="text-xs text-paper-500">
              {"Inputs the probed version declares its own fields for — they do not spend primary-reference "}
              {"capacity, and the provider field behind each slot is a probe fact, never typed here."}
            </p>
            {dedicatedSlots.map((slot) => {
              const imageId = dedicated[slot.role] ?? null;
              const pickerKey = `dedicated:${slot.role}`;
              return (
                <div key={slot.role} className="flex flex-col gap-2 rounded-card border border-ink-700 bg-ink-950/40 p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[11px] tracking-wide text-paper-500 uppercase">
                      {imageGeneratorRoleLabel(slot.role)}
                    </span>
                    {slot.binding.required ? <Tag tone="accent">required</Tag> : <Tag>optional</Tag>}
                    <code className="text-[10px] text-paper-600">{slot.binding.field}</code>
                    {slotThumb(imageId, `${imageGeneratorRoleLabel(slot.role)} input`)}
                    <div className="ml-auto flex items-center gap-1">
                      <Button
                        size="sm"
                        variant="quiet"
                        onClick={() => setOpenPicker(openPicker === pickerKey ? null : pickerKey)}
                      >
                        {imageId === null ? "Choose image" : "Change image"}
                      </Button>
                      {imageId !== null ? (
                        <Button size="sm" variant="quiet" onClick={() => setDedicatedImage(slot.role, null)}>
                          Clear
                        </Button>
                      ) : null}
                    </div>
                  </div>
                  {openPicker === pickerKey ? (
                    <OwnedImagePicker
                      label={`${imageGeneratorRoleLabel(slot.role)} image`}
                      hint="Any of your ready images — a lab fixture is usually the honest choice for a structural map."
                      value={imageId}
                      onChange={(picked) => setDedicatedImage(slot.role, picked)}
                    />
                  ) : null}
                </div>
              );
            })}
            {missingRequiredDedicated.length > 0 ? (
              <p className="text-xs text-danger-300" role="alert">
                {`The model requires ${missingRequiredDedicated
                  .map((slot) => imageGeneratorRoleLabel(slot.role))
                  .join(", ")} — the run is held until each required slot has an image.`}
              </p>
            ) : null}
          </div>
        ) : null}

        {selectedModel !== null &&
        (bindings.seed !== undefined ||
          bindings.negativePrompt !== undefined ||
          bindings.guidance !== undefined ||
          bindings.steps !== undefined ||
          bindings.editStrength !== undefined ||
          resolutionTierOffered ||
          bindings.thinkingMode !== undefined ||
          shapeOptions.length > 0 ||
          loraBound) ? (
          <div className="flex flex-col gap-3">
            <h3 className="text-xs font-medium tracking-wide text-paper-400 uppercase">Controls</h3>
            <p className="text-xs text-paper-500">
              {"Only what the active probed version binds is offered, and everything starts unset — the provider’s "}
              {"own defaults rule until you change a value. An explicitly set value that cannot be represented "}
              {"refuses the run before any spend rather than being dropped."}
            </p>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {bindings.seed !== undefined ? (
                <div className="flex flex-col gap-1">
                  <NumberField
                    label="Seed"
                    hint="Blank is random. A set seed is what makes a duplicate reproducible."
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
                    label="Guidance"
                    hint={bindingRangeHint(bindings.guidance, "Blank is the provider default.")}
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
                    label="Steps"
                    hint={bindingRangeHint(bindings.steps, "Blank is the provider default.")}
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
                    label="Edit strength"
                    hint={bindingRangeHint(bindings.editStrength, "How far the render may move from its source; blank is the provider default.")}
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
                <Field label="Thinking mode" hint="Unchecked is the provider default — the switch is only sent when ticked.">
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
              {shapeOptions.length > 0 ? (
                <Field
                  label="Output shape"
                  hint="Blank sends no shape at all — the model answers at its own default, and nothing is cropped afterwards."
                >
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
              {resolutionTierOffered ? (
                <Field label="Resolution" hint="Blank is the provider default tier.">
                  {(id) => (
                    <Select
                      id={id}
                      value={resolution}
                      onChange={(e) => setResolution(e.target.value as ImageResolutionTier | "")}
                    >
                      <option value="">— Provider default —</option>
                      {imageResolutionTiers
                        .filter(
                          (tier) =>
                            bindings.resolutionTier?.enumValues === undefined ||
                            bindings.resolutionTier.enumValues.includes(tier),
                        )
                        .map((tier) => (
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
                  end to end (spec §"Rulings the build settled"; rationale on
                  the controls assembly above). */}
            </div>
            {bindings.negativePrompt !== undefined ? (
              <Field label="Negative prompt" hint="What the render should avoid. Blank sends nothing.">
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
                    label="LoRA"
                    hint={
                      enabledLoras.length === 0
                        ? "None in the library yet. Curate one under Settings → Image models — only enabled rows are offered here."
                        : "Optional. Blends a curated weights file into this run — the library row decides which models and strengths it may run at."
                    }
                  >
                    {(id) => (
                      <Select id={id} value={loraId} onChange={(e) => setLoraId(e.target.value)}>
                        <option value="">— None —</option>
                        {enabledLoras.map((lora) => (
                          <option key={lora.id} value={lora.id}>
                            {lora.label}
                          </option>
                        ))}
                      </Select>
                    )}
                  </Field>
                  {selectedLora !== null ? (
                    <Field label="Scale">
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
                    {"A scale outside the band is refused before any spend rather than clamped."}
                  </p>
                ) : null}
                {loraModelMismatch ? (
                  <p className="text-xs text-danger-300">
                    {`These weights are not curated for ${baseImageModelSlug(selectedModel.slug)} — as it stands the `}
                    {"run is refused before any spend. Pick a listed model, or widen the row in the LoRA library."}
                  </p>
                ) : null}
              </>
            ) : null}
          </div>
        ) : null}

        {advancedInputs.length > 0 ? (
          <div className="flex flex-col gap-3">
            <h3 className="text-xs font-medium tracking-wide text-paper-400 uppercase">Advanced model inputs</h3>
            <p className="text-xs text-paper-500">
              {"Provider-specific fields the probe described that Vesper does not normalize. Unset is omitted from "}
              {"the payload; an unknown or reserved value is refused before any spend rather than passed through."}
            </p>
            <div className="grid gap-4 sm:grid-cols-2">
              {advancedInputs.map((descriptor) => (
                <AdvancedInputField
                  key={descriptor.field}
                  descriptor={descriptor}
                  value={providerValues[descriptor.field] ?? ""}
                  error={advancedErrors[descriptor.field]}
                  onChange={(value) =>
                    setProviderValues((current) => ({ ...current, [descriptor.field]: value }))
                  }
                />
              ))}
            </div>
          </div>
        ) : null}
        {reservedFields.length > 0 ? (
          <details className="text-xs text-paper-500">
            <summary className="cursor-pointer">
              {`${String(reservedFields.length)} field(s) reserved by the render path`}
            </summary>
            <p className="mt-1">
              {`${reservedFields.join(", ")} — owned by prompt, reference, aspect, control, or dedicated-input `}
              {"plumbing, so they are not editable here."}
            </p>
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
                {pinnedVersion !== null ? (
                  <span>{`pinned to ${pinnedVersion}`}</span>
                ) : (
                  <span className="text-danger-300">no pinned version — refused before any spend</span>
                )}
              </li>
              <li>
                <span className="text-paper-500">Operation —</span>{" "}
                {operation === "generate"
                  ? "prompt-only (text to image)"
                  : `edit, ${String(primaryCount)} of ${String(capacity ?? 0)} primary reference slot(s)`}
                {!operationSupported ? (
                  <span className="text-danger-300">
                    {operation === "generate"
                      ? " — this model cannot generate from text alone; add a primary reference"
                      : " — this model takes no primary reference image"}
                  </span>
                ) : null}
              </li>
              {filledDedicated.length > 0 ? (
                <li>
                  <span className="text-paper-500">Dedicated —</span>{" "}
                  {filledDedicated.map((slot) => imageGeneratorRoleLabel(slot.role)).join(", ")}
                </li>
              ) : null}
              <li>
                <span className="text-paper-500">Shape —</span>{" "}
                {aspect === "" ? "the model’s own default; nothing is cropped afterwards" : aspect}
              </li>
              <li>
                <span className="text-paper-500">Controls —</span>{" "}
                {controlLines.length > 0 ? controlLines.join(" · ") : "none set; the model’s own defaults"}
              </li>
              {advancedLines.length > 0 ? (
                <li>
                  <span className="text-paper-500">Advanced —</span> {advancedLines.join(" · ")}
                </li>
              ) : null}
              {prefill !== null ? (
                <li>
                  <span className="text-paper-500">Variant of —</span>{" "}
                  <code className="break-all">{prefill.sourceRunId}</code>
                </li>
              ) : null}
            </ul>
          )}
        </div>

        <div className="flex items-center gap-3">
          <Button variant="primary" busy={submitting} disabled={!ready} onClick={() => void submit()}>
            Run
          </Button>
          <p className="text-[11px] text-paper-500">
            The run is refused before any spend if the model’s exact provider version cannot be pinned.
          </p>
        </div>
      </div>
    </section>
  );
}
