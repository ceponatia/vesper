"use client";

import { Select } from "./select";

/**
 * Dropdown over a curated model list (`lib/narrative-models.ts` /
 * `lib/agent-models.ts` — codebase-review E-U3). A value OUTSIDE the list still
 * renders as its own option (the id as-is, docs/ui.md §World tab) so a
 * legacy/env-override id shows selected rather than being silently swapped for
 * the first curated entry.
 */
export function ModelSelect({
  models,
  value,
  onChange,
  ariaLabel,
  id,
  disabled,
  className,
}: {
  models: readonly { id: string; label: string }[];
  value: string;
  onChange: (id: string) => void;
  ariaLabel: string;
  /** Wire to a visible `<label htmlFor>` (the Field render-prop pattern). */
  id?: string;
  disabled?: boolean;
  className?: string;
}) {
  const known = models.some((option) => option.id === value);
  return (
    <Select
      id={id}
      aria-label={ariaLabel}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      className={className}
    >
      {!known ? <option value={value}>{value || "—"}</option> : null}
      {models.map((option) => (
        <option key={option.id} value={option.id}>
          {option.label}
        </option>
      ))}
    </Select>
  );
}
