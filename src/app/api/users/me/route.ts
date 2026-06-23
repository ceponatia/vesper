import type { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { emptyPlayerPersona, playerPersonaSchema } from "@/contracts";
import { parseOr } from "@/lib/parse";
import { jsonOk, readBody, withUser } from "@/server/api";
import { db, users } from "@/server/db";

/**
 * The current account's own profile (player-character.plan.md). Today it carries
 * the **default player character** — a light persona surfaced in character chat.
 * Always scoped to the signed-in user; there is no `:id` form (you can only read
 * or edit yourself).
 */

const userPatchSchema = z.object({
  /** The whole persona is replaced atomically — the settings form sends both fields together. */
  playerPersona: playerPersonaSchema,
});

/** GET /api/users/me — the persona + account name (the form's placeholder/fallback). */
export const GET = withUser(async (user) => {
  const [row] = await db()
    .select({ name: users.name, playerPersona: users.playerPersona })
    .from(users)
    .where(eq(users.id, user.id))
    .limit(1);
  const playerPersona = parseOr(
    playerPersonaSchema,
    row?.playerPersona,
    emptyPlayerPersona(),
    undefined,
    "users.player_persona",
  );
  return jsonOk({ accountName: row?.name ?? user.name, playerPersona });
});

/** PATCH /api/users/me — replace the default player character persona. */
export const PATCH = withUser(async (user, req: NextRequest) => {
  const body = await readBody(req, userPatchSchema);
  if (!body.ok) return body.response;
  const [row] = await db()
    .update(users)
    .set({ playerPersona: body.value.playerPersona })
    .where(eq(users.id, user.id))
    .returning({ playerPersona: users.playerPersona });
  const playerPersona = parseOr(
    playerPersonaSchema,
    row?.playerPersona,
    emptyPlayerPersona(),
    undefined,
    "users.player_persona",
  );
  return jsonOk({ playerPersona });
});
