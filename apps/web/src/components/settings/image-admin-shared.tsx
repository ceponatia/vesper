"use client";

import type { ImageModelSurface, ImageProfileTask } from "@vesper/image-core";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";

/**
 * The small form vocabulary the image-admin sections share (the LoRA library,
 * the model cards, and the profile editor). One spelling, because these
 * sections sit on one page and an operator reads them as one surface — and
 * because the task and surface labels are a VOCABULARY: two lists translating
 * `chat_look` differently would read as two different features.
 */

/** What each profile task is, in the operator's words rather than the enum's. */
export const TASK_LABELS: Record<ImageProfileTask, string> = {
  portrait: "portrait",
  variant: "variant (and every lab finishing pass)",
  scene: "scene",
  item: "item art",
  location: "location art",
  chat_look: "chat look",
  chat_place: "chat place",
  text_repair: "text repair",
  example_transform: "example transform",
  image_set: "image set",
};

/** The legacy surface toggles, labeled once for the create form AND each model card. */
export const MODEL_SURFACES: { key: ImageModelSurface; label: string; hint: string }[] = [
  { key: "portrait", label: "Portrait studio", hint: "Making a new portrait from a description" },
  { key: "variant", label: "New Variant", hint: "Editing an existing portrait" },
  { key: "scene", label: "Scene generator", hint: "Painting a chat moment from the avatar" },
];

/** Label + single-line text control — the one-line fields, spelled once. */
export function TextField({
  label,
  hint,
  value,
  placeholder,
  maxLength,
  onChange,
}: {
  label: string;
  hint?: string;
  value: string;
  placeholder?: string;
  maxLength: number;
  onChange: (value: string) => void;
}) {
  return (
    <Field label={label} hint={hint}>
      {(id) => (
        <Input
          id={id}
          value={value}
          placeholder={placeholder}
          maxLength={maxLength}
          spellCheck={false}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </Field>
  );
}

/** Label + numeric control — the LoRA scale band and the profile control
 * defaults, spelled once. Bounds and step come from the caller (the LoRA rails
 * are contract constants; most control defaults are unbounded optionals). */
export function NumberField({
  label,
  hint,
  value,
  min,
  max,
  step,
  placeholder,
  onChange,
}: {
  label: string;
  hint?: string;
  value: string;
  min?: number;
  max?: number;
  step?: number;
  placeholder?: string;
  onChange: (value: string) => void;
}) {
  return (
    <Field label={label} hint={hint}>
      {(id) => (
        <Input
          id={id}
          type="number"
          min={min}
          max={max}
          step={step}
          value={value}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </Field>
  );
}

/** One tick box in a group — compatibility lists, task lists, enabled switches. */
export function CheckOption({
  label,
  checked,
  title,
  onToggle,
}: {
  label: string;
  checked: boolean;
  title?: string;
  onToggle: () => void;
}) {
  return (
    <label className="flex items-center gap-2 text-sm text-paper-300" title={title}>
      <input type="checkbox" checked={checked} onChange={onToggle} className="accent-accent-500" />
      {label}
    </label>
  );
}
