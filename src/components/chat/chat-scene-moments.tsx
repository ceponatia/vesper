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

/** Group the ready, anchored scenes by their anchor message id (oldest render first). */
export function scenesByAnchor(scenes: readonly ImageRecord[]): Map<string, ImageRecord[]> {
  const map = new Map<string, ImageRecord[]>();
  for (const scene of scenes) {
    if (scene.status !== "ready") continue;
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
      {images.map((img) => (
        <button
          key={img.id}
          type="button"
          onClick={() => setEnlarged({ id: img.id, prompt: img.prompt || null })}
          aria-label="Enlarge scene moment"
          className="block w-36 cursor-pointer overflow-hidden rounded-card border border-ink-600 transition-colors hover:border-accent-500/60"
        >
          <EntityImage imageId={img.id} name={name} className="aspect-[3/4] w-full" />
        </button>
      ))}
      <ImageLightbox
        imageId={enlarged?.id ?? null}
        alt={name}
        prompt={enlarged?.prompt ?? null}
        onClose={() => setEnlarged(null)}
      />
    </div>
  );
}
