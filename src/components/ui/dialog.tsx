"use client";

import { useRef, type ReactNode } from "react";
import { cx } from "./cx";
import { useFocusTrap } from "./use-focus-trap";

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  className?: string;
}

/** Minimal modal: overlay click + Escape close, focus moves in on open and Tab cycles inside. */
export function Dialog({ open, onClose, title, children, footer, className }: DialogProps) {
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
          "w-full max-w-md rounded-card border border-ink-600 bg-ink-800 shadow-lift outline-none",
          className,
        )}
      >
        <div className="border-b border-ink-600 px-5 py-3">
          <h2 className="prose-display text-base">{title}</h2>
        </div>
        {children ? <div className="px-5 py-4 text-sm text-paper-300">{children}</div> : null}
        {footer ? <div className="flex justify-end gap-2 border-t border-ink-600 px-5 py-3">{footer}</div> : null}
      </div>
    </div>
  );
}
