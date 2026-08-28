"use client";

import { applyNavMode, type NavMode } from "@/lib/nav-mode";
import { cx } from "@/components/ui/cx";

const OPTIONS = [
  { id: "tabs", label: "Bottom tabs" },
  { id: "drawer", label: "Hamburger" },
] as const satisfies ReadonlyArray<{ id: NavMode; label: string }>;

/**
 * Switches the mobile primary-nav chrome between the bottom tab bar and the
 * hamburger drawer (docs/ui/mobile.md §Primary nav). Rendered inside whichever
 * chrome is active (the "More" sheet and the drawer footer) so you can always flip out of
 * the current mode. Persists via applyNavMode and lifts the change to AppShell,
 * which re-renders exactly one chrome — the two-value union makes "both at once"
 * and "neither" unrepresentable.
 */
export function NavModeToggle({ value, onChange }: { value: NavMode; onChange: (mode: NavMode) => void }) {
  return (
    <div>
      <p className="mb-1.5 text-[11px] tracking-wide text-paper-500 uppercase">Mobile navigation</p>
      <div role="radiogroup" aria-label="Mobile navigation style" className="flex rounded-md border border-ink-600 p-0.5">
        {OPTIONS.map((opt) => {
          const active = value === opt.id;
          return (
            <button
              key={opt.id}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => {
                applyNavMode(opt.id);
                onChange(opt.id);
              }}
              className={cx(
                "touch-target inline-flex flex-1 cursor-pointer items-center justify-center rounded px-3 py-1.5 text-sm transition-colors",
                active ? "bg-ink-700 text-paper-50" : "text-paper-400 hover:text-paper-200",
              )}
            >
              {opt.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
