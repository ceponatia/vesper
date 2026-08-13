import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { simCalendarStartSchema } from "@/lib/simulation/clock";
import { jsonError, jsonOk, readBody, withUser } from "@/server/api";
import { characterChats, db, simWorlds, simBranches } from "@/server/db";
import { readChatEngineAuthority, readSimChatClock } from "@/server/engine";

type Params = { chatId: string };

/**
 * R5 time domain (ruling 17) — the calendar-anchor editor: PATCH sets the
 * linked world's `calendar_start` (the date of story day zero; null clears it
 * back to "Day N"). Presentation config, owner-scoped: editing the anchor
 * re-labels the world's history, it never rewrites it — so this is a plain
 * update, not a durable command.
 */
const patchBodySchema = z.object({ calendarStart: simCalendarStartSchema.nullable() }).strict();

export const PATCH = withUser<Params>(async (user, req, ctx) => {
  const { chatId } = await ctx.params;
  const body = await readBody(req, patchBodySchema);
  if (!body.ok) return body.response;

  const [chat] = await db()
    .select({ id: characterChats.id })
    .from(characterChats)
    .where(and(eq(characterChats.id, chatId), eq(characterChats.ownerId, user.id)));
  if (!chat) return jsonError("not_found", "chat not found", 404);
  const authority = await readChatEngineAuthority(chatId);
  if (!authority || authority.authority === "legacy_chat" || !authority.simBranchId) {
    return jsonError("not_sim_enabled", "this conversation has no world to anchor", 409);
  }
  const [branch] = await db()
    .select({ worldId: simBranches.worldId })
    .from(simBranches)
    .where(eq(simBranches.id, authority.simBranchId));
  if (!branch) return jsonError("not_found", "world branch not found", 404);
  await db().update(simWorlds).set({ calendarStart: body.value.calendarStart }).where(eq(simWorlds.id, branch.worldId));
  return jsonOk({ simClock: await readSimChatClock(chatId) });
});
