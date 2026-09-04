"use client";

import { useState } from "react";
import {
  referenceViewsApi,
  type ReferenceViewAngleId,
  type ReferenceViewHistoryEntry,
  type ReferenceViewWardrobe,
} from "@/lib/client/api";
import { timeAgo } from "@/lib/relative-time";
import { useAsyncData } from "@/components/hooks/use-async";
import { Dialog } from "@/components/ui/dialog";
import { EntityImage } from "@/components/ui/entity-image";
import { ImageLightbox } from "@/components/ui/image-lightbox";
import { Tag } from "@/components/ui/tag";
import { referenceViewMethodCopy, referenceViewVerdictCopy } from "./reference-view-copy";

/**
 * Every image one reference-view slot has produced, newest first, each with the
 * ruling it was given.
 *
 * **Why it exists.** A slot's card shows exactly one picture — the current one —
 * so judging a change to the view instructions means comparing the render on
 * screen against a render nobody can see any more. This list is the evidence: it
 * shows what the same slot produced before, whether the owner approved it,
 * rejected it, or replaced it without looking, and it enlarges any of them.
 *
 * **READ-ONLY, absolutely.** Nothing here approves, rejects, regenerates or
 * restores. Opening the list, scrolling it and enlarging an entry leave the
 * slot's current image and its verdict exactly as they were — which is what
 * makes it safe to open a history in the middle of a review.
 *
 * **The overlay is borrowed, not rebuilt.** The list rides `Dialog`, so the
 * backdrop, the Escape/backdrop close and the focus trap are the shared ones,
 * and enlarging an entry opens the shared `ImageLightbox`
 * (docs/ui/conventions.md §Image lightbox) as a SIBLING of the dialog rather
 * than a child of it: the focus trap stacks, so Escape closes the enlarged image
 * first and lands the owner back on the list they opened it from.
 *
 * **The list is bounded and says so.** The maintenance sweep collects a replaced
 * view's bytes after the retention window, and an attempt with nothing to look
 * at is not listed at all — so the footer states the window rather than letting
 * a truncated list read as the whole story.
 */

export interface ReferenceViewHistorySlot {
  angle: ReferenceViewAngleId;
  wardrobe: ReferenceViewWardrobe;
  /** The slot in the studio's own words — "Back, full length, Undressed". */
  label: string;
}

export interface ReferenceViewHistoryProps {
  characterId: string;
  slot: ReferenceViewHistorySlot;
  onClose: () => void;
}

export function ReferenceViewHistory({ characterId, slot, onClose }: ReferenceViewHistoryProps) {
  const history = useAsyncData(
    () => referenceViewsApi.history(characterId, slot.angle, slot.wardrobe),
    [characterId, slot.angle, slot.wardrobe],
  );
  const [enlarged, setEnlarged] = useState<ReferenceViewHistoryEntry | null>(null);

  const entries = history.data?.entries ?? [];
  const retentionDays = history.data?.retentionDays ?? 0;

  return (
    <>
      <Dialog open onClose={onClose} title={`${slot.label} — past images`} size="xl">
        {history.loading ? <p className="text-xs text-paper-500">Reading this view&apos;s history…</p> : null}
        {!history.loading && history.data === null ? (
          <p className="text-xs text-paper-500">This view&apos;s history could not be read.</p>
        ) : null}
        {!history.loading && history.data !== null && entries.length === 0 ? (
          <p className="text-xs text-paper-500">Nothing has been kept for this view yet.</p>
        ) : null}

        {entries.length > 0 ? (
          <ul className="flex flex-col gap-2">
            {entries.map((entry) => {
              const verdict = referenceViewVerdictCopy[entry.verdict];
              return (
                <li
                  key={entry.id}
                  className="flex items-start gap-3 rounded-card border border-ink-600 bg-ink-950/40 p-2"
                >
                  <button
                    type="button"
                    onClick={() => setEnlarged(entry)}
                    aria-label={`Enlarge this ${verdict.label} attempt`}
                    className="block w-16 shrink-0 cursor-pointer overflow-hidden rounded-card border border-ink-700"
                  >
                    <EntityImage
                      imageId={entry.imageId}
                      name={slot.label}
                      alt={slot.label}
                      className="aspect-[3/4] w-full"
                    />
                  </button>
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <Tag tone={verdict.tone}>{verdict.label}</Tag>
                      {entry.current ? <Tag tone="accent">on the card now</Tag> : null}
                    </div>
                    <div className="flex flex-wrap items-center gap-2 text-[11px] text-paper-500">
                      {entry.method === null ? null : <span>{referenceViewMethodCopy[entry.method]}</span>}
                      <span>{timeAgo(entry.createdAt)}</span>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        ) : null}

        {retentionDays > 0 ? (
          <p className="mt-3 border-t border-ink-700 pt-2 text-[11px] text-paper-600">
            {`Replaced images are kept for ${String(retentionDays)} days.`}
          </p>
        ) : null}
      </Dialog>

      <ImageLightbox
        imageId={enlarged?.imageId ?? null}
        alt={slot.label}
        caption={enlarged === null ? null : `${slot.label} — ${referenceViewVerdictCopy[enlarged.verdict].label}`}
        onClose={() => setEnlarged(null)}
      />
    </>
  );
}
