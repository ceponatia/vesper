import { jsonError, jsonOk, withAuthorizedResource } from "@/server/api";
import { referenceViewHistoryEntries, referenceViewRetentionDays, currentReferenceViewRow } from "@/server/images";
import { ownedCharacter, parseSlot, type OwnedCharacter, type ReferenceViewSlotParams } from "../../../shared";

/**
 * Every image one slot has produced, newest first, with the ruling the owner
 * gave each one (docs/images/pipelines/reference-views.md §Review).
 *
 * A pure read, and READ-ONLY in the strong sense: it renders nothing, queues
 * nothing and writes nothing, so opening a slot's history cannot move that
 * slot's current image or its verdict. It exists so a wording change to the
 * views can be judged against the renders it actually produced rather than
 * against memory.
 *
 * Owner-only and rooted at the CHARACTER, like every other reference-view
 * route — the sheet is hidden from every player-facing surface, and its history
 * is no more visible than the views themselves.
 *
 * `retentionDays` is the honest bound on the list: the maintenance sweep
 * collects a retired view's bytes after that window, and an entry with no bytes
 * is not listed. The studio states the number rather than presenting a
 * silently-truncated list as the whole story.
 */
export const GET = withAuthorizedResource<ReferenceViewSlotParams, OwnedCharacter>(
  "character",
  ownedCharacter,
  async (user, _character, _req, ctx) => {
    const params = await ctx.params;
    const slot = parseSlot(params);
    if (slot === null) return jsonError("not_found", "no such reference view", 404);

    const current = await currentReferenceViewRow(params.id, slot);
    return jsonOk({
      currentAttemptId: current?.id ?? null,
      currentRevision: current?.reviewRevision ?? 0,
      entries: await referenceViewHistoryEntries(params.id, user.id, slot),
      retentionDays: referenceViewRetentionDays(),
    });
  },
  { limit: "read" },
);
