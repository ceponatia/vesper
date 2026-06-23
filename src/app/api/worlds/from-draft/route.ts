import type { NextRequest } from "next/server";
import { worldDraftSchema } from "@/server/authoring";
import {
  createWorldFromDraft,
  FORGE_RATE_LIMIT,
  jsonError,
  jsonOk,
  queueWorldImageGeneration,
  rateLimit,
  readBody,
  withUser,
} from "@/server/api";

/**
 * Save a world-forge draft (docs/authoring.md): cast stubs are forged into
 * real characters (capped, partial failure degrades to skeletal stubs), names
 * resolve against the library, then the converted input materializes through
 * the standard world create path. Forge-rate-limited — a save can run up to
 * MAX_GENERATED_CAST character forges.
 */
export const POST = withUser(async (user, req: NextRequest) => {
  const body = await readBody(req, worldDraftSchema);
  if (!body.ok) return body.response;
  // After body validation so a malformed request doesn't burn the budget.
  if (!rateLimit(`forge:${user.id}`, FORGE_RATE_LIMIT)) {
    return jsonError("rate_limited", "too many forge requests; try again in a minute", 429);
  }

  const result = await createWorldFromDraft(user.id, body.value);
  if (!result.ok) return jsonError(result.code, result.message, result.code === "not_found" ? 404 : 400);
  // New world: auto-generate every still-missing image (avatars, items, locations) in the background.
  queueWorldImageGeneration(user.id, result.worldId);
  return jsonOk({ id: result.worldId, diagnostics: result.diagnostics }, 201);
});
