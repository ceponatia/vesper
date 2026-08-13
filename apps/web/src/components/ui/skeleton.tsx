import { cx } from "./cx";

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden="true" className={cx("animate-pulse rounded-md bg-ink-700", className)} />;
}

export function SkeletonText({ lines = 3, className }: { lines?: number; className?: string }) {
  return (
    <div className={cx("flex flex-col gap-2", className)} aria-hidden="true">
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} className={cx("h-3.5", i === lines - 1 ? "w-2/3" : "w-full")} />
      ))}
    </div>
  );
}

/** Grid of card-shaped placeholders for library pages. */
export function SkeletonCards({ count = 6 }: { count?: number }) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="rounded-card border border-ink-600 bg-ink-800 p-4">
          <div className="flex gap-3">
            <Skeleton className="size-14 rounded-md" />
            <div className="flex-1">
              <Skeleton className="mb-2 h-4 w-1/2" />
              <SkeletonText lines={2} />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
