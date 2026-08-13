import { z } from "zod";

/**
 * R1 (engine.rollout.plan.md) — per-world engine authority. Which lane owns a
 * character chat's world truth is decided by ONE flag on the chat row and
 * nothing else (engine.plan.md §"Migration and rollout": authority is
 * assigned per world or branch by feature flag, never per row by accident).
 *
 * The four lanes are rollout STAGES, ordered — a chat normally walks left to
 * right and rollback is one flag flip back:
 *
 * - `legacy_chat` — today's chat lane owns everything; the successor is not
 *   consulted. The default for every existing and new chat.
 * - `successor_shadow` — successor calculations run alongside the chat lane
 *   with NO effects; divergences are diagnostics (R4).
 * - `successor_narrative_view` — the successor's committed NarrativeCut is
 *   used for presentation only; chat state remains authoritative (R2).
 * - `successor_authoritative` — the successor owns world truth for the
 *   migrated domains (R5).
 *
 * `successor_rag_eligibility` is deliberately NOT a lane: it is the one
 * orthogonal flag (§24 recall routing can flip independently once the
 * knowledge domain lands), so it rides a separate boolean column.
 */

export const engineAuthorities = [
  "legacy_chat",
  "successor_shadow",
  "successor_narrative_view",
  "successor_authoritative",
] as const;
export const engineAuthoritySchema = z.enum(engineAuthorities);
export type EngineAuthority = z.infer<typeof engineAuthoritySchema>;

/** The degraded default at every read boundary (resilience.md): the legacy lane. */
export const DEFAULT_ENGINE_AUTHORITY: EngineAuthority = "legacy_chat";

/** A chat's full authority state — the admin surface's read/patch shape. */
export const chatEngineAuthorityStateSchema = z
  .object({
    authority: engineAuthoritySchema,
    /** §24 recall routing — orthogonal to the lane, false until R5's knowledge domain. */
    ragEligibility: z.boolean(),
    /** The successor branch this chat's world maps onto; null until linked. */
    simBranchId: z.string().min(1).nullable(),
    /** R3: the sim actor the player embodies in the linked branch. */
    simPlayerActorId: z.string().min(1).nullable(),
    /** R3: the sim actor the chat's primary character embodies. */
    simPrimaryActorId: z.string().min(1).nullable(),
  })
  .strict();
export type ChatEngineAuthorityState = z.infer<typeof chatEngineAuthorityStateSchema>;

/** Whether this lane consults the successor engine at all. */
export function consultsSuccessor(authority: EngineAuthority): boolean {
  return authority !== "legacy_chat";
}

/** Whether the successor owns hard world truth under this lane. */
export function successorIsAuthoritative(authority: EngineAuthority): boolean {
  return authority === "successor_authoritative";
}
