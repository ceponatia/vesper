"use client";

import { useEffect, useRef, useState } from "react";
import { chatSceneModelLabels, chatSceneModels, parseChatSceneModel, type ChatSceneModel } from "@/contracts";
import { chatsApi, galleryApi, type ImageRecord } from "@/lib/client/api";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { EntityImage } from "@/components/ui/entity-image";
import { ImageLightbox } from "@/components/ui/image-lightbox";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Tag } from "@/components/ui/tag";
import { useToast } from "@/components/ui/toast";

function sceneError(image: ImageRecord): string | null {
  const error = image.meta?.error?.trim();
  return error ? error : null;
}

/**
 * Manual scene-image renderer + history strip for a conversation. Generate is
 * disabled until the first exchange — the scene is composed from the transcript.
 * The scene list is OWNED by the conversation page (slice 9 — one fetch/poll
 * shared with the inline transcript moments); this strip renders it and queues.
 * The "Scene images" heading lives on the page's disclosure toggle, so the
 * strip's own header row is just the Generate action.
 */
export function SceneStrip({
  chatId,
  name,
  hasChat,
  scenes: sceneList,
  rendering,
  onRefresh,
  sceneModel,
  onSceneModelChange,
}: {
  chatId: string;
  name: string;
  hasChat: boolean;
  /** The conversation's scene list (newest first), owned by the page. */
  scenes: ImageRecord[];
  /** A render job is live server-side (covers the composer step before the row exists). */
  rendering: boolean;
  /** Silent refetch of the shared list (after queueing). */
  onRefresh: () => void;
  /** The chat's scene-model pick ("reference" = identity-locked avatar edit). */
  sceneModel: ChatSceneModel;
  /** Save-on-select (no save button) — the page persists via the state PATCH. */
  onSceneModelChange: (model: ChatSceneModel) => void;
}) {
  const toast = useToast();
  const [generating, setGenerating] = useState(false);
  const [enlarged, setEnlarged] = useState<{ id: string; prompt: string | null } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const baselineRef = useRef(0);

  const hasPendingRow = sceneList.some((s) => s.status === "pending");
  // Show a placeholder from the instant "Generate" is clicked (`generating`, local)
  // through the whole server-side job (`rendering` — the page polls while it's live):
  // the image row doesn't exist until the (slow) composer step finishes, so without
  // this the strip would give no feedback during compose — and an auto-queued or
  // mid-compose-refreshed render would show nothing at all. Once the pending row
  // lands, its own labeled tile takes over.
  const showComposing = (generating || rendering) && !hasPendingRow;

  // Release the button spinner once the server acknowledges the job (`rendering`)
  // or the queued row materialises; the shared tile then tracks progress.
  useEffect(() => {
    if (generating && (rendering || sceneList.length > baselineRef.current)) setGenerating(false);
  }, [sceneList.length, generating, rendering]);

  const generate = async () => {
    baselineRef.current = sceneList.length;
    setGenerating(true);
    const result = await chatsApi.generateScene(chatId);
    if (!result.ok) {
      setGenerating(false);
      toast.push({ title: "Scene failed to queue", description: result.error.message, tone: "error" });
      return;
    }
    toast.push({ title: "Scene queued", description: "Rendering from the recent conversation." });
    onRefresh();
  };

  // Scene rows are gallery-kind assets, so the gallery delete route does the full
  // job (row + file + pointer cleanup). The strip and the inline transcript moment
  // both derive from the page-owned scene list, so one silent refetch clears the
  // image everywhere at once.
  const confirmDelete = async () => {
    if (!pendingDelete) return;
    setDeleting(true);
    const result = await galleryApi.remove(pendingDelete);
    setDeleting(false);
    if (!result.ok) {
      toast.push({ title: "Delete failed", description: result.error.message, tone: "error" });
      return;
    }
    if (enlarged?.id === pendingDelete) setEnlarged(null);
    setPendingDelete(null);
    toast.push({ title: "Scene deleted", tone: "success" });
    onRefresh();
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-end gap-2">
        {/* Hot-swap model pick (owner request 2026-07-11): saves on select via the
            state PATCH — no save button. Reference-capable models only (owner
            ruling 2026-07-29) — the t2i style swaps painted a different-looking
            person; the picker seam stays for reference models to come. */}
        <Select
          aria-label="Scene image model"
          value={sceneModel}
          onChange={(e) => onSceneModelChange(parseChatSceneModel(e.target.value))}
          title="Which image model paints the next scene. Every option keeps her exact look from the avatar reference."
          className="h-8 w-52 text-xs"
        >
          {chatSceneModels.map((model) => (
            <option key={model} value={model}>
              {chatSceneModelLabels[model]}
            </option>
          ))}
        </Select>
        <Button
          size="sm"
          onClick={generate}
          busy={generating}
          disabled={!hasChat}
          title={hasChat ? undefined : "Say something first — the scene is composed from the conversation"}
        >
          Generate scene
        </Button>
      </div>
      {sceneList.length === 0 && !showComposing ? (
        <p className="text-sm text-paper-500">
          No scenes yet. “Generate scene” paints the current moment from your recent exchange.
        </p>
      ) : (
        <div className="flex gap-2.5 overflow-x-auto pb-1">
          {showComposing ? (
            <div className="w-28 shrink-0">
              <PendingSceneTile />
            </div>
          ) : null}
          {sceneList.map((img) => {
            const error = sceneError(img);
            return (
              <div key={img.id} className="group relative w-28 shrink-0">
                {img.status === "pending" ? (
                  <PendingSceneTile />
                ) : img.status === "failed" ? (
                  <div className="flex aspect-[3/4] w-full flex-col justify-center gap-1.5 rounded-card border border-danger-500/40 bg-ink-950/60 px-2 py-3">
                    <Tag tone="danger" className="self-start">
                      failed
                    </Tag>
                    <p className="max-h-20 overflow-y-auto text-[11px] break-words text-paper-400" title={error ?? undefined}>
                      {error ?? "The image provider returned an error."}
                    </p>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => setEnlarged({ id: img.id, prompt: img.prompt || null })}
                    aria-label="Enlarge scene image"
                    className="block w-full cursor-pointer overflow-hidden rounded-card border border-ink-600 transition-colors hover:border-accent-500/60"
                  >
                    <EntityImage imageId={img.id} name={name} className="aspect-[3/4] w-full" />
                  </button>
                )}
                {img.status !== "pending" ? (
                  // Same `.hover-reveal` idiom as the gallery tiles: hover-gated on
                  // pointer devices, always shown on touch. Deleting also removes the
                  // inline transcript moment — both render from this one list.
                  <button
                    type="button"
                    onClick={() => setPendingDelete(img.id)}
                    aria-label="Delete scene image"
                    className="hover-reveal touch-target absolute top-1 right-1 flex size-6 cursor-pointer items-center justify-center rounded-md border border-ink-600 bg-ink-900/80 text-xs text-paper-300 backdrop-blur-sm transition-opacity hover:border-danger-500 hover:text-danger-300"
                  >
                    ✕
                  </button>
                ) : null}
              </div>
            );
          })}
        </div>
      )}

      <ImageLightbox
        imageId={enlarged?.id ?? null}
        alt={name}
        prompt={enlarged?.prompt ?? null}
        onClose={() => setEnlarged(null)}
      />

      <Dialog
        open={pendingDelete !== null}
        onClose={() => {
          if (!deleting) setPendingDelete(null);
        }}
        title="Delete this scene image?"
        footer={
          <>
            <Button onClick={() => setPendingDelete(null)} disabled={deleting}>
              Cancel
            </Button>
            <Button variant="danger" busy={deleting} onClick={() => void confirmDelete()}>
              Delete
            </Button>
          </>
        }
      >
        This permanently removes the image — from this strip, the conversation, and the Gallery. It can&rsquo;t be undone.
      </Dialog>
    </div>
  );
}

/** In-progress scene tile: a pulsing placeholder with an explicit "Painting…" label. */
function PendingSceneTile() {
  return (
    <div className="relative aspect-[3/4] w-full overflow-hidden rounded-card border border-ink-600">
      <Skeleton className="absolute inset-0 rounded-none" />
      <span className="absolute inset-x-0 bottom-0 bg-ink-950/80 px-2 py-1 text-center text-[11px] text-paper-300">
        Painting…
      </span>
    </div>
  );
}
