import { eq } from "drizzle-orm";
import { cloneEntityImages, queueIdentityPackPreparation } from "@/server/images";
import { characters, db, items, locations, socialCards } from "@/server/db";
import { queueEmbedRefresh } from "./library";
import { findViewable, type ShareableKind } from "./visibility";

/**
 * Clone-to-library (auth.plan.md slice 7). The source may be **public** (read
 * via findViewable) or your own; the result is always a new **owned, private**
 * row with `clonedFromId` provenance and self-contained, duplicated images — so
 * deleting the source later can never break your copy (the world-instances
 * guarantee, extended library→library). The source is never mutated.
 *
 * A character clone copies the **whole** authored `profile` — narrator guidance,
 * drives, intimacy notes, voice anchors and all — and that is an explicit
 * product decision (security-authz.plan.md OQ2), not an oversight: publishing a
 * character offers it as a full authored starting point, so a clone is richer
 * than the public *preview*, which `toPublicCharacterProfile` narrows to
 * presentation data only.
 *
 * Re-affirmed by the owner 2026-07-31 ("Disclose on publish"): the duplication
 * stays full-profile, and the asymmetry is disclosed to the author **at the
 * publish control** instead (`components/library/publish-toggle.tsx`; policy in
 * docs/auth.md §"Publishing and cloning"). Publishing is therefore the consent
 * boundary for the whole profile — a new profile field is clone-visible the day
 * it is added, and preview-visible only if someone adds it to the projection.
 *
 * Scope note: the snapshot is copied as-is — a character's `defaultOutfit` /
 * a location's links keep referencing the source owner's library ids, which
 * simply degrade (resolve to nothing) for the new owner rather than breaking.
 * Deep-cloning those reference graphs is a future enhancement.
 */
export type CloneResult = { ok: true; id: string } | { ok: false; code: "not_found" };

export async function cloneToLibrary(kind: ShareableKind, srcId: string, userId: string): Promise<CloneResult> {
  switch (kind) {
    case "character": {
      const src = await findViewable("character", srcId, userId);
      if (!src) return { ok: false, code: "not_found" };
      const [copy] = await db()
        .insert(characters)
        .values({
          ownerId: userId,
          name: src.name,
          profile: src.profile,
          tags: src.tags,
          visibility: "private",
          clonedFromId: src.id,
        })
        .returning({ id: characters.id });
      if (!copy) return { ok: false, code: "not_found" };
      const imageMap = await cloneEntityImages("character", src.id, src.ownerId, copy.id, userId);
      const newAvatar = src.avatarImageId ? imageMap.get(src.avatarImageId) : undefined;
      if (newAvatar) {
        await db().update(characters).set({ avatarImageId: newAvatar }).where(eq(characters.id, copy.id));
        // The copy derives its OWN pack from its own copied portrait: pack rows
        // and hidden crops never cross an owner boundary, and origin review
        // actors, overrides and trial status do not transfer
        // (image-identity-packs.spec.lifecycle.md §"Copy and publish behavior").
        queueIdentityPackPreparation(copy.id, userId);
      }
      queueEmbedRefresh("character", copy.id);
      return { ok: true, id: copy.id };
    }
    case "location": {
      const src = await findViewable("location", srcId, userId);
      if (!src) return { ok: false, code: "not_found" };
      const [copy] = await db()
        .insert(locations)
        .values({
          ownerId: userId,
          name: src.name,
          description: src.description,
          ambient: src.ambient,
          scale: src.scale,
          area: src.area,
          affordances: src.affordances,
          tags: src.tags,
          visibility: "private",
          clonedFromId: src.id,
        })
        .returning({ id: locations.id });
      if (!copy) return { ok: false, code: "not_found" };
      const imageMap = await cloneEntityImages("location", src.id, src.ownerId, copy.id, userId);
      const newImage = src.imageId ? imageMap.get(src.imageId) : undefined;
      if (newImage) await db().update(locations).set({ imageId: newImage }).where(eq(locations.id, copy.id));
      queueEmbedRefresh("location", copy.id);
      return { ok: true, id: copy.id };
    }
    case "item": {
      const src = await findViewable("item", srcId, userId);
      if (!src) return { ok: false, code: "not_found" };
      const [copy] = await db()
        .insert(items)
        .values({
          ownerId: userId,
          kind: src.kind,
          name: src.name,
          description: src.description,
          definition: src.definition,
          tags: src.tags,
          visibility: "private",
          clonedFromId: src.id,
        })
        .returning({ id: items.id });
      if (!copy) return { ok: false, code: "not_found" };
      const imageMap = await cloneEntityImages("item", src.id, src.ownerId, copy.id, userId);
      const newImage = src.imageId ? imageMap.get(src.imageId) : undefined;
      if (newImage) await db().update(items).set({ imageId: newImage }).where(eq(items.id, copy.id));
      queueEmbedRefresh("item", copy.id);
      return { ok: true, id: copy.id };
    }
    case "social_card": {
      // Cards carry no images (social-reaction-cards.plan.md) — no cloneEntityImages step.
      const src = await findViewable("social_card", srcId, userId);
      if (!src) return { ok: false, code: "not_found" };
      const [copy] = await db()
        .insert(socialCards)
        .values({
          ownerId: userId,
          name: src.name,
          description: src.description,
          definition: src.definition,
          tags: src.tags,
          visibility: "private",
          clonedFromId: src.id,
        })
        .returning({ id: socialCards.id });
      if (!copy) return { ok: false, code: "not_found" };
      queueEmbedRefresh("social_card", copy.id);
      return { ok: true, id: copy.id };
    }
  }
}
