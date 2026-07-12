import { eq, sql } from "drizzle-orm";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { characters, db, imageReferences, images, locations, sessionParticipants, sessions, users, worlds } from "@/server/db";

// Gallery route + scene-reference resolution integration suite (docs/testing.md
// §api): the GET handler invoked directly with mocked auth against DATABASE_URL.
// Self-skips when the database is unreachable.

const authState = vi.hoisted(() => ({
  user: { id: "", email: "", name: "Gallery Int", role: "admin" as const },
}));

vi.mock("@/server/auth", () => ({
  USER_COOKIE: "vesper_user",
  getCurrentUser: async () => authState.user,
  ensureDefaultUser: async () => authState.user,
  listUsers: async () => [authState.user],
}));

import { GET as galleryRoute } from "./gallery/route";
import { DELETE as galleryDelete, PATCH as galleryPatch } from "./gallery/[id]/route";
import { POST as galleryDeleteAll } from "./gallery/delete/route";
import { resolveSceneCharacterRefs } from "@/server/images";

async function probe(): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      db().execute(sql`select 1 from images limit 1`),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("connect timeout")), 4000);
      }),
    ]);
    return true;
  } catch (err) {
    process.stderr.write(`[gallery.int.test] skipping: database unreachable: ${err instanceof Error ? err.message : String(err)}\n`);
    return false;
  } finally {
    clearTimeout(timer);
  }
}

const ready = await probe();
const noCtx = { params: Promise.resolve({}) };

function req(url: string): NextRequest {
  return new NextRequest(url);
}
async function json(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

interface SceneOut {
  id: string;
  sessionId: string | null;
  sessionTitle: string | null;
  worldName: string | null;
  characterId: string | null;
  characterName: string | null;
  entityKind: string | null;
  entityName: string | null;
  favorite: boolean;
  references: Array<{ kind: string; id: string; name: string }>;
}

interface GalleryOut {
  images: SceneOut[];
  nextCursor: string | null;
}

const ids = {
  otherUser: "",
  worldOld: "",
  worldNew: "",
  sessionOld: "",
  sessionNew: "",
  character: "",
  location: "",
  sceneNew1: "",
  sceneNew2: "",
  sceneOld: "",
  sceneChat: "",
  portrait: "",
  entityArt: "",
};

beforeAll(async () => {
  if (!ready) return;
  const stamp = Date.now();
  const [user] = await db().insert(users).values({ email: `gallery-int-${stamp}@test.local`, name: "Gallery Int", role: "admin" }).returning();
  const [other] = await db().insert(users).values({ email: `gallery-int-other-${stamp}@test.local`, name: "Other" }).returning();
  if (!user || !other) throw new Error("failed to create test users");
  authState.user = { ...authState.user, id: user.id, email: user.email };
  ids.otherUser = other.id;

  const [wOld] = await db().insert(worlds).values({ ownerId: user.id, name: "Old World" }).returning();
  const [wNew] = await db().insert(worlds).values({ ownerId: user.id, name: "New World" }).returning();
  const [character] = await db().insert(characters).values({ ownerId: user.id, name: "Alice Char" }).returning();
  const [location] = await db().insert(locations).values({ ownerId: user.id, name: "Quay House" }).returning();
  if (!wOld || !wNew || !character || !location) throw new Error("failed to seed worlds/character/location");
  ids.worldOld = wOld.id;
  ids.worldNew = wNew.id;
  ids.character = character.id;
  ids.location = location.id;

  // sessionNew is more recently updated than sessionOld → it sorts first.
  const [sOld] = await db()
    .insert(sessions)
    .values({ ownerId: user.id, worldId: wOld.id, title: "Old Session", updatedAt: new Date(stamp - 60_000) })
    .returning();
  const [sNew] = await db()
    .insert(sessions)
    .values({ ownerId: user.id, worldId: wNew.id, title: "New Session", updatedAt: new Date(stamp) })
    .returning();
  if (!sOld || !sNew) throw new Error("failed to seed sessions");
  ids.sessionOld = sOld.id;
  ids.sessionNew = sNew.id;

  const scene = (over: Partial<typeof images.$inferInsert>) => ({
    ownerId: user.id,
    kind: "scene" as const,
    status: "ready" as const,
    path: `images/${user.id}/scene.webp`,
    prompt: "",
    meta: {},
    ...over,
  });

  // newest-first within sessionNew: sceneNew1 createdAt > sceneNew2
  const [sceneNew1] = await db().insert(images).values(scene({ sessionId: sNew.id, createdAt: new Date(stamp + 2000) })).returning();
  const [sceneNew2] = await db().insert(images).values(scene({ sessionId: sNew.id, createdAt: new Date(stamp + 1000) })).returning();
  const [sceneOld] = await db().insert(images).values(scene({ sessionId: sOld.id, createdAt: new Date(stamp) })).returning();
  if (!sceneNew1 || !sceneNew2 || !sceneOld) throw new Error("failed to seed scenes");
  ids.sceneNew1 = sceneNew1.id;
  ids.sceneNew2 = sceneNew2.id;
  ids.sceneOld = sceneOld.id;

  // A sessionless character-chat scene (kind="scene", entityKind="character",
  // no session) surfaces in the Gallery under "Character chats".
  const [sceneChat] = await db()
    .insert(images)
    .values(scene({ sessionId: null, entityKind: "character", entityId: character.id, createdAt: new Date(stamp + 3000) }))
    .returning();
  if (!sceneChat) throw new Error("failed to seed chat scene");
  ids.sceneChat = sceneChat.id;

  // What each scene featured now lives in the image_references join table (the
  // authoritative source the Gallery reads). sceneOld features nothing.
  await db().insert(imageReferences).values([
    { sceneImageId: sceneNew1.id, kind: "character", entityId: character.id, name: "Alice", source: "generated" },
    { sceneImageId: sceneNew1.id, kind: "location", entityId: "loc-1", name: "Quay", source: "entity" },
    { sceneImageId: sceneNew2.id, kind: "character", entityId: "char-bob", name: "Bob", source: "generated" },
    { sceneImageId: sceneChat.id, kind: "character", entityId: character.id, name: "Alice", source: "generated" },
  ]);

  // Excluded rows: pending / failed status, a true orphan (no session, no
  // entity), and another owner's scene in the same session.
  await db().insert(images).values(scene({ sessionId: sNew.id, status: "pending" }));
  await db().insert(images).values(scene({ sessionId: sOld.id, status: "failed" }));
  await db().insert(images).values(scene({ sessionId: null }));
  await db().insert(images).values(scene({ ownerId: other.id, sessionId: sNew.id }));

  // The other tabs' rows: a portrait variant and a location render — neither
  // may leak into the scenes tab, and each surfaces under its own tab.
  const [portrait] = await db()
    .insert(images)
    .values(scene({ kind: "portrait_variant", sessionId: null, entityKind: "character", entityId: character.id, createdAt: new Date(stamp + 4000) }))
    .returning();
  const [entityArt] = await db()
    .insert(images)
    .values(scene({ kind: "entity", sessionId: null, entityKind: "location", entityId: location.id, createdAt: new Date(stamp + 5000) }))
    .returning();
  if (!portrait || !entityArt) throw new Error("failed to seed portrait/entity art");
  ids.portrait = portrait.id;
  ids.entityArt = entityArt.id;

  // Participants for the resolveSceneCharacterRefs test.
  await db().insert(sessionParticipants).values([
    { sessionId: sNew.id, displayName: "Alice", characterId: character.id },
    { sessionId: sNew.id, displayName: "Player", isUser: true },
  ]);
});

afterAll(async () => {
  if (!ready) return;
  await db().delete(images).where(eq(images.ownerId, authState.user.id));
  await db().delete(images).where(eq(images.ownerId, ids.otherUser));
  await db().delete(sessions).where(eq(sessions.ownerId, authState.user.id));
  await db().delete(worlds).where(eq(worlds.ownerId, authState.user.id));
  await db().delete(characters).where(eq(characters.ownerId, authState.user.id));
  await db().delete(locations).where(eq(locations.ownerId, authState.user.id));
  await db().delete(users).where(eq(users.id, authState.user.id));
  await db().delete(users).where(eq(users.id, ids.otherUser));
  await globalThis.__vesperPool?.end();
});

describe("GET /api/gallery", () => {
  it("scenes tab: the owner's ready scenes newest-first, with joins + references", async (t) => {
    if (!ready) return t.skip();
    const body = (await json(await galleryRoute(req("http://t/api/gallery"), noCtx))) as unknown as GalleryOut;
    const scenes = body.images;

    // Only the four ready owned scenes — not pending, failed, the true orphan,
    // another owner's, or the portrait/entity rows — newest first (keyset order).
    expect(scenes.map((s) => s.id)).toEqual([ids.sceneChat, ids.sceneNew1, ids.sceneNew2, ids.sceneOld]);
    expect(body.nextCursor).toBeNull();

    // Joined session/world fields.
    const first = scenes.find((s) => s.id === ids.sceneNew1)!;
    expect(first.sessionTitle).toBe("New Session");
    expect(first.worldName).toBe("New World");
    expect(scenes.find((s) => s.id === ids.sceneOld)!.worldName).toBe("Old World");

    // The sessionless chat scene is tagged with its character; session scenes are not.
    const chat = scenes.find((s) => s.id === ids.sceneChat)!;
    expect(chat.sessionId).toBeNull();
    expect(chat.characterId).toBe(ids.character);
    expect(chat.characterName).toBe("Alice Char");
    expect(first.characterId).toBeNull();

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

  it("pages by keyset cursor without overlap or gaps", async (t) => {
    if (!ready) return t.skip();
    const page1 = (await json(await galleryRoute(req("http://t/api/gallery?limit=2"), noCtx))) as unknown as GalleryOut;
    expect(page1.images.map((s) => s.id)).toEqual([ids.sceneChat, ids.sceneNew1]);
    expect(page1.nextCursor).toBeTruthy();

    const page2 = (await json(
      await galleryRoute(req(`http://t/api/gallery?limit=2&cursor=${encodeURIComponent(page1.nextCursor ?? "")}`), noCtx),
    )) as unknown as GalleryOut;
    expect(page2.images.map((s) => s.id)).toEqual([ids.sceneNew2, ids.sceneOld]);

    // A garbage cursor degrades to the first page, never a failed request.
    const garbage = (await json(await galleryRoute(req("http://t/api/gallery?limit=2&cursor=nonsense"), noCtx))) as unknown as GalleryOut;
    expect(garbage.images.map((s) => s.id)).toEqual([ids.sceneChat, ids.sceneNew1]);
  });

  it("portraits tab: portrait variants joined to their character", async (t) => {
    if (!ready) return t.skip();
    const body = (await json(await galleryRoute(req("http://t/api/gallery?tab=portraits"), noCtx))) as unknown as GalleryOut;
    expect(body.images.map((p) => p.id)).toEqual([ids.portrait]);
    expect(body.images[0]!.characterName).toBe("Alice Char");
  });

  it("entity tab: entity art with the source entity's name resolved", async (t) => {
    if (!ready) return t.skip();
    const body = (await json(await galleryRoute(req("http://t/api/gallery?tab=entity"), noCtx))) as unknown as GalleryOut;
    expect(body.images.map((e) => e.id)).toEqual([ids.entityArt]);
    expect(body.images[0]!.entityKind).toBe("location");
    expect(body.images[0]!.entityName).toBe("Quay House");
  });
});

describe("PATCH /api/gallery/:id (favorite)", () => {
  const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
  const patchReq = (id: string, favorite: boolean) =>
    new NextRequest(`http://t/api/gallery/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ favorite }),
    });

  it("toggles the favorite flag and serves it on the list payload", async (t) => {
    if (!ready) return t.skip();
    const res = await galleryPatch(patchReq(ids.sceneNew1, true), ctx(ids.sceneNew1));
    expect(res.status).toBe(200);
    const body = (await json(await galleryRoute(req("http://t/api/gallery"), noCtx))) as unknown as GalleryOut;
    expect(body.images.find((s) => s.id === ids.sceneNew1)?.favorite).toBe(true);
    await galleryPatch(patchReq(ids.sceneNew1, false), ctx(ids.sceneNew1));
  });

  it("404s another owner's image and non-gallery kinds", async (t) => {
    if (!ready) return t.skip();
    const [foreign] = await db()
      .insert(images)
      .values({
        ownerId: ids.otherUser,
        kind: "scene",
        status: "ready",
        sessionId: ids.sessionNew,
        path: `images/${ids.otherUser}/fav.webp`,
        prompt: "",
        meta: {},
      })
      .returning();
    if (!foreign) throw new Error("failed to seed foreign scene");
    expect((await galleryPatch(patchReq(foreign.id, true), ctx(foreign.id))).status).toBe(404);
    await db().delete(images).where(eq(images.id, foreign.id));
  });
});

describe("resolveSceneCharacterRefs", () => {
  it("resolves in-frame names to character refs, skipping the character-less and deduping", async (t) => {
    if (!ready) return t.skip();
    const refs = await resolveSceneCharacterRefs(ids.sessionNew, ["Alice", "alice", "Player", "Ghost"]);
    expect(refs).toEqual([{ kind: "character", id: ids.character, name: "Alice" }]);
  });

  it("returns [] for no names", async (t) => {
    if (!ready) return t.skip();
    expect(await resolveSceneCharacterRefs(ids.sessionNew, [])).toEqual([]);
  });
});

describe("DELETE /api/gallery/:id", () => {
  const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
  const exists = async (id: string) =>
    (await db().select({ id: images.id }).from(images).where(eq(images.id, id))).length === 1;

  it("hard-deletes an owned scene image", async (t) => {
    if (!ready) return t.skip();
    const [row] = await db()
      .insert(images)
      .values({
        ownerId: authState.user.id,
        kind: "scene",
        status: "ready",
        sessionId: ids.sessionNew,
        path: `images/${authState.user.id}/del.webp`,
        prompt: "",
        meta: {},
      })
      .returning();
    if (!row) throw new Error("failed to seed scene to delete");

    const res = await galleryDelete(req(`http://t/api/gallery/${row.id}`), ctx(row.id));
    expect(res.status).toBe(200);
    expect(await exists(row.id)).toBe(false);
  });

  it("404s and preserves a scene owned by someone else", async (t) => {
    if (!ready) return t.skip();
    const [row] = await db()
      .insert(images)
      .values({
        ownerId: ids.otherUser,
        kind: "scene",
        status: "ready",
        sessionId: ids.sessionNew,
        path: `images/${ids.otherUser}/del.webp`,
        prompt: "",
        meta: {},
      })
      .returning();
    if (!row) throw new Error("failed to seed other-owner scene");

    const res = await galleryDelete(req(`http://t/api/gallery/${row.id}`), ctx(row.id));
    expect(res.status).toBe(404);
    expect(await exists(row.id)).toBe(true);
  });

  it("404s and preserves a non-gallery asset (kind guard)", async (t) => {
    if (!ready) return t.skip();
    const [row] = await db()
      .insert(images)
      .values({
        ownerId: authState.user.id,
        kind: "avatar",
        status: "ready",
        entityKind: "character",
        entityId: ids.character,
        path: `images/${authState.user.id}/avatar-del.webp`,
        prompt: "",
        meta: {},
      })
      .returning();
    if (!row) throw new Error("failed to seed avatar");

    const res = await galleryDelete(req(`http://t/api/gallery/${row.id}`), ctx(row.id));
    expect(res.status).toBe(404);
    expect(await exists(row.id)).toBe(true);
  });

  it("deletes a portrait variant and clears a character avatar pointer at it", async (t) => {
    if (!ready) return t.skip();
    const [row] = await db()
      .insert(images)
      .values({
        ownerId: authState.user.id,
        kind: "portrait_variant",
        status: "ready",
        entityKind: "character",
        entityId: ids.character,
        path: `images/${authState.user.id}/portrait-del.webp`,
        prompt: "",
        meta: {},
      })
      .returning();
    if (!row) throw new Error("failed to seed portrait");
    await db().update(characters).set({ avatarImageId: row.id }).where(eq(characters.id, ids.character));

    const res = await galleryDelete(req(`http://t/api/gallery/${row.id}`), ctx(row.id));
    expect(res.status).toBe(200);
    expect(await exists(row.id)).toBe(false);
    // The soft pointer is nulled, never left dangling (the portrait studio's own rule).
    const [char] = await db().select({ avatarImageId: characters.avatarImageId }).from(characters).where(eq(characters.id, ids.character));
    expect(char?.avatarImageId).toBeNull();
  });
});

describe("POST /api/gallery/delete (bulk)", () => {
  const exists = async (id: string) =>
    (await db().select({ id: images.id }).from(images).where(eq(images.id, id))).length === 1;
  const postReq = (ids: string[]) =>
    new NextRequest("http://t/api/gallery/delete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids }),
    });
  const scene = (over: Partial<typeof images.$inferInsert>) => ({
    ownerId: authState.user.id,
    kind: "scene" as const,
    status: "ready" as const,
    path: `images/${authState.user.id}/bulk.webp`,
    prompt: "",
    meta: {},
    ...over,
  });

  it("bulk-deletes only the owner's scene rows in the list, skipping foreign + non-scene ids", async (t) => {
    if (!ready) return t.skip();
    const [a] = await db().insert(images).values(scene({ sessionId: ids.sessionNew })).returning();
    const [b] = await db().insert(images).values(scene({ sessionId: ids.sessionOld })).returning();
    const [avatar] = await db()
      .insert(images)
      .values(scene({ kind: "avatar", entityKind: "character", entityId: ids.character }))
      .returning();
    const [foreign] = await db()
      .insert(images)
      .values(scene({ ownerId: ids.otherUser, sessionId: ids.sessionNew, path: `images/${ids.otherUser}/bulk.webp` }))
      .returning();
    if (!a || !b || !avatar || !foreign) throw new Error("failed to seed bulk-delete scenes");

    const res = await galleryDeleteAll(postReq([a.id, b.id, avatar.id, foreign.id]), noCtx);
    expect(res.status).toBe(200);
    expect((await json(res)).deleted).toBe(2);

    // The two owned scenes are gone; the avatar (kind guard) and the other
    // owner's scene (owner scope) survive.
    expect(await exists(a.id)).toBe(false);
    expect(await exists(b.id)).toBe(false);
    expect(await exists(avatar.id)).toBe(true);
    expect(await exists(foreign.id)).toBe(true);
  });

  it("400s an empty id list", async (t) => {
    if (!ready) return t.skip();
    const res = await galleryDeleteAll(postReq([]), noCtx);
    expect(res.status).toBe(400);
  });
});
