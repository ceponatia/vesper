/**
 * Pure Tab-key resolution for a modal focus trap (docs/ui.md — small owned
 * primitives): given the dialog's focusable elements and the element that
 * currently has focus, decide where Tab / Shift+Tab should land.
 *
 * Returns the element to focus (the caller prevents the default move), or
 * null to let the browser handle an interior move natively.
 */
export function resolveTabTarget<T>(args: {
  /** Focusable elements inside the dialog, in document order. */
  focusables: readonly T[];
  /** The currently focused element, or null when nothing relevant has focus. */
  active: T | null;
  shiftKey: boolean;
  /** Focused when the dialog has no focusable children (the panel itself). */
  fallback: T;
}): T | null {
  const { focusables, active, shiftKey, fallback } = args;
  if (focusables.length === 0) return fallback;
  const first = focusables[0]!;
  const last = focusables[focusables.length - 1]!;
  const index = active === null ? -1 : focusables.indexOf(active);
  // Focus is outside the list (the panel itself, or escaped to the page
  // behind): pull it back inside.
  if (index === -1) return shiftKey ? last : first;
  if (shiftKey) return index === 0 ? last : null;
  return index === focusables.length - 1 ? first : null;
}

/** Tabbable elements a dialog can contain. */
export const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(", ");
