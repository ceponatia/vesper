"use client";

import type { SessionStatus, StatusParticipant } from "@/lib/client/use-session";
import { AvatarPanel } from "@/components/avatar";

/**
 * The in-session standing companion avatar: a larger portrait view of the focal NPC,
 * mounted in the Scene tab. Renders nothing when no eligible focal is present.
 */

const TIER_RANK: Record<StatusParticipant["tier"], number> = { major: 0, minor: 1, extra: 2 };

/** Present with the player (composer.tsx's rule): co-located, or location unknown either side. */
function presentWithPlayer(p: StatusParticipant, playerLocationId: string | null): boolean {
  return !playerLocationId || !p.locationId || p.locationId === playerLocationId;
}

/**
 * The **stable** focal NPC — present with the player, with an avatar to show:
 * companion → highest tier → first by id. Deliberately stable so the standing
 * avatar never swaps mid-scene.
 */
export function selectFocalParticipant(
  participants: readonly StatusParticipant[],
  playerLocationId: string | null,
): StatusParticipant | null {
  const eligible = participants.filter(
    (p) => !p.isUser && p.avatarImageId !== null && presentWithPlayer(p, playerLocationId),
  );
  const [focal] = [...eligible].sort((a, b) => {
    const companionA = a.role === "companion" ? 0 : 1;
    const companionB = b.role === "companion" ? 0 : 1;
    if (companionA !== companionB) return companionA - companionB;
    if (TIER_RANK[a.tier] !== TIER_RANK[b.tier]) return TIER_RANK[a.tier] - TIER_RANK[b.tier];
    return a.id < b.id ? -1 : 1;
  });
  return focal ?? null;
}

export function SessionAvatar({ status }: { status: SessionStatus | null }) {
  const participants = status?.participants ?? [];
  const playerLocationId = participants.find((p) => p.isUser)?.locationId ?? null;
  const focal = selectFocalParticipant(participants, playerLocationId);
  if (!focal) return null;

  return <AvatarPanel name={focal.displayName} avatarImageId={focal.avatarImageId} className="mx-auto w-full max-w-44" />;
}
