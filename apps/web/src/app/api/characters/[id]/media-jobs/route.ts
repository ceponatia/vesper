import { jsonOk, withAuthorizedResource } from "@/server/api";
import { listCharacterMediaJobs } from "@/server/images";
import { findOwnedCharacter } from "../owned";

type Params = { id: string };
type OwnedCharacter = NonNullable<Awaited<ReturnType<typeof findOwnedCharacter>>>;

/**
 * The persistent, safe status seam for one owner's character media work.
 * The service keeps both owner and character predicates on the jobs query; the
 * wrapper additionally collapses a missing and foreign character to one 404.
 */
export const GET = withAuthorizedResource<Params, OwnedCharacter>(
  "character",
  async (user, params) => (await findOwnedCharacter(params.id, user.id)) ?? null,
  async (user, _character, _req, ctx) => {
    const { id } = await ctx.params;
    return jsonOk({ jobs: await listCharacterMediaJobs(id, user.id) });
  },
  { limit: "read" },
);
