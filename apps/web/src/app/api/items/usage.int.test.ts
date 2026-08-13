import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { characters, db, items } from "@/server/db";

// Integration suite for GET /api/items/:id/usage (ux-improvements slice 6 —
// the delete dialog's in-use warning): the characters wearing the item in an
// outfit preset (new shape or the legacy id list) are named; references are
// owner-scoped. Self-skips when the database is unreachable.

const authState = vi.hoisted(() => ({
  user: { id: "", email: "", name: "Usage Int", role: "admin" as const },
}));

vi.mock("@/server/auth", async () => (await import("@/server/test-support")).routeAuthModule(authState));

import {
  apiRequest,
  bindAuthUser,
  endTestPool,
  expectApiError,
  expectJson,
  probeIntegrationDb,
  purgeOwnerRows,
  routeCtx,
  seedTestUser,
} from "@/server/test-support";
import { GET as usageGet } from "./[id]/usage/route";

const ready = await probeIntegrationDb("items-usage.int.test", "items");

const ids = { itemWorn: "", itemUnused: "", otherUser: "", otherItem: "" };

const ctx = (id: string) => routeCtx({ id });
const req = (id: string) => apiRequest(`/api/items/${id}/usage`);

beforeAll(async () => {
  if (!ready) return;
  const user = await seedTestUser("items-usage");
  const other = await seedTestUser("items-usage-other");
  bindAuthUser(authState, user);
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
  if (ready) await purgeOwnerRows([authState.user.id, ids.otherUser]);
  await endTestPool();
});

describe.skipIf(!ready)("GET /api/items/:id/usage", () => {
  it("names every character wearing the item (new preset + legacy id list)", async () => {
    const got = await expectJson<{ wornBy: { id: string; name: string }[] }>(
      await usageGet(req(ids.itemWorn), ctx(ids.itemWorn)),
      200,
    );
    expect(got.wornBy.map((c) => c.name).sort()).toEqual(["Legacy Lane", "Sabrina Vale"]);
  });

  it("returns an empty wornBy list for an unreferenced item", async () => {
    const got = await expectJson<{ wornBy: unknown[] }>(
      await usageGet(req(ids.itemUnused), ctx(ids.itemUnused)),
      200,
    );
    expect(got.wornBy).toEqual([]);
  });

  it("404s on someone else's item", async () => {
    await expectApiError(await usageGet(req(ids.otherItem), ctx(ids.otherItem)), 404, "not_found");
  });
});
