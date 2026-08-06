import { withAuthorizedResource } from "@/server/api";
import { resetIdentityPackToAutomatic } from "@/server/images";
import {
  identityPackSummaryResponse,
  ownedCharacter,
  type IdentityPackParams,
  type OwnedCharacter,
} from "../shared";

/**
 * Discard a manual crop and re-derive automatically
 * (image-identity-packs.spec.derivation.md §"Reset to automatic").
 *
 * Not an undo: the current derivation runs against the current source as a NEW
 * revision, and the manual one becomes superseded rather than being deleted, so
 * "what did my crop look like?" stays answerable for the diagnostic window.
 *
 * The result is deliberately not inspected. A reset that lands on an unusable
 * automatic pack is an honest outcome — the owner asked to stop using their
 * crop, and the answer is that this source cannot yield one on its own — so the
 * response is the refreshed summary either way, carrying the failure code when
 * there is one.
 */
export const POST = withAuthorizedResource<IdentityPackParams, OwnedCharacter>(
  "character",
  ownedCharacter,
  async (user, _character, _req, ctx) => {
    const { id } = await ctx.params;
    await resetIdentityPackToAutomatic({ ownerId: user.id, characterId: id, actorUserId: user.id });
    return identityPackSummaryResponse(id, user.id);
  },
  { limit: "image_generate" },
);
