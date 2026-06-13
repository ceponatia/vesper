import type { ReactNode } from "react";
import { cx } from "./cx";

export interface EmptyStateProps {
  title: string;
  description?: string;
  action?: ReactNode;
  className?: string;
}

/** Graceful empty surface for fresh installs and filtered-out lists. */
export function EmptyState({ title, description, action, className }: EmptyStateProps) {
  return (
    <div
      className={cx(
        "flex flex-col items-center gap-3 rounded-card border border-dashed border-ink-600 px-6 py-12 text-center",
        className,
      )}
    >
      <span aria-hidden="true" className="prose-display text-2xl text-paper-500">
        ❧
      </span>
      <p className="prose-display text-lg">{title}</p>
      {description ? <p className="max-w-md text-sm text-paper-400">{description}</p> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}
