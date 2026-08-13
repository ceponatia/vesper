"use client";

import { useEffect, useRef, type ReactNode } from "react";
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

/**
 * Accessible tab strip; panel rendering is owned by the caller. Scrolls
 * horizontally when the tabs outgrow the width (dense editors have 5–7 tabs that
 * overflow a phone) and keeps the active tab scrolled into view as it changes.
 */
export function Tabs<Id extends string>({ tabs, value, onChange, className }: TabsProps<Id>) {
  const activeRef = useRef<HTMLButtonElement>(null);
  const mounted = useRef(false);

  // Keep the active tab visible when the selection moves (e.g. arrow keys reach
  // an off-screen tab). Skip the initial mount so it never yanks page scroll.
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    activeRef.current?.scrollIntoView({ inline: "nearest", block: "nearest" });
  }, [value]);

  const move = (from: Id, delta: number) => {
    const index = tabs.findIndex((t) => t.id === from);
    if (index < 0) return;
    const next = tabs[(index + delta + tabs.length) % tabs.length];
    if (next) onChange(next.id);
  };
  return (
    <div
      role="tablist"
      className={cx(
        "flex items-end gap-1 overflow-x-auto border-b border-ink-600 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
        className,
      )}
    >
      {tabs.map((tab) => {
        const active = tab.id === value;
        return (
          <button
            key={tab.id}
            ref={active ? activeRef : undefined}
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
              "-mb-px inline-flex shrink-0 cursor-pointer items-center gap-1.5 border-b-2 px-3 py-2 text-sm whitespace-nowrap transition-colors",
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
