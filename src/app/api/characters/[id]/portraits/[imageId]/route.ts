import fs from "node:fs/promises";
import { and, eq } from "drizzle-orm";
import { characters, db, images } from "@/server/db";
import { absoluteImagePath, invalidateIdentityPackForSource } from "@/server/images";
import { jsonError, jsonOk, withAuthorizedResource } from "@/server/api";
import { findOwnedCharacter } from "../../owned";
import { findPortrait } from "../owned";

type Params = { id: string; imageId: string };

type OwnedCharacter = NonNullable<Awaited<ReturnType<typeof findOwnedCharacter>>>;

/**
 * A portrait is addressed as a CHILD — `(parent character, image)` — so the
 * parent is authorized by the wrapper and the child by `findPortrait`, which is
 * owner-scoped, entity-scoped and kind-scoped in one query. Both halves stay:
 * the wrapper is what `pnpm lint:authz` requires of a resource-ID route, and the
 * lookup is what keeps a hidden `identity_face_crop` out of a studio route.
 */
const ownedCharacter = async (user: { id: string }, params: Params) =>
  (await findOwnedCharacter(params.id, user.id)) ?? null;

export const GET = withAuthorizedResource<Params, OwnedCharacter>(
  "character",
  ownedCharacter,
  async (user, _character, _req, ctx) => {
    const { id, imageId } = await ctx.params;
    const row = await findPortrait(user.id, id, imageId);
    if (!row) return jsonError("not_found", "portrait not found", 404);
    return jsonOk({ image: row });
  },
);

export const DELETE = withAuthorizedResource<Params, OwnedCharacter>(
  "character",
  ownedCharacter,
  async (user, _character, _req, ctx) => {
    const { id, imageId } = await ctx.params;
    const row = await findPortrait(user.id, id, imageId);
    if (!row) return jsonError("not_found", "portrait not found", 404);

    // Retire first, delete second (image-identity-packs.spec.lifecycle.md §"Source
    // deletion"): this route deletes the row itself rather than going through
    // `deleteOwnedImage`, so it owns the ordering `purgeImagesWhere` owns for every
    // other path. The pack's `source_image_id` is a `set null` FK, so after the
    // delete no query can still match the pack by this id and it would keep
    // reporting `ready` over a source that is gone. Contained, because maintenance
    // must not fail a portrait delete the owner asked for.
    await invalidateIdentityPackForSource({ sourceImageIds: [imageId] }).catch(() => undefined);
    // a deleted canonical portrait leaves the character avatar-less, never dangling;
    // owner predicate direct, not just via findPortrait (security-authz.plan.md slice 6)
    await db()
      .update(characters)
      .set({ avatarImageId: null })
      .where(and(eq(characters.id, id), eq(characters.ownerId, user.id), eq(characters.avatarImageId, imageId)));
    await db().delete(images).where(and(eq(images.id, imageId), eq(images.ownerId, user.id)));
    void fs.unlink(absoluteImagePath(row)).catch(() => undefined); // sweep reconciles stragglers
    return jsonOk({ ok: true });
  },
);
