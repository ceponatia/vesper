import type { HTMLAttributes } from "react";
import { cx } from "./cx";

/** Quiet raised surface; interactive variants add hover affordance. */
export function Card({
  className,
  interactive = false,
  ...rest
}: HTMLAttributes<HTMLDivElement> & { interactive?: boolean }) {
  return (
    <div
      className={cx(
        "rounded-card border border-ink-600 bg-ink-800 shadow-lift",
        interactive && "transition-colors duration-100 hover:border-ink-500 hover:bg-ink-750",
        className,
      )}
      {...rest}
    />
  );
}
