"use client";

import { useState } from "react";
import { useSession } from "@/lib/client/use-session";
import { useIsAdmin } from "@/components/hooks/use-is-admin";
import { Composer } from "./composer";
import { Feed } from "./feed";
import { SidePanel } from "./side-panel";

/**
 * The play screen (docs/ui.md §Play screen): feed + composer center, tabbed
 * side panel right; the panel collapses to a drawer under lg. Fills the
 * viewport below the 3.25rem app header so the feed scrolls internally.
 */
export function PlayScreen({ sessionId }: { sessionId: string }) {
  const session = useSession(sessionId);
  const isAdmin = useIsAdmin();
  const [drawerOpen, setDrawerOpen] = useState(false);

  return (
    // No flex-1 here: as a flex item its basis would override the explicit
    // height and stretch the page to content size (document scroll, dead
    // trackpad over the overscroll-contained feed, sidebar scrolling away).
    <div className="flex h-[calc(100dvh-3.25rem)] min-h-0">
      <section className="flex min-h-0 min-w-0 flex-1 flex-col">
        <Feed session={session} />
        <Composer session={session} />
      </section>

      <aside
        aria-label="Session state"
        className="hidden w-88 shrink-0 border-l border-ink-600 bg-ink-900 lg:block xl:w-96"
      >
        <SidePanel session={session} isAdmin={isAdmin} />
      </aside>

      {/* Drawer trigger + overlay under lg */}
      <button
        type="button"
        onClick={() => setDrawerOpen(true)}
        aria-label="Open session panel"
        className="fixed right-4 bottom-28 z-40 cursor-pointer rounded-full border border-ink-500 bg-ink-800 px-4 py-2 text-xs text-paper-200 shadow-lift hover:border-accent-500 lg:hidden"
      >
        World
      </button>
      {drawerOpen ? (
        <div
          className="fixed inset-0 z-50 flex justify-end bg-ink-950/60 backdrop-blur-[2px] lg:hidden"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setDrawerOpen(false);
          }}
        >
          <div className="flex h-full w-[88vw] max-w-96 flex-col border-l border-ink-600 bg-ink-900">
            <div className="flex justify-end border-b border-ink-600 px-2 py-1">
              <button
                type="button"
                onClick={() => setDrawerOpen(false)}
                aria-label="Close session panel"
                className="cursor-pointer rounded-md px-2 py-1 text-paper-500 hover:text-paper-100"
              >
                ×
              </button>
            </div>
            <div className="min-h-0 flex-1">
              <SidePanel session={session} isAdmin={isAdmin} />
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
