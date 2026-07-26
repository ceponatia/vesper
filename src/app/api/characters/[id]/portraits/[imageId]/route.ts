import fs from "node:fs/promises";
import { and, eq } from "drizzle-orm";
import { characters, db, images } from "@/server/db";
import { absoluteImagePath } from "@/server/images";
import { jsonError, jsonOk, withUser } from "@/server/api";
import { findPortrait } from "../owned";

type Params = { id: string; imageId: string };

export const GET = withUser<Params>(async (user, _req, ctx) => {
  const { id, imageId } = await ctx.params;
  const row = await findPortrait(user.id, id, imageId);
  if (!row) return jsonError("not_found", "portrait not found", 404);
  return jsonOk({ image: row });
});

export const DELETE = withUser<Params>(async (user, _req, ctx) => {
  const { id, imageId } = await ctx.params;
  const row = await findPortrait(user.id, id, imageId);
  if (!row) return jsonError("not_found", "portrait not found", 404);

  await db().delete(images).where(eq(images.id, imageId));
  // a deleted canonical portrait leaves the character avatar-less, never dangling
  await db()
    .update(characters)
    .set({ avatarImageId: null })
    .where(and(eq(characters.id, id), eq(characters.avatarImageId, imageId)));
  void fs.unlink(absoluteImagePath(row)).catch(() => undefined); // sweep reconciles stragglers
  return jsonOk({ ok: true });
});
