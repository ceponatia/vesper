import type { AuthorizedHandler } from "@/server/api";
import { withOwnerAdminResource } from "@/server/api";
import { getIdentityPackHistoryForAdmin, type IdentityPackHistory } from "@/server/images";

export type IdentityPackParams = { packId: string };

/**
 * The self-scoped boundary both pack-id admin handlers share.
 *
 * A pack id in a URL is not authorization even for an administrator
 * (image-identity-packs.spec.lifecycle.md §"Authorization root"): the resolver
 * walks pack → character → owner and refuses anything that is not the requesting
 * admin's, which `withOwnerAdminResource` turns into the same 404 a nonexistent
 * pack gets. `/api/admin/self` is by definition the administrator's own data;
 * reaching another user's pack is a support boundary
 * (`withCrossAccountSupport`), with its own audit trail, not a wrapper away.
 *
 * Resolving the history here rather than in each handler also means the override
 * route already holds the current revision's coordinates, which is what a
 * re-approval with no submitted crop needs.
 */
export function withOwnPackHistory<P extends IdentityPackParams>(handler: AuthorizedHandler<P, IdentityPackHistory>) {
  return withOwnerAdminResource<P, IdentityPackHistory>(
    "identity pack",
    async (user, params) => {
      const history = await getIdentityPackHistoryForAdmin(params.packId);
      return history !== null && history.ownerId === user.id ? history : null;
    },
    handler,
  );
}
