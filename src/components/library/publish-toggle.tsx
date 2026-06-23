"use client";

import { useState } from "react";
import { charactersApi, itemsApi, locationsApi, type Visibility } from "@/lib/client/api";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";

export type ShareableKind = "character" | "location" | "item";

const updaters: Record<ShareableKind, (id: string, body: unknown) => ReturnType<typeof charactersApi.update>> = {
  character: charactersApi.update,
  location: locationsApi.update,
  item: itemsApi.update,
};

/**
 * Publish / un-publish a shareable entity (auth.plan.md). Public ⇒ discoverable
 * and **copyable** by anyone (copy-on-use: they get an owned copy, never a live
 * reference to yours). An independent action, not part of the editor's save —
 * it owns the visibility state once mounted.
 */
export function PublishToggle({ kind, id, visibility }: { kind: ShareableKind; id: string; visibility: Visibility }) {
  const toast = useToast();
  const [current, setCurrent] = useState<Visibility>(visibility);
  const [busy, setBusy] = useState(false);
  const isPublic = current === "public";

  async function toggle() {
    const next: Visibility = isPublic ? "private" : "public";
    setBusy(true);
    const result = await updaters[kind](id, { visibility: next });
    setBusy(false);
    if (!result.ok) {
      toast.push({ title: "Couldn't change visibility", description: result.error.message, tone: "error" });
      return;
    }
    setCurrent(next);
    toast.push({
      title: next === "public" ? "Published" : "Made private",
      description: next === "public" ? "Anyone can now find and copy this." : "Only you can see this now.",
      tone: "success",
    });
  }

  return (
    <Button
      variant="ghost"
      size="sm"
      busy={busy}
      onClick={toggle}
      title={isPublic ? "Public — discoverable and copyable by anyone. Click to make private." : "Private — only you. Click to publish."}
    >
      {isPublic ? "● Public" : "○ Private"}
    </Button>
  );
}
