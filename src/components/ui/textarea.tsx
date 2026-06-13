"use client";

import type { TextareaHTMLAttributes } from "react";
import { cx } from "./cx";
import { controlClass } from "./input";

export function Textarea({ className, rows = 4, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea rows={rows} className={cx(controlClass, "resize-y py-2 leading-relaxed", className)} {...rest} />;
}
