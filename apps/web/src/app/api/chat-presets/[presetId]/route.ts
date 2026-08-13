import { and, eq } from "drizzle-orm";
import { jsonError, jsonOk, withUser } from "@/server/api";
import { chatScenarioPresets, db } from "@/server/db";

type Params = { presetId: string };

/** DELETE /api/chat-presets/:presetId — remove one preset (owner-scoped; 404 on a miss). */
export const DELETE = withUser<Params>(async (user, _req, ctx) => {
  const { presetId } = await ctx.params;
  const [deleted] = await db()
    .delete(chatScenarioPresets)
    .where(and(eq(chatScenarioPresets.id, presetId), eq(chatScenarioPresets.ownerId, user.id)))
    .returning({ id: chatScenarioPresets.id });
  if (!deleted) return jsonError("not_found", "preset not found", 404);
  return jsonOk({ deleted: true });
});
