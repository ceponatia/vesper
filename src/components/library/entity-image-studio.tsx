"use client";

import { useEffect, useRef, useState } from "react";
import { itemsApi, locationsApi } from "@/lib/client/api";
import { useAsyncData } from "@/components/hooks/use-async";
import { Button } from "@/components/ui/button";
import { cx } from "@/components/ui/cx";
import { EntityImage } from "@/components/ui/entity-image";
import { ImageLightbox } from "@/components/ui/image-lightbox";
import { useToast } from "@/components/ui/toast";

const POLL_MS = 3000;

export interface EntityImageStudioProps {
  entityKind: "item" | "location";
  entityId: string;
  name: string;
  /** The entity's current canonical image id (from its detail row), or null. */
  imageId: string | null;
  /** Called when a fresh image is ready — the parent refetches the entity. */
  onImageChanged: () => void;
}

/**
 * Minimal image studio for library items/locations (docs/images.md §Entity
 * images): one canonical image generated from the entity's fields, a
 * Generate/Regenerate button, and click-to-enlarge. No variants, no upload —
 * if you dislike the result, regenerate. Generation runs as a background job,
 * so leaving the page never interrupts it; this view polls until it lands.
 */
export function EntityImageStudio({ entityKind, entityId, name, imageId, onImageChanged }: EntityImageStudioProps) {
  const api = entityKind === "item" ? itemsApi : locationsApi;
  const toast = useToast();
  const latest = useAsyncData(() => api.image(entityId), [entityKind, entityId]);
  const [generating, setGenerating] = useState(false);
  const [enlarged, setEnlarged] = useState(false);

  const row = latest.data?.image ?? null;
  const pending = generating || row?.status === "pending";
  const { reload } = latest; // stable (useAsyncData memoizes it)

  // The latest row id present when we kicked off — a fresh row with a different
  // id reaching a terminal status means our generation finished (handles the
  // fast demo path where it never visibly sits in `pending`).
  const startRowIdRef = useRef<string | null>(null);
  const onChangedRef = useRef(onImageChanged);
  const toastRef = useRef(toast);
  useEffect(() => {
    onChangedRef.current = onImageChanged;
    toastRef.current = toast;
  });

  // Poll the row while a generation is in flight.
  useEffect(() => {
    if (!pending) return;
    const timer = setInterval(() => reload({ silent: true }), POLL_MS);
    return () => clearInterval(timer);
  }, [pending, reload]);

  // Detect completion: a new row (id changed) reached ready/failed.
  useEffect(() => {
    if (!generating || !row) return;
    if (row.id === startRowIdRef.current || row.status === "pending") return;
    setGenerating(false);
    if (row.status === "ready") {
      onChangedRef.current();
    } else {
      toastRef.current.push({
        title: "Image generation failed",
        description: "Try generating again.",
        tone: "error",
      });
    }
  }, [generating, row]);

  const generate = async () => {
    startRowIdRef.current = row?.id ?? null;
    setGenerating(true);
    const result = await api.generateImage(entityId);
    if (!result.ok) {
      setGenerating(false);
      startRowIdRef.current = null;
      toast.push({ title: "Couldn't start generation", description: result.error.message, tone: "error" });
      return;
    }
    reload({ silent: true });
  };

  const frame = entityKind === "item" ? "aspect-square w-44" : "aspect-[3/2] w-64";
  const failed = !pending && row?.status === "failed";

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start gap-5">
        <button
          type="button"
          onClick={() => imageId && setEnlarged(true)}
          disabled={!imageId || pending}
          aria-label={imageId ? "Enlarge image" : undefined}
          className="cursor-pointer rounded-card disabled:cursor-default"
        >
          {pending ? (
            <div
              className={cx(
                "flex items-center justify-center rounded-card border border-dashed border-ink-600 text-sm text-paper-500",
                frame,
              )}
            >
              Painting…
            </div>
          ) : (
            <EntityImage
              imageId={imageId}
              name={name}
              className={cx("rounded-card border border-ink-600 text-3xl", frame)}
            />
          )}
        </button>
        <div className="flex max-w-sm flex-col gap-2">
          <h3 className="text-xs font-medium tracking-wide text-paper-400 uppercase">Image</h3>
          <p className="text-sm text-paper-400">
            {entityKind === "item"
              ? "A product photo generated from this item’s name, kind, and description."
              : "An establishing shot generated from this location’s fields — landscape or interior by its scale."}
          </p>
          <Button variant="primary" onClick={generate} busy={pending} className="w-fit">
            {imageId ? "Regenerate" : "Generate image"}
          </Button>
          {pending ? <p className="text-xs text-paper-500">Working — this can take a minute…</p> : null}
          {failed ? <p className="text-xs text-danger-300">Last attempt failed — try again.</p> : null}
        </div>
      </div>

      <ImageLightbox imageId={enlarged ? imageId : null} alt={name} onClose={() => setEnlarged(false)} />
    </div>
  );
}
