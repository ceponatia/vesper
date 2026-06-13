"use client";

import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cx } from "./cx";

export type ButtonVariant = "primary" | "ghost" | "quiet" | "danger";
export type ButtonSize = "sm" | "md";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Shows a spinner and disables the button. */
  busy?: boolean;
}

const variants: Record<ButtonVariant, string> = {
  primary:
    "bg-accent-500 text-ink-950 font-medium hover:bg-accent-400 disabled:bg-ink-600 disabled:text-paper-500",
  ghost:
    "border border-ink-600 text-paper-200 hover:border-ink-500 hover:bg-ink-800 disabled:text-paper-500",
  quiet: "text-paper-400 hover:text-paper-100 hover:bg-ink-800 disabled:text-paper-500",
  danger:
    "border border-danger-500/40 text-danger-300 hover:bg-danger-500/10 hover:border-danger-500 disabled:text-paper-500",
};

const sizes: Record<ButtonSize, string> = {
  sm: "h-7 px-2.5 text-xs gap-1.5",
  md: "h-9 px-3.5 text-sm gap-2",
};

export function Spinner({ className }: { className?: string }) {
  return (
    <svg
      className={cx("size-3.5 animate-spin", className)}
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
    >
      <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2" />
      <path d="M8 1.5A6.5 6.5 0 0 1 14.5 8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

export function Button({
  variant = "ghost",
  size = "md",
  busy = false,
  className,
  children,
  disabled,
  type,
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type ?? "button"}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      className={cx(
        "inline-flex shrink-0 cursor-pointer items-center justify-center rounded-md transition-colors duration-100 disabled:cursor-not-allowed",
        variants[variant],
        sizes[size],
        className,
      )}
      {...rest}
    >
      {busy ? <Spinner /> : null}
      {children as ReactNode}
    </button>
  );
}
