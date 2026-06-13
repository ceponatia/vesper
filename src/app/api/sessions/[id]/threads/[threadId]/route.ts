import { eq } from "drizzle-orm";
import { emptySessionRuntime, sessionRuntimeSchema } from "@/contracts";
import { parseOr } from "@/lib/parse";
import { jsonError, jsonOk, withUser } from "@/server/api";
import { db, sessions } from "@/server/db";
import { findOwnedSession } from "../../../_shared/access";

type Params = { id: string; threadId: string };

/**
 * DELETE /api/sessions/:id/threads/:threadId — dev-only manual thread close
 * (docs/story-threads.md §Manual close). Marks the story thread `resolved` in
 * `sessions.runtime`; resolved threads drop from the status payload, so the
 * World-tab card disappears. Admin-gated server-side (never trusts the client
 * flag). Resilience: runtime parsed with `parseOr`, unknown thread → 404.
 */
export const DELETE = withUser<Params>(async (user, _req, ctx) => {
  if (user.role !== "admin") return jsonError("forbidden", "closing threads is an admin action", 403);

  const { id, threadId } = await ctx.params;
  const session = await findOwnedSession(user.id, id);
  if (!session) return jsonError("not_found", "session not found", 404);

  const runtime = parseOr(sessionRuntimeSchema, session.runtime, emptySessionRuntime(), undefined, "sessions.runtime");
  if (!runtime.storyThreads.some((t) => t.id === threadId)) {
    return jsonError("not_found", "thread not found in this session", 404);
  }

  const storyThreads = runtime.storyThreads.map((t) => (t.id === threadId ? { ...t, status: "resolved" as const } : t));
  await db().update(sessions).set({ runtime: { ...runtime, storyThreads } }).where(eq(sessions.id, id));

  return jsonOk({ id: threadId, status: "resolved" });
});
