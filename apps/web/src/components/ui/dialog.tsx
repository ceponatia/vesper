"use client";

import { useRef, type ReactNode } from "react";
import { cx } from "./cx";
import { useFocusTrap } from "./use-focus-trap";

/**
 * Panel width caps: md for confirmations and one-field forms, lg for pickers and
 * reading surfaces, xl for field-heavy sheets that deserve desktop room (the
 * viewport-padded `w-full` keeps every tier phone-safe). Width is a prop, not a
 * `className` override: `cx` is a plain join, so a caller's `max-w-*` and the
 * base's both land on the element and stylesheet order picks the winner — the
 * old `className="max-w-lg"` overrides silently lost to `max-w-md`.
 */
const sizeClasses = {
  md: "max-w-md",
  lg: "max-w-lg",
  xl: "max-w-4xl",
} as const;

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  size?: keyof typeof sizeClasses;
}

/** Minimal modal: overlay click + Escape close, focus moves in on open and Tab cycles inside. */
export function Dialog({ open, onClose, title, children, footer, size = "md" }: DialogProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  useFocusTrap(open, onClose, panelRef);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink-950/70 p-4 backdrop-blur-[2px]"
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
          // max-h + flex column, title/footer pinned and the content region scrolling
          // internally (same recipe as Sheet's bottom panel) — tall content (the
          // portrait-review dialog, avatar-upload-dialog's crop stage) no longer pushes
          // the footer's buttons off-screen with nothing scrollable to reach them.
          "flex max-h-[85dvh] w-full flex-col rounded-card border border-ink-600 bg-ink-800 shadow-lift outline-none",
          sizeClasses[size],
        )}
      >
        <div className="shrink-0 border-b border-ink-600 px-5 py-3">
          <h2 className="prose-display text-base">{title}</h2>
        </div>
        {children ? <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4 text-sm text-paper-300">{children}</div> : null}
        {footer ? <div className="flex shrink-0 justify-end gap-2 border-t border-ink-600 px-5 py-3">{footer}</div> : null}
      </div>
    </div>
  );
}
