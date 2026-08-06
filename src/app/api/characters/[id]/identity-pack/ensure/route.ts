import { withAuthorizedResource } from "@/server/api";
import { ensureIdentityPack } from "@/server/images";
import {
  identityPackSummaryResponse,
  ownedCharacter,
  type IdentityPackParams,
  type OwnedCharacter,
} from "../shared";

/**
 * Prepare (or re-prepare) the character's pack on the owner's request
 * (image-identity-packs.spec.lifecycle.md §"Lazy backfill").
 *
 * `purpose: "identity_render"` because a person is waiting: that arm waits out
 * the bounded local derivation and answers with a settled pack, where
 * `background` may return the moment work is reserved and leave the owner
 * looking at `pending` after clicking Prepare. Nothing here reaches an image
 * provider — the work is a file read, a hash, a detector pass and two sharp
 * passes — which is why no render budget is charged.
 *
 * A typed failure still answers **200**. An unusable pack is product feedback
 * ("use a clearer portrait", "crop it yourself"), not a server error, and the
 * summary carries the actionable `failureCode`; making it a 4xx would push the
 * client into error handling for the one case it most needs to render properly.
 * `ensureIdentityPack` is idempotent, so a second click coalesces rather than
 * deriving twice.
 *
 * The service's result is passed to the responder rather than discarded,
 * because a failure that happens BEFORE a revision is persisted never reaches
 * the summary: the re-read still shows the previous pack (or `none`), so
 * without the `blocked` field the owner clicks Prepare and is answered with
 * silence.
 */
export const POST = withAuthorizedResource<IdentityPackParams, OwnedCharacter>(
  "character",
  ownedCharacter,
  async (user, _character, _req, ctx) => {
    const { id } = await ctx.params;
    const result = await ensureIdentityPack({ ownerId: user.id, characterId: id, purpose: "identity_render" });
    return identityPackSummaryResponse(id, user.id, result);
  },
  // The closest reviewed bucket for a lane that decodes and re-encodes an image
  // on the request path. It spends no provider budget, so it is deliberately not
  // gated by `imageRenderRejection`; the cost being bounded is what makes that safe.
  { limit: "image_generate" },
);
