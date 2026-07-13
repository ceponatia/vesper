import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq, gte, inArray, sql } from "drizzle-orm";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  characters,
  db,
  images,
  itemInstances,
  items,
  jobs,
  locations,
  loreChunks,
  sessionLinks,
  sessionLocations,
  sessionParticipants,
  sessions,
  users,
  worldCast,
  worldLocations,
  worlds,
} from "@/server/db";
import { resetRateLimits } from "@/server/api";

// Demo-mode route-handler integration suite (docs/testing.md §api): handlers
// invoked directly with mocked auth against DATABASE_URL. Self-skips when the
// database is unreachable.

const authState = vi.hoisted(() => ({
  user: { id: "", email: "", name: "Routes Int", role: "admin" as const },
}));

vi.mock("@/server/auth", () => ({
  getCurrentUser: async () => authState.user,
  // respond.ts imports this for the 401 instanceof check; resolution never
  // throws here (getCurrentUser always resolves), so a stand-in class suffices.
  Unauthenticated: class Unauthenticated extends Error {},
}));

import { GET as listCharactersRoute, POST as createCharacterRoute } from "./characters/route";
import {
  DELETE as deleteCharacterRoute,
  GET as getCharacterRoute,
  PATCH as patchCharacterRoute,
} from "./characters/[id]/route";
import { POST as forgeCharacterRoute } from "./characters/forge/route";
import { POST as avatarRoute } from "./characters/[id]/avatar/route";
import { GET as listPortraitsRoute, POST as portraitRoute } from "./characters/[id]/portraits/route";
import {
  DELETE as deletePortraitRoute,
  GET as getPortraitRoute,
} from "./characters/[id]/portraits/[imageId]/route";
import { POST as promotePortraitRoute } from "./characters/[id]/portraits/[imageId]/promote/route";
import { GET as listLocationsRoute, POST as createLocationRoute } from "./locations/route";
import { PATCH as patchLocationRoute } from "./locations/[id]/route";
import { GET as listItemsRoute, POST as createItemRoute } from "./items/route";
import { PATCH as patchItemRoute } from "./items/[id]/route";
import { POST as worldFromDraftRoute } from "./worlds/from-draft/route";
import { POST as updateWorldFromDraftRoute } from "./worlds/[id]/from-draft/route";
import { GET as listWorldsRoute, POST as createWorldRoute } from "./worlds/route";
import { DELETE as deleteWorldRoute, GET as getWorldRoute, PATCH as patchWorldRoute } from "./worlds/[id]/route";
import { POST as duplicateWorldRoute } from "./worlds/[id]/duplicate/route";
import { POST as spawnSessionRoute } from "./worlds/[id]/sessions/route";
import { POST as forgeWorldRoute } from "./worlds/forge/route";
import { GET as imageFileRoute } from "./images/[id]/file/route";
import { POST as itemImagesBatchRoute } from "./items/images/route";
import { POST as locationImagesBatchRoute } from "./locations/images/route";
import { POST as cloneCharacterRoute } from "./characters/[id]/clone/route";
import { GET as devMeRoute } from "./dev/me/route";

async function probe(): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      db().execute(sql`select 1 from worlds limit 1`),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("connect timeout")), 4000);
      }),
    ]);
    return true;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[library-routes.int.test] skipping: database unreachable or unmigrated: ${reason}\n`);
    return false;
  } finally {
    clearTimeout(timer);
  }
}

const ready = await probe();
const testStart = new Date();
let tmpDataRoot = "";

function get(url: string): NextRequest {
  return new NextRequest(url);
}
function send(url: string, method: string, body?: unknown): NextRequest {
  return new NextRequest(url, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}
function ctx<P>(params: P): { params: Promise<P> } {
  return { params: Promise.resolve(params) };
}
const noParams = ctx({});

async function json(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

async function waitForJob(jobId: string, timeoutMs = 10_000): Promise<typeof jobs.$inferSelect> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const [row] = await db().select().from(jobs).where(eq(jobs.id, jobId)).limit(1);
    if (row && row.status !== "running" && row.status !== "queued") return row;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`job ${jobId} did not settle in ${timeoutMs}ms`);
}

beforeAll(async () => {
  if (!ready) return;
  tmpDataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "vesper-api-int-"));
  process.env.DATA_ROOT = tmpDataRoot;
  const [user] = await db()
    .insert(users)
    .values({ email: `routes-int-${Date.now()}@test.local`, name: "Routes Int", role: "admin" })
    .returning();
  if (!user) throw new Error("failed to create test user");
  authState.user = { ...authState.user, id: user.id, email: user.email };
  resetRateLimits();
});

afterAll(async () => {
  delete process.env.DATA_ROOT;
  if (!ready) return;
  await fs.rm(tmpDataRoot, { recursive: true, force: true });
  const ownerId = authState.user.id;
  await db().delete(sessions).where(eq(sessions.ownerId, ownerId));
  await db().delete(worlds).where(eq(worlds.ownerId, ownerId));
  await db().delete(images).where(eq(images.ownerId, ownerId));
  await db().delete(items).where(eq(items.ownerId, ownerId));
  await db().delete(locations).where(eq(locations.ownerId, ownerId));
  await db().delete(characters).where(eq(characters.ownerId, ownerId));
  await db().delete(jobs).where(gte(jobs.createdAt, testStart));
  await db().delete(users).where(eq(users.id, ownerId));
  await globalThis.__vesperPool?.end();
});

let characterId = "";
let locationId = "";
let clothingItemId = "";
let worldId = "";

describe("characters CRUD + search", () => {
  it("creates a character and lists it via ?q and ?tag", async (t) => {
    if (!ready) return t.skip();
    const created = await createCharacterRoute(
      send("http://t/api/characters", "POST", {
        name: "Mireille Voss",
        tags: ["harbor", "stoic"],
        profile: { bio: "A weary harbor-master.", personality: "dry humor", aliases: ["Captain Voss"] },
      }),
      noParams,
    );
    expect(created.status).toBe(201);
    const body = await json(created);
    characterId = (body.character as { id: string }).id;

    const byName = await json(await listCharactersRoute(get("http://t/api/characters?q=mireille"), noParams));
    expect((byName.characters as unknown[]).length).toBe(1);
    const byTag = await json(await listCharactersRoute(get("http://t/api/characters?tag=harbor"), noParams));
    expect((byTag.characters as Array<{ id: string }>).map((c) => c.id)).toContain(characterId);
    const miss = await json(await listCharactersRoute(get("http://t/api/characters?q=zzz-nonexistent"), noParams));
    expect(miss.characters).toEqual([]);
  });

  it("rejects an invalid create body with the envelope", async (t) => {
    if (!ready) return t.skip();
    const res = await createCharacterRoute(send("http://t/api/characters", "POST", { name: "" }), noParams);
    expect(res.status).toBe(400);
    const body = await json(res);
    expect((body.error as { code: string }).code).toBe("invalid_body");
  });

  it("materializes suggested outfit items on save, reusing by name", async (t) => {
    if (!ready) return t.skip();
    const suggestion = {
      kind: "clothing",
      name: "Storm Slicker",
      description: "Oiled canvas coat.",
      coverage: ["torso", "arms"],
      layer: 3,
    };
    const created = await createCharacterRoute(
      send("http://t/api/characters", "POST", {
        name: "Suggestion Tester",
        suggestedItems: [suggestion, { kind: "clothing", name: "Odd Hat", coverage: ["head", "not-a-location"] }],
      }),
      noParams,
    );
    expect(created.status).toBe(201);
    const body = await json(created);
    // Materialized ids land in the DEFAULT preset (outfits[0] — ux-improvements slice 8).
    type PresetProfile = { profile: { outfits: { id: string; items: string[] }[] } };
    const outfit = (body.character as PresetProfile).profile.outfits[0]?.items ?? [];
    expect(outfit.length).toBe(2);

    const [slicker] = await db().select().from(items).where(eq(items.id, outfit[0]!)).limit(1);
    expect(slicker?.name).toBe("Storm Slicker");
    expect(slicker?.tags).toContain("suggested");
    // invalid coverage id degrades to the valid subset, with a diagnostic
    expect((body.diagnostics as Array<{ code: string }>).map((d) => d.code)).toContain(
      "api.library.suggested_item.coverage_dropped",
    );
    const [hat] = await db().select().from(items).where(eq(items.id, outfit[1]!)).limit(1);
    expect((hat?.definition as { coverage: string[] }).coverage).toEqual(["head"]);

    // a second save with the same suggestion reuses the existing item
    const again = await createCharacterRoute(
      send("http://t/api/characters", "POST", { name: "Suggestion Tester II", suggestedItems: [suggestion] }),
      noParams,
    );
    expect(again.status).toBe(201);
    const againOutfit = ((await json(again)).character as PresetProfile).profile.outfits[0]?.items;
    expect(againOutfit).toEqual([outfit[0]]);
  });

  it("PATCH merges a partial profile without clobbering unsent fields", async (t) => {
    if (!ready) return t.skip();
    const res = await patchCharacterRoute(
      send(`http://t/api/characters/${characterId}`, "PATCH", { profile: { bio: "Updated bio." } }),
      ctx({ id: characterId }),
    );
    expect(res.status).toBe(200);
    const body = await json(res);
    const profile = (body.character as { profile: { bio: string; personality: string; aliases: string[] } }).profile;
    expect(profile.bio).toBe("Updated bio.");
    expect(profile.personality).toBe("dry humor");
    expect(profile.aliases).toEqual(["Captain Voss"]);
  });

  it("404s for a character owned by someone else", async (t) => {
    if (!ready) return t.skip();
    const original = authState.user;
    const [other] = await db()
      .insert(users)
      .values({ email: `routes-int-other-${Date.now()}@test.local`, name: "Other" })
      .returning();
    if (!other) throw new Error("failed to create second user");
    try {
      authState.user = { ...original, id: other.id, email: other.email };
      const res = await getCharacterRoute(get(`http://t/api/characters/${characterId}`), ctx({ id: characterId }));
      expect(res.status).toBe(404);
    } finally {
      authState.user = original;
      await db().delete(users).where(eq(users.id, other.id));
    }
  });
});

describe("entity visibility (auth.plan.md)", () => {
  it("public entities read cross-owner but never write; private stay owner-only", async (t) => {
    if (!ready) return t.skip();
    const owner = authState.user;
    const mkChar = async (name: string) =>
      ((await json(await createCharacterRoute(send("http://t/api/characters", "POST", { name }), noParams))).character as {
        id: string;
      }).id;
    const privateId = await mkChar("Secret Muse");
    const publicId = await mkChar("Public Muse");

    const published = await patchCharacterRoute(
      send(`http://t/api/characters/${publicId}`, "PATCH", { visibility: "public" }),
      ctx({ id: publicId }),
    );
    expect(published.status).toBe(200);
    expect(((await json(published)).character as { visibility: string }).visibility).toBe("public");

    const [other] = await db()
      .insert(users)
      .values({ email: `routes-int-vis-${Date.now()}@test.local`, name: "Viewer" })
      .returning();
    if (!other) throw new Error("failed to create second user");
    try {
      authState.user = { ...owner, id: other.id, email: other.email };
      // Read widens to owner-or-public: a public entity reads cross-owner, a private one 404s.
      expect((await getCharacterRoute(get(`http://t/api/characters/${publicId}`), ctx({ id: publicId }))).status).toBe(200);
      expect((await getCharacterRoute(get(`http://t/api/characters/${privateId}`), ctx({ id: privateId }))).status).toBe(404);
      // Writes never cross owner — even on a public entity (treated as not-found).
      expect(
        (await patchCharacterRoute(send(`http://t/api/characters/${publicId}`, "PATCH", { name: "hijack" }), ctx({ id: publicId }))).status,
      ).toBe(404);
      expect((await deleteCharacterRoute(get(`http://t/api/characters/${publicId}`), ctx({ id: publicId }))).status).toBe(404);
    } finally {
      authState.user = owner;
      await db().delete(users).where(eq(users.id, other.id));
    }

    // Owner still sees the public entity, and the cross-owner PATCH never landed.
    const ownerView = await json(await getCharacterRoute(get(`http://t/api/characters/${publicId}`), ctx({ id: publicId })));
    expect((ownerView.character as { name: string }).name).toBe("Public Muse");

    await deleteCharacterRoute(get(`http://t/api/characters/${publicId}`), ctx({ id: publicId }));
    await deleteCharacterRoute(get(`http://t/api/characters/${privateId}`), ctx({ id: privateId }));
  });

  it("clones a public entity into an owned, private copy that survives source deletion", async (t) => {
    if (!ready) return t.skip();
    const owner = authState.user;
    const srcId = ((await json(await createCharacterRoute(send("http://t/api/characters", "POST", { name: "Shared Muse", tags: ["origin"] }), noParams))).character as { id: string }).id;
    await patchCharacterRoute(send(`http://t/api/characters/${srcId}`, "PATCH", { visibility: "public" }), ctx({ id: srcId }));

    const [other] = await db()
      .insert(users)
      .values({ email: `routes-int-clone-${Date.now()}@test.local`, name: "Cloner" })
      .returning();
    if (!other) throw new Error("failed to create second user");
    const asOther = { ...owner, id: other.id, email: other.email };
    let cloneId = "";
    try {
      authState.user = asOther;
      const cloned = await cloneCharacterRoute(send(`http://t/api/characters/${srcId}/clone`, "POST", {}), ctx({ id: srcId }));
      expect(cloned.status).toBe(201);
      cloneId = ((await json(cloned)) as { id: string }).id;

      const copy = (await json(await getCharacterRoute(get(`http://t/api/characters/${cloneId}`), ctx({ id: cloneId })))).character as {
        visibility: string;
        tags: string[];
        clonedFromId: string | null;
      };
      expect(copy.visibility).toBe("private");
      expect(copy.tags).toContain("origin");
      expect(copy.clonedFromId).toBe(srcId);

      // Owner deletes the source; the cross-owner clone must survive intact.
      authState.user = owner;
      expect((await deleteCharacterRoute(get(`http://t/api/characters/${srcId}`), ctx({ id: srcId }))).status).toBe(200);
      authState.user = asOther;
      expect((await getCharacterRoute(get(`http://t/api/characters/${cloneId}`), ctx({ id: cloneId }))).status).toBe(200);
    } finally {
      authState.user = asOther;
      if (cloneId) await deleteCharacterRoute(get(`http://t/api/characters/${cloneId}`), ctx({ id: cloneId }));
      authState.user = owner;
      await db().delete(users).where(eq(users.id, other.id));
    }
  });
});

describe("library list facets, sort & scope (library-ux.plan.md §Follow-up pass)", () => {
  it("character list carries speciesId/gender/worldCount and honors ?sort=name", async (t) => {
    if (!ready) return t.skip();
    const mk = async (name: string) =>
      ((await json(await createCharacterRoute(send("http://t/api/characters", "POST", { name, tags: ["facet-sort"] }), noParams)))
        .character as { id: string }).id;
    // Created in reverse-alphabetical order so updated-recency and name order disagree.
    const aaId = await mk("Aa Facet Muse");
    const zzId = await mk("Zz Facet Muse");

    const [world] = await db().insert(worlds).values({ ownerId: authState.user.id, name: "Facet World" }).returning();
    if (!world) throw new Error("failed to create world");
    // Two cast rows pointing at the same source must still count ONE world (distinct world_id).
    await db().insert(worldCast).values([
      { worldId: world.id, name: "Aa Copy", sourceCharacterId: aaId },
      { worldId: world.id, name: "Aa Copy 2", sourceCharacterId: aaId },
    ]);

    const byRecency = (await json(await listCharactersRoute(get("http://t/api/characters?tag=facet-sort"), noParams)))
      .characters as Array<{ id: string; speciesId: string | null; gender: string | null; worldCount: number }>;
    expect(byRecency.map((c) => c.id)).toEqual([zzId, aaId]);
    const aa = byRecency.find((c) => c.id === aaId);
    // A blank-created character carries the registry defaults (human, female).
    expect(aa?.speciesId).toBe("human");
    expect(aa?.gender).toBe("female");
    expect(aa?.worldCount).toBe(1);
    expect(byRecency.find((c) => c.id === zzId)?.worldCount).toBe(0);

    const byName = (await json(await listCharactersRoute(get("http://t/api/characters?tag=facet-sort&sort=name"), noParams)))
      .characters as Array<{ id: string }>;
    expect(byName.map((c) => c.id)).toEqual([aaId, zzId]);

    await db().delete(worlds).where(eq(worlds.id, world.id));
    for (const id of [aaId, zzId]) await deleteCharacterRoute(get(`http://t/api/characters/${id}`), ctx({ id }));
  });

  it("location list carries scale + worldCount", async (t) => {
    if (!ready) return t.skip();
    const created = await createLocationRoute(
      send("http://t/api/locations", "POST", { name: "Facet Harbor", tags: ["facet-scale"] }),
      noParams,
    );
    const locId = ((await json(created)).location as { id: string }).id;
    const [world] = await db().insert(worlds).values({ ownerId: authState.user.id, name: "Facet Loc World" }).returning();
    if (!world) throw new Error("failed to create world");
    await db().insert(worldLocations).values({ worldId: world.id, sourceLocationId: locId });

    const listed = (await json(await listLocationsRoute(get("http://t/api/locations?tag=facet-scale"), noParams)))
      .locations as Array<{ id: string; scale: string; worldCount: number }>;
    const row = listed.find((l) => l.id === locId);
    expect(row?.scale).toBe("room"); // the column default rides the list payload
    expect(row?.worldCount).toBe(1);

    await db().delete(worlds).where(eq(worlds.id, world.id));
    await db().delete(locations).where(eq(locations.id, locId));
  });

  it("?scope=public surfaces another owner's published rows; owned stays private", async (t) => {
    if (!ready) return t.skip();
    const owner = authState.user;
    const charId = ((await json(await createCharacterRoute(send("http://t/api/characters", "POST", { name: "Scope Muse", tags: ["scope-test"] }), noParams))).character as { id: string }).id;
    await patchCharacterRoute(send(`http://t/api/characters/${charId}`, "PATCH", { visibility: "public" }), ctx({ id: charId }));
    const itemId = ((await json(await createItemRoute(send("http://t/api/items", "POST", { name: "Scope Cloak", kind: "clothing", tags: ["scope-test"] }), noParams))).item as { id: string }).id;
    await patchItemRoute(send(`http://t/api/items/${itemId}`, "PATCH", { visibility: "public" }), ctx({ id: itemId }));

    const [other] = await db()
      .insert(users)
      .values({ email: `routes-int-scope-${Date.now()}@test.local`, name: "Scoper" })
      .returning();
    if (!other) throw new Error("failed to create second user");
    try {
      authState.user = { ...owner, id: other.id, email: other.email };
      const pubChars = (await json(await listCharactersRoute(get("http://t/api/characters?tag=scope-test&scope=public"), noParams)))
        .characters as Array<{ id: string }>;
      expect(pubChars.map((c) => c.id)).toContain(charId);
      const ownChars = (await json(await listCharactersRoute(get("http://t/api/characters?tag=scope-test"), noParams)))
        .characters as Array<{ id: string }>;
      expect(ownChars).toEqual([]);
      const pubItems = (await json(await listItemsRoute(get("http://t/api/items?tag=scope-test&scope=all"), noParams)))
        .items as Array<{ id: string }>;
      expect(pubItems.map((i) => i.id)).toContain(itemId);
      const ownItems = (await json(await listItemsRoute(get("http://t/api/items?tag=scope-test"), noParams)))
        .items as Array<{ id: string }>;
      expect(ownItems).toEqual([]);
    } finally {
      authState.user = owner;
      await db().delete(users).where(eq(users.id, other.id));
    }
    await deleteCharacterRoute(get(`http://t/api/characters/${charId}`), ctx({ id: charId }));
    await db().delete(items).where(eq(items.id, itemId));
  });
});

describe("locations and items", () => {
  it("creates a location", async (t) => {
    if (!ready) return t.skip();
    const res = await createLocationRoute(
      send("http://t/api/locations", "POST", {
        name: "Harbor Office",
        description: "Cramped, salt-stained.",
        ambient: { scent: "tar and kelp" },
        tags: ["harbor"],
      }),
      noParams,
    );
    expect(res.status).toBe(201);
    locationId = ((await json(res)).location as { id: string }).id;
  });

  it("creates a clothing item and rejects unknown coverage ids", async (t) => {
    if (!ready) return t.skip();
    const bad = await createItemRoute(
      send("http://t/api/items", "POST", {
        name: "Oilskin Coat",
        kind: "clothing",
        definition: { coverage: ["torso_dorsal_fin"], layer: 3 },
      }),
      noParams,
    );
    expect(bad.status).toBe(400);
    expect(((await json(bad)).error as { code: string }).code).toBe("invalid_coverage");

    const good = await createItemRoute(
      send("http://t/api/items", "POST", {
        name: "Oilskin Coat",
        kind: "clothing",
        description: "Heavy, weatherproof.",
        definition: { coverage: ["neck"], layer: 3 },
      }),
      noParams,
    );
    expect(good.status).toBe(201);
    clothingItemId = ((await json(good)).item as { id: string }).id;
  });

  it("filters the item list by ?kind, ignoring an unknown kind", async (t) => {
    if (!ready) return t.skip();
    const obj = await createItemRoute(
      send("http://t/api/items", "POST", { name: "Brass Lantern", kind: "object" }),
      noParams,
    );
    expect(obj.status).toBe(201);
    const objectItemId = ((await json(obj)).item as { id: string }).id;

    const kindsOf = (body: Record<string, unknown>) => (body.items as { id: string; kind: string }[]);

    // ?kind=clothing returns only the coat, never the object.
    const clothing = kindsOf(await json(await listItemsRoute(get("http://t/api/items?kind=clothing"), noParams)));
    expect(clothing.every((i) => i.kind === "clothing")).toBe(true);
    expect(clothing.map((i) => i.id)).toContain(clothingItemId);
    expect(clothing.map((i) => i.id)).not.toContain(objectItemId);

    // No kind → both kinds present; an unknown kind degrades to no filter.
    const all = kindsOf(await json(await listItemsRoute(get("http://t/api/items"), noParams)));
    expect(all.map((i) => i.id)).toEqual(expect.arrayContaining([clothingItemId, objectItemId]));
    const bogus = kindsOf(await json(await listItemsRoute(get("http://t/api/items?kind=weapon"), noParams)));
    expect(bogus.map((i) => i.id)).toEqual(expect.arrayContaining([clothingItemId, objectItemId]));
  });

  it("applies the result cap per-kind and resolves ids past the cap (defaultOutfit regression)", async (t) => {
    if (!ready) return t.skip();
    const ownerId = authState.user.id;
    // Flood the library with >LIST_LIMIT (100) NEWER items of another kind. Pre-fix,
    // the global cap (order by updated_at desc) filled with these and pushed the
    // older clothing — like a character's defaultOutfit — out of the clothing list,
    // making it render as "not in library" though it was never deleted.
    const flood = Array.from({ length: 105 }, (_, i) => ({ ownerId, kind: "object" as const, name: `Flood Object ${i}` }));
    const inserted = await db().insert(items).values(flood).returning({ id: items.id });
    try {
      const kindsOf = (body: Record<string, unknown>) => body.items as { id: string; kind: string }[];
      // The per-kind cap keeps the (older) coat in the clothing list.
      const clothing = kindsOf(await json(await listItemsRoute(get("http://t/api/items?kind=clothing"), noParams)));
      expect(clothing.every((i) => i.kind === "clothing")).toBe(true);
      expect(clothing.map((i) => i.id)).toContain(clothingItemId);
      // ?ids resolves a specific reference (outfit item) regardless of the cap.
      const byIds = kindsOf(await json(await listItemsRoute(get(`http://t/api/items?ids=${clothingItemId}`), noParams)));
      expect(byIds.map((i) => i.id)).toEqual([clothingItemId]);
      // empty ids → empty (must not fall through to the unfiltered list).
      const none = kindsOf(await json(await listItemsRoute(get("http://t/api/items?ids="), noParams)));
      expect(none).toEqual([]);
    } finally {
      await db().delete(items).where(inArray(items.id, inserted.map((r) => r.id)));
    }
  });

  it("404s cross-user PATCH for character, location and item without modifying rows", async (t) => {
    if (!ready) return t.skip();
    const original = authState.user;
    const [other] = await db()
      .insert(users)
      .values({ email: `routes-int-patcher-${Date.now()}@test.local`, name: "Other Patcher" })
      .returning();
    if (!other) throw new Error("failed to create second user");
    try {
      authState.user = { ...original, id: other.id, email: other.email };
      const charRes = await patchCharacterRoute(
        send(`http://t/api/characters/${characterId}`, "PATCH", { name: "Hijacked" }),
        ctx({ id: characterId }),
      );
      expect(charRes.status).toBe(404);
      const locRes = await patchLocationRoute(
        send(`http://t/api/locations/${locationId}`, "PATCH", { name: "Hijacked" }),
        ctx({ id: locationId }),
      );
      expect(locRes.status).toBe(404);
      const itemRes = await patchItemRoute(
        send(`http://t/api/items/${clothingItemId}`, "PATCH", { name: "Hijacked" }),
        ctx({ id: clothingItemId }),
      );
      expect(itemRes.status).toBe(404);
    } finally {
      authState.user = original;
      await db().delete(users).where(eq(users.id, other.id));
    }
    // The UPDATE itself is owner-scoped (defense-in-depth), so nothing changed.
    const [charRow] = await db().select().from(characters).where(eq(characters.id, characterId)).limit(1);
    expect(charRow?.name).toBe("Mireille Voss");
    const [locRow] = await db().select().from(locations).where(eq(locations.id, locationId)).limit(1);
    expect(locRow?.name).toBe("Harbor Office");
    const [itemRow] = await db().select().from(items).where(eq(items.id, clothingItemId)).limit(1);
    expect(itemRow?.name).toBe("Oilskin Coat");
  });
});

describe("worlds", () => {
  it("creates a world with nested locations/links/cast/items/lore", async (t) => {
    if (!ready) return t.skip();
    const res = await createWorldRoute(
      send("http://t/api/worlds", "POST", {
        name: "Tidewater",
        description: "A drowned port city.",
        lore: {
          synopsis: "The flood never receded.",
          plotAnchors: [{ id: "anchor-1", title: "The missing ledger", summary: "Someone cooked the books.", priority: "active" }],
        },
        locations: [
          { name: "Quay", description: "Wet stone.", links: ["Harbor Office"] },
          { locationId, description: "Now with a leak." },
        ],
        cast: [{ characterId, role: "companion", startLocationName: "Harbor Office" }],
        items: [
          { itemId: clothingItemId, castCharacterId: characterId, worn: true },
          { definition: { kind: "container", name: "Ledger Chest" }, locationName: "Quay" },
        ],
        loreChunks: [
          { title: "The Flood", body: "It came at night.", tier: "always" },
          { title: "The Ledger", body: "Hidden in the chest.", visibility: "secret", unlockTags: ["ledger"] },
        ],
      }),
      noParams,
    );
    expect(res.status).toBe(201);
    const body = await json(res);
    worldId = (body.world as { id: string }).id;
    expect((body.locations as unknown[]).length).toBe(2);
    expect((body.links as unknown[]).length).toBe(1);
    expect((body.cast as Array<{ characterId: string; startWorldLocationId: string | null }>)[0]?.characterId).toBe(characterId);
    expect((body.cast as Array<{ startWorldLocationId: string | null }>)[0]?.startWorldLocationId).not.toBeNull();
    expect((body.items as unknown[]).length).toBe(2);
    expect((body.loreChunks as unknown[]).length).toBe(2);
    // the world-location override is applied to the effective description
    const overridden = (body.locations as Array<{ locationId: string; description: string }>).find(
      (l) => l.locationId === locationId,
    );
    expect(overridden?.description).toBe("Now with a leak.");
  });

  it("400s on unknown nested references before writing anything", async (t) => {
    if (!ready) return t.skip();
    const res = await createWorldRoute(
      send("http://t/api/worlds", "POST", { name: "Broken", cast: [{ characterId: "no-such-id" }] }),
      noParams,
    );
    expect(res.status).toBe(400);
    expect(((await json(res)).error as { code: string }).code).toBe("invalid_reference");
    const list = await json(await listWorldsRoute(get("http://t/api/worlds?q=Broken"), noParams));
    expect(list.worlds).toEqual([]);
  });

  it("rejects a raw forge draft posted to the create route (strict body)", async (t) => {
    if (!ready) return t.skip();
    const res = await createWorldRoute(
      send("http://t/api/worlds", "POST", { name: "Drafty", castSuggestions: [], itemPlacements: [] }),
      noParams,
    );
    expect(res.status).toBe(400);
    expect(((await json(res)).error as { code: string }).code).toBe("invalid_body");
  });

  it("saves a forge draft: matches cast by name, creates stubs, places items", async (t) => {
    if (!ready) return t.skip();
    resetRateLimits();
    const res = await worldFromDraftRoute(
      send("http://t/api/worlds/from-draft", "POST", {
        name: "Draft Harbor",
        description: "A foggy harbor town.",
        locations: [
          { name: "Quay", description: "Stone quay.", links: ["Lighthouse"] },
          { name: "Lighthouse", description: "The old light.", links: [] },
        ],
        castSuggestions: [
          { name: "Mireille Voss", conceptNote: "the harbor-master", role: "companion" },
          { name: "Tobin Ash", conceptNote: "a nervous apprentice lighthouse keeper", role: "npc" },
        ],
        itemPlacements: [
          {
            itemName: "Keeper's Oil Lantern",
            definition: { kind: "object", name: "Keeper's Oil Lantern", description: "Brass, salt-pitted." },
            locationName: "Lighthouse",
            worn: false,
          },
          {
            itemName: "Keeper's Wool Coat",
            definition: { kind: "clothing", name: "Keeper's Wool Coat", coverage: ["torso", "arms"], layer: 3 },
            castName: "Tobin Ash",
            worn: true,
          },
        ],
      }),
      noParams,
    );
    expect(res.status).toBe(201);
    const body = await json(res);
    const draftWorldId = body.id as string;
    expect(draftWorldId.length).toBeGreaterThan(0);

    const detail = await json(await getWorldRoute(get(`http://t/api/worlds/${draftWorldId}`), ctx({ id: draftWorldId })));
    const cast = detail.cast as Array<{ characterId: string }>;
    expect(cast.length).toBe(2);
    // "Mireille Voss" re-matched the existing library character — no duplicate
    expect(cast.map((c) => c.characterId)).toContain(characterId);

    // the unmatched stub became a real character (skeletal in demo mode, tagged)
    const stubCharacterId = cast.map((c) => c.characterId).find((id) => id !== characterId);
    const [stubRow] = await db().select().from(characters).where(eq(characters.id, stubCharacterId!)).limit(1);
    expect(stubRow?.name).toBe("Tobin Ash");
    expect(stubRow?.tags).toContain("stub");
    expect((stubRow?.profile as { bio: string }).bio).toBe("a nervous apprentice lighthouse keeper");
    expect((body.diagnostics as Array<{ code: string }>).map((d) => d.code)).toContain(
      "api.world.from_draft.cast_saved_as_stub",
    );

    // item placements: worn clothing landed on the stub, the lantern at its location
    const placed = detail.items as Array<{ name: string; castId: string | null; worldLocationId: string | null; worn: boolean }>;
    expect(placed.length).toBe(2);
    const coat = placed.find((i) => i.name === "Keeper's Wool Coat");
    expect(coat?.castId).not.toBeNull();
    expect(coat?.worn).toBe(true);
    const lantern = placed.find((i) => i.name === "Keeper's Oil Lantern");
    expect(lantern?.worldLocationId).not.toBeNull();
    expect((detail.links as unknown[]).length).toBe(1);

    // cleanup so later world counts stay deterministic
    await deleteWorldRoute(get(`http://t/api/worlds/${draftWorldId}`), ctx({ id: draftWorldId }));
    await db().delete(characters).where(eq(characters.id, stubCharacterId!));
  });

  it("PATCH replaces lore chunks and merges style without clobbering", async (t) => {
    if (!ready) return t.skip();
    const first = await patchWorldRoute(
      send(`http://t/api/worlds/${worldId}`, "PATCH", { style: { directives: ["slow-burn pacing"] } }),
      ctx({ id: worldId }),
    );
    expect(first.status).toBe(200);
    const second = await patchWorldRoute(
      send(`http://t/api/worlds/${worldId}`, "PATCH", {
        style: {
          socialCards: [
            { id: "no-flames", label: "No open flames on the docks", description: "", kind: "social_rule", triggers: [], severity: 40, reactionOverrides: [] },
          ],
        },
        loreChunks: [{ title: "Rewritten", body: "Only chunk now." }],
      }),
      ctx({ id: worldId }),
    );
    expect(second.status).toBe(200);
    const body = await json(second);
    const style = (body.world as { style: { directives: string[]; socialCards: unknown[] } }).style;
    expect(style.directives).toEqual(["slow-burn pacing"]); // earlier patch survived the cards patch
    expect(style.socialCards.length).toBe(1);
    expect((body.loreChunks as unknown[]).length).toBe(1);
    expect((body.locations as unknown[]).length).toBe(2); // untouched family kept
  });

  it("duplicates deep with lineage", async (t) => {
    if (!ready) return t.skip();
    const res = await duplicateWorldRoute(send(`http://t/api/worlds/${worldId}/duplicate`, "POST"), ctx({ id: worldId }));
    expect(res.status).toBe(201);
    const body = await json(res);
    const copy = body.world as { id: string; name: string; duplicatedFromWorldId: string | null };
    expect(copy.id).not.toBe(worldId);
    expect(copy.duplicatedFromWorldId).toBe(worldId);
    expect(copy.name).toContain("(copy)");
    expect((body.locations as unknown[]).length).toBe(2);
    expect((body.links as unknown[]).length).toBe(1);
    expect((body.cast as unknown[]).length).toBe(1);
    expect((body.items as unknown[]).length).toBe(2);
    expect((body.loreChunks as unknown[]).length).toBe(1);
    // cleanup the copy so later counts stay deterministic
    await deleteWorldRoute(get(`http://t/api/worlds/${copy.id}`), ctx({ id: copy.id }));
  });

  it("spawns a session: locations, links, participants, worn item instances, seeded threads", async (t) => {
    if (!ready) return t.skip();
    const res = await spawnSessionRoute(send(`http://t/api/worlds/${worldId}/sessions`, "POST", {}), ctx({ id: worldId }));
    expect(res.status).toBe(201);
    const body = await json(res);
    const session = body.session as { id: string; title: string; runtime: { storyThreads: Array<{ source: string }> } };
    expect(session.title).toBe("Tidewater");
    expect(session.runtime.storyThreads.length).toBe(1);
    expect(session.runtime.storyThreads[0]?.source).toBe("anchor");

    const locs = await db().select().from(sessionLocations).where(eq(sessionLocations.sessionId, session.id));
    expect(locs.length).toBe(2);
    const links = await db().select().from(sessionLinks).where(eq(sessionLinks.sessionId, session.id));
    expect(links.length).toBe(1);

    const participants = await db().select().from(sessionParticipants).where(eq(sessionParticipants.sessionId, session.id));
    expect(participants.length).toBe(2); // player + cast member
    const player = participants.find((p) => p.isUser);
    const companion = participants.find((p) => !p.isUser);
    expect(player?.role).toBe("player");
    expect(companion?.characterId).toBe(characterId);

    const instances = await db().select().from(itemInstances).where(eq(itemInstances.sessionId, session.id));
    expect(instances.length).toBe(2);
    const worn = instances.find((i) => i.worn);
    expect(worn?.holderParticipantId).toBe(companion?.id);
    const placed = instances.find((i) => !i.worn);
    expect(placed?.locationId).not.toBeNull();

    await db().delete(sessions).where(eq(sessions.id, session.id));
  });

  it("404s spawn and detail for an unknown world", async (t) => {
    if (!ready) return t.skip();
    const spawn = await spawnSessionRoute(send("http://t/api/worlds/nope/sessions", "POST", {}), ctx({ id: "nope" }));
    expect(spawn.status).toBe(404);
    const detail = await getWorldRoute(get("http://t/api/worlds/nope"), ctx({ id: "nope" }));
    expect(detail.status).toBe(404);
  });

  it("updates a saved world from the draft shape without duplicating library rows", async (t) => {
    if (!ready) return t.skip();
    resetRateLimits();
    const before = await json(await getWorldRoute(get(`http://t/api/worlds/${worldId}`), ctx({ id: worldId })));
    const beforeLocations = before.locations as Array<{ id: string; locationId: string; name: string }>;
    const harborOffice = beforeLocations.find((l) => l.name === "Now with a leak." || l.locationId === locationId);
    expect(harborOffice).toBeDefined();
    const libLocationsBefore = await db().select({ id: locations.id }).from(locations).where(eq(locations.ownerId, authState.user.id));
    const libItemsBefore = await db().select({ id: items.id }).from(items).where(eq(items.ownerId, authState.user.id));

    const res = await updateWorldFromDraftRoute(
      send(`http://t/api/worlds/${worldId}/from-draft`, "POST", {
        name: "Tidewater",
        description: "A drowned port city, revised.",
        locations: [
          // linked library location survives as an override, not a duplicate
          { locationId, name: "Harbor Office", description: "Repainted.", links: ["Quay"] },
          { name: "Quay", description: "Wet stone.", links: ["Harbor Office"] },
        ],
        castSuggestions: [{ existingCharacterId: characterId, name: "Mireille Voss", conceptNote: "", role: "companion" }],
        itemPlacements: [
          // name-matches the existing library item — reused, not re-created
          { itemName: "Oilskin Coat", definition: { kind: "clothing", name: "Oilskin Coat" }, castName: "Mireille Voss", worn: true },
        ],
        loreChunks: [{ title: "Revised chunk", body: "Only one now." }],
      }),
      ctx({ id: worldId }),
    );
    expect(res.status).toBe(200);

    const after = await json(await getWorldRoute(get(`http://t/api/worlds/${worldId}`), ctx({ id: worldId })));
    expect((after.world as { description: string }).description).toBe("A drowned port city, revised.");
    const afterLocations = after.locations as Array<{ locationId: string; name: string; description: string }>;
    expect(afterLocations.length).toBe(2);
    const linked = afterLocations.find((l) => l.locationId === locationId);
    expect(linked?.description).toBe("Repainted."); // override applied, base row kept
    expect((after.cast as Array<{ characterId: string }>).map((c) => c.characterId)).toEqual([characterId]);
    const afterItems = after.items as Array<{ itemId: string; worn: boolean }>;
    expect(afterItems.length).toBe(1);
    expect(afterItems[0]?.itemId).toBe(clothingItemId); // reused by name
    expect(afterItems[0]?.worn).toBe(true);

    // no library rows were duplicated by the save: the name-only "Quay" reuses
    // the row this world already created for it rather than orphaning it and
    // inserting a fresh one (followups.phase3.md §5).
    const libLocationsAfter = await db().select({ id: locations.id }).from(locations).where(eq(locations.ownerId, authState.user.id));
    const libItemsAfter = await db().select({ id: items.id }).from(items).where(eq(items.ownerId, authState.user.id));
    expect(libLocationsAfter.length).toBe(libLocationsBefore.length);
    expect(libItemsAfter.length).toBe(libItemsBefore.length);
  });
});

describe("batch entity images: malformed body must 400, never widen scope (codebase-review A4)", () => {
  it("rejects invalid JSON instead of queueing an unscoped paid batch", async (t) => {
    if (!ready) return t.skip();
    for (const [route, url] of [
      [itemImagesBatchRoute, "http://t/api/items/images"],
      [locationImagesBatchRoute, "http://t/api/locations/images"],
    ] as const) {
      const res = await route(
        new NextRequest(url, { method: "POST", body: "{not json", headers: { "content-type": "application/json" } }),
        noParams,
      );
      expect(res.status).toBe(400);
    }
  });

  it("still accepts an empty object as the deliberate generate-all scope", async (t) => {
    if (!ready) return t.skip();
    // {} (no ids) is the client's "all missing" request — must not 400. AI_FAKE
    // makes any queued render a no-op placeholder; the assertion is only the status.
    const res = await itemImagesBatchRoute(send("http://t/api/items/images", "POST", {}), noParams);
    expect([200, 202]).toContain(res.status);
  });
});

describe("images: avatar job, portraits, serving", () => {
  let avatarImageId = "";
  let variantImageId = "";

  it("runs the avatar job and serves the file with immutable caching", async (t) => {
    if (!ready) return t.skip();
    const res = await avatarRoute(
      send(`http://t/api/characters/${characterId}/avatar`, "POST", { style: "stylized" }),
      ctx({ id: characterId }),
    );
    expect(res.status).toBe(202);
    const { jobId } = (await json(res)) as { jobId: string };
    const job = await waitForJob(jobId);
    expect(job.status).toBe("done");
    avatarImageId = (job.payload as { imageId: string }).imageId;

    const [imageRow] = await db().select().from(images).where(eq(images.id, avatarImageId)).limit(1);
    expect(imageRow?.status).toBe("ready");
    expect((imageRow?.meta as { demo?: boolean }).demo).toBe(true);
    const [charRow] = await db().select().from(characters).where(eq(characters.id, characterId)).limit(1);
    expect(charRow?.avatarImageId).toBe(avatarImageId);

    const file = await imageFileRoute(get(`http://t/api/images/${avatarImageId}/file`), ctx({ id: avatarImageId }));
    expect(file.status).toBe(200);
    expect(file.headers.get("content-type")).toBe("image/webp");
    expect(file.headers.get("cache-control")).toContain("immutable");
  });

  it("404s for missing and non-ready images", async (t) => {
    if (!ready) return t.skip();
    const missing = await imageFileRoute(get("http://t/api/images/nope/file"), ctx({ id: "nope" }));
    expect(missing.status).toBe(404);
    const [pendingRow] = await db()
      .insert(images)
      .values({ ownerId: authState.user.id, kind: "entity", entityKind: "world", path: "images/x/pending.webp" })
      .returning();
    if (!pendingRow) throw new Error("failed to insert pending image");
    const pending = await imageFileRoute(get(`http://t/api/images/${pendingRow.id}/file`), ctx({ id: pendingRow.id }));
    expect(pending.status).toBe(404);
  });

  it("generates, fetches, promotes and deletes a portrait variant", async (t) => {
    if (!ready) return t.skip();
    const res = await portraitRoute(
      send(`http://t/api/characters/${characterId}/portraits`, "POST", { kind: "pose", instruction: "leaning on the rail" }),
      ctx({ id: characterId }),
    );
    expect(res.status).toBe(202);
    const { jobId } = (await json(res)) as { jobId: string };
    const job = await waitForJob(jobId);
    expect(job.status).toBe("done");
    variantImageId = (job.payload as { imageId: string }).imageId;

    const list = await listPortraitsRoute(get(`http://t/api/characters/${characterId}/portraits`), ctx({ id: characterId }));
    expect(list.status).toBe(200);
    const listed = (await json(list)).portraits as Array<{ id: string }>;
    expect(listed.map((p) => p.id)).toContain(variantImageId);

    const single = await getPortraitRoute(
      get(`http://t/api/characters/${characterId}/portraits/${variantImageId}`),
      ctx({ id: characterId, imageId: variantImageId }),
    );
    expect(single.status).toBe(200);

    const promoted = await promotePortraitRoute(
      send(`http://t/api/characters/${characterId}/portraits/${variantImageId}/promote`, "POST"),
      ctx({ id: characterId, imageId: variantImageId }),
    );
    expect(promoted.status).toBe(200);
    const [charRow] = await db().select().from(characters).where(eq(characters.id, characterId)).limit(1);
    expect(charRow?.avatarImageId).toBe(variantImageId);

    const deleted = await deletePortraitRoute(
      get(`http://t/api/characters/${characterId}/portraits/${variantImageId}`),
      ctx({ id: characterId, imageId: variantImageId }),
    );
    expect(deleted.status).toBe(200);
    const [afterDelete] = await db().select().from(characters).where(eq(characters.id, characterId)).limit(1);
    expect(afterDelete?.avatarImageId).toBeNull(); // promoted-then-deleted avatar never dangles

    // character detail lists remaining portraits (the original avatar)
    const detail = await json(await getCharacterRoute(get(`http://t/api/characters/${characterId}`), ctx({ id: characterId })));
    expect((detail.portraits as Array<{ id: string }>).map((p) => p.id)).toContain(avatarImageId);
  });
});

describe("forge endpoints (demo mode) and rate limiting", () => {
  it("drafts a character without saving", async (t) => {
    if (!ready) return t.skip();
    resetRateLimits();
    const before = await db().select({ id: characters.id }).from(characters).where(eq(characters.ownerId, authState.user.id));
    const res = await forgeCharacterRoute(
      send("http://t/api/characters/forge", "POST", { prompt: "a weary harbor-master in her forties" }),
      noParams,
    );
    expect(res.status).toBe(200);
    const body = await json(res);
    const draft = body.draft as { name: string; profile: { bio: string } };
    expect(draft.name.length).toBeGreaterThan(0);
    expect(Array.isArray(body.diagnostics)).toBe(true);
    const after = await db().select({ id: characters.id }).from(characters).where(eq(characters.ownerId, authState.user.id));
    expect(after.length).toBe(before.length); // drafts never save
  });

  it("drafts a world and rate-limits the eleventh call", async (t) => {
    if (!ready) return t.skip();
    resetRateLimits();
    const res = await forgeWorldRoute(send("http://t/api/worlds/forge", "POST", { prompt: "a drowned port city" }), noParams);
    expect(res.status).toBe(200);
    const draft = (await json(res)).draft as { locations: unknown[] };
    expect(draft.locations.length).toBeGreaterThan(0);

    let limited: Response | undefined;
    for (let i = 0; i < 10; i++) {
      limited = await forgeWorldRoute(send("http://t/api/worlds/forge", "POST", { prompt: "again" }), noParams);
      if (limited.status === 429) break;
    }
    expect(limited?.status).toBe(429);
  });
});

describe("dev identity", () => {
  it("dev/me returns the resolved user", async (t) => {
    if (!ready) return t.skip();
    const me = await json(await devMeRoute(get("http://t/api/dev/me"), noParams));
    expect((me.user as { id: string }).id).toBe(authState.user.id);
  });

  it("dev/me 404s in production (the dev-route gate)", async (t) => {
    if (!ready) return t.skip();
    const prev = process.env.NODE_ENV;
    // NODE_ENV is read-only in the Next types; assign through a cast for the test.
    (process.env as Record<string, string | undefined>).NODE_ENV = "production";
    try {
      const gated = await devMeRoute(get("http://t/api/dev/me"), noParams);
      expect(gated.status).toBe(404);
    } finally {
      (process.env as Record<string, string | undefined>).NODE_ENV = prev;
    }
  });
});

describe("deletion guards", () => {
  it("deletes a library character even while a world references it; the world keeps its snapshot", async (t) => {
    if (!ready) return t.skip();
    // world-instances.plan.md: worlds hold their own entity snapshots, so a
    // library delete no longer 409s ("in use") and never breaks the world — the
    // cast copy survives with a now-dangling source pointer.
    const charGone = await deleteCharacterRoute(get(`http://t/api/characters/${characterId}`), ctx({ id: characterId }));
    expect(charGone.status).toBe(200);
    const cast = await db().select().from(worldCast).where(eq(worldCast.worldId, worldId));
    expect(cast.length).toBeGreaterThan(0);
    expect(cast.every((c) => c.name.length > 0)).toBe(true);

    const worldGone = await deleteWorldRoute(get(`http://t/api/worlds/${worldId}`), ctx({ id: worldId }));
    expect(worldGone.status).toBe(200);
    const [chunkCount] = await db()
      .select({ count: sql<number>`count(*)::int` })
      .from(loreChunks)
      .where(eq(loreChunks.worldId, worldId));
    expect(chunkCount?.count).toBe(0);
  });
});
