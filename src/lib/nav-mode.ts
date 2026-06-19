/**
 * Mobile primary-navigation mode (docs/ui.md §Mobile). On phones the shell shows
 * one of two nav chromes — a bottom tab bar or a hamburger + slide-in drawer —
 * switchable so both can be exercised. The mode is a single flag persisted in
 * localStorage; `AppShell` reads it on mount and reflects it.
 *
 * The invariant the UI relies on — exactly one mode active, never both, never
 * none — is *structural*: `NavMode` is a two-value union and `parseNavMode`
 * coerces anything unknown to `"tabs"`, so a render-time ternary can never
 * produce both or neither. There's no pre-paint `<html>` script (unlike
 * contrast-theme): the nav chrome is client-rendered and hidden on the SSR
 * desktop tree, so there's nothing to flash.
 */

export const NAV_MODE_STORAGE_KEY = "vesper-nav-mode";

export type NavMode = "tabs" | "drawer";

/** Pure: coerce any stored/string value to a known mode (default "tabs"). */
export function parseNavMode(value: string | null | undefined): NavMode {
  return value === "drawer" ? "drawer" : "tabs";
}

/** The mode persisted last ("tabs" when absent / storage unavailable). */
export function readStoredNavMode(): NavMode {
  if (typeof localStorage === "undefined") return "tabs";
  try {
    return parseNavMode(localStorage.getItem(NAV_MODE_STORAGE_KEY));
  } catch {
    return "tabs";
  }
}

/** Persist a mode. No-ops without storage (private mode / quota). */
export function applyNavMode(mode: NavMode): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(NAV_MODE_STORAGE_KEY, mode);
  } catch {
    // private mode / quota — the in-memory mode still applies for this session.
  }
}
