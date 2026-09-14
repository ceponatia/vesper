import type { FinalizeChatStateInput } from "./finalize-types";

/**
 * Leaf module: which present ensemble members share the shared continuity
 * leg's garment handle enumeration and materialization pass (#298). Kept
 * separate from `ensemble.ts` (which pulls in `character-fold.ts`, which
 * pulls in `finalize-agents.ts`'s own types) so that `finalize-agents.ts` and
 * `wardrobe-fold.ts` can depend on this one fact without completing a cycle
 * back to themselves. This file imports nothing from a sibling `chat-state`
 * store — only the plain type its one function's signature needs.
 */

/** One roster member as `FinalizeChatStateInput.roster` carries it. */
export type EnsembleRosterMember = NonNullable<FinalizeChatStateInput["roster"]>[number];

/**
 * The present members besides the primary — the set the shared continuity leg
 * enumerates into the garment handle table and the wardrobe fold materializes
 * on the write. Both reads must agree on exactly this set, so it is computed in
 * ONE place rather than re-filtered by each caller.
 */
export function presentEnsembleMembers(
  roster: FinalizeChatStateInput["roster"],
  primaryCharacterId: string,
): EnsembleRosterMember[] {
  return (roster ?? []).filter(
    (member) => member.presence === "present" && member.characterId !== primaryCharacterId,
  );
}
