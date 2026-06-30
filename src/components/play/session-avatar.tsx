"use client";

import { useState } from "react";
import type { SessionReactionBeat, SessionStatus, StatusParticipant } from "@/lib/client/use-session";
import { AvatarPanel, type AvatarBeatInput } from "@/components/avatar";

/**
 * The in-session standing companion avatar (avatar-3d.plan.md §"In-session play"): a
 * portrait-sized avatar of the focal NPC that emotes live as the session progresses —
 * sustained-emotion crossfades every turn (from `participant.avatarCue`) plus a one-shot
 * reaction beat (from the turn's `reactionBeat`, fired once via a mount-baseline guard).
 * Mounted in the Scene tab; renders nothing when no eligible focal is present.
 */

const TIER_RANK: Record<StatusParticipant["tier"], number> = { major: 0, minor: 1, extra: 2 };

/** Present with the player (composer.tsx's rule): co-located, or location unknown either side. */
function presentWithPlayer(p: StatusParticipant, playerLocationId: string | null): boolean {
  return !playerLocationId || !p.locationId || p.locationId === playerLocationId;
}

/**
 * The **stable** focal NPC — present with the player, with a cue and a library characterId
 * (needed for the manifest fetch): companion → highest tier → first by id. Deliberately
 * independent of the per-turn reaction target, so the standing avatar never swaps mid-scene.
 */
export function selectFocalParticipant(
  participants: readonly StatusParticipant[],
  playerLocationId: string | null,
): StatusParticipant | null {
  const eligible = participants.filter(
    (p) => !p.isUser && p.avatarCue !== null && p.characterId !== null && presentWithPlayer(p, playerLocationId),
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

/**
 * The beat's turn number when it's a fresh, focal-targeted beat (so `AvatarPanel` replays it
 * once), else `0` (no beat — never a swap). `baselineTurn` is the latest turn at mount
 * (`-1` for a fresh session with no completed turns), so turn 1 of a new session fires
 * (`1 > -1`) while a resumed session's already-seen latest turn is suppressed (`5 > 5` is
 * false). `null` baseline ⇒ not captured yet ⇒ no beat. Pure for testability.
 */
export function resolveBeatTick(
  baselineTurn: number | null,
  reactionBeat: SessionReactionBeat | null,
  focalId: string,
): number {
  if (baselineTurn === null || reactionBeat === null || reactionBeat.participantId !== focalId) return 0;
  return reactionBeat.turn > baselineTurn ? reactionBeat.turn : 0;
}

export function SessionAvatar({ status }: { status: SessionStatus | null }) {
  // Mount-baseline for the beat replay guard: the latest ready turn when this panel first had
  // a loaded status (`-1` if none yet — a fresh session). Captured once via render-time
  // setState (the codebase's derived-state pattern), so a beat never fires on mount / refresh
  // — only when a strictly newer turn lands. Capturing `?? -1` (not skipping the null case) is
  // what lets a fresh session's turn 1 fire instead of being swallowed.
  const [baselineTurn, setBaselineTurn] = useState<number | null>(null);
  if (baselineTurn === null && status !== null) setBaselineTurn(status.latestTurn ?? -1);

  const participants = status?.participants ?? [];
  const playerLocationId = participants.find((p) => p.isUser)?.locationId ?? null;
  const focal = selectFocalParticipant(participants, playerLocationId);
  if (!focal || !focal.avatarCue || !focal.characterId) return null;

  const reactionBeat = status?.reactionBeat ?? null;
  const isForFocal = reactionBeat?.participantId === focal.id;
  const beatTick = resolveBeatTick(baselineTurn, reactionBeat, focal.id);
  const beat: AvatarBeatInput | null =
    isForFocal && reactionBeat
      ? { valence: reactionBeat.valence, magnitude: reactionBeat.magnitude, concept: reactionBeat.concept }
      : null;

  return (
    <AvatarPanel
      characterId={focal.characterId}
      name={focal.displayName}
      avatarImageId={focal.avatarImageId}
      cue={focal.avatarCue}
      beat={beat}
      beatTick={beatTick}
      className="mx-auto w-full max-w-44"
    />
  );
}
