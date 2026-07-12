"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { cx } from "@/components/ui/cx";
import { readStoredNavMode, type NavMode } from "@/lib/nav-mode";
import { AccountMenu } from "./account-menu";
import { ContrastToggle } from "./contrast-toggle";
import { BottomTabBar } from "./bottom-tab-bar";
import { NavDrawer } from "./nav-drawer";
import { isNavActive, NAV_LINKS } from "./nav-links";

/**
 * Global chrome: slim header + unconstrained main. Pages wrap themselves in
 * <PageContainer>; the play screen uses the full viewport.
 *
 * Responsive nav (docs/ui.md §Mobile): the desktop top-nav shows at ≥md; below
 * md one of two mobile chromes takes over per the persisted nav-mode — the
 * bottom tab bar (default) or a hamburger drawer. The mode is a two-value union,
 * so exactly one chrome is ever chosen. The bottom bar is suppressed on the
 * immersive play screen (its fixed footer would collide with the composer); the
 * hamburger lives in the header, so it stays available everywhere.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [navMode, setNavMode] = useState<NavMode>("tabs");

  // Sync the stored mode after mount (deferred past a microtask, per the
  // no-sync-setState-in-effects rule — mirrors ContrastToggle).
  useEffect(() => {
    const stored = readStoredNavMode();
    if (stored !== "tabs") void Promise.resolve().then(() => setNavMode(stored));
  }, []);

  // Immersive surfaces own the bottom edge (their composer would collide with the
  // fixed tab bar): the play screen and the full-screen conversation page — but not
  // the /chat hub, which is a normal list page.
  const immersive = pathname.startsWith("/sessions/") || /^\/chat\/[^/]+/.test(pathname);
  const showBottomBar = navMode === "tabs" && !immersive;

  // The sign-in page stands alone — no nav chrome (you're not "in" the app yet).
  if (pathname === "/sign-in") return <>{children}</>;

  return (
    <>
      {/* h-13 (3.25rem) on the header itself, border included (border-box): the
          play screen sizes itself with calc(100dvh - 3.25rem) and a 1px
          mismatch puts a scrollbar on the document. Do not let this height drift. */}
      <header className="sticky top-0 z-40 h-13 border-b border-ink-600 bg-ink-900/90 backdrop-blur">
        <div className="mx-auto flex h-full max-w-7xl items-center gap-4 px-4 sm:gap-6 sm:px-6">
          {navMode === "drawer" ? <NavDrawer navMode={navMode} onNavModeChange={setNavMode} /> : null}
          <Link href="/" className="prose-display text-lg tracking-wide text-paper-50 italic">
            Vesper
          </Link>
          <nav className="hidden items-center gap-1 text-sm md:flex">
            {NAV_LINKS.map((link) => {
              const active = isNavActive(pathname, link);
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
          <div className="ml-auto flex items-center gap-3">
            <ContrastToggle />
            <AccountMenu />
          </div>
        </div>
      </header>
      <main
        className={cx(
          "flex min-h-0 flex-1 flex-col",
          showBottomBar && "pb-[calc(3.5rem+env(safe-area-inset-bottom))] md:pb-0",
        )}
      >
        {children}
      </main>
      {showBottomBar ? <BottomTabBar navMode={navMode} onNavModeChange={setNavMode} /> : null}
    </>
  );
}

/** Standard reading-width wrapper for everything except the play screen. */
export function PageContainer({ children, wide = false }: { children: ReactNode; wide?: boolean }) {
  return (
    <div className={cx("mx-auto w-full px-4 py-8 sm:px-6", wide ? "max-w-7xl" : "max-w-5xl")}>{children}</div>
  );
}
