"use client";

import { useEffect, useState } from "react";
import { applyContrast, readStoredContrast, type ContrastMode } from "@/lib/contrast-theme";
import { cx } from "@/components/ui/cx";

/**
 * Header toggle for the high-contrast accessibility theme (UX-audit M6 / feature
 * #6). The actual mode is applied pre-paint by the root-layout inline script;
 * this button only reflects + flips it. First render assumes "default" (matching
 * SSR, so no hydration mismatch) and syncs to the stored value after mount —
 * deferred past a microtask per the no-sync-setState-in-effects rule.
 */
export function ContrastToggle() {
  const [mode, setMode] = useState<ContrastMode>("default");

  useEffect(() => {
    const stored = readStoredContrast();
    if (stored !== "default") void Promise.resolve().then(() => setMode(stored));
  }, []);

  const high = mode === "high";
  const toggle = () => {
    const next: ContrastMode = high ? "default" : "high";
    setMode(next);
    applyContrast(next);
  };

  return (
    <button
      type="button"
      onClick={toggle}
      aria-pressed={high}
      aria-label="Toggle high-contrast theme"
      title="High-contrast theme"
      className={cx(
        "ml-auto inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs transition-colors",
        high ? "bg-ink-800 text-paper-50" : "text-paper-400 hover:text-paper-100",
      )}
    >
      <span aria-hidden className="text-sm leading-none">
        ◐
      </span>
      <span className="hidden sm:inline">High contrast</span>
    </button>
  );
}
