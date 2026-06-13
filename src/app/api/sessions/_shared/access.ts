import { and, eq } from "drizzle-orm";
import { db, sessions } from "@/server/db";

export type SessionRow = typeof sessions.$inferSelect;

/** Owner-scoped session lookup — every session route resolves through this. */
export async function findOwnedSession(userId: string, sessionId: string): Promise<SessionRow | null> {
  const [row] = await db()
    .select()
    .from(sessions)
    .where(and(eq(sessions.id, sessionId), eq(sessions.ownerId, userId)))
    .limit(1);
  return row ?? null;
}
