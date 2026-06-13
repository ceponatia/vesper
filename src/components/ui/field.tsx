"use client";

import { useId, type ReactNode } from "react";
import { cx } from "./cx";

export interface FieldProps {
  label: ReactNode;
  hint?: ReactNode;
  error?: string | null;
  /** Render-prop so the control can pick up the generated id for the label. */
  children: ReactNode | ((controlId: string) => ReactNode);
  className?: string;
}

/** Label + control + hint/error wrapper used by every form (docs/ui.md). */
export function Field({ label, hint, error, children, className }: FieldProps) {
  const controlId = useId();
  return (
    <div className={cx("flex flex-col gap-1.5", className)}>
      <label htmlFor={controlId} className="text-xs font-medium tracking-wide text-paper-400 uppercase">
        {label}
      </label>
      {typeof children === "function" ? children(controlId) : children}
      {error ? (
        <p className="text-xs text-danger-300" role="alert">
          {error}
        </p>
      ) : hint ? (
        <p className="text-xs text-paper-500">{hint}</p>
      ) : null}
    </div>
  );
}
