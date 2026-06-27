"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { cx } from "./cx";
import { useFocusTrap } from "./use-focus-trap";

export type SheetSide = "right" | "left" | "bottom";

export interface SheetProps {
  open: boolean;
  onClose: () => void;
  /** Edge the panel slides in from. Default "right". */
  side?: SheetSide;
  /** Optional header title; a close (×) button always renders alongside. */
  title?: ReactNode;
  children: ReactNode;
  /** Applied to the overlay root — use for breakpoint gating (e.g. "lg:hidden"). */
  className?: string;
}

const PANEL_BY_SIDE: Record<SheetSide, string> = {
  right: "inset-y-0 right-0 h-full w-[88vw] max-w-96 border-l",
  left: "inset-y-0 left-0 h-full w-[88vw] max-w-80 border-r",
  bottom: "inset-x-0 bottom-0 max-h-[85dvh] rounded-t-card border-t pb-[env(safe-area-inset-bottom)]",
};

const CLOSED_BY_SIDE: Record<SheetSide, string> = {
  right: "translate-x-full",
  left: "-translate-x-full",
  bottom: "translate-y-full",
};

/**
 * Edge-anchored modal panel (docs/ui.md — small owned primitives). Shares the
 * overlay-click + Escape + focus-trap behaviour with Dialog (via useFocusTrap)
 * but slides in from a screen edge — the building block for the play side panel,
 * the mobile nav drawer, and bottom action sheets. The enter slide is gated by
 * prefers-reduced-motion. No exit animation (unmounts immediately on close),
 * matching Dialog's minimalism.
 *
 * The overlay is **portalled to document.body**: its `fixed inset-0` must size to
 * the viewport, but a `transform`/`filter`/`backdrop-filter` ancestor establishes
 * a containing block for fixed descendants and would trap it. The nav drawer is
 * mounted inside the backdrop-blurred header, so without the portal the overlay
 * collapsed to the header's height and the panel body (links + nav-mode switch)
 * scrolled into a sliver — the empty-drawer bug. document.body is always a clean
 * viewport-sized containing block.
 */
export function Sheet({ open, onClose, side = "right", title, children, className }: SheetProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  useFocusTrap(open, onClose, panelRef);

  // Start translated off-screen, then flip on the next frame so the transition
  // plays from the closed position. rAF (not a microtask) so the browser paints
  // the closed state first.
  const [entered, setEntered] = useState(false);
  // Reset to the closed position the moment `open` flips false — adjusted during
  // render (the "previous render" pattern), never via setState in an effect.
  const [prevOpen, setPrevOpen] = useState(open);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (!open) setEntered(false);
  }
  useEffect(() => {
    if (!open) return;
    const raf = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(raf);
  }, [open]);

  // Closed, or pre-mount on the server where there's no document.body to portal
  // into (every Sheet starts closed, so SSR always lands here and renders null —
  // no hydration mismatch).
  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div
      className={cx("fixed inset-0 z-50 flex bg-ink-950/60 backdrop-blur-[2px]", className)}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        className={cx(
          "absolute flex flex-col border-ink-600 bg-ink-900 shadow-lift outline-none",
          "transition-transform duration-200 ease-out motion-reduce:transition-none",
          PANEL_BY_SIDE[side],
          entered ? "translate-x-0 translate-y-0" : CLOSED_BY_SIDE[side],
        )}
      >
        <div className="flex items-center justify-between gap-2 border-b border-ink-600 px-3 py-2">
          {title ? <h2 className="prose-display text-sm text-paper-100">{title}</h2> : <span />}
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="touch-target inline-flex cursor-pointer items-center justify-center rounded-md px-2 py-1 text-paper-500 hover:text-paper-100"
          >
            ×
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
