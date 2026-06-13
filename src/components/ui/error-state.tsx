"use client";

import type { ApiError } from "@/lib/client/api";
import { Button } from "./button";
import { cx } from "./cx";

export interface ErrorStateProps {
  error: ApiError;
  onRetry?: () => void;
  className?: string;
}

/** Every async surface gets one of these instead of a blank or a crash. */
export function ErrorState({ error, onRetry, className }: ErrorStateProps) {
  return (
    <div
      role="alert"
      className={cx(
        "flex flex-col items-center gap-2 rounded-card border border-danger-500/30 bg-danger-500/5 px-6 py-8 text-center",
        className,
      )}
    >
      <p className="text-sm text-danger-300">{error.message}</p>
      <p className="text-xs text-paper-500">{error.code}</p>
      {onRetry ? (
        <Button size="sm" onClick={onRetry} className="mt-1">
          Try again
        </Button>
      ) : null}
    </div>
  );
}
