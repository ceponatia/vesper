import { eq, sql } from "drizzle-orm";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { characters, db, items, users } from "@/server/db";

// Integration suite for GET /api/items/:id/usage (ux-improvements slice 6 —
// the delete dialog's in-use warning): the characters wearing the item in an
// outfit preset (new shape or the legacy id list) are named; references are
// owner-scoped. Self-skips when the database is unreachable.

const authState = vi.hoisted(() => ({
  user: { id: "", email: "", name: "Usage Int", role: "admin" as const },
}));

vi.mock("@/server/auth", () => ({
  USER_COOKIE: "vesper_user",
  getCurrentUser: async () => authState.user,
  ensureDefaultUser: async () => authState.user,
  listUsers: async () => [authState.user],
}));

import { GET as usageGet } from "./[id]/usage/route";

async function probe(): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      db().execute(sql`select 1 from items limit 1`),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("connect timeout")), 4000);
      }),
    ]);
    return true;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[items-usage.int.test] skipping — database unreachable or unmigrated: ${reason}\n`);
    return false;
  } finally {
    clearTimeout(timer);
  }
}

const ready = await probe();

const ids = { itemWorn: "", itemUnused: "", otherUser: "", otherItem: "" };

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const req = (id: string) => new NextRequest(`http://t/api/items/${id}/usage`);

beforeAll(async () => {
  if (!ready) return;
  const stamp = Date.now();
  const [user] = await db()
    .insert(users)
    .values({ email: `items-usage-${stamp}@test.local`, name: "Usage Int" })
    .returning();
  const [other] = await db()
    .insert(users)
    .values({ email: `items-usage-other-${stamp}@test.local`, name: "Other" })
    .returning();
  if (!user || !other) throw new Error("failed to create test users");
  authState.user = { ...authState.user, id: user.id, email: user.email };
  ids.otherUser = other.id;

  const [worn] = await db()
    .insert(items)
    .values({ ownerId: user.id, kind: "clothing", name: "Silk wrap dress", definition: {} })
    .returning();
  const [unused] = await db()
    .insert(items)
    .values({ ownerId: user.id, kind: "clothing", name: "Forgotten scarf", definition: {} })
    .returning();
  const [foreign] = await db()
    .insert(items)
    .values({ ownerId: other.id, kind: "clothing", name: "Not yours", definition: {} })
    .returning();
  if (!worn || !unused || !foreign) throw new Error("failed to seed items");
  ids.itemWorn = worn.id;
  ids.itemUnused = unused.id;
  ids.otherItem = foreign.id;

  // One character on the new preset shape, one still on the legacy id list
  // (unmigrated row) — the usage SQL must find both (ux-improvements slice 8).
  await db()
    .insert(characters)
    .values({
      ownerId: user.id,
      name: "Sabrina Vale",
      profile: { outfits: [{ id: "everyday", name: "Everyday", items: [worn.id] }] },
    });
  await db()
    .insert(characters)
    .values({ ownerId: user.id, name: "Legacy Lane", profile: { defaultOutfit: [worn.id] } });
});

afterAll(async () => {
  if (ready) {
    for (const owner of [authState.user.id, ids.otherUser]) {
      if (!owner) continue;
      await db().delete(characters).where(eq(characters.ownerId, owner));
      await db().delete(items).where(eq(items.ownerId, owner));
      await db().delete(users).where(eq(users.id, owner));
    }
  }
  await globalThis.__vesperPool?.end();
  globalThis.__vesperPool = undefined;
});

describe.skipIf(!ready)("GET /api/items/:id/usage", () => {
  it("names every character wearing the item (new preset + legacy id list)", async () => {
    const res = await usageGet(req(ids.itemWorn), ctx(ids.itemWorn));
    expect(res.status).toBe(200);
    const got = (await res.json()) as { wornBy: { id: string; name: string }[] };
    expect(got.wornBy.map((c) => c.name).sort()).toEqual(["Legacy Lane", "Sabrina Vale"]);
  });

  it("returns an empty wornBy list for an unreferenced item", async () => {
    const res = await usageGet(req(ids.itemUnused), ctx(ids.itemUnused));
    expect(res.status).toBe(200);
    const got = (await res.json()) as { wornBy: unknown[] };
    expect(got.wornBy).toEqual([]);
  });

  it("404s on someone else's item", async () => {
    const res = await usageGet(req(ids.otherItem), ctx(ids.otherItem));
    expect(res.status).toBe(404);
  });
});
