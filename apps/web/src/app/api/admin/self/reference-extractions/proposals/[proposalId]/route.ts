import { NextResponse, type NextRequest } from "next/server";
import { visualExtractionDecisionSchema } from "@/contracts";
import { jsonError, jsonOk, readBody, withOwnerAdmin } from "@/server/api";
import { decideVisualReferenceProposal } from "@/server/reference-extraction";

type Params = { proposalId: string };

/**
 * One human ruling on one extraction proposal: accept — optionally with a
 * manual edit — or reject. Owner-admin only.
 *
 * An accept must echo the `currentDigest` of the diff the reviewer was shown;
 * the server recomputes it against canonical truth as it stands, and a
 * mismatch answers 409 with the fresh diff instead of writing anything. That
 * is the rule held at the wire: extraction cannot overwrite canonical truth
 * without review, because an accept only lands against the exact canonical
 * state that was reviewed. On acceptance the fact reaches its owner through
 * the owner's own write path (attributes today;
 * located facts and canonical presentation answer with
 * `visual_state.extraction.owner_unavailable` until a lane persists them).
 */
export const POST = withOwnerAdmin<Params>(async (user, req: NextRequest, ctx) => {
  const params = await ctx.params;
  const body = await readBody(req, visualExtractionDecisionSchema);
  if (!body.ok) return body.response;
  const result = await decideVisualReferenceProposal({
    ownerId: user.id,
    proposalId: params.proposalId,
    action: body.value.action,
    ...(body.value.currentDigest === undefined ? {} : { currentDigest: body.value.currentDigest }),
    ...(body.value.editedValue === undefined ? {} : { editedValue: body.value.editedValue }),
  });
  if (!result.ok) {
    const status =
      result.code === "not_found" ? 404
      : result.code === "canonical_moved" || result.code === "conflict" ? 409
      : 422;
    // `canonical_moved` (and a missing digest) carry the FRESH diff so the
    // reviewer's next look needs no extra round trip — the identity-pack
    // stale-save precedent of a 409 that answers with current state.
    if (result.diff !== undefined || result.diagnostics !== undefined) {
      return NextResponse.json(
        {
          error: { code: result.code, message: result.message },
          ...(result.diff === undefined ? {} : { diff: result.diff }),
          ...(result.diagnostics === undefined ? {} : { diagnostics: result.diagnostics }),
        },
        { status },
      );
    }
    return jsonError(result.code, result.message, status);
  }
  return jsonOk({ proposal: result.proposal, diagnostics: result.diagnostics });
});
