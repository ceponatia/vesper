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
  items,
  jobs,
  locations,
  personas,
  users,
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
import { GET as imageFileRoute } from "./images/[id]/file/route";
import { POST as itemImagesBatchRoute } from "./items/images/route";
import { POST as locationImagesBatchRoute } from "./locations/images/route";
import { POST as cloneCharacterRoute } from "./characters/[id]/clone/route";
import { GET as listPersonasRoute, POST as createPersonaRoute } from "./personas/route";
import {
  DELETE as deletePersonaRoute,
  GET as getPersonaRoute,
  PATCH as patchPersonaRoute,
} from "./personas/[id]/route";
import { GET as devMeRoute } from "./dev/me/route";

async function probe(): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      db().execute(sql`select 1 from characters limit 1`),
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
  await db().delete(images).where(eq(images.ownerId, ownerId));
  await db().delete(items).where(eq(items.ownerId, ownerId));
  await db().delete(locations).where(eq(locations.ownerId, ownerId));
  await db().delete(characters).where(eq(characters.ownerId, ownerId));
  await db().delete(personas).where(eq(personas.ownerId, ownerId));
  await db().delete(jobs).where(gte(jobs.createdAt, testStart));
  await db().delete(users).where(eq(users.id, ownerId));
  await globalThis.__vesperPool?.end();
});

let characterId = "";
let locationId = "";
let clothingItemId = "";
let personaId = "";

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
  it("character list carries speciesId/gender and honors ?sort=name", async (t) => {
    if (!ready) return t.skip();
    const mk = async (name: string) =>
      ((await json(await createCharacterRoute(send("http://t/api/characters", "POST", { name, tags: ["facet-sort"] }), noParams)))
        .character as { id: string }).id;
    // Created in reverse-alphabetical order so updated-recency and name order disagree.
    const aaId = await mk("Aa Facet Muse");
    const zzId = await mk("Zz Facet Muse");

    const byRecency = (await json(await listCharactersRoute(get("http://t/api/characters?tag=facet-sort"), noParams)))
      .characters as Array<{ id: string; speciesId: string | null; gender: string | null }>;
    expect(byRecency.map((c) => c.id)).toEqual([zzId, aaId]);
    const aa = byRecency.find((c) => c.id === aaId);
    // A blank-created character carries the registry defaults (human, female).
    expect(aa?.speciesId).toBe("human");
    expect(aa?.gender).toBe("female");

    const byName = (await json(await listCharactersRoute(get("http://t/api/characters?tag=facet-sort&sort=name"), noParams)))
      .characters as Array<{ id: string }>;
    expect(byName.map((c) => c.id)).toEqual([aaId, zzId]);

    for (const id of [aaId, zzId]) await deleteCharacterRoute(get(`http://t/api/characters/${id}`), ctx({ id }));
  });

  it("location list carries scale", async (t) => {
    if (!ready) return t.skip();
    const created = await createLocationRoute(
      send("http://t/api/locations", "POST", { name: "Facet Harbor", tags: ["facet-scale"] }),
      noParams,
    );
    const locId = ((await json(created)).location as { id: string }).id;

    const listed = (await json(await listLocationsRoute(get("http://t/api/locations?tag=facet-scale"), noParams)))
      .locations as Array<{ id: string; scale: string }>;
    const row = listed.find((l) => l.id === locId);
    expect(row?.scale).toBe("room"); // the column default rides the list payload

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

describe("personas CRUD", () => {
  it("creates a persona and lists it", async (t) => {
    if (!ready) return t.skip();
    const res = await createPersonaRoute(
      send("http://t/api/personas", "POST", {
        title: "Brian, 22",
        name: "Brian",
        tags: ["young"],
        profile: { bio: "A quiet man who fixes things.", intimateRegions: ["penis"] },
      }),
      noParams,
    );
    expect(res.status).toBe(201);
    personaId = ((await json(res)).persona as { id: string }).id;

    const list = await listPersonasRoute(get("http://t/api/personas"), noParams);
    const rows = (await json(list)).personas as { id: string; title: string; name: string }[];
    expect(rows.map((r) => r.id)).toContain(personaId);
    expect(rows.find((r) => r.id === personaId)?.title).toBe("Brian, 22");
  });

  // The whole reason `title` exists: `name` must be free to repeat across personas.
  it("allows a duplicate name under a different title", async (t) => {
    if (!ready) return t.skip();
    const res = await createPersonaRoute(
      send("http://t/api/personas", "POST", { title: "Brian, 40", name: "Brian" }),
      noParams,
    );
    expect(res.status).toBe(201);
  });

  it("rejects a duplicate title with a typed 409, not a raw unique-violation 500", async (t) => {
    if (!ready) return t.skip();
    const res = await createPersonaRoute(
      send("http://t/api/personas", "POST", { title: "Brian, 22", name: "Someone Else" }),
      noParams,
    );
    expect(res.status).toBe(409);
    expect(((await json(res)).error as { code: string }).code).toBe("title_conflict");
  });

  it("merges a partial profile PATCH instead of replacing it", async (t) => {
    if (!ready) return t.skip();
    // Seed a wardrobe, then PATCH only `attributes` — the outfits must survive.
    const seeded = await patchPersonaRoute(
      send("http://t/api/personas/x", "PATCH", {
        profile: { outfits: [{ id: "everyday", name: "Everyday", items: ["shirt"] }] },
      }),
      ctx({ id: personaId }),
    );
    expect(seeded.status).toBe(200);

    const patched = await patchPersonaRoute(
      send("http://t/api/personas/x", "PATCH", {
        profile: { attributes: [{ id: "skin.tone", value: "tan", source: "manual" }] },
      }),
      ctx({ id: personaId }),
    );
    expect(patched.status).toBe(200);
    const profile = ((await json(patched)).persona as { profile: Record<string, unknown> }).profile;
    expect(profile.attributes).toHaveLength(1);
    // The invariant partialWithoutDefaults exists to protect: unsent fields keep their value.
    expect(profile.outfits).toHaveLength(1);
    expect(profile.bio).toBe("A quiet man who fixes things.");
  });

  it("gets and deletes a persona; a foreign id is a 404", async (t) => {
    if (!ready) return t.skip();
    const got = await getPersonaRoute(get("http://t/api/personas/x"), ctx({ id: personaId }));
    expect(got.status).toBe(200);

    const missing = await getPersonaRoute(get("http://t/api/personas/x"), ctx({ id: "nope-not-a-real-id" }));
    expect(missing.status).toBe(404);

    const gone = await deletePersonaRoute(send("http://t/api/personas/x", "DELETE"), ctx({ id: personaId }));
    expect(gone.status).toBe(200);
    const after = await getPersonaRoute(get("http://t/api/personas/x"), ctx({ id: personaId }));
    expect(after.status).toBe(404);
  });
});
