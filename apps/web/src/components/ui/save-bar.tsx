"use client";

import type { ReactNode } from "react";
import { Button } from "./button";

export interface SaveBarProps {
  dirty: boolean;
  saving: boolean;
  onSave: () => void;
  saveLabel?: string;
  /** A blocked workflow keeps its dirty state while making Save unavailable. */
  disabled?: boolean;
  /** Persistent context for saving, such as a required recovery decision. */
  status?: ReactNode;
  /** Extra actions (delete, cancel) rendered on the left. */
  secondary?: ReactNode;
}

/** Sticky save bar with dirty-state indication for long editors (docs/ui/conventions.md §Forms and drafts). */
export function SaveBar({ dirty, saving, onSave, saveLabel = "Save", secondary, disabled = false, status }: SaveBarProps) {
  return (
    // Offset above the mobile bottom tab bar (bottom-tab-bar.tsx: fixed, h-14, `md:hidden`)
    // so the bar is never hidden underneath it; the calc mirrors app-shell.tsx's own
    // `pb-[calc(3.5rem+env(safe-area-inset-bottom))]` reservation for that same bar.
    <div className="sticky bottom-[calc(3.5rem+env(safe-area-inset-bottom))] z-30 -mx-1 mt-8 rounded-t-card border-t border-ink-600 bg-ink-900/95 px-4 py-3 backdrop-blur md:bottom-0">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">{secondary}</div>
        <div className="flex items-center gap-3">
          <span role="status" className="text-xs text-paper-500">
            {status ?? (saving ? "Saving…" : dirty ? "Unsaved changes" : "All changes saved")}
          </span>
          <Button variant="primary" onClick={onSave} busy={saving} disabled={disabled || (!dirty && !saving)}>
            {saveLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
