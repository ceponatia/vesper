/**
 * Cast-tier spawn rules shared by the engine and the world editor
 * (cast-tiers-and-affinity-spec, decision 46). Lives in src/lib (pure) so the
 * client-side cast notice and the server-side spawn diagnostic count majors
 * with the same rule; `engine/constants.ts` re-exports the cap for engine code.
 */

export type CastTier = "major" | "minor" | "extra";
export type CastRole = "companion" | "npc";

/**
 * Soft cap on major-tier cast members per session — warn, never block or trim.
 * Every major costs prompt space and memory rows each turn; past ~6 a session
 * degrades quietly, so both spawn and the world editor surface a notice.
 */
export const MAJOR_TIER_SOFT_CAP = 6;

/**
 * The tier a cast member actually holds at spawn: companions left at the
 * authored default ("minor") are bumped to major; an explicit "extra"
 * companion stays extra. Mirrored by engine/spawn.ts when materializing
 * participants — change both together or the editor notice will lie.
 */
export function spawnTier(role: CastRole, tier: CastTier): CastTier {
  return role === "companion" && tier === "minor" ? "major" : tier;
}

/** How many of these cast members will hold major tier once spawned. */
export function countSpawnMajors(cast: ReadonlyArray<{ role: CastRole; tier: CastTier }>): number {
  return cast.reduce((n, member) => (spawnTier(member.role, member.tier) === "major" ? n + 1 : n), 0);
}
