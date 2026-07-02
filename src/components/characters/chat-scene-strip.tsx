"use client";

import { useEffect, useRef, useState } from "react";
import { chatsApi, type ImageRecord } from "@/lib/client/api";
import { useAsyncData } from "@/components/hooks/use-async";
import { usePollWhile } from "@/components/hooks/use-poll-while";
import { Button } from "@/components/ui/button";
import { EntityImage } from "@/components/ui/entity-image";
import { ImageLightbox } from "@/components/ui/image-lightbox";
import { Skeleton } from "@/components/ui/skeleton";
import { Tag } from "@/components/ui/tag";
import { useToast } from "@/components/ui/toast";

const POLL_MS = 2500;

function sceneError(image: ImageRecord): string | null {
  const error = image.meta?.error?.trim();
  return error ? error : null;
}

/**
 * Manual scene-image renderer + history strip for a conversation. Generate is
 * disabled until the first exchange — the scene is composed from the transcript.
 */
export function SceneStrip({ chatId, name, hasChat }: { chatId: string; name: string; hasChat: boolean }) {
  const toast = useToast();
  const scenes = useAsyncData(() => chatsApi.scenes(chatId), [chatId]);
  const [generating, setGenerating] = useState(false);
  const [enlarged, setEnlarged] = useState<{ id: string; prompt: string | null } | null>(null);
  const baselineRef = useRef(0);

  const sceneList = scenes.data ?? [];
  const hasPendingRow = sceneList.some((s) => s.status === "pending");
  const hasPending = hasPendingRow || generating;
  // Show an immediate placeholder the instant "Generate" is clicked — the image
  // row doesn't exist until the (slow) composer step finishes, so without this
  // the strip would give no feedback during compose. Once the pending row lands,
  // its own labeled tile takes over (and `generating` is released below).
  const showComposing = generating && !hasPendingRow;

  usePollWhile(hasPending, () => scenes.reload({ silent: true }), POLL_MS);

  // Release the button spinner once the queued row materialises; its own
  // pending tile then tracks progress (mirrors the portrait studio).
  useEffect(() => {
    if (generating && sceneList.length > baselineRef.current) setGenerating(false);
  }, [sceneList.length, generating]);

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
    scenes.reload({ silent: true });
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-xs font-medium tracking-wide text-paper-400 uppercase">Scene images</h3>
        <div className="flex items-center gap-2">
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
              <div key={img.id} className="w-28 shrink-0">
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
