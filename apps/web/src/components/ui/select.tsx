"use client";

import type { SelectHTMLAttributes } from "react";
import { cx } from "./cx";
import { controlClass } from "./input";

export function Select({ className, children, style, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={cx(controlClass, "h-9 touch-target appearance-none pr-9 [&>option]:bg-control-fill", className)}
      style={{
        backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' fill='none' viewBox='0 0 16 16'%3E%3Cpath d='m4 6 4 4 4-4' stroke='%23bfb59e' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E")`,
        backgroundPosition: "right 0.75rem center",
        backgroundRepeat: "no-repeat",
        ...style,
      }}
      {...rest}
    >
      {children}
    </select>
  );
}
