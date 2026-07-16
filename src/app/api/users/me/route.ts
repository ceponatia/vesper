import type { NextRequest } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { jsonError, jsonOk, readBody, withUser } from "@/server/api";
import { db, personas, users } from "@/server/db";

/**
 * The current account's own profile. It carries the **default persona** — which of the
 * owner's personas new chats start as (persona-library.plan.md slice 6, the middle rung
 * of `resolveChatPersona`'s ladder). Always scoped to the signed-in user; there is no
 * `:id` form (you can only read or edit yourself).
 *
 * The old `playerPersona` blob this route used to write is gone — migration 0052
 * backfilled it into a real `personas` row and 0053 dropped the column. Editing *who
 * you are* now happens in the persona editor; this route only picks the default.
 */

const userPatchSchema = z.object({
  /** A `personas.id` to make default, or null/"" to clear it. */
  defaultPersonaId: z.string().nullable(),
});

/** GET /api/users/me — the default-persona pick + account name (the form's fallback). */
export const GET = withUser(async (user) => {
  const [row] = await db()
    .select({ name: users.name, defaultPersonaId: users.defaultPersonaId })
    .from(users)
    .where(eq(users.id, user.id))
    .limit(1);
  return jsonOk({ accountName: row?.name ?? user.name, defaultPersonaId: row?.defaultPersonaId ?? null });
});

/** PATCH /api/users/me — set (or clear) the default persona. */
export const PATCH = withUser(async (user, req: NextRequest) => {
  const body = await readBody(req, userPatchSchema);
  if (!body.ok) return body.response;
  const picked = body.value.defaultPersonaId?.trim() ?? "";

  // Owner-strict: you cannot default to someone else's persona (or a deleted one).
  // The column is a soft pointer with no FK, so this check is the guard.
  if (picked) {
    const [owned] = await db()
      .select({ id: personas.id })
      .from(personas)
      .where(and(eq(personas.id, picked), eq(personas.ownerId, user.id)))
      .limit(1);
    if (!owned) return jsonError("not_found", "persona not found", 404);
  }

  const [row] = await db()
    .update(users)
    .set({ defaultPersonaId: picked || null })
    .where(eq(users.id, user.id))
    .returning({ defaultPersonaId: users.defaultPersonaId });
  return jsonOk({ defaultPersonaId: row?.defaultPersonaId ?? null });
});
