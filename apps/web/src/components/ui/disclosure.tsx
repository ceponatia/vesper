import type { ReactNode } from "react";
import { cx } from "./cx";

/** Optional form detail stays mounted, preserving in-progress edits when folded. */
export function Disclosure({
  title,
  description,
  defaultOpen = false,
  className,
  children,
}: {
  title: string;
  description?: ReactNode;
  defaultOpen?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <details open={defaultOpen} className={cx("group/disclosure rounded-card border border-ink-600 bg-ink-800", className)}>
      <summary className="touch-target flex cursor-pointer list-none items-center gap-3 rounded-card px-4 py-3 hover:bg-ink-750 [&::-webkit-details-marker]:hidden">
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium text-paper-200">{title}</span>
          {description ? <span className="mt-1 block text-xs leading-relaxed text-paper-500">{description}</span> : null}
        </span>
        <svg className="size-4 shrink-0 text-paper-400 transition-transform group-open/disclosure:rotate-90" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="m6 4 4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </summary>
      <div className="flex min-w-0 flex-col gap-4 border-t border-ink-600 p-4">{children}</div>
    </details>
  );
}
