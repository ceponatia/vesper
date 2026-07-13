import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { diag, type DiagnosticSink } from "@/contracts/diagnostics";
import { emptyItemDefinition, itemDefinitionSchema, type ItemDefinition } from "@/contracts/items/item";
import { authoredRelationshipListSchema, type AuthoredRelationship } from "@/contracts/relationships/authored";
import { emptyLocationSnapshot, locationSnapshotSchema, type LocationSnapshot } from "@/contracts/world/location";
import { initialMeters } from "@/contracts/meters/registry";
import { emptyBrief } from "@/contracts/state/brief";
import { participantStateSchema, type ParticipantState } from "@/contracts/state/participant-state";
import { emptySceneGenState, sceneGenStateSchema } from "@/contracts/state/scene-gen";
import { sessionRuntimeSchema, storyThreadSchema, type SessionRuntime, type StoryThread } from "@/contracts/state/session-runtime";
import {
  characterProfileSchema,
  emptyCharacterProfile,
  emptyWorldLore,
  emptyWorldStyle,
  outfitItems as defaultOutfitIds,
  worldLoreSchema,
  worldStyleSchema,
  type CharacterProfile,
  type WorldLore,
  type WorldStyle,
} from "@/contracts/world/profile";
import { countSpawnMajors, MAJOR_TIER_SOFT_CAP, spawnTier } from "@/lib/cast-tiers";
import { newId } from "@/lib/ids";
import { parseOr } from "@/lib/parse";
import {
  characters,
  db,
  episodes,
  facts,
  images,
  itemInstances,
  items,
  jobs,
  participantRelationships,
  sessionLinks,
  sessionLocations,
  sessionParticipants,
  sessions,
  turns,
  worldCast,
  worldItems,
  worldLinks,
  worldLocations,
  worlds,
  type Db,
} from "../db";
import { indexLoreChunks } from "../memory";
import { seedRelationshipRows, type RelationshipSeedMember } from "./relationship-seeds";
import { effectiveMeterDefinitions } from "./scene";

/**
 * Session materialization (docs/turn-engine.md §Other paths): a session is a
 * full instantiation of its world — locations, links, cast snapshots, item
 * instances — so play never reads world/library rows again.
 */


export interface CreateSessionInput {
  worldId: string;
  userId: string;
  title?: string;
  embodied?: boolean;
  playerCharacterId?: string | null;
  sink?: DiagnosticSink;
}

export interface CreateSessionResult {
  sessionId: string;
}

/** Fresh participant state with the world's meter overrides applied. */
export function spawnParticipantState(style: WorldStyle): ParticipantState {
  return participantStateSchema.parse({ meters: initialMeters(effectiveMeterDefinitions(style)) });
}

/** Story threads seeded from world plot anchors: active → open, background → cooling (dormant until touched). */
export function threadsFromAnchors(lore: WorldLore): StoryThread[] {
  return lore.plotAnchors.map((anchor) =>
    storyThreadSchema.parse({
      id: anchor.id,
      title: anchor.title,
      summary: anchor.summary,
      status: anchor.priority === "active" ? "open" : "cooling",
      source: "anchor",
    }),
  );
}

interface WorldMaterial {
  world: typeof worlds.$inferSelect;
  style: WorldStyle;
  lore: WorldLore;
  worldLocs: Array<{
    id: string;
    sourceLocationId: string | null;
    snapshot: LocationSnapshot;
  }>;
  links: Array<typeof worldLinks.$inferSelect>;
  cast: Array<{
    id: string;
    role: "companion" | "npc";
    tier: "major" | "minor" | "extra";
    startWorldLocationId: string | null;
    relationships: AuthoredRelationship[];
    sourceCharacterId: string | null;
    characterName: string;
    avatarImageId: string | null;
    profile: CharacterProfile;
  }>;
  worldItemRows: Array<{
    id: string;
    sourceItemId: string | null;
    worldLocationId: string | null;
    castId: string | null;
    worn: boolean;
    containerWorldItemId: string | null;
    quantity: number;
    definition: ItemDefinition;
  }>;
  /** Library items referenced by cast and player defaultOutfit lists, by id. */
  outfitItems: Map<string, ItemDefinition>;
}

function parseItemDefinition(
  row: { kind: "clothing" | "object" | "container"; name: string; description: string; definition: unknown },
  sink?: DiagnosticSink,
): ItemDefinition {
  const extras = typeof row.definition === "object" && row.definition !== null ? row.definition : {};
  return parseOr(
    itemDefinitionSchema,
    { ...extras, kind: row.kind, name: row.name, description: row.description },
    { ...emptyItemDefinition(), kind: row.kind, name: row.name, description: row.description },
    sink,
    "items.definition",
  );
}

async function loadWorldMaterial(
  worldId: string,
  playerOutfitIds: readonly string[],
  sink?: DiagnosticSink,
): Promise<WorldMaterial | null> {
  const [world] = await db().select().from(worlds).where(eq(worlds.id, worldId)).limit(1);
  if (!world) return null;

  // World rows carry self-contained snapshots (world-instances.plan.md) — spawn
  // reads them directly, never joining the library, so a deleted library row
  // never breaks a session.
  const [locRows, linkRows, castRows, itemRows] = await Promise.all([
    db()
      .select({
        id: worldLocations.id,
        sourceLocationId: worldLocations.sourceLocationId,
        snapshot: worldLocations.snapshot,
      })
      .from(worldLocations)
      .where(eq(worldLocations.worldId, worldId))
      // sessions mirror the authored map order (world_locations.sort)
      .orderBy(asc(worldLocations.sort), asc(worldLocations.id)),
    db().select().from(worldLinks).where(eq(worldLinks.worldId, worldId)),
    db()
      .select({
        id: worldCast.id,
        role: worldCast.role,
        tier: worldCast.tier,
        startWorldLocationId: worldCast.startWorldLocationId,
        relationships: worldCast.relationships,
        sourceCharacterId: worldCast.sourceCharacterId,
        characterName: worldCast.name,
        avatarImageId: worldCast.avatarImageId,
        profile: worldCast.snapshot,
      })
      .from(worldCast)
      .where(eq(worldCast.worldId, worldId)),
    db()
      .select({
        id: worldItems.id,
        sourceItemId: worldItems.sourceItemId,
        worldLocationId: worldItems.worldLocationId,
        castId: worldItems.castId,
        worn: worldItems.worn,
        containerWorldItemId: worldItems.containerWorldItemId,
        quantity: worldItems.quantity,
        snapshot: worldItems.snapshot,
      })
      .from(worldItems)
      .where(eq(worldItems.worldId, worldId)),
  ]);

  const worldLocs = locRows.map((row) => ({
    id: row.id,
    sourceLocationId: row.sourceLocationId,
    snapshot: parseOr(locationSnapshotSchema, row.snapshot, emptyLocationSnapshot(), sink, "world_locations.snapshot"),
  }));

  const cast = castRows.map((row) => ({
    ...row,
    relationships: parseOr(authoredRelationshipListSchema, row.relationships, [], sink, "world_cast.relationships"),
    profile: parseOr(characterProfileSchema, row.profile, emptyCharacterProfile(), sink, "world_cast.snapshot"),
  }));

  // Player default-outfit items are still resolved from the library at spawn (the
  // player picks a currently-owned character); cast outfits come from each cast
  // snapshot's default preset (outfits[0]), also resolved against the library here.
  const outfitIds = [...new Set([...cast.flatMap((c) => defaultOutfitIds(c.profile)), ...playerOutfitIds])];
  const outfitItems = new Map<string, ItemDefinition>();
  if (outfitIds.length > 0) {
    const rows = await db().select().from(items).where(inArray(items.id, outfitIds));
    for (const row of rows) outfitItems.set(row.id, parseItemDefinition(row, sink));
  }

  return {
    world,
    style: parseOr(worldStyleSchema, world.style, emptyWorldStyle(), sink, "worlds.style"),
    lore: parseOr(worldLoreSchema, world.lore, emptyWorldLore(), sink, "worlds.lore"),
    worldLocs,
    links: linkRows,
    cast,
    worldItemRows: itemRows.map((row) => ({
      id: row.id,
      sourceItemId: row.sourceItemId,
      worldLocationId: row.worldLocationId,
      castId: row.castId,
      worn: row.worn,
      containerWorldItemId: row.containerWorldItemId,
      quantity: row.quantity,
      definition: parseOr(itemDefinitionSchema, row.snapshot, emptyItemDefinition(), sink, "world_items.snapshot"),
    })),
    outfitItems,
  };
}

interface PlayerSeed {
  characterId: string | null;
  displayName: string;
  profile: CharacterProfile;
  avatarImageId: string | null;
}

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** Insert all session children. Pure data assembly + inserts; reads happen in loadWorldMaterial. */
async function materializeSession(
  tx: Tx,
  args: { sessionId: string; material: WorldMaterial; embodied: boolean; player: PlayerSeed | null; sink?: DiagnosticSink },
): Promise<void> {
  const { sessionId, material, sink } = args;

  // Locations: copy the world's snapshot into the session (world-instances.plan.md).
  const sessionLocByWorldLoc = new Map<string, string>();
  const locationValues = material.worldLocs.map((wl) => {
    const id = newId();
    sessionLocByWorldLoc.set(wl.id, id);
    return {
      id,
      sessionId,
      locationId: wl.sourceLocationId,
      name: wl.snapshot.name,
      description: wl.snapshot.description,
      ambient: wl.snapshot.ambient,
      scale: wl.snapshot.scale,
      area: wl.snapshot.area,
      affordances: wl.snapshot.affordances,
      emergent: false,
    };
  });
  if (locationValues.length > 0) await tx.insert(sessionLocations).values(locationValues);
  const firstLocationId = locationValues[0]?.id ?? null;

  // Item instance ids are pre-generated before links so a link's door item
  // (library item id on the world link) can resolve to its session instance.
  const instanceByWorldItem = new Map<string, string>();
  for (const wi of material.worldItemRows) instanceByWorldItem.set(wi.id, newId());
  const firstInstanceByLibraryItem = new Map<string, string>();
  for (const wi of material.worldItemRows) {
    if (wi.sourceItemId && !firstInstanceByLibraryItem.has(wi.sourceItemId)) {
      const instanceId = instanceByWorldItem.get(wi.id);
      if (instanceId) firstInstanceByLibraryItem.set(wi.sourceItemId, instanceId);
    }
  }

  // Links.
  const linkValues = material.links.flatMap((link) => {
    const fromId = sessionLocByWorldLoc.get(link.fromWorldLocationId);
    const toId = sessionLocByWorldLoc.get(link.toWorldLocationId);
    if (!fromId || !toId) {
      sink?.push(diag("warn", "spawn.link.unmapped", "world link references an unmaterialized location", { context: { linkId: link.id } }));
      return [];
    }
    const doorItemId = link.doorItemId ? (firstInstanceByLibraryItem.get(link.doorItemId) ?? null) : null;
    if (link.doorItemId && !doorItemId) {
      sink?.push(diag("info", "spawn.link.door_unplaced", "link door item has no placed instance in this world", { context: { linkId: link.id } }));
    }
    return [{
      sessionId,
      fromId,
      toId,
      label: link.label,
      travelMinutes: link.travelMinutes,
      audibility: link.audibility,
      access: link.access,
      doorItemId,
    }];
  });
  if (linkValues.length > 0) await tx.insert(sessionLinks).values(linkValues);

  // Participants: cast first, then the embodied player. A player character
  // that is itself in the cast is promoted in place — its cast row becomes the
  // player participant (keeping the world_cast linkage so placed items and
  // outfit dedup resolve to it) instead of spawning a duplicate NPC.
  const usedNames = new Set<string>();
  const uniqueName = (wanted: string): string => {
    let name = wanted.trim() || "Unnamed";
    let n = 2;
    while (usedNames.has(name.toLowerCase())) name = `${wanted} ${n++}`;
    usedNames.add(name.toLowerCase());
    return name;
  };

  const authoredStart = material.world.playerStartWorldLocationId
    ? (sessionLocByWorldLoc.get(material.world.playerStartWorldLocationId) ?? null)
    : null;
  const playerCharacterId = args.embodied ? (args.player?.characterId ?? null) : null;
  const playerCastId = playerCharacterId
    ? (material.cast.find((member) => member.sourceCharacterId === playerCharacterId)?.id ?? null)
    : null;

  let playerParticipantId: string | null = null;
  const participantByCast = new Map<string, string>();
  const participantValues: Array<typeof sessionParticipants.$inferInsert> = material.cast.map((member) => {
    const id = newId();
    participantByCast.set(member.id, id);
    const isPlayer = member.id === playerCastId;
    if (isPlayer) playerParticipantId = id;
    const castStart = member.startWorldLocationId ? (sessionLocByWorldLoc.get(member.startWorldLocationId) ?? null) : null;
    return {
      id,
      sessionId,
      characterId: member.sourceCharacterId,
      isUser: isPlayer,
      displayName: uniqueName(member.characterName),
      role: isPlayer ? ("player" as const) : member.role,
      // Companions default to major unless explicitly tiered down (lib/cast-tiers.ts).
      tier: isPlayer ? ("major" as const) : spawnTier(member.role, member.tier),
      snapshot: member.profile,
      state: spawnParticipantState(material.style),
      // A promoted player's authored cast placement beats the world's generic
      // player start: the specific placement is the stronger signal.
      locationId: castStart ?? (isPlayer ? authoredStart : null) ?? firstLocationId,
      avatarImageId: member.avatarImageId,
    };
  });

  if (args.embodied && args.player && !playerParticipantId) {
    playerParticipantId = newId();
    // The player starts at the world's authored start location when set;
    // otherwise where the story is: with the companion if one exists,
    // otherwise wherever the first cast member starts, otherwise the first room.
    const anchor =
      participantValues.find((p) => p.role === "companion") ?? participantValues.find((p) => !p.isUser);
    participantValues.push({
      id: playerParticipantId,
      sessionId,
      characterId: args.player.characterId,
      isUser: true,
      displayName: uniqueName(args.player.displayName),
      role: "player" as const,
      tier: "major" as const,
      snapshot: args.player.profile,
      state: spawnParticipantState(material.style),
      locationId: authoredStart ?? anchor?.locationId ?? firstLocationId,
      avatarImageId: args.player.avatarImageId,
    });
  }
  if (participantValues.length > 0) await tx.insert(sessionParticipants).values(participantValues);

  // Major-tier soft cap (decision 46): warn, never block or trim. The player
  // (always major) is excluded so this fires on the same authored-cast count
  // as the world editor's notice.
  const majorCount = countSpawnMajors(material.cast);
  if (majorCount > MAJOR_TIER_SOFT_CAP) {
    sink?.push(
      diag(
        "warn",
        "spawn.cast.major_soft_cap",
        `${majorCount} major-tier cast members exceed the soft cap of ${MAJOR_TIER_SOFT_CAP}; each major costs prompt space and memory every turn`,
        { context: { majorCount, cap: MAJOR_TIER_SOFT_CAP } },
      ),
    );
  }

  // Authored relationships → directional participant_relationships rows at the
  // stage midpoint (relationship-seeds.ts has the rules: sparse strangers,
  // implied reverse edges, classifier-driven player `perceived` rows).
  const participantValueById = new Map(participantValues.map((p) => [p.id, p]));
  const seedMembers: RelationshipSeedMember[] = [];
  for (const member of material.cast) {
    const participantId = participantByCast.get(member.id);
    const value = participantId ? participantValueById.get(participantId) : undefined;
    if (!participantId || !value) continue;
    seedMembers.push({
      participantId,
      displayName: value.displayName,
      relationships: member.relationships,
      bondText: member.profile.bio,
    });
  }
  const relationshipRows = seedRelationshipRows(seedMembers, playerParticipantId, sink);
  if (relationshipRows.length > 0) {
    await tx.insert(participantRelationships).values(relationshipRows.map((row) => ({ ...row, sessionId })));
  }

  // Item instances: world placements (ids pre-generated above, before links,
  // so containers and link door items can reference the same batch), then
  // default outfits.
  const itemValues: Array<typeof itemInstances.$inferInsert> = [];
  for (const wi of material.worldItemRows) {
    const quantity = Math.max(1, wi.quantity);
    for (let q = 0; q < quantity; q++) {
      const id = q === 0 ? instanceByWorldItem.get(wi.id) : newId();
      const containerInstanceId = wi.containerWorldItemId ? (instanceByWorldItem.get(wi.containerWorldItemId) ?? null) : null;
      const holderParticipantId = !containerInstanceId && wi.castId ? (participantByCast.get(wi.castId) ?? null) : null;
      let locationId = !containerInstanceId && !holderParticipantId && wi.worldLocationId
        ? (sessionLocByWorldLoc.get(wi.worldLocationId) ?? null)
        : null;
      if (!containerInstanceId && !holderParticipantId && !locationId) {
        sink?.push(
          diag("warn", "spawn.item.unplaced", `world item "${wi.definition.name}" had no resolvable placement; placed in the first location`, {
            context: { worldItemId: wi.id },
          }),
        );
        locationId = firstLocationId;
        if (!locationId) continue; // no locations at all — cannot satisfy the CHECK constraint
      }
      itemValues.push({
        id,
        sessionId,
        itemId: wi.sourceItemId,
        name: wi.definition.name,
        snapshot: wi.definition,
        holderParticipantId,
        worn: holderParticipantId !== null && wi.worn,
        locationId,
        containerInstanceId,
        state: {},
      });
    }
  }

  // Default outfits: every cast member (and the embodied player's character)
  // spawns wearing their profile.defaultOutfit, unless the world already
  // placed that exact item worn on them. A promoted player is already in the
  // cast list (with its castId, so the worn-dedup applies) — no extra entry.
  const wearers: Array<{ participantId: string; profile: CharacterProfile; castId: string | null }> = material.cast.map((member) => ({
    participantId: participantByCast.get(member.id) ?? "",
    profile: member.profile,
    castId: member.id,
  }));
  if (playerParticipantId && args.player && !playerCastId) {
    wearers.push({ participantId: playerParticipantId, profile: args.player.profile, castId: null });
  }
  for (const wearer of wearers) {
    if (!wearer.participantId) continue;
    for (const itemId of defaultOutfitIds(wearer.profile)) {
      const definition = material.outfitItems.get(itemId);
      if (!definition) {
        sink?.push(diag("warn", "spawn.outfit.missing", `default outfit item ${itemId} not found in the library`, { context: { itemId } }));
        continue;
      }
      const alreadyWorn =
        wearer.castId !== null &&
        material.worldItemRows.some((wi) => wi.castId === wearer.castId && wi.sourceItemId === itemId && wi.worn);
      if (alreadyWorn) continue;
      itemValues.push({
        id: newId(),
        sessionId,
        itemId,
        name: definition.name,
        snapshot: definition,
        holderParticipantId: wearer.participantId,
        worn: true,
        locationId: null,
        containerInstanceId: null,
        state: {},
      });
    }
  }
  if (itemValues.length > 0) await tx.insert(itemInstances).values(itemValues);
}

function spawnRuntime(lore: WorldLore): SessionRuntime {
  return sessionRuntimeSchema.parse({ storyThreads: threadsFromAnchors(lore) });
}

export async function createSessionFromWorld(input: CreateSessionInput): Promise<CreateSessionResult | null> {
  const embodied = input.embodied ?? true;
  // Player first: the material load needs the player's defaultOutfit ids so a
  // non-cast player character still spawns wearing their outfit.
  const player = embodied ? await loadPlayerSeed(input.userId, input.playerCharacterId ?? null, input.sink) : null;
  const material = await loadWorldMaterial(input.worldId, player ? defaultOutfitIds(player.profile) : [], input.sink);
  if (!material || material.world.ownerId !== input.userId) return null;
  // A world may be authored with zero locations (UX-audit §1b: import-your-own), but a
  // session needs somewhere to stand — refuse until at least one location exists.
  if (material.worldLocs.length === 0) {
    input.sink?.push(diag("warn", "spawn.no_locations", "this world has no locations yet — add at least one before starting a session"));
    return null;
  }

  const sessionId = newId();
  await db().transaction(async (tx) => {
    await tx.insert(sessions).values({
      id: sessionId,
      ownerId: input.userId,
      worldId: input.worldId,
      title: input.title?.trim() || material.world.name,
      embodied,
      status: "ready",
      clockMinutes: 0,
      runtime: spawnRuntime(material.lore),
      brief: emptyBrief(),
      scene: emptySceneGenState(),
    });
    await materializeSession(tx, { sessionId, material, embodied, player, sink: input.sink });
  });

  await indexLoreChunks(input.worldId, input.sink);
  return { sessionId };
}

async function loadPlayerSeed(
  userId: string,
  playerCharacterId: string | null,
  sink?: DiagnosticSink,
): Promise<PlayerSeed> {
  if (playerCharacterId) {
    const [row] = await db()
      .select()
      .from(characters)
      .where(and(eq(characters.id, playerCharacterId), eq(characters.ownerId, userId)))
      .limit(1);
    if (row) {
      return {
        characterId: row.id,
        displayName: row.name,
        profile: parseOr(characterProfileSchema, row.profile, emptyCharacterProfile(), sink, "characters.profile"),
        avatarImageId: row.avatarImageId,
      };
    }
    sink?.push(diag("warn", "spawn.player.character_missing", "player character not found; using a default player identity"));
  }
  // No chosen character ⇒ a neutral in-world identity, never the account name (UX-audit P1).
  return { characterId: null, displayName: "You", profile: emptyCharacterProfile(), avatarImageId: null };
}

/**
 * Restart (docs/turn-engine.md): wipe the session's instance data and
 * re-materialize from the world — identical to a fresh spawn, same session
 * id. Scene gallery images are kept, flagged `meta.preRestart`.
 */
export async function restartSession(sessionId: string, sink?: DiagnosticSink): Promise<boolean> {
  const [session] = await db().select().from(sessions).where(eq(sessions.id, sessionId)).limit(1);
  if (!session) return false;

  // Preserve the original player identity (snapshot is re-taken from the
  // library). Loaded before the material so the player's defaultOutfit ids
  // are part of the outfit-item lookup.
  const [playerRow] = await db()
    .select({ characterId: sessionParticipants.characterId })
    .from(sessionParticipants)
    .where(and(eq(sessionParticipants.sessionId, sessionId), eq(sessionParticipants.isUser, true)))
    .limit(1);
  const player = session.embodied ? await loadPlayerSeed(session.ownerId, playerRow?.characterId ?? null, sink) : null;
  const material = await loadWorldMaterial(session.worldId, player ? defaultOutfitIds(player.profile) : [], sink);
  if (!material) return false;

  // Keep the user's scene-generation settings; clear progress/status.
  const prevScene = parseOr(sceneGenStateSchema, session.scene, emptySceneGenState(), sink, "sessions.scene");
  const resetScene = { ...emptySceneGenState(), interval: prevScene.interval };

  await db().transaction(async (tx) => {
    await tx.delete(turns).where(eq(turns.sessionId, sessionId));
    await tx.delete(episodes).where(eq(episodes.sessionId, sessionId));
    await tx.delete(facts).where(eq(facts.sessionId, sessionId));
    await tx.delete(jobs).where(eq(jobs.sessionId, sessionId));
    await tx.delete(itemInstances).where(eq(itemInstances.sessionId, sessionId));
    await tx.delete(sessionParticipants).where(eq(sessionParticipants.sessionId, sessionId));
    await tx.delete(sessionLocations).where(eq(sessionLocations.sessionId, sessionId)); // cascades session_links
    await tx
      .update(images)
      .set({ meta: sql`${images.meta} || '{"preRestart": true}'::jsonb` })
      .where(and(eq(images.sessionId, sessionId), eq(images.kind, "scene")));
    await tx
      .update(sessions)
      .set({
        status: "ready",
        clockMinutes: 0,
        runtime: spawnRuntime(material.lore),
        brief: emptyBrief(),
        scene: resetScene,
      })
      .where(eq(sessions.id, sessionId));
    await materializeSession(tx, { sessionId, material, embodied: session.embodied, player, sink });
  });

  await indexLoreChunks(session.worldId, sink);
  return true;
}
