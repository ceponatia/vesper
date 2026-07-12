"use client";

import { useState } from "react";
import type { ImageRecord } from "@/lib/client/api";
import { EntityImage } from "@/components/ui/entity-image";
import { ImageLightbox } from "@/components/ui/image-lightbox";

/**
 * Inline scene moments (character-chat-standalone plan area 8, slice 9): scene
 * images rendered IN the transcript, under the assistant message they were
 * anchored to at generation time — a long chat reads like an illustrated story.
 * Un-anchored (legacy) scenes stay strip-only; a dangling anchor (its message was
 * deleted or rerun-snipped) simply matches no line and degrades to strip-only too.
 */

/**
 * Group the anchored scenes by their anchor message id (oldest render first).
 * Ready renders always show; a FAILED selfie also shows — the "Failed"
 * placeholder the retry ruling calls for (chat-selfies.plan.md), enlarging to
 * the sent prompt for debugging — because a photo message that silently never
 * arrives would leave the reply's "sending you this…" dangling.
 */
export function scenesByAnchor(scenes: readonly ImageRecord[]): Map<string, ImageRecord[]> {
  const map = new Map<string, ImageRecord[]>();
  for (const scene of scenes) {
    const failedSelfie = scene.status === "failed" && scene.meta.flavor === "selfie";
    if (scene.status !== "ready" && !failedSelfie) continue;
    const anchor = scene.anchorMessageId;
    if (!anchor) continue;
    const list = map.get(anchor) ?? [];
    list.push(scene);
    map.set(anchor, list);
  }
  for (const list of map.values()) list.reverse(); // list arrives newest-first; read oldest-first inline
  return map;
}

/** The thumbnails under one message — tap to enlarge (shared lightbox idiom). */
export function SceneMomentRow({ images, name }: { images: ImageRecord[]; name: string }) {
  const [enlarged, setEnlarged] = useState<{ id: string; prompt: string | null } | null>(null);
  if (!images.length) return null;
  return (
    <div className="ml-10 flex gap-2">
      {images.map((img) => {
        const selfie = img.meta.flavor === "selfie";
        const failed = img.status === "failed";
        return (
          <button
            key={img.id}
            type="button"
            onClick={() => setEnlarged({ id: img.id, prompt: img.prompt || null })}
            aria-label={failed ? "Selfie failed — enlarge for details" : selfie ? `Photo from ${name}` : "Enlarge scene moment"}
            title={selfie ? `A photo from ${name}` : undefined}
            className={`block w-36 cursor-pointer overflow-hidden border transition-colors hover:border-accent-500/60 ${
              selfie ? "rounded-2xl border-accent-500/40" : "rounded-card border-ink-600"
            }`}
          >
            {failed ? (
              // The retry-once policy exhausted (chat-selfies.plan.md §Rulings): a plain
              // "Failed" tile; enlarging shows the sent prompt (admin panel) for debugging.
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
