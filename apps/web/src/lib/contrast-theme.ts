/**
 * High-contrast accessibility theme (UX-audit M6 / feature #6). The mode is a
 * single flag persisted in localStorage and reflected as `data-contrast="high"`
 * on `<html>`, which globals.css keys its louder token overrides off. A tiny
 * inline script in the root layout applies the stored mode before first paint
 * (no flash); this module is the typed read/apply path the toggle uses at
 * runtime. `parseContrastMode` is pure (shared with both).
 */

export const CONTRAST_STORAGE_KEY = "vesper-contrast";

export type ContrastMode = "default" | "high";

/** Pure: coerce any stored/string value to a known mode. */
export function parseContrastMode(value: string | null | undefined): ContrastMode {
  return value === "high" ? "high" : "default";
}

/** The mode persisted last (default when absent / storage unavailable). */
export function readStoredContrast(): ContrastMode {
  if (typeof localStorage === "undefined") return "default";
  try {
    return parseContrastMode(localStorage.getItem(CONTRAST_STORAGE_KEY));
  } catch {
    return "default";
  }
}

/** Reflect a mode onto `<html>` and persist it. No-ops without a DOM. */
export function applyContrast(mode: ContrastMode): void {
  if (typeof document !== "undefined") {
    if (mode === "high") document.documentElement.dataset.contrast = "high";
    else delete document.documentElement.dataset.contrast;
  }
  if (typeof localStorage !== "undefined") {
    try {
      localStorage.setItem(CONTRAST_STORAGE_KEY, mode);
    } catch {
      // private mode / quota — the in-DOM flag still applies for this session.
    }
  }
}
