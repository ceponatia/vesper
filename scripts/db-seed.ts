import "dotenv/config";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  characterProfileSchema,
  itemDefinitionSchema,
  locationSnapshotSchema,
  worldLoreSchema,
  worldStyleSchema,
  type CharacterProfile,
  type ItemDefinition,
} from "../src/contracts";
import { DiagnosticCollector } from "../src/contracts/diagnostics";
import { newId } from "../src/lib/ids";
import {
  characters,
  db,
  itemInstances,
  items,
  locations,
  loreChunks,
  sessionLocations,
  sessionParticipants,
  sessions,
  users,
  worldCast,
  worldItems,
  worldLinks,
  worldLocations,
  worlds,
  type Db,
} from "../src/server/db";
import { indexLoreChunks, refreshSearchEmbedding } from "../src/server/memory";
import { DEV_PASSWORD, ensureDevCredential } from "../src/server/auth";
import { harborHouse, SEED_TAG, WORLD_NAME, type SeedWorldFixture } from "./fixtures/harbor-house";

/**
 * Idempotent dev seed (docs/getting-started.md): wipes and recreates the
 * "Harbor House" starter world for the default dev user. Seed rows are marked
 * with SEED_TAG in their tags column; user-authored content is never wiped —
 * lingering references to seed rows are detached (sessions keep playing from
 * their snapshots), never cascaded.
 */

const DEV_EMAIL = "player@vesper.local";

/** The dedicated UI/QA admin (CLAUDE.md) — a fixed id every Tsukikage Onsen
 *  `ownerId` references, so it must be preserved, never recreated with a new id. */
const UXTEST_ID = "uxtestmaina1b2c3d4e5f6g7";
const UXTEST_EMAIL = "uxtest-main@vesper.local";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

async function ensureDevUser(): Promise<{ id: string; name: string }> {
  const [existing] = await db().select().from(users).where(eq(users.email, DEV_EMAIL)).limit(1);
  if (existing) return existing;
  const [created] = await db()
    .insert(users)
    .values({ email: DEV_EMAIL, name: "Player", role: "admin", emailVerified: true })
    .onConflictDoNothing()
    .returning();
  if (created) return created;
  const [raced] = await db().select().from(users).where(eq(users.email, DEV_EMAIL)).limit(1);
  if (!raced) throw new Error("failed to ensure default dev user");
  return raced;
}

/** Ensure the UI/QA admin row exists (preserving its fixed id) — fresh DBs lack it. */
async function ensureUxtestAdmin(): Promise<string> {
  await db()
    .insert(users)
    .values({ id: UXTEST_ID, email: UXTEST_EMAIL, name: "UX Tester", role: "admin", emailVerified: true })
    .onConflictDoNothing();
  return UXTEST_ID;
}

/** ids of owner rows carrying the seed marker tag. */
async function taggedIds(tx: Tx, table: typeof characters | typeof locations | typeof items, ownerId: string): Promise<string[]> {
  const marker = JSON.stringify([SEED_TAG]);
  const rows = await tx
    .select({ id: table.id })
    .from(table)
    .where(and(eq(table.ownerId, ownerId), sql`${table.tags} @> ${marker}::jsonb`));
  return rows.map((r) => r.id);
}

async function wipe(tx: Tx, ownerId: string): Promise<void> {
  const oldWorlds = await tx
    .select({ id: worlds.id })
    .from(worlds)
    .where(and(eq(worlds.ownerId, ownerId), eq(worlds.name, WORLD_NAME)));
  const worldIds = oldWorlds.map((w) => w.id);
  if (worldIds.length > 0) {
    // sessions.world_id has no cascade; their children cascade from sessions.
    const gone = await tx.delete(sessions).where(inArray(sessions.worldId, worldIds)).returning({ id: sessions.id });
    if (gone.length > 0) console.log(`  deleted ${gone.length} session(s) of the previous seed world`);
    await tx.delete(worlds).where(inArray(worlds.id, worldIds)); // cascades world_* + lore_chunks
    console.log(`  deleted previous world "${WORLD_NAME}" (${worldIds.length})`);
  }

  const charIds = await taggedIds(tx, characters, ownerId);
  if (charIds.length > 0) {
    await tx.update(sessionParticipants).set({ characterId: null }).where(inArray(sessionParticipants.characterId, charIds));
    const borrowed = await tx.delete(worldCast).where(inArray(worldCast.sourceCharacterId, charIds)).returning({ id: worldCast.id });
    if (borrowed.length > 0) console.log(`  warning: removed ${borrowed.length} cast row(s) referencing seed characters in other worlds`);
    await tx.delete(characters).where(inArray(characters.id, charIds));
  }

  const itemIds = await taggedIds(tx, items, ownerId);
  if (itemIds.length > 0) {
    await tx.update(itemInstances).set({ itemId: null }).where(inArray(itemInstances.itemId, itemIds));
    const borrowed = await tx.delete(worldItems).where(inArray(worldItems.sourceItemId, itemIds)).returning({ id: worldItems.id });
    if (borrowed.length > 0) console.log(`  warning: removed ${borrowed.length} item placement(s) referencing seed items in other worlds`);
    await tx.delete(items).where(inArray(items.id, itemIds));
  }

  const locIds = await taggedIds(tx, locations, ownerId);
  if (locIds.length > 0) {
    await tx.update(sessionLocations).set({ locationId: null }).where(inArray(sessionLocations.locationId, locIds));
    const borrowed = await tx.delete(worldLocations).where(inArray(worldLocations.sourceLocationId, locIds)).returning({ id: worldLocations.id });
    if (borrowed.length > 0) console.log(`  warning: removed ${borrowed.length} location row(s) referencing seed locations in other worlds`);
    await tx.delete(locations).where(inArray(locations.id, locIds));
  }
}

interface CreatedWorld {
  worldId: string;
  characterIds: string[];
  locationIds: string[];
  itemIds: string[];
}

function requireKey<V>(map: Map<string, V>, key: string, what: string): V {
  const value = map.get(key);
  if (value === undefined) throw new Error(`fixture references unknown ${what} key "${key}"`);
  return value;
}

async function create(tx: Tx, ownerId: string, fixture: SeedWorldFixture): Promise<CreatedWorld> {
  // Library locations.
  const locIdByKey = new Map<string, string>(fixture.locations.map((l) => [l.key, newId()]));
  await tx.insert(locations).values(
    fixture.locations.map((l) => ({
      id: requireKey(locIdByKey, l.key, "location"),
      ownerId,
      name: l.name,
      description: l.description,
      ambient: l.ambient,
      tags: [...l.tags, SEED_TAG],
    })),
  );

  // Library items. Validate the composed definition; store extras only
  // (items.definition holds the ItemDefinition extras slice — see server/api/schemas.ts).
  const itemIdByKey = new Map<string, string>(fixture.items.map((i) => [i.key, newId()]));
  // Capture the composed ItemDefinition per key so the world copy can bake it as
  // its snapshot (world-instances.plan.md — the world owns a full copy).
  const itemDefByKey = new Map<string, ItemDefinition>();
  await tx.insert(items).values(
    fixture.items.map((i) => {
      const tags = [...(i.tags ?? []), SEED_TAG];
      itemDefByKey.set(i.key, itemDefinitionSchema.parse({ kind: i.kind, name: i.name, description: i.description, tags, ...i.extras }));
      return {
        id: requireKey(itemIdByKey, i.key, "item"),
        ownerId,
        kind: i.kind,
        name: i.name,
        description: i.description,
        definition: i.extras ?? {},
        tags,
      };
    }),
  );

  // Characters (defaultOutfit references resolved library item ids).
  const charIdByKey = new Map<string, string>(fixture.characters.map((c) => [c.key, newId()]));
  // Capture each built profile + name so the world cast can bake them as its copy.
  const profileByCharKey = new Map<string, CharacterProfile>();
  const nameByCharKey = new Map<string, string>(fixture.characters.map((c) => [c.key, c.name]));
  await tx.insert(characters).values(
    fixture.characters.map((c) => {
      const profile = characterProfileSchema.parse({
        bio: c.bio,
        personality: c.personality,
        voice: c.voice,
        speciesId: "human",
        bodyPlanId: "humanoid",
        attributes: c.attributes,
        aliases: c.aliases,
        defaultOutfit: c.defaultOutfitKeys.map((k) => requireKey(itemIdByKey, k, "item")),
        schedule: c.schedule,
      });
      profileByCharKey.set(c.key, profile);
      return {
        id: requireKey(charIdByKey, c.key, "character"),
        ownerId,
        name: c.name,
        profile,
        tags: [...c.tags, SEED_TAG],
      };
    }),
  );

  // World.
  const worldId = newId();
  await tx.insert(worlds).values({
    id: worldId,
    ownerId,
    name: fixture.name,
    description: fixture.description,
    style: worldStyleSchema.parse(fixture.style),
    lore: worldLoreSchema.parse({
      synopsis: fixture.synopsis,
      factions: fixture.factions.map((f) => ({
        id: f.id,
        name: f.name,
        description: f.description,
        memberCharacterIds: f.memberCharacterKeys.map((k) => requireKey(charIdByKey, k, "character")),
        conflicts: f.conflicts,
      })),
      plotAnchors: fixture.plotAnchors,
    }),
    narrativeModel: "", // per-world override unset → env default
  });

  // World locations + links.
  const worldLocIdByKey = new Map<string, string>(fixture.locations.map((l) => [l.key, newId()]));
  await tx.insert(worldLocations).values(
    fixture.locations.map((l) => ({
      id: requireKey(worldLocIdByKey, l.key, "world location"),
      worldId,
      sourceLocationId: requireKey(locIdByKey, l.key, "location"),
      snapshot: locationSnapshotSchema.parse({
        name: l.name,
        description: l.description,
        ambient: l.ambient,
        tags: [...l.tags, SEED_TAG],
      }),
    })),
  );
  await tx.insert(worldLinks).values(
    fixture.links.map((link) => ({
      worldId,
      fromWorldLocationId: requireKey(worldLocIdByKey, link.from, "world location"),
      toWorldLocationId: requireKey(worldLocIdByKey, link.to, "world location"),
      label: link.label,
    })),
  );

  // Cast.
  const castIdByCharKey = new Map<string, string>(fixture.cast.map((c) => [c.characterKey, newId()]));
  await tx.insert(worldCast).values(
    fixture.cast.map((c) => ({
      id: requireKey(castIdByCharKey, c.characterKey, "cast"),
      worldId,
      sourceCharacterId: requireKey(charIdByKey, c.characterKey, "character"),
      name: requireKey(nameByCharKey, c.characterKey, "character name"),
      snapshot: requireKey(profileByCharKey, c.characterKey, "character profile"),
      role: c.role,
      startWorldLocationId: requireKey(worldLocIdByKey, c.startLocationKey, "world location"),
    })),
  );

  // Item placements. Container rows are referenced by their world_items id, so
  // every placement's id is precomputed and keyed by item key.
  const worldItemIdByItemKey = new Map<string, string>(fixture.placements.map((p) => [p.itemKey, newId()]));
  await tx.insert(worldItems).values(
    fixture.placements.map((p) => {
      const placements = [p.locationKey, p.castKey, p.containerKey].filter((v) => v !== undefined);
      if (placements.length !== 1) throw new Error(`placement for "${p.itemKey}" must set exactly one of location/cast/container`);
      const snapshot = requireKey(itemDefByKey, p.itemKey, "item definition");
      return {
        id: requireKey(worldItemIdByItemKey, p.itemKey, "placement"),
        worldId,
        sourceItemId: requireKey(itemIdByKey, p.itemKey, "item"),
        name: snapshot.name,
        snapshot,
        worldLocationId: p.locationKey ? requireKey(worldLocIdByKey, p.locationKey, "world location") : null,
        castId: p.castKey ? requireKey(castIdByCharKey, p.castKey, "cast") : null,
        worn: p.worn ?? false,
        containerWorldItemId: p.containerKey ? requireKey(worldItemIdByItemKey, p.containerKey, "placement") : null,
        quantity: p.quantity ?? 1,
      };
    }),
  );

  // Lore chunks (embedded after commit by indexLoreChunks).
  await tx.insert(loreChunks).values(
    fixture.loreChunks.map((chunk) => ({
      worldId,
      title: chunk.title,
      body: chunk.body,
      category: chunk.category,
      tier: chunk.tier,
      visibility: chunk.visibility,
      unlockTags: chunk.unlockTags ?? [],
      locationTags: chunk.locationTags ?? [],
      characterIds: (chunk.characterKeys ?? []).map((k) => requireKey(charIdByKey, k, "character")),
      sort: chunk.sort,
    })),
  );

  return {
    worldId,
    characterIds: [...charIdByKey.values()],
    locationIds: [...locIdByKey.values()],
    itemIds: [...itemIdByKey.values()],
  };
}

async function main(): Promise<void> {
  const user = await ensureDevUser();
  console.log(`seeding "${WORLD_NAME}" for ${DEV_EMAIL} (${user.id})`);

  // Provision the shared dev credential so `POST /api/dev/impersonate` can mint a
  // real signed session for the Player + the UI/QA admin (auth.plan.md).
  const uxtestId = await ensureUxtestAdmin();
  await ensureDevCredential(user.id);
  await ensureDevCredential(uxtestId);
  console.log(`  dev credential set (password "${DEV_PASSWORD}") for ${DEV_EMAIL} + ${UXTEST_EMAIL}`);

  const created = await db().transaction(async (tx) => {
    await wipe(tx, user.id);
    return create(tx, user.id, harborHouse);
  });

  console.log(
    `  created world ${created.worldId}: ${created.locationIds.length} locations, ` +
      `${created.characterIds.length} characters, ${created.itemIds.length} items, ${harborHouse.loreChunks.length} lore chunks`,
  );

  // Embeddings (demo mode → pseudo vectors). Failures degrade to diagnostics.
  const sink = new DiagnosticCollector();
  const indexed = await indexLoreChunks(created.worldId, sink);
  console.log(`  embedded ${indexed} lore chunk(s)`);
  let refreshed = 0;
  for (const id of created.characterIds) refreshed += (await refreshSearchEmbedding("character", id, sink)) ? 1 : 0;
  for (const id of created.locationIds) refreshed += (await refreshSearchEmbedding("location", id, sink)) ? 1 : 0;
  for (const id of created.itemIds) refreshed += (await refreshSearchEmbedding("item", id, sink)) ? 1 : 0;
  console.log(`  refreshed ${refreshed} search embedding(s)`);
  for (const d of sink.items) console.log(`  diagnostic [${d.severity}] ${d.code}: ${d.message}`);

  console.log("seed complete");
}

main()
  .then(async () => {
    await globalThis.__vesperPool?.end();
  })
  .catch(async (err) => {
    console.error(err);
    await globalThis.__vesperPool?.end();
    process.exit(1);
  });
