import type { NextRequest } from "next/server";
import { worldDraftSchema } from "@/server/authoring";
import {
  FORGE_RATE_LIMIT,
  jsonError,
  jsonOk,
  rateLimit,
  readBody,
  updateWorldFromDraft,
  withUser,
} from "@/server/api";

type Params = { id: string };

/**
 * Save edits to an existing world from the draft shape (docs/authoring.md):
 * same conversion as the create path — cast stubs forged (capped), names
 * resolved, linked locations kept as overrides — then a full-replace PATCH of
 * all nested families. Forge-rate-limited (a save can run character forges).
 */
export const POST = withUser<Params>(async (user, req: NextRequest, ctx) => {
  if (!rateLimit(`forge:${user.id}`, FORGE_RATE_LIMIT)) {
    return jsonError("rate_limited", "too many forge requests; try again in a minute", 429);
  }
  const { id } = await ctx.params;
  const body = await readBody(req, worldDraftSchema);
  if (!body.ok) return body.response;

  const result = await updateWorldFromDraft(user.id, id, body.value);
  if (!result.ok) return jsonError(result.code, result.message, result.code === "not_found" ? 404 : 400);
  return jsonOk({ id: result.worldId, diagnostics: result.diagnostics });
});
