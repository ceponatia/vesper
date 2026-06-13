import { eq } from "drizzle-orm";
import { deleteSessionImages, jsonError, jsonOk, withUser } from "@/server/api";
import { db, sessions, worlds } from "@/server/db";
import { findOwnedSession } from "../_shared/access";

type Params = { id: string };

export const GET = withUser<Params>(async (user, _req, ctx) => {
  const { id } = await ctx.params;
  const session = await findOwnedSession(user.id, id);
  if (!session) return jsonError("not_found", "session not found", 404);
  const [world] = await db()
    .select({ id: worlds.id, name: worlds.name })
    .from(worlds)
    .where(eq(worlds.id, session.worldId))
    .limit(1);
  return jsonOk({ session: { ...session, worldName: world?.name ?? null } });
});

export const DELETE = withUser<Params>(async (user, _req, ctx) => {
  const { id } = await ctx.params;
  const session = await findOwnedSession(user.id, id);
  if (!session) return jsonError("not_found", "session not found", 404);
  // Scene images first (their FK would just set-null), then the session —
  // cascades turns/messages/episodes/facts/participants/locations/instances/jobs.
  await deleteSessionImages(id, user.id);
  await db().delete(sessions).where(eq(sessions.id, id));
  return jsonOk({ ok: true });
});
