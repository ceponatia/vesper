"use client";

import { useEffect, useState } from "react";
import { z } from "zod";
import { apiPost, sessionsApi } from "@/lib/client/api";
import type { UseSession } from "@/lib/client/use-session";
import { useAsyncData } from "@/components/hooks/use-async";
import { Button } from "@/components/ui/button";
import { cx } from "@/components/ui/cx";
import { EntityImage } from "@/components/ui/entity-image";
import { ImageLightbox } from "@/components/ui/image-lightbox";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import { relationshipToPlayer } from "./cast-relationship";
import { ParticipantCard } from "./participant-card";

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

      <PresentCast session={session} />

      <ImageLightbox
        imageId={enlargedId}
        alt={session.status?.title ?? "Scene"}
        onClose={() => setEnlargedId(null)}
      />
    </div>
  );
}

/**
 * Who is at the player's location right now (docs/ui.md): the same cast cards
 * as the Cast tab, scoped to co-located NPCs so the player can see who is here
 * to interact with — the present set the scene composer would draw from. The
 * player is excluded (the scene is their first-person POV). Co-location follows
 * composer.tsx's rule: filter by `locationId` when known, include otherwise.
 */
function PresentCast({ session }: { session: UseSession }) {
  // Independent accordion (the Cast tab keeps its own): one card open at a time.
  const [expandedId, setExpandedId] = useState<string | null>(null);
  // Relationships refetch after every completed turn, same as the Cast tab;
  // stale edges stay rendered while a refetch is in flight.
  const relationships = useAsyncData(
    () => sessionsApi.relationships(session.sessionId),
    [session.sessionId, session.status?.clockMinutes ?? 0],
  );

  const participants = session.status?.participants ?? [];
  const player = participants.find((p) => p.isUser) ?? null;
  const present = participants.filter(
    (p) =>
      !p.isUser &&
      p.role !== "player" &&
      (!player?.locationId || !p.locationId || p.locationId === player.locationId),
  );
  const edges = relationships.data;

  return (
    <section className="flex flex-col gap-3 border-t border-ink-700 pt-4">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-xs font-medium tracking-wide text-paper-400 uppercase">Here with you</h3>
        {session.status?.location?.name ? (
          <span className="truncate text-[11px] text-paper-500" title={session.status.location.name}>
            {session.status.location.name}
          </span>
        ) : null}
      </div>
      {present.length === 0 ? (
        <p className="text-xs text-paper-500">No one else is at this location.</p>
      ) : (
        present.map((participant) => (
          <ParticipantCard
            key={participant.id}
            sessionId={session.sessionId}
            participant={participant}
            relationship={
              // Only NPC→player edges are tracked; until they load once, render
              // nothing rather than a false "Stranger".
              player && edges ? relationshipToPlayer(edges, participant.id, player.id) : null
            }
            playerLocationId={player?.locationId ?? null}
            expanded={expandedId === participant.id}
            onToggle={() => setExpandedId((prev) => (prev === participant.id ? null : participant.id))}
          />
        ))
      )}
    </section>
  );
}
