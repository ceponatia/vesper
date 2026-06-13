"use client";

import { useState } from "react";
import { cx } from "./cx";
import { Tag } from "./tag";

export interface TagInputProps {
  value: readonly string[];
  onChange: (tags: string[]) => void;
  placeholder?: string;
  id?: string;
  className?: string;
}

/** Chip list + free text entry (Enter/comma adds, Backspace removes last). */
export function TagInput({ value, onChange, placeholder, id, className }: TagInputProps) {
  const [draft, setDraft] = useState("");

  const commit = () => {
    const tag = draft.trim();
    setDraft("");
    if (!tag || value.includes(tag)) return;
    onChange([...value, tag]);
  };

  return (
    <div
      className={cx(
        "flex min-h-9 flex-wrap items-center gap-1.5 rounded-md border border-ink-600 bg-ink-850 px-2 py-1.5 focus-within:border-accent-500",
        className,
      )}
    >
      {value.map((tag) => (
        <Tag key={tag} onRemove={() => onChange(value.filter((t) => t !== tag))}>
          {tag}
        </Tag>
      ))}
      <input
        id={id}
        value={draft}
        placeholder={value.length === 0 ? placeholder : undefined}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === ",") {
            e.preventDefault();
            commit();
          } else if (e.key === "Backspace" && draft === "" && value.length > 0) {
            onChange(value.slice(0, -1));
          }
        }}
        className="h-5 min-w-20 flex-1 bg-transparent text-sm text-paper-100 placeholder:text-paper-500 focus:outline-none"
      />
    </div>
  );
}
