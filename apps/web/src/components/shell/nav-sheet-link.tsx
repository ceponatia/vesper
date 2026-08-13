"use client";

import Link from "next/link";
import { cx } from "@/components/ui/cx";
import { NavIcon } from "./nav-icons";
import type { NavDest } from "./nav-links";

/** Full-width nav row shared by the mobile nav drawer and the bottom-bar "More" sheet. */
export function NavSheetLink({
  dest,
  active,
  onNavigate,
}: {
  dest: NavDest;
  active: boolean;
  onNavigate: () => void;
}) {
  return (
    <Link
      href={dest.href}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      className={cx(
        "touch-target flex items-center gap-3 rounded-md px-3 text-sm transition-colors",
        active ? "bg-ink-800 text-paper-50" : "text-paper-300 hover:bg-ink-800 hover:text-paper-100",
      )}
    >
      <NavIcon name={dest.icon} className="size-5 shrink-0" />
      {dest.label}
    </Link>
  );
}
