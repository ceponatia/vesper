"use client";

import { cx } from "./cx";

export interface SliderProps {
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
  unit?: string;
  id?: string;
  className?: string;
  disabled?: boolean;
}

export function Slider({ value, min, max, step, onChange, unit, id, className, disabled }: SliderProps) {
  return (
    <div className={cx("flex items-center gap-3", className)}>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(e) => {
          const next = Number(e.target.value);
          if (Number.isFinite(next)) onChange(next);
        }}
        className="h-1.5 flex-1 cursor-pointer appearance-none rounded-full bg-ink-600 accent-accent-500"
      />
      <span className="w-16 shrink-0 text-right text-xs tabular-nums text-paper-300">
        {Number.isInteger(step) ? value : value.toFixed(2)}
        {unit ? <span className="text-paper-500"> {unit}</span> : null}
      </span>
    </div>
  );
}
