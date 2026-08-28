"use client";

import type { ReactNode } from "react";
import { cx } from "./cx";

export type TagTone = "default" | "accent" | "ai" | "danger" | "ok";

const tones: Record<TagTone, string> = {
  default: "border-ink-500 text-paper-300",
  accent: "border-accent-500/50 text-accent-300",
  /** Marks AI-sourced values until the human touches them (docs/authoring/manual-editing.md). */
  ai: "border-accent-500/60 bg-accent-500/10 text-accent-300",
  danger: "border-danger-500/50 text-danger-300",
  ok: "border-ok-400/50 text-ok-400",
};

export interface TagProps {
  children: ReactNode;
  tone?: TagTone;
  onRemove?: () => void;
  className?: string;
  title?: string;
}

export function Tag({ children, tone = "default", onRemove, className, title }: TagProps) {
  return (
    <span
      title={title}
      className={cx(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] leading-4 whitespace-nowrap",
        tones[tone],
        className,
      )}
    >
      {children}
      {onRemove ? (
        <button
          type="button"
          onClick={onRemove}
          aria-label="Remove"
          className="-mr-0.5 cursor-pointer rounded-full px-0.5 text-paper-500 hover:text-paper-100"
        >
          ×
        </button>
      ) : null}
    </span>
  );
}

/** The provenance chip: AI-drafted value not yet touched by the human. */
export function AiTag() {
  return (
    <Tag tone="ai" title="Drafted by the forge — edits make it yours">
      AI
    </Tag>
  );
}
