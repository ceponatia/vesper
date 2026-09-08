import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { authoredRelationshipRecordSchema } from "@/contracts";
import { jsonError, jsonOk, readBody, withAuthorizedResource } from "@/server/api";
import { getLibraryRelationships, saveLibraryRelationships } from "@/server/authoring";
import { findOwnedCharacter } from "../owned";

type Params = { id: string };

/**
 * Library-level default relationship edges (owner ruling 2026-07-07): the
 * character editor's Relationships tab. Edges are directed FROM this character
 * toward other library characters; conversation creation seeds its matrix from
 * these for every roster pair. PUT is a versioned replace-set: the sent list
 * becomes the character's outgoing edges only if `baseRevision` is current.
 */
const putBodySchema = z.object({
  baseRevision: z.number().int().nonnegative().max(2_147_483_646),
  edges: z
    .array(
      z.object({
        toCharacterId: z.string().min(1),
        record: authoredRelationshipRecordSchema,
      }),
    )
    .max(24),
});

const ownedCharacter = async (user: { id: string }, params: Params) =>
  (await findOwnedCharacter(params.id, user.id)) ?? null;

type OwnedCharacter = NonNullable<Awaited<ReturnType<typeof findOwnedCharacter>>>;

export const GET = withAuthorizedResource<Params, OwnedCharacter>("character", ownedCharacter, async (user, _character, _req, ctx) => {
  const { id } = await ctx.params;
  const result = await getLibraryRelationships(user.id, id);
  return result ? jsonOk(result) : jsonError("not_found", "character not found", 404);
});

export const PUT = withAuthorizedResource<Params, OwnedCharacter>("character", ownedCharacter, async (user, _character, req: NextRequest, ctx) => {
  const { id } = await ctx.params;
  const body = await readBody(req, putBodySchema);
  if (!body.ok) return body.response;
  const result = await saveLibraryRelationships(user.id, id, body.value.baseRevision, body.value.edges);
  if (result.ok) return jsonOk(result.value);
  if (result.code === "relationship_conflict") {
    return NextResponse.json(
      {
        error: {
          code: result.code,
          message: "library relationships changed elsewhere; choose which version to keep",
        },
        current: result.current,
      },
      { status: 409 },
    );
  }
  if (result.code === "invalid_edge") {
    return jsonError("invalid_edge", "each relationship needs one different target character", 400);
  }
  return jsonError("not_found", result.code === "target_not_found" ? "target character not found" : "character not found", 404);
});
