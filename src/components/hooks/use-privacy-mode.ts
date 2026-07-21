"use client";

import { useEffect, useState } from "react";

const PRIVACY_MODE_STORAGE_KEY = "vesper:privacy-mode";

function readStoredPrivacyMode(): boolean {
  if (typeof localStorage === "undefined") return false;
  try {
    return localStorage.getItem(PRIVACY_MODE_STORAGE_KEY) === "on";
  } catch {
    return false;
  }
}

function persistPrivacyMode(value: boolean): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(PRIVACY_MODE_STORAGE_KEY, value ? "on" : "off");
  } catch {
    // private mode / quota — the in-memory value still applies for this session.
  }
}

/**
 * Privacy mode (mobile-ux.plan.md ruling 4): a client-side toggle that makes the
 * chat screen safe to have open around company — hides the standing portrait,
 * swaps the header/feed avatars for a first-initial monogram, and hides scene
 * imagery entirely. Persisted in localStorage, default OFF.
 *
 * Follows the nav-mode precedent (`lib/nav-mode.ts` + `app-shell.tsx`'s use of
 * it): first render assumes off so server and client markup agree (nothing to
 * flash), then the stored value syncs in after mount, deferred past a microtask
 * so the sync satisfies the no-sync-setState-in-effects rule.
 *
 * `chat-conversation.tsx` is the single caller — it owns the state and passes the
 * value + setter down to every consumer (message bubbles, the header portrait,
 * the scene sections, the conversation menu) as props. That makes it the one
 * source of truth with nothing to keep in sync beyond ordinary prop flow, since
 * every consumer is a descendant of the one component holding the state.
 */
export function usePrivacyMode(): [boolean, (next: boolean) => void] {
  const [privacyMode, setPrivacyModeState] = useState(false);

  useEffect(() => {
    const stored = readStoredPrivacyMode();
    if (stored) void Promise.resolve().then(() => setPrivacyModeState(true));
  }, []);

  const setPrivacyMode = (next: boolean) => {
    persistPrivacyMode(next);
    setPrivacyModeState(next);
  };

  return [privacyMode, setPrivacyMode];
}
