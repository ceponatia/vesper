import type { NextRequest } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { emotionLabelEnum } from "@/contracts";
import { characters, db } from "@/server/db";
import { enqueueAvatarSeed } from "@/server/engine";
import { GENERATION_RATE_LIMIT, jsonError, jsonOk, rateLimit, readBody, withUser } from "@/server/api";

type Params = { id: string };

const expressionBodySchema = z.object({ emotion: emotionLabelEnum });

/**
 * **Lazy-gen** one avatar expression frame on demand (avatar-3d.plan.md §"Jobs"): the
 * standing avatar panel POSTs the current emotion when it has no frame yet. Enqueues a
 * single-emotion `avatar_seed` job (idempotent — `generateAvatarExpression` dedups + honors
 * the negative-cache tombstone, so a repeat or a content-rejected frame is never re-billed).
 * Owner-scoped + rate-limited; poll the manifest for the new frame.
 */
export const POST = withUser<Params>(async (user, req: NextRequest, ctx) => {
  const { id } = await ctx.params;
  const body = await readBody(req, expressionBodySchema);
  if (!body.ok) return body.response;
  const [row] = await db()
    .select({ id: characters.id })
    .from(characters)
    .where(and(eq(characters.id, id), eq(characters.ownerId, user.id)))
    .limit(1);
  if (!row) return jsonError("not_found", "character not found", 404);
  if (!rateLimit(`avatar_expression:${user.id}`, GENERATION_RATE_LIMIT)) {
    return jsonError("rate_limited", "too many expression generations; try again in a minute", 429);
  }

  await enqueueAvatarSeed(id, user.id, [body.value.emotion]);
  return jsonOk({ ok: true, characterId: id, emotion: body.value.emotion }, 202);
});
