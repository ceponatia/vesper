import type { NextRequest } from "next/server";
import { z } from "zod";
import { acceptPortrait, clearPortraitAcceptance } from "@/server/images";
import { jsonError, jsonOk, readBody, withAuthorizedResource } from "@/server/api";
import { findOwnedCharacter } from "../../owned";

type Params = { id: string };

type OwnedCharacter = NonNullable<Awaited<ReturnType<typeof findOwnedCharacter>>>;

/**
 * Owner-only, rooted at the CHARACTER in the URL — the same authorization root
 * every portrait and identity-pack route uses, and what `pnpm lint:authz`
 * requires of a resource-ID route. A foreign character and a nonexistent one get
 * the same 404, never two distinguishable answers.
 */
const ownedCharacter = async (user: { id: string }, params: Params) =>
  (await findOwnedCharacter(params.id, user.id)) ?? null;

const acceptBodySchema = z.object({ imageId: z.string().min(1) });

/**
 * Accept the portrait on screen as the character's identity source
 * (docs/images/identity-packs.md).
 *
 * The body names the image deliberately. A studio tab left open while another
 * one regenerated the portrait would otherwise accept a picture its owner never
 * looked at, so a request naming anything but the current candidate is refused
 * with `portrait_changed` (409) carrying the CURRENT acceptance — the client
 * re-reads from the refusal instead of racing a second GET for the state it just
 * lost.
 *
 * Accepting what is already accepted is a 200 that writes nothing and queues
 * nothing: the pack for those bytes already exists or is already being prepared.
 */
export const POST = withAuthorizedResource<Params, OwnedCharacter>(
  "character",
  ownedCharacter,
  async (user, _character, req: NextRequest, ctx) => {
    const { id } = await ctx.params;
    const body = await readBody(req, acceptBodySchema);
    if (!body.ok) return body.response;

    const result = await acceptPortrait({ ownerId: user.id, characterId: id, imageId: body.value.imageId });
    if (result.status === "not_found") return jsonError("not_found", "character not found", 404);
    if (result.status === "conflict") {
      // `jsonError` carries no extra fields and must not learn to — `{ error: {
      // code, message } }` is the envelope every client parses — so the BODY
      // widens instead, and `error.code` stays exactly where error handling
      // already looks for it (the identity-pack routes' shape).
      return jsonOk(
        {
          error: {
            code: "portrait_changed",
            message: "this character's portrait changed; review the new one and accept again",
          },
          acceptance: result.acceptance,
        },
        409,
      );
    }
    return jsonOk({ acceptance: result.acceptance });
  },
  { limit: "write" },
);

/**
 * Withdraw acceptance: the character keeps the portrait it is showing and stops
 * having an identity source.
 *
 * It deletes nothing — not the portrait, not the pack rows, not the crop. Every
 * pack read compares against the accepted pointer, so a null pointer already
 * reads as "no usable identity reference" and the identity-critical lanes answer
 * with their existing refusal.
 */
export const DELETE = withAuthorizedResource<Params, OwnedCharacter>(
  "character",
  ownedCharacter,
  async (user, _character, _req, ctx) => {
    const { id } = await ctx.params;
    const result = await clearPortraitAcceptance(id, user.id);
    if (result.status === "not_found") return jsonError("not_found", "character not found", 404);
    return jsonOk({ acceptance: result.acceptance });
  },
  { limit: "write" },
);
