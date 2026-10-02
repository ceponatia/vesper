"use client";

import { useState } from "react";
import { ownedImagesApi, type ImageRecord } from "@/lib/client/api";
import {
  imageRecoverableHint,
  imageRecoverActionLabel,
  imageRecoverFailedTitle,
  imageRecoveredToastTitle,
} from "@/components/images/recovery-copy";
import { Button } from "@/components/ui/button";
import { EntityImage } from "@/components/ui/entity-image";
import { ImageLightbox } from "@/components/ui/image-lightbox";
import { useToast } from "@/components/ui/toast";

/**
 * Inline scene moments: scene images rendered IN the transcript, under the
 * assistant message they were anchored to at generation time — a long chat
 * reads like an illustrated story.
 * Un-anchored (legacy) scenes stay strip-only; a dangling anchor (its message was
 * deleted or rerun-snipped) simply matches no line and degrades to strip-only too.
 */

/**
 * Group the anchored scenes by their anchor message id (oldest render first).
 * Ready renders always show. A FAILED non-selfie scene shows too, but only
 * while its paid output can still be recovered (`recoverable`) — the owner
 * ruling for issue #686: unlike a selfie, an ordinary failed scene is not
 * otherwise worth a permanent placeholder in the transcript, so one that
 * can never be recovered is left out exactly as before #686. A FAILED selfie
 * always shows (the retry ruling's "Failed" placeholder, enlarging to
 * the sent prompt for debugging) whether or not it is recoverable — because a
 * photo message that silently never arrives would leave the reply's "sending
 * you this…" dangling — and it additionally gains the Recover action once
 * `recoverable` is true.
 */
export function scenesByAnchor(scenes: readonly ImageRecord[]): Map<string, ImageRecord[]> {
  const map = new Map<string, ImageRecord[]>();
  for (const scene of scenes) {
    const failedSelfie = scene.status === "failed" && scene.meta.flavor === "selfie";
    const failedRecoverable = scene.status === "failed" && scene.recoverable;
    if (scene.status !== "ready" && !failedSelfie && !failedRecoverable) continue;
    const anchor = scene.anchorMessageId;
    if (!anchor) continue;
    const list = map.get(anchor) ?? [];
    list.push(scene);
    map.set(anchor, list);
  }
  for (const list of map.values()) list.reverse(); // list arrives newest-first; read oldest-first inline
  return map;
}

/** The thumbnails under one message — tap to enlarge (shared lightbox idiom).
 * `onRecovered` refetches the chat's scenes list after a recovery lands or a
 * refusal reports `expired` (threaded from `chat-conversation.tsx`'s
 * `scenes.reload`, the same handle the scene strip and the poll already
 * share) — there is deliberately no second data path here. */
export function SceneMomentRow({
  images,
  name,
  onRecovered,
}: {
  images: ImageRecord[];
  name: string;
  onRecovered: () => void;
}) {
  const toast = useToast();
  const [enlarged, setEnlarged] = useState<{ id: string; prompt: string | null } | null>(null);
  // Tracked per image id, not a single flag: Civitai's download retry can take
  // minutes, and only the recovering tile's own control should wait on it —
  // every other tile in the row (and the row's own poll) stays live.
  const [recovering, setRecovering] = useState<ReadonlySet<string>>(new Set());
  if (!images.length) return null;

  const recover = async (img: ImageRecord) => {
    setRecovering((prev) => new Set(prev).add(img.id));
    const result = await ownedImagesApi.recover(img.id);
    setRecovering((prev) => {
      const next = new Set(prev);
      next.delete(img.id);
      return next;
    });
    if (!result.ok) {
      toast.push({ title: imageRecoverFailedTitle, description: result.error.message, tone: "error" });
      // The offer is gone for good — refetch so the tile drops the action
      // rather than offering a recovery that will only refuse again.
      if (result.error.code === "expired") onRecovered();
      return;
    }
    toast.push({ title: imageRecoveredToastTitle, description: "It now shows in the conversation." });
    onRecovered();
  };

  return (
    // overflow-x-auto (matching the sibling scene strip, chat-scene-strip.tsx):
    // 3+ fixed-width thumbnails would otherwise overflow the transcript column
    // with no wrap or scroll. shrink-0 keeps each thumb at its full w-36
    // instead of the flex row squeezing them to fit.
    <div className="ml-10 flex gap-2 overflow-x-auto pb-1">
      {images.map((img) => {
        const selfie = img.meta.flavor === "selfie";
        const failed = img.status === "failed";
        const borderClass = selfie ? "rounded-2xl border-accent-500/40" : "rounded-card border-ink-600";

        // A recoverable failed tile needs TWO independent controls — enlarge
        // (for the sent prompt, same debugging value the plain Failed tile
        // always had) and Recover — so it cannot be the single outer <button>
        // every other tile is: nesting the Recover button inside it would
        // nest a button in a button. Every other tile (ready, or failed and
        // NOT recoverable) keeps that exact original single-button shape.
        if (failed && img.recoverable) {
          return (
            <div key={img.id} className={`block w-36 shrink-0 overflow-hidden border ${borderClass}`}>
              <button
                type="button"
                onClick={() => setEnlarged({ id: img.id, prompt: img.prompt || null })}
                aria-label={selfie ? "Selfie failed — enlarge for details" : "Scene image failed — enlarge for details"}
                className="flex aspect-[3/4] w-full cursor-pointer flex-col items-center justify-center gap-1.5 bg-ink-800 px-2 text-center text-paper-500 transition-colors hover:border-accent-500/60"
              >
                <span className="text-sm font-medium">Failed</span>
                <span className="text-[10px] leading-snug text-paper-600">{imageRecoverableHint}</span>
              </button>
              <div className="border-t border-ink-700 bg-ink-900/60 p-1.5">
                <Button
                  size="sm"
                  variant="primary"
                  className="w-full"
                  busy={recovering.has(img.id)}
                  aria-label={selfie ? `Recover the photo from ${name}` : "Recover this scene image"}
                  onClick={() => void recover(img)}
                >
                  {imageRecoverActionLabel}
                </Button>
              </div>
            </div>
          );
        }

        return (
          <button
            key={img.id}
            type="button"
            onClick={() => setEnlarged({ id: img.id, prompt: img.prompt || null })}
            aria-label={failed ? "Selfie failed — enlarge for details" : selfie ? `Photo from ${name}` : "Enlarge scene moment"}
            title={selfie ? `A photo from ${name}` : undefined}
            className={`block w-36 shrink-0 cursor-pointer overflow-hidden border transition-colors hover:border-accent-500/60 ${borderClass}`}
          >
            {failed ? (
              // The retry-once policy exhausted and nothing (left) to
              // recover: a plain "Failed" tile; enlarging shows the sent
              // prompt (admin panel) for debugging.
              <div className="flex aspect-[3/4] w-full flex-col items-center justify-center gap-1 bg-ink-800 text-paper-500">
                <span className="text-sm font-medium">Failed</span>
                <span className="px-2 text-center text-[10px] text-paper-600">the photo never arrived</span>
              </div>
            ) : (
              <EntityImage imageId={img.id} name={name} className="aspect-[3/4] w-full" />
            )}
          </button>
        );
      })}
      <ImageLightbox
        imageId={enlarged?.id ?? null}
        alt={name}
        prompt={enlarged?.prompt ?? null}
        onClose={() => setEnlarged(null)}
      />
    </div>
  );
}
