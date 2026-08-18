"use client";

import { useState } from "react";
import { charactersApi, itemsApi, locationsApi, socialCardsApi, type ApiResult, type Visibility } from "@/lib/client/api";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/toast";
import {
  CHARACTER_PUBLISH_CONFIRM,
  CLONE_DISCLOSURE,
  MADE_PRIVATE_TOAST,
  PUBLISHED_TOAST,
  publishConfirmRequired,
  type ShareableKind,
} from "./publish-disclosure";

export type { ShareableKind };

// The toggle reads only `ok` — each kind's PATCH returns its own envelope
// (a character's carries the saved profile), so the shared shape is the widest one.
const updaters: Record<ShareableKind, (id: string, body: unknown) => Promise<ApiResult<unknown>>> = {
  character: charactersApi.update,
  location: locationsApi.update,
  item: itemsApi.update,
  social_card: socialCardsApi.update,
};

/**
 * Publish / un-publish a shareable entity (auth.plan.md). Public ⇒ discoverable
 * and **copyable** by anyone (copy-on-use: they get an owned copy, never a live
 * reference to yours). An independent action, not part of the editor's save —
 * it owns the visibility state once mounted.
 *
 * Disclosure is two-layer, per the owner ruling (2026-07-31): the one-line
 * summary sits inline beside the button so an author reads it *while* deciding,
 * and publishing a **character** — the only kind carrying private authored
 * fields, and the only irreversible direction — additionally routes through a
 * confirmation naming what a copy takes (full profile, images) and what
 * unpublishing can't undo. Every other move stays one click. Copy and flow rule
 * both live in `./publish-disclosure` so a test pins them.
 */
export function PublishToggle({ kind, id, visibility }: { kind: ShareableKind; id: string; visibility: Visibility }) {
  const toast = useToast();
  const [current, setCurrent] = useState<Visibility>(visibility);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const isPublic = current === "public";
  const next: Visibility = isPublic ? "private" : "public";
  // Whether this *kind* can ever ask to confirm — the dialog is mounted only
  // then, so an item's toggle never carries the character copy in its tree.
  const confirmable = publishConfirmRequired(kind, "public");

  async function apply() {
    setBusy(true);
    const result = await updaters[kind](id, { visibility: next });
    setBusy(false);
    if (!result.ok) {
      // Confirm stays open on failure so the author can retry without re-reading it.
      toast.push({ title: "Couldn't change visibility", description: result.error.message, tone: "error" });
      return;
    }
    setConfirming(false);
    setCurrent(next);
    toast.push({
      title: next === "public" ? "Published" : "Made private",
      description: next === "public" ? PUBLISHED_TOAST[kind] : MADE_PRIVATE_TOAST,
      tone: "success",
    });
  }

  return (
    <div className="flex min-w-0 flex-col items-start gap-1">
      <Button
        variant="ghost"
        size="sm"
        busy={busy && !confirming}
        onClick={() => {
          if (publishConfirmRequired(kind, next)) setConfirming(true);
          else void apply();
        }}
        aria-haspopup={confirmable && !isPublic ? "dialog" : undefined}
        title={isPublic ? "Public — discoverable and copyable by anyone. Click to make private." : "Private — only you. Click to publish."}
      >
        {isPublic ? "● Public" : "○ Private"}
      </Button>
      <p className="max-w-xs text-xs text-paper-500">{CLONE_DISCLOSURE[kind]}</p>
      {confirmable ? (
        <Dialog
          open={confirming}
          onClose={() => setConfirming(false)}
          title={CHARACTER_PUBLISH_CONFIRM.title}
          footer={
            <>
              <Button onClick={() => setConfirming(false)}>{CHARACTER_PUBLISH_CONFIRM.cancelLabel}</Button>
              <Button variant="primary" busy={busy} onClick={() => void apply()}>
                {CHARACTER_PUBLISH_CONFIRM.confirmLabel}
              </Button>
            </>
          }
        >
          <div className="flex flex-col gap-2">
            {CHARACTER_PUBLISH_CONFIRM.paragraphs.map((paragraph) => (
              <p key={paragraph}>{paragraph}</p>
            ))}
          </div>
        </Dialog>
      ) : null}
    </div>
  );
}
