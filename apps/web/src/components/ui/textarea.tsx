"use client";

import type { TextareaHTMLAttributes } from "react";
import { cx } from "./cx";
import { controlClass } from "./input";

export function Textarea({ className, rows = 4, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      rows={rows}
      // Auto-grow with content (Tailwind v4 `field-sizing-content`) instead of a
      // mouse-only drag handle — `rows` still sets the floor, `max-h` the ceiling
      // (mobile-ux W3 task 6; matches the pattern already used for the message
      // edit-in-place box).
      className={cx(controlClass, "field-sizing-content max-h-[60vh] py-2 leading-relaxed", className)}
      {...rest}
    />
  );
}
