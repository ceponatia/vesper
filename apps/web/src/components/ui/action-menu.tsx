"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Button, Spinner } from "./button";
import { cx } from "./cx";

export interface ActionMenuItem {
  label: string;
  onSelect: () => void;
  disabled?: boolean;
  danger?: boolean;
  busy?: boolean;
}

/** Secondary actions with the same outside-click/Escape convention as AccountMenu. */
export function ActionMenu({ label = "More actions", ariaLabel = label, items }: { label?: string; ariaLabel?: string; items: readonly ActionMenuItem[] }) {
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const container = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const enterAtEnd = useRef(false);

  function focusTrigger() {
    container.current?.querySelector<HTMLButtonElement>("[data-menu-trigger]")?.focus();
  }

  useEffect(() => {
    if (!open) return;
    const enabled = panel.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)');
    const first = enterAtEnd.current ? enabled?.[enabled.length - 1] : enabled?.[0];
    (first ?? panel.current)?.focus();
    function onPointer(event: PointerEvent) {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("pointerdown", onPointer);
    return () => document.removeEventListener("pointerdown", onPointer);
  }, [open]);

  return (
    <div
      ref={container}
      className="relative ml-auto shrink-0"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
      }}
    >
      <Button
        size="sm"
        variant="quiet"
        data-menu-trigger=""
        aria-label={ariaLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => {
          enterAtEnd.current = false;
          setOpen(!open);
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape" && open) {
            event.preventDefault();
            event.stopPropagation();
            setOpen(false);
          }
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            enterAtEnd.current = event.key === "ArrowUp";
            setOpen(true);
          }
        }}
      >
        <span>{label}</span><span aria-hidden="true">⋯</span>
      </Button>
      {open ? (
        <div
          ref={panel}
          id={menuId}
          role="menu"
          aria-label={ariaLabel}
          tabIndex={-1}
          className="absolute top-full right-0 z-50 mt-1 w-52 max-w-[calc(100vw-2rem)] rounded-card border border-ink-500 bg-ink-800 p-1 shadow-lift"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              setOpen(false);
              focusTrigger();
              return;
            }
            if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
            event.preventDefault();
            const enabled = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)'));
            if (!enabled.length) return;
            const current = enabled.indexOf(document.activeElement as HTMLButtonElement);
            const next = event.key === "Home" ? 0 : event.key === "End" ? enabled.length - 1
              : (current + (event.key === "ArrowDown" ? 1 : -1) + enabled.length) % enabled.length;
            enabled[next]?.focus();
          }}
        >
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              tabIndex={-1}
              disabled={item.disabled || item.busy}
              aria-busy={item.busy || undefined}
              className={cx(
                "touch-target flex w-full cursor-pointer items-center gap-2 rounded-md px-3 py-2 text-left text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-50",
                item.danger ? "text-danger-300 hover:bg-danger-500/10" : "text-paper-200 hover:bg-ink-700",
              )}
              onClick={() => {
                setOpen(false);
                focusTrigger();
                item.onSelect();
              }}
            >
              {item.busy ? <Spinner /> : null}{item.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
