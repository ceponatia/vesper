import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { characters, db, imageReferences, images, locations } from "@/server/db";

// Gallery route integration suite (docs/testing.md §api): the GET handler invoked
// directly with mocked auth against DATABASE_URL. Self-skips when the database is
// unreachable.

const authState = vi.hoisted(() => ({
  user: { id: "", email: "", name: "Gallery Int", role: "admin" as const },
}));

vi.mock("@/server/auth", async () => (await import("@/server/test-support")).routeAuthModule(authState));

import {
  apiRequest,
  bindAuthUser,
  canonicalImageRow,
  endTestPool,
  expectApiError,
  expectJson,
  probeIntegrationDb,
  purgeOwnerRows,
  routeCtx,
  seedTestUser,
} from "@/server/test-support";
import { GET as galleryRoute } from "./gallery/route";
import { DELETE as galleryDelete, PATCH as galleryPatch } from "./gallery/[id]/route";
import { POST as galleryDeleteAll } from "./gallery/delete/route";

const ready = await probeIntegrationDb("gallery.int.test", "images");
const noCtx = routeCtx();

interface SceneOut {
  id: string;
  characterId: string | null;
  characterName: string | null;
  entityKind: string | null;
  entityName: string | null;
  prompt: string;
  favorite: boolean;
  references: Array<{ kind: string; id: string; name: string }>;
}

interface GalleryOut {
  images: SceneOut[];
  nextCursor: string | null;
}

const ids = {
  otherUser: "",
  character: "",
  location: "",
  sceneNew1: "",
  sceneNew2: "",
  sceneNew3: "",
  sceneOld: "",
  portrait: "",
  entityArt: "",
};

beforeAll(async () => {
  if (!ready) return;
  const stamp = Date.now();
  const user = await seedTestUser("gallery-int", { role: "admin" });
  const other = await seedTestUser("gallery-int-other");
  bindAuthUser(authState, user);
  ids.otherUser = other.id;

  const [character] = await db().insert(characters).values({ ownerId: user.id, name: "Alice Char" }).returning();
  const [location] = await db().insert(locations).values({ ownerId: user.id, name: "Quay House" }).returning();
  if (!character || !location) throw new Error("failed to seed character/location");
  ids.character = character.id;
  ids.location = location.id;

  // Every scene is a character-chat scene: kind="scene", entityKind="character",
  // anchored on a library character the owner still has (the scenes tab inner-joins it).
  const scene = (over: Partial<typeof images.$inferInsert>) =>
    canonicalImageRow({
      ownerId: user.id,
      kind: "scene" as const,
      status: "ready" as const,
      entityKind: "character" as const,
      entityId: character.id,
      prompt: "",
      meta: {},
      ...over,
    });

  // newest-first by createdAt desc, id desc.
  const [sceneNew1] = await db().insert(images).values(scene({ createdAt: new Date(stamp + 4000) })).returning();
  const [sceneNew2] = await db().insert(images).values(scene({ createdAt: new Date(stamp + 3000) })).returning();
  const [sceneNew3] = await db().insert(images).values(scene({ createdAt: new Date(stamp + 2000) })).returning();
  const [sceneOld] = await db().insert(images).values(scene({ createdAt: new Date(stamp + 1000) })).returning();
  if (!sceneNew1 || !sceneNew2 || !sceneNew3 || !sceneOld) throw new Error("failed to seed scenes");
  ids.sceneNew1 = sceneNew1.id;
  ids.sceneNew2 = sceneNew2.id;
  ids.sceneNew3 = sceneNew3.id;
  ids.sceneOld = sceneOld.id;

  // What each scene featured lives in the image_references join table (the
  // authoritative source the Gallery reads). sceneOld features nothing.
  await db().insert(imageReferences).values([
    { sceneImageId: sceneNew1.id, kind: "character", entityId: character.id, name: "Alice", source: "generated" },
    { sceneImageId: sceneNew1.id, kind: "location", entityId: "loc-1", name: "Quay", source: "entity" },
    { sceneImageId: sceneNew2.id, kind: "character", entityId: "char-bob", name: "Bob", source: "generated" },
  ]);

  // Excluded rows: pending / failed status, a character-anchored scene whose
  // character no longer exists (inner join drops it), and another owner's scene.
  await db().insert(images).values(scene({ status: "pending" }));
  await db().insert(images).values(scene({ status: "failed" }));
  await db().insert(images).values(scene({ entityId: "no-such-character" }));
  await db().insert(images).values(scene({ ownerId: other.id }));

  // The other tabs' rows: a portrait variant and a location render — neither
  // may leak into the scenes tab, and each surfaces under its own tab.
  const [portrait] = await db()
    .insert(images)
    .values(scene({ kind: "portrait_variant", entityKind: "character", entityId: character.id, createdAt: new Date(stamp + 5000) }))
    .returning();
  const [entityArt] = await db()
    .insert(images)
    .values(scene({ kind: "entity", entityKind: "location", entityId: location.id, createdAt: new Date(stamp + 6000) }))
    .returning();
  if (!portrait || !entityArt) throw new Error("failed to seed portrait/entity art");
  ids.portrait = portrait.id;
  ids.entityArt = entityArt.id;
});

afterAll(async () => {
  if (ready) await purgeOwnerRows([authState.user.id, ids.otherUser]);
  await endTestPool();
});

describe.skipIf(!ready)("GET /api/gallery", () => {
  it("scenes tab: the owner's ready character-chat scenes newest-first, with references", async () => {
    const body = await expectJson<GalleryOut>(await galleryRoute(apiRequest("/api/gallery"), noCtx));
    const scenes = body.images;

    // Only the four ready owned scenes — not pending, failed, the character-less
    // orphan, another owner's, or the portrait/entity rows — newest first (keyset order).
    expect(scenes.map((s) => s.id)).toEqual([ids.sceneNew1, ids.sceneNew2, ids.sceneNew3, ids.sceneOld]);
    expect(body.nextCursor).toBeNull();

    // Every scene is tagged with its anchor character (no session/world fields anymore).
    const first = scenes.find((s) => s.id === ids.sceneNew1)!;
    expect(first.characterId).toBe(ids.character);
    expect(first.characterName).toBe("Alice Char");

    // References come from the join table (order within a scene is not contractual).
    expect(first.references).toHaveLength(2);
    expect(first.references).toEqual(
      expect.arrayContaining([
        { kind: "character", id: ids.character, name: "Alice" },
        { kind: "location", id: "loc-1", name: "Quay" },
      ]),
    );
    expect(scenes.find((s) => s.id === ids.sceneOld)!.references).toEqual([]);
  });

  it("pages by keyset cursor without overlap or gaps", async () => {
    const page1 = await expectJson<GalleryOut>(
      await galleryRoute(apiRequest("/api/gallery", { query: { limit: "2" } }), noCtx),
    );
    expect(page1.images.map((s) => s.id)).toEqual([ids.sceneNew1, ids.sceneNew2]);
    expect(page1.nextCursor).toBeTruthy();

    const page2 = await expectJson<GalleryOut>(
      await galleryRoute(apiRequest("/api/gallery", { query: { limit: "2", cursor: page1.nextCursor ?? "" } }), noCtx),
    );
    expect(page2.images.map((s) => s.id)).toEqual([ids.sceneNew3, ids.sceneOld]);

    // A garbage cursor degrades to the first page, never a failed request.
    const garbage = await expectJson<GalleryOut>(
      await galleryRoute(apiRequest("/api/gallery", { query: { limit: "2", cursor: "nonsense" } }), noCtx),
    );
    expect(garbage.images.map((s) => s.id)).toEqual([ids.sceneNew1, ids.sceneNew2]);
  });

  it("portraits tab: portrait variants joined to their character", async () => {
    const body = await expectJson<GalleryOut>(
      await galleryRoute(apiRequest("/api/gallery", { query: { tab: "portraits" } }), noCtx),
    );
    expect(body.images.map((p) => p.id)).toEqual([ids.portrait]);
    expect(body.images[0]!.characterName).toBe("Alice Char");
  });

  it("entity tab: entity art with the source entity's name resolved", async () => {
    const body = await expectJson<GalleryOut>(
      await galleryRoute(apiRequest("/api/gallery", { query: { tab: "entity" } }), noCtx),
    );
    expect(body.images.map((e) => e.id)).toEqual([ids.entityArt]);
    expect(body.images[0]!.entityKind).toBe("location");
    expect(body.images[0]!.entityName).toBe("Quay House");
  });
});

describe.skipIf(!ready)("PATCH /api/gallery/:id (favorite)", () => {
  const ctx = (id: string) => routeCtx({ id });
  const patchReq = (id: string, favorite: boolean) =>
    apiRequest(`/api/gallery/${id}`, { method: "PATCH", body: { favorite } });

  it("toggles the favorite flag and serves it on the list payload", async () => {
    const res = await galleryPatch(patchReq(ids.sceneNew1, true), ctx(ids.sceneNew1));
    expect(res.status).toBe(200);
    const body = await expectJson<GalleryOut>(await galleryRoute(apiRequest("/api/gallery"), noCtx));
    expect(body.images.find((s) => s.id === ids.sceneNew1)?.favorite).toBe(true);
    await galleryPatch(patchReq(ids.sceneNew1, false), ctx(ids.sceneNew1));
  });

  it("404s another owner's image and non-gallery kinds", async () => {
    const [foreign] = await db()
      .insert(images)
      .values(canonicalImageRow({
        ownerId: ids.otherUser,
        kind: "scene" as const,
        status: "ready" as const,
        entityKind: "character" as const,
        entityId: ids.character,
        prompt: "",
        meta: {},
      }))
      .returning();
    if (!foreign) throw new Error("failed to seed foreign scene");
    expect((await galleryPatch(patchReq(foreign.id, true), ctx(foreign.id))).status).toBe(404);
    await db().delete(images).where(eq(images.id, foreign.id));
  });
});

describe.skipIf(!ready)("DELETE /api/gallery/:id", () => {
  const ctx = (id: string) => routeCtx({ id });
  const exists = async (id: string) =>
    (await db().select({ id: images.id }).from(images).where(eq(images.id, id))).length === 1;

  it("hard-deletes an owned scene image", async () => {
    const [row] = await db()
      .insert(images)
      .values(canonicalImageRow({
        ownerId: authState.user.id,
        kind: "scene" as const,
        status: "ready" as const,
        entityKind: "character" as const,
        entityId: ids.character,
        prompt: "",
        meta: {},
      }))
      .returning();
    if (!row) throw new Error("failed to seed scene to delete");

    const res = await galleryDelete(apiRequest(`/api/gallery/${row.id}`), ctx(row.id));
    expect(res.status).toBe(200);
    expect(await exists(row.id)).toBe(false);
  });

  it("404s and preserves a scene owned by someone else", async () => {
    const [row] = await db()
      .insert(images)
      .values(canonicalImageRow({
        ownerId: ids.otherUser,
        kind: "scene" as const,
        status: "ready" as const,
        entityKind: "character" as const,
        entityId: ids.character,
        prompt: "",
        meta: {},
      }))
      .returning();
    if (!row) throw new Error("failed to seed other-owner scene");

    const res = await galleryDelete(apiRequest(`/api/gallery/${row.id}`), ctx(row.id));
    expect(res.status).toBe(404);
    expect(await exists(row.id)).toBe(true);
  });

  it("404s and preserves a non-gallery asset (kind guard)", async () => {
    const [row] = await db()
      .insert(images)
      .values(canonicalImageRow({
        ownerId: authState.user.id,
        kind: "avatar" as const,
        status: "ready" as const,
        entityKind: "character" as const,
        entityId: ids.character,
        prompt: "",
        meta: {},
      }))
      .returning();
    if (!row) throw new Error("failed to seed avatar");

    const res = await galleryDelete(apiRequest(`/api/gallery/${row.id}`), ctx(row.id));
    expect(res.status).toBe(404);
    expect(await exists(row.id)).toBe(true);
  });

  it("deletes a portrait variant and clears a character avatar pointer at it", async () => {
    const [row] = await db()
      .insert(images)
      .values(canonicalImageRow({
        ownerId: authState.user.id,
        kind: "portrait_variant" as const,
        status: "ready" as const,
        entityKind: "character" as const,
        entityId: ids.character,
        prompt: "",
        meta: {},
      }))
      .returning();
    if (!row) throw new Error("failed to seed portrait");
    await db().update(characters).set({ avatarImageId: row.id }).where(eq(characters.id, ids.character));

    const res = await galleryDelete(apiRequest(`/api/gallery/${row.id}`), ctx(row.id));
    expect(res.status).toBe(200);
    expect(await exists(row.id)).toBe(false);
    // The soft pointer is nulled, never left dangling (the portrait studio's own rule).
    const [char] = await db().select({ avatarImageId: characters.avatarImageId }).from(characters).where(eq(characters.id, ids.character));
    expect(char?.avatarImageId).toBeNull();
  });
});

describe.skipIf(!ready)("POST /api/gallery/delete (bulk)", () => {
  const exists = async (id: string) =>
    (await db().select({ id: images.id }).from(images).where(eq(images.id, id))).length === 1;
  const postReq = (ids: string[]) => apiRequest("/api/gallery/delete", { body: { ids } });
  const scene = (over: Partial<typeof images.$inferInsert>) =>
    canonicalImageRow({
      ownerId: authState.user.id,
      kind: "scene" as const,
      status: "ready" as const,
      entityKind: "character" as const,
      entityId: ids.character,
      prompt: "",
      meta: {},
      ...over,
    });

  it("bulk-deletes only the owner's scene rows in the list, skipping foreign + non-scene ids", async () => {
    const [a] = await db().insert(images).values(scene({})).returning();
    const [b] = await db().insert(images).values(scene({})).returning();
    const [avatar] = await db()
      .insert(images)
      .values(scene({ kind: "avatar" }))
      .returning();
    const [foreign] = await db()
      .insert(images)
      .values(scene({ ownerId: ids.otherUser }))
      .returning();
    if (!a || !b || !avatar || !foreign) throw new Error("failed to seed bulk-delete scenes");

    const deleted = await expectJson<{ deleted: number }>(
      await galleryDeleteAll(postReq([a.id, b.id, avatar.id, foreign.id]), noCtx),
      200,
    );
    expect(deleted.deleted).toBe(2);

    // The two owned scenes are gone; the avatar (kind guard) and the other
    // owner's scene (owner scope) survive.
    expect(await exists(a.id)).toBe(false);
    expect(await exists(b.id)).toBe(false);
    expect(await exists(avatar.id)).toBe(true);
    expect(await exists(foreign.id)).toBe(true);
  });

  it("400s an empty id list", async () => {
    await expectApiError(await galleryDeleteAll(postReq([]), noCtx), 400);
  });
});
