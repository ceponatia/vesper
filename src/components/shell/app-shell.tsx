"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { cx } from "@/components/ui/cx";

const navLinks = [
  { href: "/worlds", label: "Worlds" },
  { href: "/characters", label: "Characters" },
  { href: "/locations", label: "Locations" },
  { href: "/items", label: "Items" },
  { href: "/gallery", label: "Gallery" },
] as const;

/**
 * Global chrome: slim header + unconstrained main. Pages wrap themselves in
 * <PageContainer>; the play screen uses the full viewport.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  return (
    <>
      {/* h-13 (3.25rem) on the header itself, border included (border-box): the
          play screen sizes itself with calc(100dvh - 3.25rem) and a 1px
          mismatch puts a scrollbar on the document. */}
      <header className="sticky top-0 z-40 h-13 border-b border-ink-600 bg-ink-900/90 backdrop-blur">
        <div className="mx-auto flex h-full max-w-7xl items-center gap-6 px-4 sm:px-6">
          <Link href="/" className="prose-display text-lg tracking-wide text-paper-50 italic">
            Vesper
          </Link>
          <nav className="flex items-center gap-1 text-sm">
            {navLinks.map((link) => {
              const active = pathname === link.href || pathname.startsWith(`${link.href}/`);
              return (
                <Link
                  key={link.href}
                  href={link.href}
                  aria-current={active ? "page" : undefined}
                  className={cx(
                    "rounded-md px-2.5 py-1.5 transition-colors",
                    active ? "bg-ink-800 text-paper-50" : "text-paper-400 hover:text-paper-100",
                  )}
                >
                  {link.label}
                </Link>
              );
            })}
          </nav>
        </div>
      </header>
      <main className="flex min-h-0 flex-1 flex-col">{children}</main>
    </>
  );
}

/** Standard reading-width wrapper for everything except the play screen. */
export function PageContainer({ children, wide = false }: { children: ReactNode; wide?: boolean }) {
  return (
    <div className={cx("mx-auto w-full px-4 py-8 sm:px-6", wide ? "max-w-7xl" : "max-w-5xl")}>{children}</div>
  );
}
