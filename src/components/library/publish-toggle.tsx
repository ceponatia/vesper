"use client";

import { useState } from "react";
import { charactersApi, itemsApi, locationsApi, socialCardsApi, type Visibility } from "@/lib/client/api";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";

export type ShareableKind = "character" | "location" | "item" | "social_card";

const updaters: Record<ShareableKind, (id: string, body: unknown) => ReturnType<typeof charactersApi.update>> = {
  character: charactersApi.update,
  location: locationsApi.update,
  item: itemsApi.update,
  social_card: socialCardsApi.update,
};

/**
 * What a duplicate of a published row actually carries, stated at the control
 * (owner ruling 2026-07-31, "Disclose on publish"). `cloneToLibrary`
 * (`src/server/api/clone.ts`) copies the **whole stored profile**, not the
 * narrowed public preview — so for a character that includes narrator guidance,
 * drives, intimacy notes, and voice anchors a browsing viewer never sees. The
 * ruling kept full-profile duplication and required the author be told, so the
 * copy is a genuine authored starting point AND nobody is surprised by it.
 *
 * Characters are the surface with private authored fields, so they carry the
 * explicit sentence; the other kinds keep the plain copyable statement.
 */
const CLONE_DISCLOSURE: Readonly<Record<ShareableKind, string>> = {
  character:
    "Publishing lets anyone duplicate the full character profile — including private fields the public preview hides, such as narrator guidance, drives, intimacy notes, and voice anchors.",
  location: "Publishing lets anyone duplicate this location into their own library.",
  item: "Publishing lets anyone duplicate this item into their own library.",
  social_card: "Publishing lets anyone duplicate this card into their own library.",
};

/**
 * Publish / un-publish a shareable entity (auth.plan.md). Public ⇒ discoverable
 * and **copyable** by anyone (copy-on-use: they get an owned copy, never a live
 * reference to yours). An independent action, not part of the editor's save —
 * it owns the visibility state once mounted.
 *
 * The clone-policy disclosure sits inline beside the button — no modal, per the
 * ruling: an author deciding whether to publish should read it while deciding,
 * not have to dismiss it.
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
      description:
        next === "public"
          ? kind === "character"
            ? "Anyone can now find this and duplicate the full profile, private fields included."
            : "Anyone can now find and copy this."
          : "Only you can see this now.",
      tone: "success",
    });
  }

  return (
    <div className="flex min-w-0 flex-col items-start gap-1">
      <Button
        variant="ghost"
        size="sm"
        busy={busy}
        onClick={toggle}
        title={isPublic ? "Public — discoverable and copyable by anyone. Click to make private." : "Private — only you. Click to publish."}
      >
        {isPublic ? "● Public" : "○ Private"}
      </Button>
      <p className="max-w-xs text-xs text-paper-500">{CLONE_DISCLOSURE[kind]}</p>
    </div>
  );
}
