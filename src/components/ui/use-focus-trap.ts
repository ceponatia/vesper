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
  useEffect(() => {
    if (!open) return;
    panelRef.current?.focus();
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
