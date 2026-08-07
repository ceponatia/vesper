import type { NextRequest } from "next/server";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { seedNewPersonaProfile } from "@/contracts";
import { parseOrNull } from "@/lib/parse";
import { db, personas } from "@/server/db";
import {
  isUniqueViolation,
  jsonError,
  jsonOk,
  parseTagsParam,
  personaCreateSchema,
  queueEmbedRefresh,
  readBody,
  searchLibraryIds,
  withUser,
} from "@/server/api";

export const GET = withUser(async (user, req: NextRequest) => {
  const params = req.nextUrl.searchParams;
  const q = params.get("q") ?? undefined;
  const tags = parseTagsParam(params.get("tag"));
  const sort = parseOrNull(z.enum(["updated", "name"]), params.get("sort"));
  // No `scope` param: personas are owner-only (no visibility column) — a persona is
  // *you*, so there is no public/browse tier to widen to (persona-library.plan.md).
  const ids = await searchLibraryIds("persona", user.id, { q, tags, sort: sort ?? undefined, scope: "owned" });
  if (ids.length === 0) return jsonOk({ personas: [] });
  // Summary columns only — the bare row carries the 1536-dim search embedding.
  const rows = await db()
    .select({
      id: personas.id,
      title: personas.title,
      name: personas.name,
      tags: personas.tags,
      avatarImageId: personas.avatarImageId,
      updatedAt: personas.updatedAt,
    })
    .from(personas)
    .where(and(inArray(personas.id, ids), eq(personas.ownerId, user.id)));
  const byId = new Map(rows.map((r) => [r.id, r]));
  return jsonOk({ personas: ids.flatMap((id) => byId.get(id) ?? []) });
});

export const POST = withUser(async (user, req: NextRequest) => {
  const body = await readBody(req, personaCreateSchema);
  if (!body.ok) return body.response;
  // The persona is the player's body, so it is born the way a character is
  // (characters/route.ts): curated core-visual defaults on a blank body, the
  // body-config those attribute values activate, then the persisted-baseline
  // facts against the seeded body. The body-config half is what stops a persona
  // being born — and staying — with no intimate anatomy at all, which is audit
  // E1 on the player's own avatar (intimate-defaulting.md §3b).
  const profile = seedNewPersonaProfile(body.value.profile);
  try {
    const [row] = await db()
      .insert(personas)
      .values({ ownerId: user.id, ...body.value, profile })
      .returning();
    if (!row) return jsonError("create_failed", "persona insert returned no row", 500);
    queueEmbedRefresh("persona", row.id);
    return jsonOk({ persona: row }, 201);
  } catch (err) {
    // (owner_id, title) is UNIQUE — the constraint IS the feature, so surface it as a
    // typed 409 the form can render inline rather than a raw 500.
    if (isUniqueViolation(err)) {
      return jsonError("title_conflict", `You already have a persona titled "${body.value.title}".`, 409);
    }
    throw err;
  }
});
