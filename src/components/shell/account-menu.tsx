"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { signOut, useSession } from "@/components/auth/auth-client";

/**
 * Header identity control (auth.plan.md): the signed-in user's name + a sign-out
 * button, or a "Sign in" link when there's no session. Reads Better Auth's
 * reactive session, so it tracks sign-in/out without a reload.
 */
export function AccountMenu() {
  const { data, isPending } = useSession();
  const router = useRouter();
  const [busy, setBusy] = useState(false);

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
    <div className="flex items-center gap-2">
      <span className="hidden max-w-32 truncate text-sm text-paper-400 sm:inline">{data.user.name}</span>
      <Button variant="quiet" size="sm" busy={busy} onClick={onSignOut}>
        Sign out
      </Button>
    </div>
  );
}
