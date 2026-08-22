"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { cx } from "@/components/ui/cx";
import { signOut, useSession } from "@/components/auth/auth-client";
import { useIsAdmin } from "@/components/hooks/use-is-admin";

/**
 * Header identity control (auth.plan.md): the signed-in user's name as a
 * dropdown trigger — opening a small menu to **Settings** (the profile / default
 * player character, player-character.plan.md) and **Sign out** — or a "Sign in"
 * link when there's no session. Reads Better Auth's reactive session, so it
 * tracks sign-in/out without a reload.
 */
export function AccountMenu() {
  const { data, isPending } = useSession();
  const isAdmin = useIsAdmin();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Close on outside click or Escape while the menu is open (a subscription, not
  // a sync setState-in-effect — added only while open and torn down on close).
  useEffect(() => {
    if (!open) return;
    function onDocPointer(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDocPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  async function onSignOut() {
    setBusy(true);
    await signOut();
    router.push("/sign-in");
    router.refresh();
  }

  if (isPending) return null;

  if (!data?.user) {
    return (
      <Link href="/sign-in" className="text-sm text-paper-400 transition-colors hover:text-paper-100">
        Sign in
      </Link>
    );
  }

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex items-center gap-1 rounded-md px-2 py-1 text-sm text-paper-400 transition-colors hover:text-paper-100"
      >
        <span className="max-w-32 truncate">{data.user.name}</span>
        <svg
          className={cx("size-3.5 transition-transform", open && "rotate-180")}
          viewBox="0 0 16 16"
          fill="none"
          aria-hidden="true"
        >
          <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open ? (
        <div
          role="menu"
          className="absolute top-full right-0 z-50 mt-1 w-48 overflow-hidden rounded-card border border-ink-600 bg-ink-800 py-1 shadow-lift"
        >
          <Link
            href="/settings"
            role="menuitem"
            onClick={() => setOpen(false)}
            className="block px-3 py-2 text-sm text-paper-200 transition-colors hover:bg-ink-700"
          >
            Settings
          </Link>
          {isAdmin ? (
            // Admin-only (R4, engine.rollout.plan.md): the Engine Comparison
            // review screen — reports and rulings without touching the API by hand.
            <Link
              href="/admin/shadow"
              role="menuitem"
              onClick={() => setOpen(false)}
              className="block px-3 py-2 text-sm text-paper-200 transition-colors hover:bg-ink-700"
            >
              Engine Comparison
            </Link>
          ) : null}
          <div className="my-1 border-t border-ink-600" />
          <button
            type="button"
            role="menuitem"
            onClick={onSignOut}
            disabled={busy}
            className="block w-full px-3 py-2 text-left text-sm text-paper-300 transition-colors hover:bg-ink-700 disabled:opacity-50"
          >
            {busy ? "Signing out…" : "Sign out"}
          </button>
        </div>
      ) : null}
    </div>
  );
}
