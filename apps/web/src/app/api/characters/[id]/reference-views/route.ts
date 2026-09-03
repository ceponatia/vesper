import { jsonOk, withAuthorizedResource } from "@/server/api";
import { getReferenceViewSet } from "@/server/images";
import { ownedCharacter, plannedCount, type OwnedCharacter, type ReferenceViewParams } from "./shared";

/**
 * The owner's view of the reference view set
 * (docs/images/pipelines/reference-views.md).
 *
 * A pure read: it renders nothing and queues nothing, so opening the portrait
 * tab cannot start billable work on every visit. Every slot is always reported,
 * `missing` where nothing has been built — the studio's grid is the shape of the
 * registry, not of the rows that happen to exist.
 *
 * `planned` is the count a build WOULD render for this character after the age
 * gate, so the studio's button and the server's budget charge come from the same
 * number rather than two that can drift.
 */
export const GET = withAuthorizedResource<ReferenceViewParams, OwnedCharacter>(
  "character",
  ownedCharacter,
  async (user, _character, _req, ctx) => {
    const { id } = await ctx.params;
    return jsonOk({ set: await getReferenceViewSet(id, user.id), planned: await plannedCount(id, user.id) });
  },
  { limit: "read" },
);
