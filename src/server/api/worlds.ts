import { asc, eq, inArray, isNull, and } from "drizzle-orm";
import { z } from "zod";
import {
  authoredRelationshipListSchema,
  authoredRelationshipSchema,
  diag,
  itemDefinitionSchema,
  loreChunkCategorySchema,
  loreChunkTierSchema,
  loreChunkVisibilitySchema,
  worldLoreSchema,
  worldStyleSchema,
  type AuthoredRelationship,
  type Diagnostic,
  type DiagnosticSink,
} from "@/contracts";
import { DiagnosticCollector } from "@/contracts/diagnostics";
import { parseOr } from "@/lib/parse";
import { castRoleSchema, castTierSchema, locationScaleSchema } from "@/server/authoring";
import {
  characters,
  db,
  items,
  locations,
  loreChunks,
  worldCast,
  worldItems,
  worldLinks,
  worldLocations,
  worlds,
  type Db,
} from "@/server/db";
import { DEFAULT_INTER_AREA_TRAVEL_MINUTES } from "@/server/engine";
import { generateAvatarsBatch, generateEntityImagesBatch, missingEntityImageIds } from "@/server/images";
import { indexLoreChunks } from "@/server/memory";
import { log } from "@/lib/log";
import { startJob } from "./jobs";
import { queueEmbedRefresh } from "./library";
import { errorText } from "./respond";
import { ambientSchema, nameSchema, partialWithoutDefaults, tagsSchema } from "./schemas";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

// ---------------------------------------------------------------------------
// Input schemas (docs/authoring.md: world save materializes worlds + world_*
// rows; the same nested shape serves create and full-replace PATCH)
// ---------------------------------------------------------------------------

export const worldLocationOverridesSchema = z
  .object({
    name: nameSchema,
    description: z.string(),
    ambient: ambientSchema,
    tags: tagsSchema,
    scale: locationScaleSchema,
    area: z.string().trim().max(100),
  })
  .partial();

export const worldLocationInputSchema = z
  .object({
    /** Link an existing library location; omit to create one from the fields below. */
    locationId: z.string().min(1).optional(),
    name: z.string().trim().max(200).default(""),
    description: z.string().default(""),
    ambient: ambientSchema.default({}),
    tags: tagsSchema.default([]),
    /** Spatial size class (proximity-spec); persisted on new library locations, in overrides for linked ones. */
    scale: locationScaleSchema.catch("room").default("room"),
    /** Map-grouping label — drives default link travel times (intra-area 1, inter-area 10). */
    area: z.string().trim().max(100).optional(),
    overrides: worldLocationOverridesSchema.default({}),
    /** Names of other locations in this payload this one connects to (undirected). */
    links: z.array(z.string()).default([]),
  })
  .refine((loc) => loc.locationId !== undefined || loc.name.length > 0, {
    message: "a location needs a locationId or a name",
  });
export type WorldLocationInput = z.infer<typeof worldLocationInputSchema>;

export const worldLoreChunkInputSchema = z.object({
  title: z.string().trim().min(1).max(300),
  body: z.string().default(""),
  category: loreChunkCategorySchema.catch("history"),
  tier: loreChunkTierSchema.catch("scene"),
  visibility: loreChunkVisibilitySchema.catch("public"),
  unlockTags: z.array(z.string()).default([]),
  locationTags: z.array(z.string()).default([]),
  characterIds: z.array(z.string()).default([]),
  manuallyUnlocked: z.boolean().default(false),
});
export type WorldLoreChunkInput = z.infer<typeof worldLoreChunkInputSchema>;

export const worldCastInputSchema = z.object({
  characterId: z.string().min(1),
  role: castRoleSchema.catch("npc"),
  tier: castTierSchema.catch("minor").default("minor"),
  startLocationName: z.string().optional(),
  /** Authored edges toward other cast names or "player" (contracts/relationships/authored.ts). */
  relationships: z.array(authoredRelationshipSchema).max(100).default([]),
});
export type WorldCastInput = z.infer<typeof worldCastInputSchema>;

export const worldItemInputSchema = z
  .object({
    /** Link an existing library item; omit to create one from `definition`. */
    itemId: z.string().min(1).optional(),
    definition: itemDefinitionSchema.optional(),
    locationName: z.string().optional(),
    castCharacterId: z.string().optional(),
    worn: z.boolean().default(false),
    quantity: z.number().int().min(1).max(20).default(1),
  })
  .refine((item) => item.itemId !== undefined || item.definition !== undefined, {
    message: "an item needs an itemId or a definition",
  });
export type WorldItemInput = z.infer<typeof worldItemInputSchema>;

// Strict: a forge draft posted here by mistake (castSuggestions,
// itemPlacements, …) must be a loud 400, not a silently empty world — drafts
// save through /api/worlds/from-draft.
export const worldCreateSchema = z
  .object({
    name: nameSchema,
    description: z.string().default(""),
    style: worldStyleSchema.default(() => worldStyleSchema.parse({})),
    lore: worldLoreSchema.default(() => worldLoreSchema.parse({})),
    narrativeModel: z.string().default(""),
    locations: z.array(worldLocationInputSchema).max(100).default([]),
    loreChunks: z.array(worldLoreChunkInputSchema).max(200).default([]),
    cast: z.array(worldCastInputSchema).max(100).default([]),
    items: z.array(worldItemInputSchema).max(300).default([]),
    /** Where the player starts, by location name (decision 47); unset keeps the anchor-to-companion default. */
    playerStartLocationName: z.string().optional(),
  })
  .strict();
export type WorldCreateBody = z.infer<typeof worldCreateSchema>;

/**
 * PATCH: scalar fields merge; each nested array, when present, fully replaces
 * that family. Replacing `locations` cascades away links and item placements,
 * so editors saving the map should send locations + cast + items together.
 */
export const worldPatchSchema = z.object({
  name: nameSchema.optional(),
  description: z.string().optional(),
  style: partialWithoutDefaults(worldStyleSchema).optional(),
  lore: partialWithoutDefaults(worldLoreSchema).optional(),
  narrativeModel: z.string().optional(),
  locations: z.array(worldLocationInputSchema).max(100).optional(),
  loreChunks: z.array(worldLoreChunkInputSchema).max(200).optional(),
  cast: z.array(worldCastInputSchema).max(100).optional(),
  items: z.array(worldItemInputSchema).max(300).optional(),
  playerStartLocationName: z.string().optional(),
});
export type WorldPatchBody = z.infer<typeof worldPatchSchema>;

// ---------------------------------------------------------------------------
// Reference prefetch (unknown ids are a 400, before anything is written)
// ---------------------------------------------------------------------------

interface EntityRefs {
  locationsById: Map<string, typeof locations.$inferSelect>;
  charactersById: Map<string, typeof characters.$inferSelect>;
  itemsById: Map<string, typeof items.$inferSelect>;
}

export type WorldWriteResult =
  | { ok: true; worldId: string; diagnostics: Diagnostic[] }
  | { ok: false; code: "not_found" | "invalid_reference"; message: string };

async function prefetchRefs(
  ownerId: string,
  input: Pick<WorldCreateBody, "locations" | "cast" | "items">,
): Promise<{ ok: true; refs: EntityRefs } | { ok: false; message: string }> {
  const locationIds = [...new Set(input.locations.flatMap((l) => (l.locationId ? [l.locationId] : [])))];
  const characterIds = [...new Set(input.cast.map((c) => c.characterId))];
  const itemIds = [...new Set(input.items.flatMap((i) => (i.itemId ? [i.itemId] : [])))];

  const [locationRows, characterRows, itemRows] = await Promise.all([
    locationIds.length
      ? db().select().from(locations).where(and(eq(locations.ownerId, ownerId), inArray(locations.id, locationIds)))
      : Promise.resolve([]),
    characterIds.length
      ? db().select().from(characters).where(and(eq(characters.ownerId, ownerId), inArray(characters.id, characterIds)))
      : Promise.resolve([]),
    itemIds.length
      ? db().select().from(items).where(and(eq(items.ownerId, ownerId), inArray(items.id, itemIds)))
      : Promise.resolve([]),
  ]);

  const refs: EntityRefs = {
    locationsById: new Map(locationRows.map((r) => [r.id, r])),
    charactersById: new Map(characterRows.map((r) => [r.id, r])),
    itemsById: new Map(itemRows.map((r) => [r.id, r])),
  };
  const missing = [
    ...locationIds.filter((id) => !refs.locationsById.has(id)).map((id) => `location ${id}`),
    ...characterIds.filter((id) => !refs.charactersById.has(id)).map((id) => `character ${id}`),
    ...itemIds.filter((id) => !refs.itemsById.has(id)).map((id) => `item ${id}`),
  ];
  if (missing.length > 0) return { ok: false, message: `unknown references: ${missing.slice(0, 5).join(", ")}` };
  return { ok: true, refs };
}

// ---------------------------------------------------------------------------
// Materialization (shared by create and PATCH-replace)
// ---------------------------------------------------------------------------

interface MaterializeResult {
  createdLocationIds: string[];
  createdItemIds: string[];
  worldLocationIdByName: Map<string, string>;
}

async function materializeLocations(
  tx: Tx,
  ownerId: string,
  worldId: string,
  input: readonly WorldLocationInput[],
  refs: EntityRefs,
  sink: DiagnosticSink,
): Promise<{ created: string[]; worldLocationIdByName: Map<string, string> }> {
  const created: string[] = [];
  const worldLocationIdByName = new Map<string, string>();
  const resolved: Array<{ input: WorldLocationInput; worldLocationId: string; effectiveName: string }> = [];

  for (const [index, loc] of input.entries()) {
    let baseId: string;
    let effectiveName: string;
    if (loc.locationId) {
      const base = refs.locationsById.get(loc.locationId);
      if (!base) continue; // prefetch already rejected unknown ids; defensive
      baseId = base.id;
      effectiveName = loc.overrides.name ?? base.name;
    } else {
      const [row] = await tx
        .insert(locations)
        .values({ ownerId, name: loc.name, description: loc.description, ambient: loc.ambient, scale: loc.scale, tags: loc.tags })
        .returning({ id: locations.id });
      if (!row) continue;
      created.push(row.id);
      baseId = row.id;
      effectiveName = loc.name;
    }
    // Area is world-placement data, so it always rides in overrides; for a
    // linked library location, scale rides there too (the base row is shared).
    const overrides = loc.locationId
      ? { ...loc.overrides, scale: loc.overrides.scale ?? loc.scale, area: loc.overrides.area ?? loc.area }
      : { ...(loc.area ? { area: loc.area } : {}) };
    // The array index is the authored map order (editor reordering).
    const [wl] = await tx
      .insert(worldLocations)
      .values({ worldId, locationId: baseId, overrides, sort: index })
      .returning({ id: worldLocations.id });
    if (!wl) continue;
    const key = effectiveName.trim().toLowerCase();
    if (worldLocationIdByName.has(key)) {
      sink.push(diag("warn", "api.world.location.duplicate_name", `duplicate location name "${effectiveName}"`));
    } else {
      worldLocationIdByName.set(key, wl.id);
    }
    resolved.push({ input: loc, worldLocationId: wl.id, effectiveName });
  }

  // Undirected link names → one world_links row per unique pair. Travel time
  // defaults by area (multi-character-v1-defaults.phase3.md): same/unset area ⇒ 1
  // minute; both areas set and different ⇒ the inter-area default. Editable
  // per link afterwards.
  const areaByWorldLocationId = new Map<string, string | undefined>(
    resolved.map((loc) => [loc.worldLocationId, (loc.input.overrides.area ?? loc.input.area)?.trim().toLowerCase() || undefined]),
  );
  const linked = new Set<string>();
  for (const loc of resolved) {
    for (const target of loc.input.links) {
      const toId = worldLocationIdByName.get(target.trim().toLowerCase());
      if (!toId || toId === loc.worldLocationId) {
        if (!toId) {
          sink.push(
            diag("warn", "api.world.link.unresolved", `link target "${target}" from "${loc.effectiveName}" not found`),
          );
        }
        continue;
      }
      const pair = [loc.worldLocationId, toId].sort().join("|");
      if (linked.has(pair)) continue;
      linked.add(pair);
      const fromArea = areaByWorldLocationId.get(loc.worldLocationId);
      const toArea = areaByWorldLocationId.get(toId);
      const travelMinutes = fromArea && toArea && fromArea !== toArea ? DEFAULT_INTER_AREA_TRAVEL_MINUTES : 1;
      await tx.insert(worldLinks).values({ worldId, fromWorldLocationId: loc.worldLocationId, toWorldLocationId: toId, travelMinutes });
    }
  }
  return { created, worldLocationIdByName };
}

interface MaterializeSeeds {
  /** Existing world locations by effective name (PATCH families that keep the current map). */
  worldLocationIdByName?: Map<string, string>;
  /** Existing cast ids by character id (PATCH that keeps the current cast). */
  castIdByCharacterId?: Map<string, string>;
}

async function materializeWorldEntities(
  tx: Tx,
  ownerId: string,
  worldId: string,
  input: Pick<WorldCreateBody, "locations" | "cast" | "items" | "loreChunks">,
  refs: EntityRefs,
  sink: DiagnosticSink,
  seeds: MaterializeSeeds = {},
): Promise<MaterializeResult> {
  const { created: createdLocationIds, worldLocationIdByName } =
    input.locations.length > 0 || !seeds.worldLocationIdByName
      ? await materializeLocations(tx, ownerId, worldId, input.locations, refs, sink)
      : { created: [], worldLocationIdByName: seeds.worldLocationIdByName };

  const castIdByCharacterId = new Map<string, string>(seeds.castIdByCharacterId ?? []);
  for (const member of input.cast) {
    if (castIdByCharacterId.has(member.characterId)) {
      sink.push(diag("warn", "api.world.cast.duplicate", `character ${member.characterId} listed twice; kept first`));
      continue;
    }
    const startName = member.startLocationName?.trim().toLowerCase();
    const startWorldLocationId = startName ? worldLocationIdByName.get(startName) : undefined;
    if (startName && !startWorldLocationId) {
      sink.push(diag("warn", "api.world.cast.start_unresolved", `start location "${member.startLocationName}" not found`));
    }
    const [row] = await tx
      .insert(worldCast)
      .values({
        worldId,
        characterId: member.characterId,
        role: member.role,
        tier: member.tier,
        startWorldLocationId,
        relationships: member.relationships,
      })
      .returning({ id: worldCast.id });
    if (row) castIdByCharacterId.set(member.characterId, row.id);
  }

  const createdItemIds: string[] = [];
  for (const item of input.items) {
    let itemId: string;
    if (item.itemId) {
      itemId = item.itemId;
    } else if (item.definition) {
      const def = item.definition;
      const [row] = await tx
        .insert(items)
        .values({
          ownerId,
          kind: def.kind,
          name: def.name,
          description: def.description,
          tags: def.tags,
          definition: {
            coverage: def.coverage,
            // category template anchors coverage semantics (docs/contracts.md) —
            // must be persisted so clothing reads as Top/Bra/Footwear/etc.
            category: def.category,
            subtype: def.subtype,
            layer: def.layer,
            opacity: def.opacity,
            sensory: def.sensory,
            fields: def.fields,
          },
        })
        .returning({ id: items.id });
      if (!row) continue;
      createdItemIds.push(row.id);
      itemId = row.id;
    } else {
      continue; // schema refine prevents this
    }

    const locationKey = item.locationName?.trim().toLowerCase();
    const worldLocationId = locationKey ? worldLocationIdByName.get(locationKey) : undefined;
    if (locationKey && !worldLocationId) {
      sink.push(diag("warn", "api.world.item.location_unresolved", `item location "${item.locationName}" not found`));
    }
    const castId = item.castCharacterId ? castIdByCharacterId.get(item.castCharacterId) : undefined;
    if (item.castCharacterId && !castId) {
      sink.push(diag("warn", "api.world.item.cast_unresolved", `item holder ${item.castCharacterId} is not in the cast`));
    }
    await tx.insert(worldItems).values({
      worldId,
      itemId,
      // exactly one placement; cast wins when both resolve
      worldLocationId: castId ? null : worldLocationId,
      castId,
      worn: item.worn && castId !== undefined,
      quantity: item.quantity,
    });
  }

  let sort = 0;
  for (const chunk of input.loreChunks) {
    await tx.insert(loreChunks).values({ worldId, ...chunk, sort: sort++ });
  }

  return { createdLocationIds, createdItemIds, worldLocationIdByName };
}

async function existingLocationNameMap(tx: Tx, worldId: string): Promise<Map<string, string>> {
  const rows = await tx
    .select({ id: worldLocations.id, overrides: worldLocations.overrides, name: locations.name })
    .from(worldLocations)
    .innerJoin(locations, eq(worldLocations.locationId, locations.id))
    .where(eq(worldLocations.worldId, worldId));
  const map = new Map<string, string>();
  for (const row of rows) {
    const overrides = parseOr(worldLocationOverridesSchema, row.overrides, {}, undefined, "world_locations.overrides");
    map.set((overrides.name ?? row.name).trim().toLowerCase(), row.id);
  }
  return map;
}

/**
 * Resolve and persist the player's start location (decision 47). Empty/unset
 * clears the column (spawn falls back to anchoring on the companion);
 * unresolvable names warn and leave the column unchanged.
 */
async function applyPlayerStart(
  tx: Tx,
  worldId: string,
  playerStartLocationName: string | undefined,
  worldLocationIdByName: Map<string, string>,
  sink: DiagnosticSink,
): Promise<void> {
  if (playerStartLocationName === undefined) return;
  const wanted = playerStartLocationName.trim().toLowerCase();
  if (!wanted) {
    await tx.update(worlds).set({ playerStartWorldLocationId: null }).where(eq(worlds.id, worldId));
    return;
  }
  const id = worldLocationIdByName.get(wanted);
  if (!id) {
    sink.push(diag("warn", "api.world.player_start_unresolved", `player start location "${playerStartLocationName}" not found`));
    return;
  }
  await tx.update(worlds).set({ playerStartWorldLocationId: id }).where(eq(worlds.id, worldId));
}

function afterWorldWrite(worldId: string, materialized: MaterializeResult, loreTouched: boolean): void {
  for (const id of materialized.createdLocationIds) queueEmbedRefresh("location", id);
  for (const id of materialized.createdItemIds) queueEmbedRefresh("item", id);
  if (loreTouched) {
    void indexLoreChunks(worldId).catch((err: unknown) => {
      log.warn("api.worlds", "lore indexing failed", { worldId, error: errorText(err) });
    });
  }
}

/**
 * Auto-generate every still-missing image for a freshly saved world
 * (followups.phase3.md §4): avatars for cast characters, product/scene images
 * for the world's items and locations — but only where the image is null, so
 * reused library entities keep the image they already have (user ruling). Runs
 * as one background job (parallel batches of 5), so it never blocks the save
 * and survives the author navigating away. Best-effort: failures are logged,
 * never surfaced to the save. Called from the world-create routes (real saves),
 * not from createWorld itself, so direct-call tests don't spawn image work.
 */
export function queueWorldImageGeneration(ownerId: string, worldId: string): void {
  void startJob({
    type: "entity_image",
    payload: { worldId, kind: "world_backfill" },
    run: async () => {
      const [locRows, itemRows, castRows] = await Promise.all([
        db().select({ id: worldLocations.locationId }).from(worldLocations).where(eq(worldLocations.worldId, worldId)),
        db().select({ id: worldItems.itemId }).from(worldItems).where(eq(worldItems.worldId, worldId)),
        db().select({ id: worldCast.characterId }).from(worldCast).where(eq(worldCast.worldId, worldId)),
      ]);
      const [locationIds, itemIds, characterIds] = await Promise.all([
        missingEntityImageIds("location", ownerId, { ids: locRows.map((r) => r.id) }),
        missingEntityImageIds("item", ownerId, { ids: itemRows.map((r) => r.id) }),
        missingAvatarCharacterIds(ownerId, castRows.map((r) => r.id)),
      ]);
      const [locationCount, itemCount, avatarCount] = await Promise.all([
        generateEntityImagesBatch("location", locationIds, ownerId),
        generateEntityImagesBatch("item", itemIds, ownerId),
        generateAvatarsBatch(characterIds, ownerId),
      ]);
      return { locations: locationCount, items: itemCount, avatars: avatarCount };
    },
  }).catch((err: unknown) => {
    log.warn("api.worlds", "world image generation failed to enqueue", { worldId, error: errorText(err) });
  });
}

/** Cast character ids that still lack an avatar — the auto-generation candidates. */
async function missingAvatarCharacterIds(ownerId: string, ids: readonly string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const rows = await db()
    .select({ id: characters.id })
    .from(characters)
    .where(and(eq(characters.ownerId, ownerId), isNull(characters.avatarImageId), inArray(characters.id, [...ids])));
  return rows.map((r) => r.id);
}

// ---------------------------------------------------------------------------
// Create / update / duplicate
// ---------------------------------------------------------------------------

export async function createWorld(ownerId: string, body: WorldCreateBody): Promise<WorldWriteResult> {
  const refs = await prefetchRefs(ownerId, body);
  if (!refs.ok) return { ok: false, code: "invalid_reference", message: refs.message };

  const sink = new DiagnosticCollector();
  const { worldId, materialized } = await db().transaction(async (tx) => {
    const [world] = await tx
      .insert(worlds)
      .values({
        ownerId,
        name: body.name,
        description: body.description,
        style: body.style,
        lore: body.lore,
        narrativeModel: body.narrativeModel,
      })
      .returning({ id: worlds.id });
    if (!world) throw new Error("worlds insert returned no row");
    const materialized = await materializeWorldEntities(tx, ownerId, world.id, body, refs.refs, sink);
    await applyPlayerStart(tx, world.id, body.playerStartLocationName, materialized.worldLocationIdByName, sink);
    return { worldId: world.id, materialized };
  });

  afterWorldWrite(worldId, materialized, body.loreChunks.length > 0);
  return { ok: true, worldId, diagnostics: sink.items };
}

export async function updateWorld(ownerId: string, worldId: string, body: WorldPatchBody): Promise<WorldWriteResult> {
  const [world] = await db()
    .select()
    .from(worlds)
    .where(and(eq(worlds.id, worldId), eq(worlds.ownerId, ownerId)))
    .limit(1);
  if (!world) return { ok: false, code: "not_found", message: "world not found" };

  const nested = { locations: body.locations ?? [], cast: body.cast ?? [], items: body.items ?? [], loreChunks: body.loreChunks ?? [] };
  const refs = await prefetchRefs(ownerId, nested);
  if (!refs.ok) return { ok: false, code: "invalid_reference", message: refs.message };

  const sink = new DiagnosticCollector();
  const materialized = await db().transaction(async (tx) => {
    const scalar: Partial<typeof worlds.$inferInsert> = {};
    if (body.name !== undefined) scalar.name = body.name;
    if (body.description !== undefined) scalar.description = body.description;
    if (body.narrativeModel !== undefined) scalar.narrativeModel = body.narrativeModel;
    if (body.style !== undefined) {
      scalar.style = { ...parseOr(worldStyleSchema, world.style, worldStyleSchema.parse({}), sink, "worlds.style"), ...body.style };
    }
    if (body.lore !== undefined) {
      scalar.lore = { ...parseOr(worldLoreSchema, world.lore, worldLoreSchema.parse({}), sink, "worlds.lore"), ...body.lore };
    }
    if (Object.keys(scalar).length > 0) await tx.update(worlds).set(scalar).where(eq(worlds.id, worldId));

    if (body.locations !== undefined) await tx.delete(worldLocations).where(eq(worldLocations.worldId, worldId));
    if (body.cast !== undefined) await tx.delete(worldCast).where(eq(worldCast.worldId, worldId));
    if (body.items !== undefined) await tx.delete(worldItems).where(eq(worldItems.worldId, worldId));
    if (body.loreChunks !== undefined) await tx.delete(loreChunks).where(eq(loreChunks.worldId, worldId));

    if (body.locations || body.cast || body.items || body.loreChunks) {
      // Families not sent in this PATCH keep their current rows; seed the name
      // maps from them so the sent families can still reference them.
      const seeds: MaterializeSeeds = {};
      if (body.locations === undefined) seeds.worldLocationIdByName = await existingLocationNameMap(tx, worldId);
      if (body.cast === undefined) {
        const existingCast = await tx
          .select({ id: worldCast.id, characterId: worldCast.characterId })
          .from(worldCast)
          .where(eq(worldCast.worldId, worldId));
        seeds.castIdByCharacterId = new Map(existingCast.map((c) => [c.characterId, c.id]));
      }
      const result = await materializeWorldEntities(tx, ownerId, worldId, nested, refs.refs, sink, seeds);
      await applyPlayerStart(tx, worldId, body.playerStartLocationName, result.worldLocationIdByName, sink);
      return result;
    }
    if (body.playerStartLocationName !== undefined) {
      await applyPlayerStart(tx, worldId, body.playerStartLocationName, await existingLocationNameMap(tx, worldId), sink);
    }
    return { createdLocationIds: [], createdItemIds: [], worldLocationIdByName: new Map<string, string>() };
  });

  afterWorldWrite(worldId, materialized, body.loreChunks !== undefined);
  return { ok: true, worldId, diagnostics: sink.items };
}

export type DuplicateWorldResult = { ok: true; worldId: string } | { ok: false; code: "not_found" };

/** Deep-copy a world (+locations/links/cast/items/lore); lineage via duplicated_from_world_id. */
export async function duplicateWorld(ownerId: string, worldId: string, name?: string): Promise<DuplicateWorldResult> {
  const [source] = await db()
    .select()
    .from(worlds)
    .where(and(eq(worlds.id, worldId), eq(worlds.ownerId, ownerId)))
    .limit(1);
  if (!source) return { ok: false, code: "not_found" };

  const newWorldId = await db().transaction(async (tx) => {
    const [copy] = await tx
      .insert(worlds)
      .values({
        ownerId,
        name: name?.trim() || `${source.name} (copy)`,
        description: source.description,
        style: source.style,
        lore: source.lore,
        narrativeModel: source.narrativeModel,
        imageId: source.imageId,
        duplicatedFromWorldId: source.id,
      })
      .returning({ id: worlds.id });
    if (!copy) throw new Error("worlds insert returned no row");

    const sourceLocations = await tx.select().from(worldLocations).where(eq(worldLocations.worldId, source.id));
    const locationIdMap = new Map<string, string>();
    for (const row of sourceLocations) {
      const [inserted] = await tx
        .insert(worldLocations)
        .values({ worldId: copy.id, locationId: row.locationId, overrides: row.overrides, sort: row.sort })
        .returning({ id: worldLocations.id });
      if (inserted) locationIdMap.set(row.id, inserted.id);
    }

    const sourceLinks = await tx.select().from(worldLinks).where(eq(worldLinks.worldId, source.id));
    for (const link of sourceLinks) {
      const fromId = locationIdMap.get(link.fromWorldLocationId);
      const toId = locationIdMap.get(link.toWorldLocationId);
      if (!fromId || !toId) continue;
      await tx.insert(worldLinks).values({ worldId: copy.id, fromWorldLocationId: fromId, toWorldLocationId: toId, label: link.label });
    }

    const sourceCast = await tx.select().from(worldCast).where(eq(worldCast.worldId, source.id));
    const castIdMap = new Map<string, string>();
    for (const member of sourceCast) {
      const [inserted] = await tx
        .insert(worldCast)
        .values({
          worldId: copy.id,
          characterId: member.characterId,
          role: member.role,
          tier: member.tier,
          relationships: member.relationships,
          startWorldLocationId: member.startWorldLocationId ? (locationIdMap.get(member.startWorldLocationId) ?? null) : null,
        })
        .returning({ id: worldCast.id });
      if (inserted) castIdMap.set(member.id, inserted.id);
    }

    const sourceItems = await tx.select().from(worldItems).where(eq(worldItems.worldId, source.id));
    const itemIdMap = new Map<string, string>();
    for (const item of sourceItems) {
      const [inserted] = await tx
        .insert(worldItems)
        .values({
          worldId: copy.id,
          itemId: item.itemId,
          worldLocationId: item.worldLocationId ? (locationIdMap.get(item.worldLocationId) ?? null) : null,
          castId: item.castId ? (castIdMap.get(item.castId) ?? null) : null,
          worn: item.worn,
          quantity: item.quantity,
        })
        .returning({ id: worldItems.id });
      if (inserted) itemIdMap.set(item.id, inserted.id);
    }
    // containers in a second pass: the full old→new map exists only now
    for (const item of sourceItems) {
      if (!item.containerWorldItemId) continue;
      const newId = itemIdMap.get(item.id);
      const newContainerId = itemIdMap.get(item.containerWorldItemId);
      if (!newId || !newContainerId) continue;
      await tx.update(worldItems).set({ containerWorldItemId: newContainerId }).where(eq(worldItems.id, newId));
    }

    const sourceChunks = await tx.select().from(loreChunks).where(eq(loreChunks.worldId, source.id));
    for (const chunk of sourceChunks) {
      await tx.insert(loreChunks).values({
        worldId: copy.id,
        title: chunk.title,
        body: chunk.body,
        category: chunk.category,
        tier: chunk.tier,
        visibility: chunk.visibility,
        unlockTags: chunk.unlockTags,
        locationTags: chunk.locationTags,
        characterIds: chunk.characterIds,
        sort: chunk.sort,
        manuallyUnlocked: chunk.manuallyUnlocked,
        embedding: chunk.embedding,
        embedder: chunk.embedder,
      });
    }

    return copy.id;
  });

  return { ok: true, worldId: newWorldId };
}

// ---------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------

export interface WorldDetail {
  world: typeof worlds.$inferSelect;
  locations: Array<{
    id: string;
    locationId: string;
    name: string;
    description: string;
    ambient: unknown;
    scale: "intimate" | "room" | "hall" | "open" | "expanse";
    tags: unknown;
    overrides: z.infer<typeof worldLocationOverridesSchema>;
  }>;
  links: Array<{ id: string; fromWorldLocationId: string; toWorldLocationId: string; label: string | null; travelMinutes: number }>;
  cast: Array<{
    id: string;
    characterId: string;
    role: "companion" | "npc";
    tier: "major" | "minor" | "extra";
    startWorldLocationId: string | null;
    relationships: AuthoredRelationship[];
    name: string;
    avatarImageId: string | null;
  }>;
  items: Array<{
    id: string;
    itemId: string;
    name: string;
    kind: "clothing" | "object" | "container";
    worldLocationId: string | null;
    castId: string | null;
    worn: boolean;
    containerWorldItemId: string | null;
    quantity: number;
  }>;
  loreChunks: Array<Omit<typeof loreChunks.$inferSelect, "embedding" | "embedder">>;
}

export async function getWorldDetail(ownerId: string, worldId: string): Promise<WorldDetail | null> {
  const [world] = await db()
    .select()
    .from(worlds)
    .where(and(eq(worlds.id, worldId), eq(worlds.ownerId, ownerId)))
    .limit(1);
  if (!world) return null;

  const [locationRows, linkRows, castRows, itemRows, chunkRows] = await Promise.all([
    db()
      .select({
        id: worldLocations.id,
        locationId: worldLocations.locationId,
        overrides: worldLocations.overrides,
        name: locations.name,
        description: locations.description,
        ambient: locations.ambient,
        scale: locations.scale,
        tags: locations.tags,
      })
      .from(worldLocations)
      .innerJoin(locations, eq(worldLocations.locationId, locations.id))
      .where(eq(worldLocations.worldId, worldId))
      // authored map order; id tiebreak keeps pre-sort rows (all 0) stable
      .orderBy(asc(worldLocations.sort), asc(worldLocations.id)),
    db().select().from(worldLinks).where(eq(worldLinks.worldId, worldId)),
    db()
      .select({
        id: worldCast.id,
        characterId: worldCast.characterId,
        role: worldCast.role,
        tier: worldCast.tier,
        startWorldLocationId: worldCast.startWorldLocationId,
        relationships: worldCast.relationships,
        name: characters.name,
        avatarImageId: characters.avatarImageId,
      })
      .from(worldCast)
      .innerJoin(characters, eq(worldCast.characterId, characters.id))
      .where(eq(worldCast.worldId, worldId)),
    db()
      .select({
        id: worldItems.id,
        itemId: worldItems.itemId,
        name: items.name,
        kind: items.kind,
        worldLocationId: worldItems.worldLocationId,
        castId: worldItems.castId,
        worn: worldItems.worn,
        containerWorldItemId: worldItems.containerWorldItemId,
        quantity: worldItems.quantity,
      })
      .from(worldItems)
      .innerJoin(items, eq(worldItems.itemId, items.id))
      .where(eq(worldItems.worldId, worldId)),
    db()
      .select({
        id: loreChunks.id,
        worldId: loreChunks.worldId,
        title: loreChunks.title,
        body: loreChunks.body,
        category: loreChunks.category,
        tier: loreChunks.tier,
        visibility: loreChunks.visibility,
        unlockTags: loreChunks.unlockTags,
        locationTags: loreChunks.locationTags,
        characterIds: loreChunks.characterIds,
        sort: loreChunks.sort,
        manuallyUnlocked: loreChunks.manuallyUnlocked,
        createdAt: loreChunks.createdAt,
      })
      .from(loreChunks)
      .where(eq(loreChunks.worldId, worldId))
      .orderBy(asc(loreChunks.sort)),
  ]);

  return {
    world,
    locations: locationRows.map((row) => {
      const overrides = parseOr(worldLocationOverridesSchema, row.overrides, {}, undefined, "world_locations.overrides");
      return {
        id: row.id,
        locationId: row.locationId,
        name: overrides.name ?? row.name,
        description: overrides.description ?? row.description,
        ambient: overrides.ambient ?? row.ambient,
        scale: overrides.scale ?? row.scale,
        tags: overrides.tags ?? row.tags,
        overrides,
      };
    }),
    links: linkRows.map((l) => ({
      id: l.id,
      fromWorldLocationId: l.fromWorldLocationId,
      toWorldLocationId: l.toWorldLocationId,
      label: l.label,
      travelMinutes: l.travelMinutes,
    })),
    cast: castRows.map((row) => ({
      ...row,
      relationships: parseOr(authoredRelationshipListSchema, row.relationships, [], undefined, "world_cast.relationships"),
    })),
    items: itemRows,
    loreChunks: chunkRows,
  };
}
