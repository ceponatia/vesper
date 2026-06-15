import { eq, sql } from "drizzle-orm";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { characters, db, images, sessionParticipants, sessions, users, worlds } from "@/server/db";

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
import { DELETE as galleryDelete } from "./gallery/[id]/route";
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
  sessionId: string;
  sessionTitle: string;
  worldName: string | null;
  references: Array<{ kind: string; id: string; name: string }>;
}

const ids = {
  otherUser: "",
  worldOld: "",
  worldNew: "",
  sessionOld: "",
  sessionNew: "",
  character: "",
  sceneNew1: "",
  sceneNew2: "",
  sceneOld: "",
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
  if (!wOld || !wNew || !character) throw new Error("failed to seed worlds/character");
  ids.worldOld = wOld.id;
  ids.worldNew = wNew.id;
  ids.character = character.id;

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
  const [sceneNew1] = await db()
    .insert(images)
    .values(scene({
      sessionId: sNew.id,
      createdAt: new Date(stamp + 2000),
      meta: { references: [{ kind: "character", id: character.id, name: "Alice" }, { kind: "location", id: "loc-1", name: "Quay" }] },
    }))
    .returning();
  const [sceneNew2] = await db()
    .insert(images)
    .values(scene({ sessionId: sNew.id, createdAt: new Date(stamp + 1000), meta: { references: [{ kind: "character", id: "char-bob", name: "Bob" }] } }))
    .returning();
  const [sceneOld] = await db().insert(images).values(scene({ sessionId: sOld.id, createdAt: new Date(stamp), meta: { references: [] } })).returning();
  if (!sceneNew1 || !sceneNew2 || !sceneOld) throw new Error("failed to seed scenes");
  ids.sceneNew1 = sceneNew1.id;
  ids.sceneNew2 = sceneNew2.id;
  ids.sceneOld = sceneOld.id;

  // Excluded rows: pending / failed status, an orphan (deleted-session) scene,
  // and another owner's scene in the same session.
  await db().insert(images).values(scene({ sessionId: sNew.id, status: "pending" }));
  await db().insert(images).values(scene({ sessionId: sOld.id, status: "failed" }));
  await db().insert(images).values(scene({ sessionId: null }));
  await db().insert(images).values(scene({ ownerId: other.id, sessionId: sNew.id }));

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
  await db().delete(users).where(eq(users.id, authState.user.id));
  await db().delete(users).where(eq(users.id, ids.otherUser));
  await globalThis.__vesperPool?.end();
});

describe("GET /api/gallery", () => {
  it("returns the owner's ready scenes, grouped-orderable by session recency, with references", async (t) => {
    if (!ready) return t.skip();
    const body = await json(await galleryRoute(req("http://t/api/gallery"), noCtx));
    const scenes = body.scenes as SceneOut[];

    // Only the three ready, still-existing-session, owned scenes — not pending,
    // failed, orphaned (null session), or another owner's.
    expect(scenes.map((s) => s.id).sort()).toEqual([ids.sceneNew1, ids.sceneNew2, ids.sceneOld].sort());

    // Newest session first; newest scene first within a session.
    expect(scenes.map((s) => s.id)).toEqual([ids.sceneNew1, ids.sceneNew2, ids.sceneOld]);

    // Joined session/world fields.
    const first = scenes.find((s) => s.id === ids.sceneNew1)!;
    expect(first.sessionTitle).toBe("New Session");
    expect(first.worldName).toBe("New World");
    expect(scenes.find((s) => s.id === ids.sceneOld)!.worldName).toBe("Old World");

    // References ride through from meta.
    expect(first.references).toEqual([
      { kind: "character", id: ids.character, name: "Alice" },
      { kind: "location", id: "loc-1", name: "Quay" },
    ]);
    expect(scenes.find((s) => s.id === ids.sceneOld)!.references).toEqual([]);
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

  it("404s and preserves a non-scene asset (kind guard)", async (t) => {
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
});
