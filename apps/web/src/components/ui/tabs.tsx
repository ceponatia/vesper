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
  /** Callers with panels use `${idPrefix}-panel-${id}` and name them from the tab id. */
  idPrefix?: string;
  ariaLabel?: string;
}

/** Horizontally scrolling, automatic-activation tabs with a single keyboard stop. */
export function Tabs<Id extends string>({ tabs, value, onChange, className, idPrefix, ariaLabel }: TabsProps<Id>) {
  const stripRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const strip = stripRef.current;
    if (!strip) return;
    // Adjust only this strip: scrollIntoView can also scroll the page under a sticky header.
    const reveal = () => {
      const active = strip.querySelector<HTMLElement>('[aria-selected="true"]');
      if (!active) return;
      const parent = strip.getBoundingClientRect();
      const child = active.getBoundingClientRect();
      if (child.left < parent.left) strip.scrollLeft += child.left - parent.left;
      else if (child.right > parent.right) strip.scrollLeft += child.right - parent.right;
    };
    reveal();
    const observer = new ResizeObserver(reveal);
    observer.observe(strip);
    return () => observer.disconnect();
  }, [value]);

  return (
    <div
      ref={stripRef}
      role="tablist"
      aria-label={ariaLabel}
      className={cx(
        "flex items-end gap-1 overflow-x-auto border-b border-ink-600 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
        className,
      )}
    >
      {tabs.map((tab, index) => {
        const active = tab.id === value;
        return (
          <button
            key={tab.id}
            id={idPrefix ? `${idPrefix}-tab-${tab.id}` : undefined}
            aria-controls={idPrefix ? `${idPrefix}-panel-${tab.id}` : undefined}
            role="tab"
            type="button"
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            onClick={() => onChange(tab.id)}
            onKeyDown={(event) => {
              let next: number;
              if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
              else if (event.key === "ArrowLeft") next = (index - 1 + tabs.length) % tabs.length;
              else if (event.key === "Home") next = 0;
              else if (event.key === "End") next = tabs.length - 1;
              else return;
              event.preventDefault();
              const selected = tabs[next];
              if (!selected) return;
              onChange(selected.id);
              stripRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus({ preventScroll: true });
            }}
            className={cx(
              "touch-target -mb-px inline-flex shrink-0 cursor-pointer items-center gap-1.5 border-b-2 px-3 py-2 text-sm whitespace-nowrap transition-colors",
              active ? "border-accent-500 text-paper-50" : "border-transparent text-paper-400 hover:text-paper-200",
            )}
          >
            {tab.label}
            {tab.badge !== undefined && tab.badge !== null ? <span className="text-[11px] text-paper-500">{tab.badge}</span> : null}
          </button>
        );
      })}
    </div>
  );
}
