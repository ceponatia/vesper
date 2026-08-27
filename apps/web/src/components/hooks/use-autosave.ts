"use client";

import { useCallback, useEffect, useRef } from "react";

/**
 * Editor autosave (ruled 2026-07-13):
 * drafts should never be losable, so the editors move from explicit-save to
 * always-saved.
 *
 * - **Structured edits** (selects, toggles, sliders, pickers) save shortly
 *   after the last change — `signal` is the form object itself, so every edit
 *   resets the debounce window.
 * - **Free text** saves when the user leaves the field: mount the returned
 *   `onBlur` on the editable container (React's onBlur is focusout — it
 *   bubbles), which flushes immediately on any field exit. Mid-typing saves
 *   never fire because typing keeps resetting the debounce.
 * - **The Save button stays** as a manual flush + visual reassurance.
 * - **Forge-draft discipline**: while `enabled` is false (a staged ✦ result
 *   awaiting review) nothing auto-commits — the SaveBar stays the review step.
 * - **Navigation guard**: `beforeunload` warns only while something is unsaved
 *   or a write is in flight — the ruled remnant of the old dirty-guard idea.
 *
 * The caller's `save` must be safe to re-run (the editors' editGen pattern
 * keeps late edits dirty); pass a silent variant so autosave doesn't toast.
 */
export function useAutosave({
  enabled,
  dirty,
  saving,
  save,
  signal,
  delayMs = 1500,
}: {
  enabled: boolean;
  dirty: boolean;
  saving: boolean;
  save: () => Promise<unknown>;
  /** The form/draft object — its identity change is the "an edit happened" tick. */
  signal: unknown;
  delayMs?: number;
}): { onBlur: () => void } {
  const latest = useRef({ enabled, dirty, saving, save });
  useEffect(() => {
    latest.current = { enabled, dirty, saving, save };
  });
  const inFlight = useRef(false);

  const run = useCallback(() => {
    const s = latest.current;
    if (inFlight.current || !s.enabled || !s.dirty || s.saving) return;
    inFlight.current = true;
    void s
      .save()
      .catch(() => undefined) // the editor's save() surfaces its own errors
      .finally(() => {
        inFlight.current = false;
      });
  }, []);

  // Debounced save after the last edit; any newer edit (new `signal` identity)
  // or a starting save resets the window.
  useEffect(() => {
    if (!enabled || !dirty || saving) return;
    const timer = setTimeout(run, delayMs);
    return () => clearTimeout(timer);
  }, [enabled, dirty, saving, delayMs, signal, run]);

  // Warn only while a write is unsaved/in flight (ruled: no full dirty guard).
  useEffect(() => {
    const handler = (event: BeforeUnloadEvent) => {
      const s = latest.current;
      if (s.dirty || s.saving) event.preventDefault();
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, []);

  return { onBlur: run };
}
