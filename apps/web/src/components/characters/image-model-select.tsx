"use client";

import type { ImageModel } from "@/lib/client/api";
import { Select } from "@/components/ui/select";

/**
 * The shared registry model picker (image-model-registry.plan.md). Every
 * surface that chooses a model — the portrait studio's two sections and the
 * chat scene strip — renders this, so they agree on what an empty registry and
 * a still-loading list look like.
 *
 * The value is a model id; `""` means "whatever this surface's default is",
 * which is what the server resolves when no id is sent. That keeps the picker
 * useful before its list has loaded: the user can generate immediately and get
 * the default rather than being blocked on a fetch.
 */
export function ImageModelSelect({
  id,
  models,
  value,
  onChange,
  disabled,
  title,
  className = "",
  emptyHint = "No model is registered for this.",
}: {
  id?: string;
  /** Null while loading — the picker shows a single placeholder and stays usable. */
  models: ImageModel[] | null;
  value: string;
  onChange: (modelId: string) => void;
  disabled?: boolean;
  title?: string;
  className?: string;
  emptyHint?: string;
}) {
  if (models !== null && models.length === 0) {
    return <p className="text-xs text-paper-500">{emptyHint}</p>;
  }
  return (
    <Select
      id={id}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled}
      title={title}
      className={className}
      aria-label="Image model"
    >
      {models === null ? (
        <option value="">Loading models…</option>
      ) : (
        models.map((model) => (
          <option key={model.id} value={model.id}>
            {model.label}
          </option>
        ))
      )}
    </Select>
  );
}

/**
 * Resolve what to send the server: the explicit pick, else the first offered
 * model, else nothing (the server falls back to the surface default). Sending
 * the first model rather than `""` keeps the request honest about what the user
 * is looking at in the dropdown.
 */
export function pickedId(value: string, models: ImageModel[] | null): string | undefined {
  if (value) return value;
  return models?.[0]?.id;
}
