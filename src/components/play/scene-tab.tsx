"use client";

import { useEffect, useState } from "react";
import { z } from "zod";
import { apiPost } from "@/lib/client/api";
import type { UseSession } from "@/lib/client/use-session";
import { Button } from "@/components/ui/button";
import { cx } from "@/components/ui/cx";
import { EntityImage } from "@/components/ui/entity-image";
import { ImageLightbox } from "@/components/ui/image-lightbox";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";

const INTERVALS = [
  { value: 0, label: "Off" },
  { value: 2, label: "Every 2 turns" },
  { value: 4, label: "Every 4 turns" },
  { value: 8, label: "Every 8 turns" },
] as const;

const GENERATING_POLL_MS = 4000;

/** Scene tab: current image, gallery strip, generate-now, interval (docs/ui.md). */
export function SceneTab({ session }: { session: UseSession }) {
  const toast = useToast();
  const [viewingId, setViewingId] = useState<string | null>(null);
  const [enlargedId, setEnlargedId] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  const scene = session.status?.scene ?? null;
  const generating = scene?.gen.status === "generating";

  // While an image is rendering, quietly re-poll status so it appears.
  // `refresh` is stable per session id (use-session.ts), so this resubscribes
  // only when polling starts/stops or the session changes.
  const { refresh } = session;
  useEffect(() => {
    if (!generating) return;
    const timer = setInterval(() => void refresh(), GENERATING_POLL_MS);
    return () => clearInterval(timer);
  }, [generating, refresh]);

  const act = async (body: Record<string, unknown>, failure: string) => {
    setWorking(true);
    const result = await apiPost(z.unknown(), `/api/sessions/${session.sessionId}/scene`, body);
    setWorking(false);
    if (!result.ok) {
      toast.push({ title: failure, description: result.error.message, tone: "error" });
      return;
    }
    await session.refresh();
  };

  if (session.statusLoading) {
    return (
      <div className="flex flex-col gap-3 p-4">
        <Skeleton className="aspect-video w-full rounded-card" />
        <Skeleton className="h-8 w-1/2" />
      </div>
    );
  }

  const shownId = viewingId ?? scene?.currentImageId ?? null;
  const gallery = scene?.gallery ?? [];

  return (
    <div className="flex flex-col gap-4 p-4">
      {shownId ? (
        <button
          type="button"
          onClick={() => setEnlargedId(shownId)}
          aria-label="Enlarge scene image"
          className="block w-full cursor-pointer"
        >
          <EntityImage
            imageId={shownId}
            name={session.status?.title ?? "Scene"}
            className="aspect-video w-full rounded-card border border-ink-600"
          />
        </button>
      ) : (
        <div className="flex aspect-video w-full items-center justify-center rounded-card border border-dashed border-ink-600 text-sm text-paper-500">
          {generating ? "Painting the scene…" : "No scene image yet"}
        </div>
      )}

      {gallery.length > 0 ? (
        <div className="flex gap-2 overflow-x-auto pb-1" aria-label="Scene gallery">
          {[...gallery].reverse().map((image) => (
            <button
              key={image.id}
              type="button"
              onClick={() => setViewingId(image.id)}
              aria-label="View scene image"
              className={cx(
                "h-14 w-20 shrink-0 cursor-pointer overflow-hidden rounded-md border transition-colors",
                image.id === shownId ? "border-accent-500" : "border-ink-600 hover:border-ink-500",
              )}
            >
              <EntityImage imageId={image.id} name="Scene" className="h-full w-full" />
            </button>
          ))}
        </div>
      ) : null}

      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="primary"
          busy={working || generating}
          onClick={() => void act({ action: "generate" }, "Couldn't request a scene image")}
        >
          {generating ? "Generating…" : "Generate now"}
        </Button>
        {scene?.gen.status === "failed" ? (
          <span className="text-xs text-danger-300">last render failed — try again</span>
        ) : null}
      </div>

      <label className="flex flex-col gap-1.5">
        <span className="text-xs font-medium tracking-wide text-paper-400 uppercase">Auto-generate</span>
        <Select
          value={String(scene?.gen.interval ?? 0)}
          disabled={working}
          onChange={(e) =>
            void act(
              { action: "setInterval", interval: Number(e.target.value) || 0 },
              "Couldn't change the interval",
            )
          }
          className="h-8 text-xs"
        >
          {INTERVALS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </Select>
      </label>

      <ImageLightbox
        imageId={enlargedId}
        alt={session.status?.title ?? "Scene"}
        onClose={() => setEnlargedId(null)}
      />
    </div>
  );
}
