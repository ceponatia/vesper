"use client";

import type { ReactNode } from "react";
import { Button } from "./button";

export interface SaveBarProps {
  dirty: boolean;
  saving: boolean;
  onSave: () => void;
  saveLabel?: string;
  /** Extra actions (delete, cancel) rendered on the left. */
  secondary?: ReactNode;
}

/** Sticky save bar with dirty-state indication for long editors (docs/ui.md). */
export function SaveBar({ dirty, saving, onSave, saveLabel = "Save", secondary }: SaveBarProps) {
  return (
    <div className="sticky bottom-0 z-30 -mx-1 mt-8 rounded-t-card border-t border-ink-600 bg-ink-900/95 px-4 py-3 backdrop-blur">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">{secondary}</div>
        <div className="flex items-center gap-3">
          <span className="text-xs text-paper-500">
            {saving ? "Saving…" : dirty ? "Unsaved changes" : "All changes saved"}
          </span>
          <Button variant="primary" onClick={onSave} busy={saving} disabled={!dirty && !saving}>
            {saveLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
