import type { NextRequest } from "next/server";
import { visualExtractionSubmissionSchema } from "@/contracts";
import { jsonError, jsonOk, readBody, withOwnerAdmin } from "@/server/api";
import {
  listVisualReferenceExtractions,
  registerVisualReferenceExtraction,
} from "@/server/reference-extraction";

/**
 * Reference-image extraction runs. Owner-admin only, and only beneath
 * `/api/admin/self` — `withOwnerAdmin` fails closed with a hidden 404 anywhere
 * else. The whole workflow stays admin-only until review behavior is proven.
 *
 * GET lists one character's runs with FRESH diffs against canonical truth.
 * POST registers one offline extractor run: the body carries the extractor's
 * OUTPUT (untrusted; parsed per proposal), never triggers a vision call, and
 * writes no canonical owner — acceptance on the proposal route is the only
 * door, and it is a human act.
 */

export const GET = withOwnerAdmin(async (user, req: NextRequest) => {
  const characterId = req.nextUrl.searchParams.get("characterId") ?? "";
  if (characterId === "") return jsonError("character_required", "pass ?characterId=", 400);
  const result = await listVisualReferenceExtractions({ ownerId: user.id, characterId });
  if (!result.ok) return jsonError(result.code, result.message, 404);
  return jsonOk({ runs: result.runs });
});

export const POST = withOwnerAdmin(async (user, req: NextRequest) => {
  const body = await readBody(req, visualExtractionSubmissionSchema);
  if (!body.ok) return body.response;
  const result = await registerVisualReferenceExtraction({
    ownerId: user.id,
    characterId: body.value.characterId,
    sourceImageId: body.value.sourceImageId,
    extractorId: body.value.extractorId,
    extractorVersion: body.value.extractorVersion,
    proposals: body.value.proposals,
  });
  if (!result.ok) {
    return jsonError(result.code, result.message, result.code === "not_found" ? 404 : 422);
  }
  return jsonOk({ run: result.run, diagnostics: result.diagnostics }, 201);
});
