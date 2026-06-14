"use client";

import { useState } from "react";
import { sessionsApi } from "@/lib/client/api";
import type { UseSession } from "@/lib/client/use-session";
import { useAsyncData } from "@/components/hooks/use-async";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { relationshipToPlayer } from "./cast-relationship";
import { ParticipantCard } from "./participant-card";

/** Cast tab: per-participant accordion cards (docs/ui.md §Play screen). */
export function CastTab({ session }: { session: UseSession }) {
  // Accordion: at most one card expanded; expanding one collapses the other.
  const [expandedId, setExpandedId] = useState<string | null>(null);
  // Re-fetch after every completed turn (the clock always advances); stale
  // edges stay rendered while a refetch is in flight, so the panel never
  // flashes. A failed fetch just leaves the relationship lines absent.
  const relationships = useAsyncData(
    () => sessionsApi.relationships(session.sessionId),
    [session.sessionId, session.status?.clockMinutes ?? 0],
  );

  if (session.statusLoading) {
    return (
      <div className="flex flex-col gap-3 p-4">
        <Skeleton className="h-28 w-full rounded-card" />
        <Skeleton className="h-28 w-full rounded-card" />
      </div>
    );
  }
  const participants = session.status?.participants ?? [];
  if (participants.length === 0) {
    return (
      <div className="p-4">
        <EmptyState title="No one is here" description="Participants appear once the session spawns its cast." />
      </div>
    );
  }
  const player = participants.find((p) => p.isUser) ?? null;
  const edges = relationships.data;
  return (
    <div className="flex flex-col gap-3 p-4">
      {participants.map((participant) => (
        <ParticipantCard
          key={participant.id}
          sessionId={session.sessionId}
          participant={participant}
          relationship={
            // Only NPC→player edges are tracked; until the edges have loaded
            // once, render nothing rather than a false "Stranger".
            player && !participant.isUser && edges
              ? relationshipToPlayer(edges, participant.id, player.id)
              : null
          }
          playerLocationId={player?.locationId ?? null}
          expanded={expandedId === participant.id}
          onToggle={() => setExpandedId((prev) => (prev === participant.id ? null : participant.id))}
          onTeleported={() => void session.refresh()}
        />
      ))}
    </div>
  );
}
