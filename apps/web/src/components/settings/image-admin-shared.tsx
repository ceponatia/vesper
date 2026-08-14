"use client";

import type { ImageProfileTask } from "@vesper/image-core";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";

/**
 * The small form vocabulary the image-admin sections share (the LoRA library
 * and the profile editor). One spelling, because these sections sit on one page
 * and an operator reads them as one surface — and because the task labels are a
 * VOCABULARY: two lists translating `chat_look` differently would read as two
 * different features.
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
