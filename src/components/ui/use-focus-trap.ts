"use client";

import { useEffect, type RefObject } from "react";
import { FOCUSABLE_SELECTOR, resolveTabTarget } from "./focus-trap";

/**
 * Modal focus-trap behaviour shared by Dialog and Sheet (docs/ui.md — small
 * owned primitives). While `open`, Escape closes, focus moves onto the panel,
 * and Tab / Shift+Tab cycle through the panel's focusables without escaping to
 * the page behind. The pure landing-spot decision lives in `resolveTabTarget`.
 */
export function useFocusTrap(
  open: boolean,
  onClose: () => void,
  panelRef: RefObject<HTMLElement | null>,
): void {
  // Focus-on-open lives in its own effect keyed only on `open`: callers pass
  // inline `onClose` functions, so an effect that both depends on `onClose` and
  // calls focus() re-runs on every parent render and yanks focus out of
  // whatever input the user is typing in (one keystroke per click). The
  // `contains` guard also lets an autoFocus child keep focus on open.
  useEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    if (panel && !panel.contains(document.activeElement)) panel.focus();
  }, [open, panelRef]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
        return;
      }
      if (e.key !== "Tab") return;
      const panel = panelRef.current;
      if (!panel) return;
      const target = resolveTabTarget({
        focusables: Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)),
        active: document.activeElement instanceof HTMLElement ? document.activeElement : null,
        shiftKey: e.shiftKey,
        fallback: panel,
      });
      if (target) {
        e.preventDefault();
        target.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose, panelRef]);
}
