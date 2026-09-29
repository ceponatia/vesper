"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { charactersApi } from "@/lib/client/api";
import { useToast } from "@/components/ui/toast";

/**
 * Forge creates a blank character the same way the library's New does
 * (create-on-new, `entity-library.tsx` `createBlank`), then opens it with the
 * creation-brief panel expanded (`character-edit-page.tsx`). Shared by the
 * library's Forge control and the dashboard's "forge someone" link so both
 * create-and-open the same way, with their own busy state guarding double-clicks.
 */
export function useForgeCharacter() {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  const forge = async () => {
    if (busy) return;
    setBusy(true);
    // Randomized placeholder (create-on-new): several fresh characters never
    // share a name, so nothing dupes or shadows in pickers.
    const name = `Untitled character ${Math.random().toString(36).slice(2, 6)}`;
    const result = await charactersApi.create({ name });
    setBusy(false);
    if (result.ok) router.push(`/characters/${result.data.id}?forge=1`);
    else toast.push({ title: "Couldn't create", description: result.error.message, tone: "error" });
  };

  return { busy, forge };
}
