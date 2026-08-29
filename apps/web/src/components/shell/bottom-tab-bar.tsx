"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { cx } from "@/components/ui/cx";
import { Sheet } from "@/components/ui/sheet";
import type { NavMode } from "@/lib/nav-mode";
import { NavIcon } from "./nav-icons";
import { isNavActive, OVERFLOW_NAV, PRIMARY_NAV, type NavDest } from "./nav-links";
import { NavModeToggle } from "./nav-mode-toggle";
import { NavSheetLink } from "./nav-sheet-link";

function TabLink({ dest, active, onClick }: { dest: NavDest; active: boolean; onClick?: () => void }) {
  return (
    <Link
      href={dest.href}
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={cx(
        "flex flex-1 flex-col items-center justify-center gap-0.5 text-[10px] transition-colors",
        active ? "text-accent-400" : "text-paper-400 hover:text-paper-200",
      )}
    >
      <NavIcon name={dest.icon} className="size-5" />
      {dest.label}
    </Link>
  );
}

/**
 * Mobile primary navigation as a fixed bottom tab bar (docs/ui/mobile.md
 * §Primary nav) — the default nav chrome. Four primary destinations plus a "More" tab opening a
 * bottom sheet with the overflow links and the nav-style switch. `md:hidden`:
 * the desktop top-nav takes over at ≥768px. AppShell suppresses this entirely on
 * the conversation screen.
 */
export function BottomTabBar({
  navMode,
  onNavModeChange,
}: {
  navMode: NavMode;
  onNavModeChange: (mode: NavMode) => void;
}) {
  const pathname = usePathname();
  const [moreOpen, setMoreOpen] = useState(false);
  const overflowActive = OVERFLOW_NAV.some((d) => isNavActive(pathname, d));

  return (
    <>
      <nav
        aria-label="Primary"
        className="fixed inset-x-0 bottom-0 z-40 flex h-14 border-t border-ink-600 bg-ink-900/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden"
      >
        {PRIMARY_NAV.map((dest) => (
          <TabLink key={dest.href} dest={dest} active={isNavActive(pathname, dest)} />
        ))}
        <button
          type="button"
          onClick={() => setMoreOpen(true)}
          aria-haspopup="dialog"
          aria-expanded={moreOpen}
          className={cx(
            "flex flex-1 flex-col items-center justify-center gap-0.5 text-[10px] transition-colors",
            overflowActive ? "text-accent-400" : "text-paper-400 hover:text-paper-200",
          )}
        >
          <NavIcon name="more" className="size-5" />
          More
        </button>
      </nav>

      <Sheet open={moreOpen} onClose={() => setMoreOpen(false)} side="bottom" title="More" className="md:hidden">
        <div className="flex flex-col gap-1 p-3">
          {OVERFLOW_NAV.map((dest) => (
            <NavSheetLink
              key={dest.href}
              dest={dest}
              active={isNavActive(pathname, dest)}
              onNavigate={() => setMoreOpen(false)}
            />
          ))}
          <div className="mt-2 border-t border-ink-600 pt-3">
            <NavModeToggle value={navMode} onChange={onNavModeChange} />
          </div>
        </div>
      </Sheet>
    </>
  );
}
