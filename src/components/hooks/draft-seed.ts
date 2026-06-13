/**
 * Pure decision for seeding an editor's controlled draft from fetched detail
 * data (docs/ui.md §Conventions). Used by the long editors via the React
 * "adjust state while rendering" pattern.
 *
 * Invariants:
 * - An entity is seeded exactly once per visit ("keep" once `seededId`
 *   matches): refetches — silent avatar polling, post-save reloads — can
 *   never clobber in-progress edits.
 * - Navigating to a different entity drops the stale draft ("clear") until
 *   the new entity's data arrives, then seeds it ("seed").
 */
export type DraftSeedAction = "seed" | "clear" | "keep";

export function decideDraftSeed(args: {
  /** The id the editor page is showing. */
  entityId: string;
  /** The id the current draft was seeded from, or null before the first seed. */
  seededId: string | null;
  /** The id of the data currently held by the fetch hook, or null while loading. */
  loadedId: string | null;
}): DraftSeedAction {
  if (args.seededId === args.entityId) return "keep"; // already seeded — edits win over refetches
  if (args.loadedId === args.entityId) return "seed"; // fresh data for this entity arrived
  return args.seededId === null ? "keep" : "clear"; // navigated away — drop the stale draft
}
