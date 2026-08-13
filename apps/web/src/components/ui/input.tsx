"use client";

import type { InputHTMLAttributes } from "react";
import { cx } from "./cx";

export const controlClass =
  "w-full rounded-md border border-ink-600 bg-ink-850 px-3 text-sm text-paper-100 placeholder:text-paper-500 hover:border-ink-500 focus:border-accent-500 focus:outline-none disabled:opacity-50";

export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cx(controlClass, "h-9", className)} {...rest} />;
}
