"use client";

import { useEffect, useState } from "react";

/**
 * Whether the user asked the OS to minimise motion (`prefers-reduced-motion: reduce`).
 * The avatar renderer reads this to freeze idle loops, skip the expression crossfade, and
 * suppress one-shot reaction beats (a static expression still updates). The CSS also gates
 * the keyframes off; this is the JS half so the renderer doesn't queue beats that never
 * animate (and never fire `animationend`).
 *
 * SSR-safe + lint-safe (mirrors `useIsMobile` / ContrastToggle): first render assumes
 * motion is allowed (`false`), then syncs after mount with the initial set deferred past a
 * microtask. The change listener is browser-fired, so its setState is fine directly.
 */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    const mql = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (mql.matches) void Promise.resolve().then(() => setReduced(true));
    const onChange = (e: MediaQueryListEvent) => setReduced(e.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  return reduced;
}
