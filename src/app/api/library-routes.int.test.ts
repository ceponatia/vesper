import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq, gte, sql } from "drizzle-orm";
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
  USER_COOKIE: "vesper_user",
  getCurrentUser: async () => authState.user,
  ensureDefaultUser: async () => authState.user,
  listUsers: async () => [authState.user],
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
import { POST as createLocationRoute } from "./locations/route";
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
import { GET as devMeRoute } from "./dev/me/route";
import { POST as switchUserRoute } from "./dev/switch-user/route";

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
    const outfit = (body.character as { profile: { defaultOutfit: string[] } }).profile.defaultOutfit;
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
    const againOutfit = ((await json(again)).character as { profile: { defaultOutfit: string[] } }).profile.defaultOutfit;
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
          { locationId, overrides: { description: "Now with a leak." } },
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
        style: { norms: [{ rule: "No open flames on the docks", severity: "disapproval" }] },
        loreChunks: [{ title: "Rewritten", body: "Only chunk now." }],
      }),
      ctx({ id: worldId }),
    );
    expect(second.status).toBe(200);
    const body = await json(second);
    const style = (body.world as { style: { directives: string[]; norms: unknown[] } }).style;
    expect(style.directives).toEqual(["slow-burn pacing"]); // earlier patch survived the norms patch
    expect(style.norms.length).toBe(1);
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
  it("dev/me returns the resolved user and the switch sets the cookie", async (t) => {
    if (!ready) return t.skip();
    const me = await json(await devMeRoute(get("http://t/api/dev/me"), noParams));
    expect((me.user as { id: string }).id).toBe(authState.user.id);

    const switched = await switchUserRoute(
      send("http://t/api/dev/switch-user", "POST", { userId: authState.user.id }),
      noParams,
    );
    expect(switched.status).toBe(200);
    expect(switched.headers.get("set-cookie")).toContain(`vesper_user=${authState.user.id}`);

    const unknown = await switchUserRoute(send("http://t/api/dev/switch-user", "POST", { userId: "nope" }), noParams);
    expect(unknown.status).toBe(404);
  });
});

describe("deletion guards", () => {
  it("409s deleting a character used by a world, then deletes cleanly after the world", async (t) => {
    if (!ready) return t.skip();
    const inUse = await deleteCharacterRoute(get(`http://t/api/characters/${characterId}`), ctx({ id: characterId }));
    expect(inUse.status).toBe(409);
    expect(((await json(inUse)).error as { code: string }).code).toBe("in_use");

    const worldGone = await deleteWorldRoute(get(`http://t/api/worlds/${worldId}`), ctx({ id: worldId }));
    expect(worldGone.status).toBe(200);
    const [chunkCount] = await db()
      .select({ count: sql<number>`count(*)::int` })
      .from(loreChunks)
      .where(eq(loreChunks.worldId, worldId));
    expect(chunkCount?.count).toBe(0);

    const charGone = await deleteCharacterRoute(get(`http://t/api/characters/${characterId}`), ctx({ id: characterId }));
    expect(charGone.status).toBe(200);
  });
});
