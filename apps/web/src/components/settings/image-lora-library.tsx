"use client";

import { useState } from "react";
import { type ImageProfileTask, imageProfileTasks } from "@vesper/image-core";
import {
  IMAGE_LORA_MAX_SCALE,
  IMAGE_LORA_MAX_TRIGGER_WORDS,
  IMAGE_LORA_MIN_SCALE,
  imageLoraLocatorTypes,
  imageLorasApi,
  redactImageLoraLocator,
  type ImageLora,
  type ImageLoraCreateRequest,
  type ImageLoraLocatorType,
  type ImageModel,
} from "@/lib/client/api";
import { useAsyncData } from "@/components/hooks/use-async";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { ErrorState } from "@/components/ui/error-state";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Tag } from "@/components/ui/tag";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import { CheckOption, NumberField, TASK_LABELS, TextField } from "./image-admin-shared";

/**
 * The curated LoRA library, on the image-models settings page
 * (image-model-capabilities.spec.md §`image_loras`).
 *
 * A LoRA is unlike every other setting on this page: the value stored is not a
 * number a model declared a range for, it is a POINTER to somebody else's weights
 * file, and the same pointer is a style transfer on one model and noise on
 * another. So a row here is a REVIEWED entry carrying its own compatibility
 * rules — which models, which versions, which tasks, and the strength band a
 * render may use it inside — and this section is where an operator writes them.
 *
 * Three things it deliberately does NOT do:
 *
 * - It never shows a raw locator. Direct URLs can carry signed query parameters,
 *   so every row displays `redactImageLoraLocator`'s answer, the same string the
 *   diagnostics record.
 * - It never widens a rule. The scale rails, the trigger-word cap and the locator
 *   shapes come from the contract the routes save under, so the form refuses what
 *   the server would refuse rather than discovering it in a 400.
 * - It never repairs a bad scale. A default outside the curated band is reported,
 *   not clamped — the same rule the render path keeps, for the same reason.
 *
 * Admin-gated by its host page, which is UX rather than security: the
 * `/api/admin/self/image-loras` routes 404 for everyone else.
 */

/** What the locator IS, in the words the provider's own documentation uses. */
function locatorTypeLabel(locatorType: ImageLoraLocatorType): string {
  switch (locatorType) {
    case "huggingface_repo":
      return "Hugging Face repository";
    case "https_url":
      return "Direct HTTPS URL";
  }
}

/** A locator of this type, shaped — the difference between the two, shown. */
function locatorPlaceholder(locatorType: ImageLoraLocatorType): string {
  switch (locatorType) {
    case "huggingface_repo":
      return "owner/repo";
    case "https_url":
      return "https://huggingface.co/owner/repo/resolve/main/weights.safetensors";
  }
}

/**
 * What a new row is offered: the two jobs this library exists for today — a
 * variant render, which is also what every lab finishing pass runs under, and a
 * scene. Ticked rather than assumed, so an operator sees the fail-closed rule
 * ("empty means none") with something sensible already in it.
 */
const DEFAULT_ALLOWED_TASKS: readonly ImageProfileTask[] = ["variant", "scene"];

/**
 * A slug without its `:version` pin — what `compatibleModelSlugs` is compared
 * against (the evaluator's own base-slug rule, `packages/image-core/src/loras/image-loras.ts`).
 * A pinned registry row must offer the bare slug here, or every row an operator
 * ticks would refuse the model they ticked it for.
 */
function baseModelSlug(slug: string): string {
  return slug.split(":", 1)[0] ?? slug;
}

/** Comma-separated text as a clean list: trimmed, blanks dropped. */
function splitList(text: string): string[] {
  return text
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export function ImageLoraLibrary({ models }: { models: ImageModel[] }) {
  const loras = useAsyncData(() => imageLorasApi.list(), []);
  const toast = useToast();

  // `null` while nothing is being written; `"new"` for a blank row, or the row
  // being edited. Keyed onto the form below so a different row mounts a FRESH
  // form — the lab page's own idiom, and the reason a half-edited row is never
  // rewritten under the operator's hands.
  const [editing, setEditing] = useState<ImageLora | "new" | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ImageLora | null>(null);

  const rows = loras.data ?? [];
  const modelSlugs = [...new Set(models.map((model) => baseModelSlug(model.slug)))].sort((a, b) => a.localeCompare(b));

  const toggleEnabled = async (lora: ImageLora) => {
    setBusyId(lora.id);
    const result = await imageLorasApi.update(lora.id, { enabled: !lora.enabled });
    setBusyId(null);
    if (!result.ok) {
      toast.push({ title: "Update failed", description: result.error.message, tone: "error" });
      return;
    }
    loras.reload({ silent: true });
  };

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    setBusyId(pendingDelete.id);
    const result = await imageLorasApi.remove(pendingDelete.id);
    setBusyId(null);
    setPendingDelete(null);
    if (!result.ok) {
      toast.push({ title: "Delete failed", description: result.error.message, tone: "error" });
      return;
    }
    toast.push({ title: "LoRA removed", tone: "success" });
    loras.reload({ silent: true });
  };

  return (
    <section className="mt-8 rounded-card border border-ink-600 bg-ink-850 p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="prose-display text-lg">LoRA library</h2>
          <p className="mt-1 text-sm text-paper-400">
            Reviewed weights files a render may blend in: where each one lives, which models and jobs it suits, and the
            strength band it is allowed to run inside.
          </p>
        </div>
        {editing === null ? (
          <Button variant="primary" onClick={() => setEditing("new")}>
            Add a LoRA
          </Button>
        ) : null}
      </div>

      {editing !== null ? (
        <ImageLoraForm
          key={editing === "new" ? "new" : editing.id}
          lora={editing === "new" ? null : editing}
          modelSlugs={modelSlugs}
          onCancel={() => setEditing(null)}
          onSaved={(title) => {
            setEditing(null);
            toast.push({ title, tone: "success" });
            loras.reload({ silent: true });
          }}
        />
      ) : null}

      {loras.error ? <ErrorState className="mt-4" error={loras.error} onRetry={() => loras.reload()} /> : null}
      {loras.loading && !loras.data ? <Skeleton className="mt-4 h-20 w-full" /> : null}

      <div className="mt-4 flex flex-col gap-3">
        {rows.map((lora) => (
          <ImageLoraRow
            key={lora.id}
            lora={lora}
            busy={busyId === lora.id}
            onEdit={() => setEditing(lora)}
            onToggle={() => void toggleEnabled(lora)}
            onDelete={() => setPendingDelete(lora)}
          />
        ))}
        {loras.data?.length === 0 ? (
          <p className="text-sm text-paper-500">
            No LoRAs yet. A row here lets a render blend in someone else’s trained weights — a style, a look, a finish —
            under compatibility rules you write once and every render then obeys.
          </p>
        ) : null}
      </div>

      <Dialog
        open={pendingDelete !== null}
        onClose={() => setPendingDelete(null)}
        title={`Remove ${pendingDelete?.label ?? "this LoRA"}?`}
        footer={
          <>
            <Button onClick={() => setPendingDelete(null)}>Cancel</Button>
            <Button variant="danger" busy={busyId === pendingDelete?.id} onClick={() => void confirmDelete()}>
              Remove
            </Button>
          </>
        }
      >
        It disappears from every picker. Existing images are untouched; anything still naming it refuses its next render
        with a reason rather than quietly sending different weights.
      </Dialog>
    </section>
  );
}

/** One library row: the rules it carries, and the three things you can do to it. */
function ImageLoraRow({
  lora,
  busy,
  onEdit,
  onToggle,
  onDelete,
}: {
  lora: ImageLora;
  busy: boolean;
  onEdit: () => void;
  onToggle: () => void;
  onDelete: () => void;
}) {
  const slugs =
    lora.compatibleModelSlugs.length === 0
      ? "no compatible models — this row cannot render"
      : lora.compatibleModelSlugs.join(", ");
  const versions =
    lora.compatibleVersionIds.length === 0
      ? "any version"
      : `${String(lora.compatibleVersionIds.length)} pinned version(s)`;
  const tasks =
    lora.allowedTasks.length === 0
      ? "no tasks — this row cannot render"
      : lora.allowedTasks.map((task) => TASK_LABELS[task]).join(", ");

  return (
    <div className="rounded-card border border-ink-600 bg-ink-900/40 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-medium text-paper-200">{lora.label}</h3>
            {lora.builtin ? <Tag>built-in</Tag> : null}
            <Tag tone={lora.enabled ? "ok" : "default"}>{lora.enabled ? "enabled" : "switched off"}</Tag>
          </div>
          {/* Redacted, always: a direct URL can carry signed query parameters, and
              this screen is one of the places the spec forbids them reaching. */}
          <p className="mt-0.5 font-mono text-[11px] break-all text-paper-500">
            {`${locatorTypeLabel(lora.locatorType)} · ${redactImageLoraLocator(lora.locator)}`}
          </p>
          <p className="mt-1 text-[11px] text-paper-600">
            {`scale ${String(lora.minimumScale)}–${String(lora.maximumScale)} (default ${String(lora.defaultScale)}) · ${slugs} · ${versions}`}
          </p>
          <p className="mt-0.5 text-[11px] text-paper-600">
            {`tasks: ${tasks} · ${String(lora.triggerWords.length)} trigger word(s)`}
            {lora.promptPrefix === null && lora.promptSuffix === null ? "" : " · prompt additions"}
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          <Button size="sm" variant="quiet" onClick={onEdit}>
            Edit
          </Button>
          <Button
            size="sm"
            variant="quiet"
            busy={busy}
            onClick={onToggle}
            title="A switched-off row refuses every render that names it, rather than being deleted"
          >
            {lora.enabled ? "Switch off" : "Switch on"}
          </Button>
          <Button size="sm" variant="quiet" onClick={onDelete}>
            Remove
          </Button>
        </div>
      </div>
    </div>
  );
}

/** An optional prompt addition. Blank means none, never "an addition saying nothing". */
function PromptField({
  label,
  hint,
  value,
  onChange,
}: {
  label: string;
  hint: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <Field label={label} hint={hint}>
      {(id) => (
        <Textarea id={id} rows={2} value={value} maxLength={2000} onChange={(e) => onChange(e.target.value)} />
      )}
    </Field>
  );
}

/**
 * Create and edit in one component, because the two are the same form: a create
 * request and an update request differ only in which fields may be absent, and a
 * second spelling of these rules is how a row saves through one path and is
 * refused by the other.
 *
 * Seeded from the row at MOUNT; the caller keys this component by row id, so a
 * different row is a different form rather than a rewrite of one being edited.
 */
function ImageLoraForm({
  lora,
  modelSlugs,
  onCancel,
  onSaved,
}: {
  lora: ImageLora | null;
  /** Base slugs of every registered model — what the compatibility list offers. */
  modelSlugs: string[];
  onCancel: () => void;
  onSaved: (title: string) => void;
}) {
  const [label, setLabel] = useState(lora?.label ?? "");
  const [locatorType, setLocatorType] = useState<ImageLoraLocatorType>(lora?.locatorType ?? "huggingface_repo");
  const [locator, setLocator] = useState(lora?.locator ?? "");
  const [slugs, setSlugs] = useState<string[]>([...(lora?.compatibleModelSlugs ?? [])]);
  const [slugDraft, setSlugDraft] = useState("");
  const [versionText, setVersionText] = useState((lora?.compatibleVersionIds ?? []).join(", "));
  const [minimumScale, setMinimumScale] = useState(String(lora?.minimumScale ?? 0.5));
  const [defaultScale, setDefaultScale] = useState(String(lora?.defaultScale ?? 1));
  const [maximumScale, setMaximumScale] = useState(String(lora?.maximumScale ?? 1.5));
  const [triggerText, setTriggerText] = useState((lora?.triggerWords ?? []).join(", "));
  const [promptPrefix, setPromptPrefix] = useState(lora?.promptPrefix ?? "");
  const [promptSuffix, setPromptSuffix] = useState(lora?.promptSuffix ?? "");
  const [tasks, setTasks] = useState<ImageProfileTask[]>([...(lora?.allowedTasks ?? DEFAULT_ALLOWED_TASKS)]);
  const [enabled, setEnabled] = useState(lora?.enabled ?? true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Registered models first, plus anything this row already names: a LoRA may be
  // curated BEFORE the model it is for is registered, and an edit that silently
  // dropped an unregistered slug would quietly narrow the row's rules.
  const slugOptions = [...new Set([...modelSlugs, ...slugs])].sort((a, b) => a.localeCompare(b));

  const toggleSlug = (slug: string) => {
    setSlugs((current) => (current.includes(slug) ? current.filter((entry) => entry !== slug) : [...current, slug]));
  };

  const addSlug = () => {
    const trimmed = slugDraft.trim();
    setSlugDraft("");
    if (trimmed === "" || slugs.includes(trimmed)) return;
    setSlugs((current) => [...current, trimmed]);
  };

  const toggleTask = (task: ImageProfileTask) => {
    setTasks((current) => (current.includes(task) ? current.filter((entry) => entry !== task) : [...current, task]));
  };

  const save = async () => {
    const minimum = Number.parseFloat(minimumScale);
    const preferred = Number.parseFloat(defaultScale);
    const maximum = Number.parseFloat(maximumScale);
    if (!Number.isFinite(minimum) || !Number.isFinite(preferred) || !Number.isFinite(maximum)) {
      setError("Every scale is a number.");
      return;
    }
    if (minimum < IMAGE_LORA_MIN_SCALE || maximum > IMAGE_LORA_MAX_SCALE) {
      setError(
        `Scales sit between ${String(IMAGE_LORA_MIN_SCALE)} and ${String(IMAGE_LORA_MAX_SCALE)} — the band the provider's own LoRA input declares.`,
      );
      return;
    }
    // Checked here rather than left to the 400, because this is the rule an
    // operator gets wrong: a default outside the band is refused at render time,
    // never clamped, so a row saved that way renders nothing at all.
    if (minimum > preferred || preferred > maximum) {
      setError("The default sits inside the curated band: minimum ≤ default ≤ maximum.");
      return;
    }
    const triggerWords = splitList(triggerText);
    if (triggerWords.length > IMAGE_LORA_MAX_TRIGGER_WORDS) {
      setError(
        `At most ${String(IMAGE_LORA_MAX_TRIGGER_WORDS)} trigger words — they are a prompt addition, not a tag list.`,
      );
      return;
    }

    const body = {
      label: label.trim(),
      locatorType,
      locator: locator.trim(),
      compatibleModelSlugs: slugs,
      compatibleVersionIds: splitList(versionText),
      defaultScale: preferred,
      minimumScale: minimum,
      maximumScale: maximum,
      triggerWords,
      promptPrefix: promptPrefix.trim() === "" ? null : promptPrefix.trim(),
      promptSuffix: promptSuffix.trim() === "" ? null : promptSuffix.trim(),
      allowedTasks: tasks,
      enabled,
    } satisfies ImageLoraCreateRequest;

    setError(null);
    setSaving(true);
    const result = lora === null ? await imageLorasApi.create(body) : await imageLorasApi.update(lora.id, body);
    setSaving(false);
    if (!result.ok) {
      // Kept in the form rather than thrown at a toast: the message names the
      // field that was refused, and it is only useful beside that field.
      setError(result.error.message);
      return;
    }
    onSaved(lora === null ? `Added ${result.data.lora.label}` : `Saved ${result.data.lora.label}`);
  };

  return (
    <div className="mt-4 rounded-card border border-accent-500/30 bg-ink-950/40 p-4">
      <h3 className="text-xs font-medium tracking-wide text-paper-400 uppercase">
        {lora === null ? "New LoRA" : `Editing ${lora.label}`}
      </h3>

      <div className="mt-3 flex flex-col gap-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField
            label="Label"
            hint="What this LoRA is, in the words a picker should show."
            value={label}
            placeholder="Photo to anime (Qwen 2509)"
            maxLength={200}
            onChange={setLabel}
          />
          <Field label="Locator type" hint="How the provider is told where the weights are.">
            {(id) => (
              <Select
                id={id}
                value={locatorType}
                onChange={(e) => setLocatorType(e.target.value as ImageLoraLocatorType)}
              >
                {imageLoraLocatorTypes.map((entry) => (
                  <option key={entry} value={entry}>
                    {locatorTypeLabel(entry)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>

        <TextField
          label="Locator"
          hint="A public retrieval address — never a token, never a private repository. Query strings are stripped everywhere this is reported."
          value={locator}
          placeholder={locatorPlaceholder(locatorType)}
          maxLength={1000}
          onChange={setLocator}
        />

        <Field
          label="Compatible models"
          hint="Empty means nothing is compatible, not everything — a LoRA trained against one base model produces noise on another."
        >
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap gap-x-4 gap-y-2">
              {slugOptions.length === 0 ? (
                <p className="text-xs text-paper-500">No models registered yet — type one below.</p>
              ) : (
                slugOptions.map((slug) => (
                  <CheckOption
                    key={slug}
                    label={slug}
                    checked={slugs.includes(slug)}
                    title={modelSlugs.includes(slug) ? "A registered model" : "Not registered here yet"}
                    onToggle={() => toggleSlug(slug)}
                  />
                ))
              )}
            </div>
            <div className="flex items-center gap-2">
              <Input
                value={slugDraft}
                onChange={(e) => setSlugDraft(e.target.value)}
                placeholder="qwen/qwen-image-edit-plus-lora"
                spellCheck={false}
                maxLength={200}
                className="max-w-80"
              />
              <Button size="sm" onClick={addSlug} disabled={slugDraft.trim() === ""}>
                Add slug
              </Button>
            </div>
          </div>
        </Field>

        <TextField
          label="Compatible versions"
          hint="Comma-separated provider version ids. Empty means any version of a compatible model; naming versions means a render that cannot say which version runs is refused."
          value={versionText}
          placeholder="b37d69a6b94414c96cc4ecb16660b472bb62284f…"
          maxLength={1000}
          onChange={setVersionText}
        />

        {/* The scale band, bounded by the absolute rails the contract declares
            rather than by numbers typed here, so a widened provider ceiling
            moves one constant and all three controls follow. */}
        <div className="grid gap-4 sm:grid-cols-3">
          <NumberField
            label="Minimum scale"
            hint="The weakest blend a render may ask for."
            step={0.05}
            min={IMAGE_LORA_MIN_SCALE}
            max={IMAGE_LORA_MAX_SCALE}
            value={minimumScale}
            onChange={setMinimumScale}
          />
          <NumberField
            label="Default scale"
            hint="Used when a render names no scale."
            step={0.05}
            min={IMAGE_LORA_MIN_SCALE}
            max={IMAGE_LORA_MAX_SCALE}
            value={defaultScale}
            onChange={setDefaultScale}
          />
          <NumberField
            label="Maximum scale"
            hint="Anything past this is refused, never clamped."
            step={0.05}
            min={IMAGE_LORA_MIN_SCALE}
            max={IMAGE_LORA_MAX_SCALE}
            value={maximumScale}
            onChange={setMaximumScale}
          />
        </div>

        <TextField
          label="Trigger words"
          hint={`Comma-separated, at most ${String(IMAGE_LORA_MAX_TRIGGER_WORDS)}. Appended to a prompt that does not already contain them.`}
          value={triggerText}
          placeholder="anime style, cel shading"
          maxLength={1000}
          onChange={setTriggerText}
        />

        <div className="grid gap-4 sm:grid-cols-2">
          <PromptField
            label="Prompt prefix"
            hint="Optional — woven in before the compiled prompt."
            value={promptPrefix}
            onChange={setPromptPrefix}
          />
          <PromptField
            label="Prompt suffix"
            hint="Optional — woven in after it."
            value={promptSuffix}
            onChange={setPromptSuffix}
          />
        </div>

        <Field
          label="Allowed tasks"
          hint="Empty means none. A lab finishing pass runs under the variant task, whatever the picture behind it was."
        >
          <div className="flex flex-wrap gap-x-4 gap-y-2">
            {imageProfileTasks.map((task) => (
              <CheckOption
                key={task}
                label={TASK_LABELS[task]}
                checked={tasks.includes(task)}
                onToggle={() => toggleTask(task)}
              />
            ))}
          </div>
        </Field>

        <CheckOption
          label="Enabled"
          checked={enabled}
          title="A switched-off row refuses every render that names it"
          onToggle={() => setEnabled(!enabled)}
        />

        {error !== null ? (
          <p className="text-xs text-danger-300" role="alert">
            {error}
          </p>
        ) : null}

        <div className="flex items-center gap-3">
          <Button
            variant="primary"
            busy={saving}
            disabled={label.trim() === "" || locator.trim() === ""}
            onClick={() => void save()}
          >
            {lora === null ? "Add LoRA" : "Save changes"}
          </Button>
          <Button onClick={onCancel}>Cancel</Button>
        </div>
      </div>
    </div>
  );
}
