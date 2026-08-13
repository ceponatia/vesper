"use client";

import type { SelectHTMLAttributes } from "react";
import { cx } from "./cx";
import { controlClass } from "./input";

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={cx(controlClass, "h-9 appearance-none pr-8 [&>option]:bg-ink-850", className)} {...rest}>
      {children}
    </select>
  );
}
