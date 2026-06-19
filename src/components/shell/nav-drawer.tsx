"use client";

import { usePathname } from "next/navigation";
import { useState } from "react";
import { Sheet } from "@/components/ui/sheet";
import type { NavMode } from "@/lib/nav-mode";
import { NavIcon } from "./nav-icons";
import { isNavActive, NAV_LINKS } from "./nav-links";
import { NavModeToggle } from "./nav-mode-toggle";
import { NavSheetLink } from "./nav-sheet-link";

/**
 * Mobile primary navigation as a hamburger button + left slide-in drawer
 * (docs/ui.md §Mobile) — the alternate nav chrome, off by default. The trigger
 * lives in the header where the desktop nav sits; both it and the drawer are
 * `md:hidden`, so the top-nav owns ≥768px. Links close the drawer on tap (no
 * route-change effect needed, which keeps clear of the no-setState-in-effect rule).
 */
export function NavDrawer({
  navMode,
  onNavModeChange,
}: {
  navMode: NavMode;
  onNavModeChange: (mode: NavMode) => void;
}) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Open navigation menu"
        aria-haspopup="dialog"
        aria-expanded={open}
        className="touch-target -ml-1 inline-flex items-center justify-center rounded-md px-2 text-paper-300 hover:text-paper-50 md:hidden"
      >
        <NavIcon name="menu" className="size-6" />
      </button>

      <Sheet open={open} onClose={() => setOpen(false)} side="left" title="Vesper" className="md:hidden">
        <nav aria-label="Primary" className="flex flex-col gap-1 p-3">
          {NAV_LINKS.map((dest) => (
            <NavSheetLink
              key={dest.href}
              dest={dest}
              active={isNavActive(pathname, dest.href)}
              onNavigate={() => setOpen(false)}
            />
          ))}
        </nav>
        <div className="mt-auto border-t border-ink-600 p-3">
          <NavModeToggle value={navMode} onChange={onNavModeChange} />
        </div>
      </Sheet>
    </>
  );
}
