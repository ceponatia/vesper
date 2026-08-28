"use client";

import { useEffect, useRef } from "react";

/**
 * Poll-while-pending (docs/ui/conventions.md §Polling; codebase-review E-U2):
 * while `active`, run `tick` every `intervalMs`. `tick` is read through a latest-ref
 * (written in a bare effect, never during render — the strict hooks lint), so a
 * fresh closure per render never restarts the interval; only `active` flipping
 * (or the interval/cap changing) resubscribes.
 *
 * `maxPolls` is a safety cap: the interval stops after N ticks (for jobs that
 * might never settle). Flipping `active` off and back on rearms it. Callers
 * whose stop condition is stateful (e.g. "every entity has an image") instead
 * flip their own `active` flag from inside `tick`.
 */
export function usePollWhile(
  active: boolean,
  tick: () => void,
  intervalMs: number,
  opts?: { maxPolls?: number },
): void {
  const tickRef = useRef(tick);
  useEffect(() => {
    tickRef.current = tick;
  });
  const maxPolls = opts?.maxPolls;
  useEffect(() => {
    if (!active) return;
    let polls = 0;
    const timer = setInterval(() => {
      polls += 1;
      tickRef.current();
      if (maxPolls !== undefined && polls >= maxPolls) clearInterval(timer);
    }, intervalMs);
    return () => clearInterval(timer);
  }, [active, intervalMs, maxPolls]);
}
