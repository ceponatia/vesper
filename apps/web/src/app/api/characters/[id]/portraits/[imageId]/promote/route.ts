import { promoteVariant } from "@/server/images";
import { jsonError, jsonOk, withAuthorizedResource } from "@/server/api";
import { findOwnedCharacter } from "../../../owned";

type Params = { id: string; imageId: string };

type OwnedCharacter = NonNullable<Awaited<ReturnType<typeof findOwnedCharacter>>>;

const ownedCharacter = async (user: { id: string }, params: Params) =>
  (await findOwnedCharacter(params.id, user.id)) ?? null;

/**
 * Promote a ready variant to the character's canonical avatar
 * (docs/images/pipelines/portrait-variants.md).
 *
 * Defense in depth: the wrapper authorizes the parent character (and is what
 * `pnpm lint:authz` requires of a resource-ID route), and `promoteVariant`
 * re-verifies both rows against the same owner. It also queues identity-pack
 * preparation for the new canonical source, so this route does not.
 */
export const POST = withAuthorizedResource<Params, OwnedCharacter>(
  "character",
  ownedCharacter,
  async (user, _character, _req, ctx) => {
    const { id, imageId } = await ctx.params;
    const result = await promoteVariant(id, imageId, user.id);
    if (!result.ok) {
      const notFound = result.error?.includes("not found") || result.error?.includes("belong");
      return jsonError(notFound ? "not_found" : "not_ready", result.error ?? "promotion failed", notFound ? 404 : 409);
    }
    return jsonOk({ ok: true, avatarImageId: imageId });
  },
);
