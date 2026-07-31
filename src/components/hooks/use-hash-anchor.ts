"use client";

import { useEffect } from "react";

/**
 * The element id a location hash targets, or undefined when there is none.
 * A malformed hash (bad percent-encoding) degrades to no target rather than
 * throwing mid-render.
 */
export function hashTargetId(hash: string): string | undefined {
  if (!hash.startsWith("#") || hash.length < 2) return undefined;
  try {
    return decodeURIComponent(hash.slice(1));
  } catch {
    return undefined;
  }
}

/**
 * Re-run the browser's native `#anchor` scroll once client-rendered content
 * exists. On a hard navigation the browser resolves the hash BEFORE a
 * client-fetched editor mounts, finds no element, and never retries — so a
 * deep link like `/personas/<id>#adult-eligibility-declaration` (the
 * adult-eligibility blocker-link contract) lands unscrolled whenever the
 * target sits below the fold. Pass `ready` = the content is rendered; the
 * scroll fires once per readiness flip, respects the target's
 * `scroll-margin` (the `scroll-mt-24` on the declaration anchors), and a
 * hashless URL or missing element is a no-op.
 */
export function useHashAnchorScroll(ready: boolean): void {
  useEffect(() => {
    if (!ready) return;
    const id = hashTargetId(window.location.hash);
    if (id === undefined) return;
    document.getElementById(id)?.scrollIntoView();
  }, [ready]);
}
