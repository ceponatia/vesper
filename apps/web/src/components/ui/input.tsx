"use client";

import type { InputHTMLAttributes } from "react";
import { cx } from "./cx";

export const controlSurfaceClass =
  "rounded-md border border-control-border bg-control-fill transition-colors hover:border-control-hover focus-within:border-accent-400 focus-within:ring-2 focus-within:ring-accent-500/20";

export const controlClass = cx(
  controlSurfaceClass,
  "w-full px-3 text-sm text-paper-100 placeholder:text-paper-500 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50",
);

export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cx(controlClass, "h-9 touch-target", className)} {...rest} />;
}
