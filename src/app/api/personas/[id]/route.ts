import type { NextRequest } from "next/server";
import { and, eq } from "drizzle-orm";
import { emptyPersonaProfile, personaProfileSchema } from "@/contracts";
import { parseOr } from "@/lib/parse";
import { db, personas } from "@/server/db";
import {
  isUniqueViolation,
  jsonError,
  jsonOk,
  personaPatchSchema,
  queueEmbedRefresh,
  readBody,
  withUser,
} from "@/server/api";

type Params = { id: string };

/**
 * Owner-strict lookup. Personas have no `visibility` column and therefore no
 * `findViewable` owner-or-public widening — a persona is *you*, so every read is
 * owner-only (persona-library.plan.md).
 */
async function findPersona(ownerId: string, id: string) {
  const [row] = await db()
    .select()
    .from(personas)
    .where(and(eq(personas.id, id), eq(personas.ownerId, ownerId)))
    .limit(1);
  return row;
}

export const GET = withUser<Params>(async (user, _req, ctx) => {
  const { id } = await ctx.params;
  const row = await findPersona(user.id, id);
  if (!row) return jsonError("not_found", "persona not found", 404);
  return jsonOk({ persona: row });
});

export const PATCH = withUser<Params>(async (user, req: NextRequest, ctx) => {
  const { id } = await ctx.params;
  const body = await readBody(req, personaPatchSchema);
  if (!body.ok) return body.response;
  const existing = await findPersona(user.id, id);
  if (!existing) return jsonError("not_found", "persona not found", 404);

  const { profile, ...columns } = body.value;
  // A profile PATCH is a partial view (partialWithoutDefaults), so merge it over the
  // stored profile rather than replacing — an editor tab that sends only `attributes`
  // must not blank the wardrobe. The stored value parses through the contract first so
  // a corrupt row heals instead of poisoning the merge (docs/resilience.md §1).
  const nextProfile =
    profile === undefined
      ? undefined
      : personaProfileSchema.parse({
          ...parseOr(personaProfileSchema, existing.profile, emptyPersonaProfile(), undefined, "personas.profile"),
          ...profile,
        });

  const values = { ...columns, ...(nextProfile === undefined ? {} : { profile: nextProfile }) };
  if (Object.keys(values).length === 0) return jsonOk({ persona: existing });

  try {
    // `updatedAt` is $onUpdate in the schema — drizzle stamps it, same as every other
    // library PATCH.
    await db().update(personas).set(values).where(and(eq(personas.id, id), eq(personas.ownerId, user.id)));
  } catch (err) {
    if (isUniqueViolation(err)) {
      return jsonError("title_conflict", `You already have a persona titled "${body.value.title ?? ""}".`, 409);
    }
    throw err;
  }
  queueEmbedRefresh("persona", id);
  const row = (await findPersona(user.id, id)) ?? existing;
  return jsonOk({ persona: row });
});

export const DELETE = withUser<Params>(async (user, _req, ctx) => {
  const { id } = await ctx.params;
  const existing = await findPersona(user.id, id);
  if (!existing) return jsonError("not_found", "persona not found", 404);
  await db().delete(personas).where(and(eq(personas.id, id), eq(personas.ownerId, user.id)));
  return jsonOk({ ok: true });
});
