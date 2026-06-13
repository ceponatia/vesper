import type { RelationshipEdge } from "@/lib/client/api";

/** An NPC's edges toward the player, shaped for display (stages only, never values). */
export interface PlayerRelationship {
  stage: string;
  /**
   * What the NPC believes the player feels toward them, or null when the
   * line is suppressed (mutually-stranger pairs).
   */
  perceivedStage: string | null;
}

/**
 * Pure: pick a participant's feeling/perceived stages toward the player.
 * Sparse-is-stranger in both directions — a missing edge reads "stranger"
 * (the engine's explicit semantic). Display rule (followups.phase2.md #3
 * ruling): the perceived line is hidden only while the pair is mutually
 * stranger — feeling stage "stranger" AND perceived edge absent-or-"stranger"
 * — because a stranger can't plausibly think you see her as anything else.
 * Any non-stranger signal on either side renders both lines, with a missing
 * perceived row displayed as "stranger".
 */
export function relationshipToPlayer(
  edges: RelationshipEdge[],
  participantId: string,
  playerId: string,
): PlayerRelationship {
  const toPlayer = edges.filter((e) => e.fromParticipantId === participantId && e.toParticipantId === playerId);
  const stage = toPlayer.find((e) => e.kind === "feeling")?.stage ?? "stranger";
  const perceived = toPlayer.find((e) => e.kind === "perceived")?.stage ?? null;
  const mutuallyStranger = stage === "stranger" && (perceived ?? "stranger") === "stranger";
  return { stage, perceivedStage: mutuallyStranger ? null : (perceived ?? "stranger") };
}
