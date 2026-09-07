"use client";

import type { TextareaHTMLAttributes } from "react";
import { cx } from "./cx";
import { controlClass } from "./input";

export function Textarea({ className, rows = 4, style, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      rows={rows}
      // field-sizing ignores rows, so explicitly preserve the author's writing
      // area while still growing with content up to the viewport-relative cap.
      style={{ minHeight: `min(${rows}lh + 1rem + 2px, 60vh)`, ...style }}
      className={cx(controlClass, "field-sizing-content max-h-[60vh] py-2 leading-relaxed", className)}
      {...rest}
    />
  );
}
