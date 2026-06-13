import type { NextRequest } from "next/server";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { characters, db, images } from "@/server/db";
import { generateVariant } from "@/server/images";
import { jsonError, jsonOk, readBody, startJob, withUser } from "@/server/api";

type Params = { id: string };

const portraitBodySchema = z.object({
  kind: z.enum(["pose", "outfit", "expression", "setting"]),
  instruction: z.string().trim().min(1).max(1000),
});

/** All images linked to the character (avatar + variants), newest first. */
export const GET = withUser<Params>(async (user, _req, ctx) => {
  const { id } = await ctx.params;
  const [row] = await db()
    .select({ id: characters.id })
    .from(characters)
    .where(and(eq(characters.id, id), eq(characters.ownerId, user.id)))
    .limit(1);
  if (!row) return jsonError("not_found", "character not found", 404);

  const portraits = await db()
    .select()
    .from(images)
    .where(and(eq(images.ownerId, user.id), eq(images.entityKind, "character"), eq(images.entityId, id)))
    .orderBy(desc(images.createdAt));
  return jsonOk({ portraits });
});

/**
 * Identity-locked Venice reference edit of the canonical avatar, as a
 * `portrait_variant` job (docs/images.md). Poll the character's portraits for
 * the new row's status.
 */
export const POST = withUser<Params>(async (user, req: NextRequest, ctx) => {
  const { id } = await ctx.params;
  const body = await readBody(req, portraitBodySchema);
  if (!body.ok) return body.response;
  const [row] = await db()
    .select({ id: characters.id, avatarImageId: characters.avatarImageId })
    .from(characters)
    .where(and(eq(characters.id, id), eq(characters.ownerId, user.id)))
    .limit(1);
  if (!row) return jsonError("not_found", "character not found", 404);

  const jobId = await startJob({
    type: "portrait_variant",
    payload: { characterId: id, kind: body.value.kind },
    run: async () => ({
      imageId: await generateVariant({
        characterId: id,
        userId: user.id,
        kind: body.value.kind,
        instruction: body.value.instruction,
      }),
    }),
  });
  return jsonOk({ jobId, characterId: id }, 202);
});
