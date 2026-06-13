"use client";

import type { ReactNode } from "react";
import { cx } from "./cx";

export interface TabDef<Id extends string = string> {
  id: Id;
  label: ReactNode;
  /** Small counter / status hint rendered after the label. */
  badge?: ReactNode;
}

export interface TabsProps<Id extends string> {
  tabs: ReadonlyArray<TabDef<Id>>;
  value: Id;
  onChange: (id: Id) => void;
  className?: string;
}

/** Accessible tab strip; panel rendering is owned by the caller. */
export function Tabs<Id extends string>({ tabs, value, onChange, className }: TabsProps<Id>) {
  const move = (from: Id, delta: number) => {
    const index = tabs.findIndex((t) => t.id === from);
    if (index < 0) return;
    const next = tabs[(index + delta + tabs.length) % tabs.length];
    if (next) onChange(next.id);
  };
  return (
    <div role="tablist" className={cx("flex items-end gap-1 border-b border-ink-600", className)}>
      {tabs.map((tab) => {
        const active = tab.id === value;
        return (
          <button
            key={tab.id}
            role="tab"
            type="button"
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            onClick={() => onChange(tab.id)}
            onKeyDown={(e) => {
              if (e.key === "ArrowRight") move(tab.id, 1);
              else if (e.key === "ArrowLeft") move(tab.id, -1);
            }}
            className={cx(
              "-mb-px inline-flex cursor-pointer items-center gap-1.5 border-b-2 px-3 py-2 text-sm transition-colors",
              active
                ? "border-accent-500 text-paper-50"
                : "border-transparent text-paper-400 hover:text-paper-200",
            )}
          >
            {tab.label}
            {tab.badge !== undefined && tab.badge !== null ? (
              <span className="text-[11px] text-paper-500">{tab.badge}</span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
