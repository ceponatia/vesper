"use client";

import { useEffect, useState, type RefObject } from "react";
import { FOCUSABLE_SELECTOR, resolveTabTarget } from "./focus-trap";

/**
 * Open traps, in the order they opened. Only the topmost (last) trap responds
 * to Escape/Tab: with stacked layers (the calendar dialog over Scenario setup,
 * a Sheet's picker over a Dialog) every open trap listens on `document`, so
 * without this gate one Escape closes every layer at once and the lower
 * layer's Tab handler moves focus before the top one re-resolves it.
 */
const trapStack: symbol[] = [];

/**
 * Modal focus-trap behaviour shared by Dialog and Sheet (docs/ui/mobile.md
 * §Sheet). While `open`, Escape closes, focus moves onto the panel,
 * and Tab / Shift+Tab cycle through the panel's focusables without escaping to
 * the page behind. The pure landing-spot decision lives in `resolveTabTarget`.
 */
export function useFocusTrap(
  open: boolean,
  onClose: () => void,
  panelRef: RefObject<HTMLElement | null>,
): void {
  // A stable per-instance identity for the stack. Registration lives in its own
  // effect keyed only on `open`, so parent re-renders (inline `onClose` churn —
  // see below) can't pop-and-repush it and scramble the layer order.
  const [trapToken] = useState(() => Symbol("focus-trap"));
  useEffect(() => {
    if (!open) return;
    trapStack.push(trapToken);
    return () => {
      const at = trapStack.indexOf(trapToken);
      if (at >= 0) trapStack.splice(at, 1);
    };
  }, [open, trapToken]);
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
      if (trapStack[trapStack.length - 1] !== trapToken) return;
      if (e.key === "Escape") {
        onClose();
        return;
      }
      if (e.key !== "Tab") return;
      const panel = panelRef.current;
      if (!panel) return;
      const target = resolveTabTarget({
        focusables: Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter((element) => {
          // Responsive comparisons and collapsed content stay mounted. Invisible
          // controls must not become the trap's last target and let Tab escape.
          if (!element.getClientRects().length || element.matches(":disabled") || element.closest("[inert]")) return false;
          const visibility = window.getComputedStyle(element).visibility;
          return visibility !== "hidden" && visibility !== "collapse";
        }),
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
  }, [open, onClose, panelRef, trapToken]);
}
