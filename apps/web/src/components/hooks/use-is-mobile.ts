"use client";

import { useEffect, useState } from "react";

/**
 * The mobile/desktop boundary for *shell chrome* (top-nav vs bottom-bar/drawer).
 * 767.98px = one hair under Tailwind's `md` (768px), so this query and `md:`
 * utilities agree on the same boundary — `md:` is the source of truth, this just
 * mirrors it for the JS that can't be expressed as a class. The play side panel
 * keeps its own `lg` (1024px) threshold; that's a different question.
 */
export const MOBILE_QUERY = "(max-width: 767.98px)";

/**
 * Whether the viewport is phone-width. Width-only by design — `pointer`/`hover`
 * media queries (used for touch-target sizing in globals.css) are deliberately
 * kept out of this so touchscreen laptops and devtools emulation don't skew the
 * layout switch.
 *
 * SSR-safe: first render assumes desktop (`false`) so server markup matches the
 * wider tree, then syncs to the real value after mount. The post-mount sync is
 * deferred past a microtask (matching ContrastToggle) to satisfy the
 * no-sync-setState-in-effects lint rule.
 */
export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const mql = window.matchMedia(MOBILE_QUERY);
    if (mql.matches) void Promise.resolve().then(() => setIsMobile(true));
    // Fired by the browser (outside the effect body), so a direct setState here
    // is fine.
    const onChange = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  return isMobile;
}
