import { eq } from "drizzle-orm";
import {
  characterProfileSchema,
  emptyCharacterProfile,
  emptyItemDefinition,
  itemDefinitionSchema,
  locationSnapshotSchema,
  type AuthoredRelationship,
  type LocationSnapshot,
} from "@/contracts";
import { parseOr } from "@/lib/parse";
import { characters, db, items, locations, worldCast, worldItems, worldLocations } from "@/server/db";

/**
 * Test-only fixture helpers for the integration suites (not imported by app code).
 *
 * Worlds hold a self-contained snapshot copy of each library entity
 * (world-instances.plan.md). Hand-writing those snapshots inline made every int
 * test fixture couple to the world-row shape — so a storage change meant editing
 * a dozen `.insert(worldCast).values({ snapshot: {...} })` literals. These helpers
 * re-fetch the library row and bake the snapshot in **one place**: a future
 * snapshot-shape change touches only this file, and tests just say
 * `addWorldCast(worldId, characterId, { role })`.
 */

/** Insert a world location copied from a library location. Returns the world_locations id. */
export async function addWorldLocation(
  worldId: string,
  locationId: string,
  opts: { sort?: number; snapshot?: Partial<LocationSnapshot> } = {},
): Promise<string> {
  const [loc] = await db().select().from(locations).where(eq(locations.id, locationId)).limit(1);
  if (!loc) throw new Error(`world-fixture: library location ${locationId} not found`);
  const snapshot = locationSnapshotSchema.parse({
    name: loc.name,
    description: loc.description,
    ambient: loc.ambient,
    scale: loc.scale,
    area: loc.area,
    affordances: loc.affordances,
    tags: loc.tags,
    ...opts.snapshot,
  });
  const [row] = await db()
    .insert(worldLocations)
    .values({ worldId, sourceLocationId: loc.id, snapshot, sort: opts.sort ?? 0 })
    .returning({ id: worldLocations.id });
  if (!row) throw new Error("world-fixture: worldLocation insert returned no row");
  return row.id;
}

/** Insert a world cast member copied from a library character. Returns the world_cast id. */
export async function addWorldCast(
  worldId: string,
  characterId: string,
  opts: {
    role?: "companion" | "npc";
    tier?: "major" | "minor" | "extra";
    startWorldLocationId?: string | null;
    relationships?: AuthoredRelationship[];
  } = {},
): Promise<string> {
  const [char] = await db().select().from(characters).where(eq(characters.id, characterId)).limit(1);
  if (!char) throw new Error(`world-fixture: library character ${characterId} not found`);
  const [row] = await db()
    .insert(worldCast)
    .values({
      worldId,
      sourceCharacterId: char.id,
      name: char.name,
      snapshot: parseOr(characterProfileSchema, char.profile, emptyCharacterProfile(), undefined, "characters.profile"),
      avatarImageId: char.avatarImageId,
      role: opts.role ?? "npc",
      tier: opts.tier ?? "minor",
      startWorldLocationId: opts.startWorldLocationId ?? null,
      relationships: opts.relationships ?? [],
    })
    .returning({ id: worldCast.id });
  if (!row) throw new Error("world-fixture: worldCast insert returned no row");
  return row.id;
}

/** Insert a world item placement copied from a library item. Returns the world_items id. */
export async function addWorldItem(
  worldId: string,
  itemId: string,
  opts: {
    worldLocationId?: string | null;
    castId?: string | null;
    worn?: boolean;
    quantity?: number;
    containerWorldItemId?: string | null;
  } = {},
): Promise<string> {
  const [item] = await db().select().from(items).where(eq(items.id, itemId)).limit(1);
  if (!item) throw new Error(`world-fixture: library item ${itemId} not found`);
  const extras = typeof item.definition === "object" && item.definition !== null ? item.definition : {};
  const snapshot = parseOr(
    itemDefinitionSchema,
    { ...extras, kind: item.kind, name: item.name, description: item.description, tags: item.tags },
    { ...emptyItemDefinition(), kind: item.kind, name: item.name },
    undefined,
    "items.definition",
  );
  const [row] = await db()
    .insert(worldItems)
    .values({
      worldId,
      sourceItemId: item.id,
      name: snapshot.name,
      snapshot,
      worldLocationId: opts.worldLocationId ?? null,
      castId: opts.castId ?? null,
      worn: opts.worn ?? false,
      quantity: opts.quantity ?? 1,
      containerWorldItemId: opts.containerWorldItemId ?? null,
    })
    .returning({ id: worldItems.id });
  if (!row) throw new Error("world-fixture: worldItem insert returned no row");
  return row.id;
}
