"use client";

import { useState } from "react";
import {
  imageProfileOperations,
  imageProfileTasks,
  imagePromptStrategies,
  imageReferencePolicySchema,
  imageResolutionTiers,
  imageSeedPolicies,
  type ImageControlDefaults,
  type ImageModelProfileCreateRequest,
  type ImageProfileOperation,
  type ImageProfileTask,
  type ImagePromptStrategy,
  type ImageReferencePolicy,
  type ImageResolutionTier,
  type ImageSeedPolicy,
} from "@vesper/image-core";
import {
  adminImageModelProfilesApi,
  imageLorasApi,
  type ImageModel,
  type ImageModelProfile,
} from "@/lib/client/api";
import { useAsyncData } from "@/components/hooks/use-async";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Tag } from "@/components/ui/tag";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import { CheckOption, NumberField, TASK_LABELS, TextField } from "./image-admin-shared";

/**
 * The task profiles nested under one model card (image-model-capabilities.spec.md
 * §"Admin UI"): list, create, edit, switch off, remove. A profile says how
 * Vesper should USE this model for one job, so the section lives inside the
 * model's own card rather than in a page-level list.
 *
 * Form design decisions, deliberate:
 *
 * - **Reference policy is a validated JSON textarea**, not per-role
 *   multi-selects. The policy is four role lists plus per-role caps plus an
 *   identity strategy; a control per member would be a page of checkboxes for a
 *   structure operators edit rarely and by example. The textarea is validated
 *   through `imageReferencePolicySchema` BEFORE save, so it refuses what the
 *   server would refuse, and an empty box is the inert policy.
 * - **The curated common controls are structured inputs** (the spec's list:
 *   guidance, steps, negative prompt, edit strength, resolution tier,
 *   width/height, thinking mode, seed policy) — blank means "not stored", which
 *   is what keeps a default from being sent uninvited.
 * - **`providerOverrides` is the advanced JSON escape hatch.** JSON shape is
 *   checked here; the KEYS are the service's judgment against the model's
 *   probed field list (empty probe fails closed), and its refusal message
 *   renders beside the field rather than in a toast that outlives the form.
 */

const TIMEOUT_HINT = "Blank uses the environment budget. 30–900 seconds, the table's own bounds.";

/** One profile row's summary line: the facts the spec's card lists. */
function profileSummary(profile: ImageModelProfile): string {
  const timeout = profile.timeoutMs === null ? "default budget" : `${String(profile.timeoutMs / 1000)}s`;
  return `${TASK_LABELS[profile.task]} · ${profile.operation} · ${profile.promptStrategy} · timeout ${timeout}`;
}

export function ImageModelProfilesSection({
  model,
  profiles,
  onChanged,
}: {
  model: ImageModel;
  /** This model's profiles, in stored sort order (the page groups the one fetch). */
  profiles: ImageModelProfile[];
  /** Silent registry refetch after any mutation — the page owns the one fetch. */
  onChanged: () => void;
}) {
  const toast = useToast();
  const [editing, setEditing] = useState<ImageModelProfile | "new" | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ImageModelProfile | null>(null);

  const toggleEnabled = async (profile: ImageModelProfile) => {
    setBusyId(profile.id);
    const result = await adminImageModelProfilesApi.update(model.id, profile.id, { enabled: !profile.enabled });
    setBusyId(null);
    if (!result.ok) {
      toast.push({ title: "Update failed", description: result.error.message, tone: "error" });
      return;
    }
    onChanged();
  };

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    setBusyId(pendingDelete.id);
    const result = await adminImageModelProfilesApi.remove(model.id, pendingDelete.id);
    setBusyId(null);
    setPendingDelete(null);
    if (!result.ok) {
      toast.push({ title: "Delete failed", description: result.error.message, tone: "error" });
      return;
    }
    toast.push({ title: "Profile removed", tone: "success" });
    onChanged();
  };

  return (
    <div className="mt-3 border-t border-ink-600/60 pt-3">
      <div className="flex items-center justify-between gap-3">
        <h4 className="text-[11px] font-medium tracking-wide text-paper-400 uppercase">Profiles</h4>
        {editing === null ? (
          <Button size="sm" variant="quiet" onClick={() => setEditing("new")}>
            Add profile
          </Button>
        ) : null}
      </div>

      {editing !== null ? (
        <ImageModelProfileForm
          key={editing === "new" ? "new" : editing.id}
          model={model}
          profile={editing === "new" ? null : editing}
          onCancel={() => setEditing(null)}
          onSaved={(title) => {
            setEditing(null);
            toast.push({ title, tone: "success" });
            onChanged();
          }}
        />
      ) : null}

      <div className="mt-2 flex flex-col gap-2">
        {profiles.map((profile) => (
          <div key={profile.id} className="rounded-card border border-ink-600 bg-ink-900/40 px-3 py-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm text-paper-200">{profile.label}</span>
                  <code className="text-[11px] text-paper-600">{profile.key}</code>
                  {profile.builtin ? <Tag>built-in</Tag> : null}
                  {profile.isDefault ? <Tag tone="ok">{profile.task} default</Tag> : null}
                  {profile.enabled ? null : <Tag>switched off</Tag>}
                </div>
                <p className="mt-0.5 text-[11px] text-paper-600">{profileSummary(profile)}</p>
              </div>
              <div className="flex shrink-0 gap-2">
                <Button size="sm" variant="quiet" onClick={() => setEditing(profile)}>
                  Edit
                </Button>
                <Button
                  size="sm"
                  variant="quiet"
                  busy={busyId === profile.id}
                  onClick={() => void toggleEnabled(profile)}
                  title="A switched-off profile leaves every picker; stored picks degrade to the task default"
                >
                  {profile.enabled ? "Switch off" : "Switch on"}
                </Button>
                <Button size="sm" variant="quiet" onClick={() => setPendingDelete(profile)}>
                  Remove
                </Button>
              </div>
            </div>
          </div>
        ))}
        {profiles.length === 0 ? (
          <p className="text-[11px] text-paper-600">
            No profiles. Without one, no task can choose this model — resolution only runs on profiles.
          </p>
        ) : null}
      </div>

      <Dialog
        open={pendingDelete !== null}
        onClose={() => setPendingDelete(null)}
        title={`Remove ${pendingDelete?.label ?? "this profile"}?`}
        footer={
          <>
            <Button onClick={() => setPendingDelete(null)}>Cancel</Button>
            <Button variant="danger" busy={busyId === pendingDelete?.id} onClick={() => void confirmDelete()}>
              Remove
            </Button>
          </>
        }
      >
        It disappears from every picker. Anything still storing it falls back to the task’s default profile —
        including when this was the default: the next render degrades to the next offered profile, by design.
      </Dialog>
    </div>
  );
}

/** Blank means "not stored"; anything else must be the number it claims. */
function parseOptionalNumber(text: string): { ok: true; value: number | undefined } | { ok: false } {
  const trimmed = text.trim();
  if (trimmed === "") return { ok: true, value: undefined };
  const value = Number(trimmed);
  return Number.isFinite(value) ? { ok: true, value } : { ok: false };
}

/**
 * Create and edit in one form (the LoRA library's idiom): the two requests
 * differ only in which fields may be absent, and a second spelling of these
 * rules is how a row saves through one path and is refused by the other.
 * Seeded from the row at MOUNT; the caller keys this component by row id.
 */
function ImageModelProfileForm({
  model,
  profile,
  onCancel,
  onSaved,
}: {
  model: ImageModel;
  profile: ImageModelProfile | null;
  onCancel: () => void;
  onSaved: (title: string) => void;
}) {
  // The library list feeds the optional-LoRA picker. Fetched here rather than
  // page-level because the form is the only consumer and mounts on demand.
  const loras = useAsyncData(() => imageLorasApi.list(), []);

  const defaults = profile?.controlDefaults;
  const [label, setLabel] = useState(profile?.label ?? "");
  const [key, setKey] = useState(profile?.key ?? "");
  const [task, setTask] = useState<ImageProfileTask>(profile?.task ?? "portrait");
  const [operation, setOperation] = useState<ImageProfileOperation>(profile?.operation ?? "generate");
  const [strategy, setStrategy] = useState<ImagePromptStrategy>(profile?.promptStrategy ?? "text_to_image_description");
  const [timeoutSeconds, setTimeoutSeconds] = useState(
    profile?.timeoutMs == null ? "" : String(profile.timeoutMs / 1000),
  );
  const [policyText, setPolicyText] = useState(
    profile ? JSON.stringify(profile.referencePolicy, null, 2) : "",
  );
  const [seedPolicy, setSeedPolicy] = useState<ImageSeedPolicy>(defaults?.seedPolicy ?? "random");
  const [guidance, setGuidance] = useState(defaults?.guidance === undefined ? "" : String(defaults.guidance));
  const [steps, setSteps] = useState(defaults?.steps === undefined ? "" : String(defaults.steps));
  const [negativePrompt, setNegativePrompt] = useState(defaults?.negativePrompt ?? "");
  const [editStrength, setEditStrength] = useState(
    defaults?.editStrength === undefined ? "" : String(defaults.editStrength),
  );
  const [resolution, setResolution] = useState<"" | ImageResolutionTier>(defaults?.resolution ?? "");
  const [width, setWidth] = useState(defaults?.width === undefined ? "" : String(defaults.width));
  const [height, setHeight] = useState(defaults?.height === undefined ? "" : String(defaults.height));
  const [thinkingMode, setThinkingMode] = useState<"" | "on" | "off">(
    defaults?.thinkingMode === undefined ? "" : defaults.thinkingMode ? "on" : "off",
  );
  const loraDefault = defaults?.lora;
  const [loraId, setLoraId] = useState(loraDefault?.id ?? "");
  const [loraScale, setLoraScale] = useState(loraDefault?.scale === undefined ? "" : String(loraDefault.scale));
  const [overridesText, setOverridesText] = useState(
    profile && Object.keys(profile.providerOverrides).length > 0
      ? JSON.stringify(profile.providerOverrides, null, 2)
      : "",
  );
  const [enabled, setEnabled] = useState(profile?.enabled ?? true);
  const [isDefault, setIsDefault] = useState(profile?.isDefault ?? false);
  const [sort, setSort] = useState(String(profile?.sort ?? 100));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    // Everything checked here is a rule the SERVER also holds; checking first
    // keeps the failure a sentence beside the field instead of a 400 round-trip.
    const refuse = (message: string) => {
      setError(message);
    };

    const timeout = parseOptionalNumber(timeoutSeconds);
    if (!timeout.ok) return refuse("Timeout is a number of seconds, or blank for the default budget.");
    if (timeout.value !== undefined && (timeout.value < 30 || timeout.value > 900)) {
      return refuse("Timeout sits between 30 and 900 seconds — the table's own bounds.");
    }

    let policy: ImageReferencePolicy;
    try {
      const raw: unknown = policyText.trim() === "" ? {} : JSON.parse(policyText);
      const parsed = imageReferencePolicySchema.safeParse(raw);
      if (!parsed.success) {
        return refuse(`Reference policy: ${parsed.error.issues[0]?.message ?? "does not match the policy shape"}`);
      }
      policy = parsed.data;
    } catch {
      return refuse("Reference policy is not valid JSON.");
    }

    let overrides: Record<string, unknown>;
    try {
      const raw: unknown = overridesText.trim() === "" ? {} : JSON.parse(overridesText);
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        return refuse("Provider overrides are a JSON object of provider input fields.");
      }
      overrides = raw as Record<string, unknown>;
    } catch {
      return refuse("Provider overrides are not valid JSON.");
    }

    const numbers = {
      guidance: parseOptionalNumber(guidance),
      steps: parseOptionalNumber(steps),
      editStrength: parseOptionalNumber(editStrength),
      width: parseOptionalNumber(width),
      height: parseOptionalNumber(height),
      loraScale: parseOptionalNumber(loraScale),
      sort: parseOptionalNumber(sort),
    };
    for (const [name, parsed] of Object.entries(numbers)) {
      if (!parsed.ok) return refuse(`${name} is a number, or blank to leave it unset.`);
    }
    if (!numbers.guidance.ok || !numbers.steps.ok || !numbers.editStrength.ok) return;
    if (!numbers.width.ok || !numbers.height.ok || !numbers.loraScale.ok || !numbers.sort.ok) return;

    const controlDefaults: ImageControlDefaults = {
      seedPolicy,
      ...(numbers.guidance.value === undefined ? {} : { guidance: numbers.guidance.value }),
      ...(numbers.steps.value === undefined ? {} : { steps: numbers.steps.value }),
      ...(negativePrompt.trim() === "" ? {} : { negativePrompt: negativePrompt.trim() }),
      ...(numbers.editStrength.value === undefined ? {} : { editStrength: numbers.editStrength.value }),
      ...(resolution === "" ? {} : { resolution }),
      ...(numbers.width.value === undefined ? {} : { width: numbers.width.value }),
      ...(numbers.height.value === undefined ? {} : { height: numbers.height.value }),
      ...(thinkingMode === "" ? {} : { thinkingMode: thinkingMode === "on" }),
      ...(loraId === ""
        ? {}
        : { lora: { id: loraId, ...(numbers.loraScale.value === undefined ? {} : { scale: numbers.loraScale.value }) } }),
    };

    const body: ImageModelProfileCreateRequest = {
      key: key.trim(),
      label: label.trim(),
      task,
      operation,
      promptStrategy: strategy,
      referencePolicy: policy,
      controlDefaults,
      providerOverrides: overrides,
      timeoutMs: timeout.value === undefined ? null : Math.round(timeout.value * 1000),
      enabled,
      isDefault,
      sort: numbers.sort.value ?? 100,
    };

    setError(null);
    setSaving(true);
    const result =
      profile === null
        ? await adminImageModelProfilesApi.create(model.id, body)
        : await adminImageModelProfilesApi.update(model.id, profile.id, body);
    setSaving(false);
    if (!result.ok) {
      // The service's refusals (eligibility, override keys, duplicate key,
      // second default) land here, beside the fields they name.
      setError(result.error.message);
      return;
    }
    onSaved(profile === null ? `Added ${result.data.profile.label}` : `Saved ${result.data.profile.label}`);
  };

  return (
    <div className="mt-3 rounded-card border border-accent-500/30 bg-ink-950/40 p-4">
      <h4 className="text-xs font-medium tracking-wide text-paper-400 uppercase">
        {profile === null ? `New profile on ${model.label}` : `Editing ${profile.label}`}
      </h4>

      <div className="mt-3 flex flex-col gap-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField
            label="Label"
            hint="What the pickers show."
            value={label}
            placeholder="Scene (2K, fast)"
            maxLength={200}
            onChange={setLabel}
          />
          <TextField
            label="Key"
            hint="Stable machine key, unique within this model. Lowercase, dashes."
            value={key}
            placeholder="scene-fast"
            maxLength={100}
            onChange={setKey}
          />
        </div>

        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Task" hint="The job this profile is offered for.">
            {(id) => (
              <Select id={id} value={task} onChange={(e) => setTask(e.target.value as ImageProfileTask)}>
                {imageProfileTasks.map((entry) => (
                  <option key={entry} value={entry}>
                    {TASK_LABELS[entry]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Operation" hint="From text, or from an existing image. Checked against the model.">
            {(id) => (
              <Select id={id} value={operation} onChange={(e) => setOperation(e.target.value as ImageProfileOperation)}>
                {imageProfileOperations.map((entry) => (
                  <option key={entry} value={entry}>
                    {entry}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Prompt strategy" hint="A registered strategy, never free text.">
            {(id) => (
              <Select id={id} value={strategy} onChange={(e) => setStrategy(e.target.value as ImagePromptStrategy)}>
                {imagePromptStrategies.map((entry) => (
                  <option key={entry} value={entry}>
                    {entry}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>

        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Timeout (seconds)" hint={TIMEOUT_HINT}>
            {(id) => (
              <Input
                id={id}
                type="number"
                min={30}
                max={900}
                value={timeoutSeconds}
                placeholder="default"
                onChange={(e) => setTimeoutSeconds(e.target.value)}
              />
            )}
          </Field>
          <Field label="Seed policy" hint="A policy, never a stored number — a stored seed would be a pin.">
            {(id) => (
              <Select id={id} value={seedPolicy} onChange={(e) => setSeedPolicy(e.target.value as ImageSeedPolicy)}>
                {imageSeedPolicies.map((entry) => (
                  <option key={entry} value={entry}>
                    {entry}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <NumberField label="Sort" hint="Picker order; seeded rows use 10–60." value={sort} placeholder="unset" onChange={setSort} />
        </div>

        <Field
          label="Reference policy (JSON)"
          hint="Allowed/required roles, role order, per-role caps, identity strategy. Blank is the inert policy. Validated before save."
        >
          {(id) => (
            <Textarea
              id={id}
              rows={4}
              value={policyText}
              spellCheck={false}
              placeholder={'{ "allowedRoles": ["identity", "location"], "roleOrder": ["identity", "location"] }'}
              onChange={(e) => setPolicyText(e.target.value)}
            />
          )}
        </Field>

        <div className="grid gap-4 sm:grid-cols-3">
          <NumberField label="Guidance" value={guidance} step={0.1} placeholder="unset" onChange={setGuidance} />
          <NumberField label="Steps" value={steps} placeholder="unset" onChange={setSteps} />
          <NumberField
            label="Edit strength"
            hint="0–1; how far an edit may move from the source."
            value={editStrength}
            step={0.05}
            placeholder="unset"
            onChange={setEditStrength}
          />
          <Field label="Resolution tier" hint="Custom means the width/height pair is the request.">
            {(id) => (
              <Select
                id={id}
                value={resolution}
                onChange={(e) => setResolution(e.target.value as "" | ImageResolutionTier)}
              >
                <option value="">unset</option>
                {imageResolutionTiers.map((entry) => (
                  <option key={entry} value={entry}>
                    {entry}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <NumberField label="Width" value={width} placeholder="unset" onChange={setWidth} />
          <NumberField label="Height" value={height} placeholder="unset" onChange={setHeight} />
        </div>

        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Thinking mode" hint="Sent only when the model's probed bindings carry it.">
            {(id) => (
              <Select id={id} value={thinkingMode} onChange={(e) => setThinkingMode(e.target.value as "" | "on" | "off")}>
                <option value="">unset</option>
                <option value="on">on</option>
                <option value="off">off</option>
              </Select>
            )}
          </Field>
          <Field label="LoRA" hint="A library row; compatibility is judged at render time.">
            {(id) => (
              <Select id={id} value={loraId} onChange={(e) => setLoraId(e.target.value)}>
                <option value="">none</option>
                {(loras.data ?? []).map((lora) => (
                  <option key={lora.id} value={lora.id}>
                    {lora.label}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <NumberField
            label="LoRA scale"
            hint="Blank uses the row's default scale."
            value={loraScale}
            step={0.05}
            placeholder="unset"
            onChange={setLoraScale}
          />
        </div>

        <Field label="Negative prompt" hint="Stored default; sent only where the model binds one.">
          {(id) => (
            <Textarea
              id={id}
              rows={2}
              maxLength={2000}
              value={negativePrompt}
              onChange={(e) => setNegativePrompt(e.target.value)}
            />
          )}
        </Field>

        <Field
          label="Provider overrides (JSON, advanced)"
          hint="Raw provider input fields merged last. Keys are validated against this model's probed field list — an unprobed model refuses all of them (re-probe first), and reserved fields (prompt, references, aspect, version, safety) are never writable."
        >
          {(id) => (
            <Textarea
              id={id}
              rows={3}
              value={overridesText}
              spellCheck={false}
              placeholder={'{ "go_fast": true }'}
              onChange={(e) => setOverridesText(e.target.value)}
            />
          )}
        </Field>

        <div className="flex flex-wrap gap-x-6 gap-y-2">
          <CheckOption
            label="Enabled"
            checked={enabled}
            title="A switched-off profile leaves every picker; stored picks degrade to the task default"
            onToggle={() => setEnabled(!enabled)}
          />
          <CheckOption
            label={`Global default for ${TASK_LABELS[task]}`}
            checked={isDefault}
            title="At most one enabled default per task — saving a second is refused until the first is unticked"
            onToggle={() => setIsDefault(!isDefault)}
          />
        </div>

        {error !== null ? (
          <p className="text-xs text-danger-300" role="alert">
            {error}
          </p>
        ) : null}

        <div className="flex items-center gap-3">
          <Button
            variant="primary"
            busy={saving}
            disabled={label.trim() === "" || key.trim() === ""}
            onClick={() => void save()}
          >
            {profile === null ? "Add profile" : "Save changes"}
          </Button>
          <Button onClick={onCancel}>Cancel</Button>
        </div>
      </div>
    </div>
  );
}
