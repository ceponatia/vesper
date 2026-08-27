import { withAuthorizedResource } from "@/server/api";
import { identityPackSummaryResponse, ownedCharacter, type IdentityPackParams, type OwnedCharacter } from "./shared";

/**
 * The character owner's view of their identity pack.
 *
 * A pure read: it never derives, so opening the character page cannot start
 * sharp work on every visit. `status: "none"` means nobody has prepared one yet
 * and `pending` means a derivation is running — both are answers, and both are
 * things the crop editor has to be able to say out loud rather than showing an
 * endless spinner.
 */
export const GET = withAuthorizedResource<IdentityPackParams, OwnedCharacter>(
  "character",
  ownedCharacter,
  async (user, _character, _req, ctx) => {
    const { id } = await ctx.params;
    return identityPackSummaryResponse(id, user.id);
  },
  { limit: "read" },
);
