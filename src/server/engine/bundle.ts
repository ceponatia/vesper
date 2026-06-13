import { asc, eq } from "drizzle-orm";
import { z } from "zod";
import type { DiagnosticSink } from "@/contracts/diagnostics";
import {
  emptyItemDefinition,
  emptyItemInstanceState,
  itemDefinitionSchema,
  itemInstanceStateSchema,
} from "@/contracts/items/item";
import { defaultLinkAccess, linkAccessSchema } from "@/contracts/world/access";
import { emptyBrief, nextTurnBriefSchema } from "@/contracts/state/brief";
import { emptyParticipantState, participantStateSchema } from "@/contracts/state/participant-state";
import { emptySceneGenState, sceneGenStateSchema, type SceneGenState } from "@/contracts/state/scene-gen";
import { emptySessionRuntime, sessionRuntimeSchema } from "@/contracts/state/session-runtime";
import {
  characterProfileSchema,
  emptyCharacterProfile,
  emptyWorldLore,
  emptyWorldStyle,
  worldLoreSchema,
  worldStyleSchema,
} from "@/contracts/world/profile";
import { parseOr } from "@/lib/parse";
import { fillPlayerToken, fillPlayerTokenOpt, OBSERVER_PLAYER_NAME } from "@/lib/player-token";
import { db, itemInstances, participantRelationships, sessionLinks, sessionLocations, sessionParticipants, sessions, worlds } from "../db";
import { loadWorldLoreChunks, type LoreChunkLite } from "../memory";
import type { SceneBundleInput, SceneItemInput, SceneLinkInput, SceneParticipantInput, ScenePlaceInput } from "./scene";

/**
 * The one typed view of a session every engine path works from. Every JSONB
 * column crosses the trust boundary here, exactly once, via parseOr
 * (docs/resilience.md §1) — downstream code never sees raw rows.
 */

export const ambientSchema = z.object({
  scent: z.string().optional(),
  sound: z.string().optional(),
  light: z.string().optional(),
});

export type Ambient = z.infer<typeof ambientSchema>;

export interface BundleParticipant extends SceneParticipantInput {
  characterId: string | null;
  avatarImageId: string | null;
  /** Simulation/narration depth (cast-tiers-and-affinity-spec); the player is always major. */
  tier: "major" | "minor" | "extra";
}

export interface BundlePlace extends ScenePlaceInput {
  /** Library location id this session location was materialized from. */
  locationId: string | null;
  emergent: boolean;
}

export interface BundleItem extends SceneItemInput {
  /** Library item id this instance was materialized from. */
  itemId: string | null;
}

export interface BundleSession {
  id: string;
  ownerId: string;
  worldId: string;
  title: string;
  embodied: boolean;
  status: "ready" | "narrating" | "processing";
  clockMinutes: number;
}

export interface BundleWorld {
  id: string;
  ownerId: string;
  name: string;
  description: string;
  narrativeModel: string;
}

/** Structurally satisfies SceneBundleInput — pass it straight to the scene builders. */
export interface BundleRelationship {
  fromParticipantId: string;
  toParticipantId: string;
  kind: "feeling" | "perceived";
  value: number;
  stage: string;
}

export interface SessionBundle extends SceneBundleInput {
  session: BundleSession;
  world: BundleWorld;
  participants: BundleParticipant[];
  locations: BundlePlace[];
  links: SceneLinkInput[];
  items: BundleItem[];
  loreChunks: LoreChunkLite[];
  scene: SceneGenState;
  /** Affinity edges (sparse — absent edge ⇒ stranger). */
  relationships: BundleRelationship[];
}

export async function loadSessionBundle(sessionId: string, sink?: DiagnosticSink): Promise<SessionBundle | null> {
  const [sessionRow] = await db().select().from(sessions).where(eq(sessions.id, sessionId)).limit(1);
  if (!sessionRow) return null;
  const [worldRow] = await db().select().from(worlds).where(eq(worlds.id, sessionRow.worldId)).limit(1);
  if (!worldRow) return null;

  const [participantRows, locationRows, linkRows, itemRows, chunks, relationshipRows] = await Promise.all([
    db()
      .select()
      .from(sessionParticipants)
      .where(eq(sessionParticipants.sessionId, sessionId))
      .orderBy(asc(sessionParticipants.createdAt), asc(sessionParticipants.id)),
    db()
      .select()
      .from(sessionLocations)
      .where(eq(sessionLocations.sessionId, sessionId))
      .orderBy(asc(sessionLocations.createdAt), asc(sessionLocations.id)),
    db().select().from(sessionLinks).where(eq(sessionLinks.sessionId, sessionId)),
    db()
      .select()
      .from(itemInstances)
      .where(eq(itemInstances.sessionId, sessionId))
      .orderBy(asc(itemInstances.createdAt), asc(itemInstances.id)),
    loadWorldLoreChunks(sessionRow.worldId, sink),
    db().select().from(participantRelationships).where(eq(participantRelationships.sessionId, sessionId)),
  ]);

  const participants: BundleParticipant[] = participantRows.map((row) => ({
    id: row.id,
    displayName: row.displayName,
    isUser: row.isUser,
    role: row.role,
    locationId: row.locationId,
    characterId: row.characterId,
    avatarImageId: row.avatarImageId,
    tier: row.tier,
    snapshot: parseOr(characterProfileSchema, row.snapshot, emptyCharacterProfile(), sink, "session_participants.snapshot"),
    state: parseOr(participantStateSchema, row.state, emptyParticipantState(), sink, "session_participants.state"),
  }));

  const locations: BundlePlace[] = locationRows.map((row) => ({
    id: row.id,
    name: row.name,
    description: row.description,
    ambient: parseOr(ambientSchema, row.ambient, {}, sink, "session_locations.ambient"),
    scale: row.scale,
    locationId: row.locationId,
    emergent: row.emergent,
  }));

  const links: SceneLinkInput[] = linkRows.map((row) => ({
    fromId: row.fromId,
    toId: row.toId,
    label: row.label,
    travelMinutes: row.travelMinutes,
    // Trust boundary: a malformed access jsonb degrades to public — never a blocked door.
    access: parseOr(linkAccessSchema, row.access, defaultLinkAccess(), sink, "session_links.access"),
    doorItemId: row.doorItemId,
  }));

  const items: BundleItem[] = itemRows.map((row) => ({
    id: row.id,
    name: row.name,
    itemId: row.itemId,
    definition: parseOr(itemDefinitionSchema, row.snapshot, emptyItemDefinition(), sink, "item_instances.snapshot"),
    holderParticipantId: row.holderParticipantId,
    worn: row.worn,
    locationId: row.locationId,
    containerInstanceId: row.containerInstanceId,
    positionNote: row.positionNote,
    state: parseOr(itemInstanceStateSchema, row.state, emptyItemInstanceState(), sink, "item_instances.state"),
  }));

  return fillBundlePlayerToken({
    session: {
      id: sessionRow.id,
      ownerId: sessionRow.ownerId,
      worldId: sessionRow.worldId,
      title: sessionRow.title,
      embodied: sessionRow.embodied,
      status: sessionRow.status,
      clockMinutes: sessionRow.clockMinutes,
    },
    world: {
      id: worldRow.id,
      ownerId: worldRow.ownerId,
      name: worldRow.name,
      description: worldRow.description,
      narrativeModel: worldRow.narrativeModel,
    },
    participants,
    locations,
    links,
    items,
    loreChunks: chunks,
    relationships: relationshipRows.map((row) => ({
      fromParticipantId: row.fromParticipantId,
      toParticipantId: row.toParticipantId,
      kind: row.kind,
      value: row.value,
      stage: row.stage,
    })),
    style: parseOr(worldStyleSchema, worldRow.style, emptyWorldStyle(), sink, "worlds.style"),
    lore: parseOr(worldLoreSchema, worldRow.lore, emptyWorldLore(), sink, "worlds.lore"),
    runtime: parseOr(sessionRuntimeSchema, sessionRow.runtime, emptySessionRuntime(), sink, "sessions.runtime"),
    brief: parseOr(nextTurnBriefSchema, sessionRow.brief, emptyBrief(), sink, "sessions.brief"),
    scene: parseOr(sceneGenStateSchema, sessionRow.scene, emptySceneGenState(), sink, "sessions.scene"),
    clockMinutes: sessionRow.clockMinutes,
  });
}

/** The `{{player}}` fill for a loaded bundle: the embodied player's display name, else the observer phrase. */
export function bundlePlayerName(bundle: Pick<SessionBundle, "participants">): string {
  return bundle.participants.find((p) => p.isUser)?.displayName ?? OBSERVER_PLAYER_NAME;
}

/**
 * Resolve the `{{player}}` authoring token across the bundle's authored-text
 * fields — once, right after the parse boundary, so prompts, post-turn
 * agents, and the status payload all see identical substituted text
 * (docs/authoring.md §The {{player}} token). The field list below is the
 * contract; it is applied explicitly, never via a generic object walker:
 *
 * - world description · lore synopsis · lore chunk title/body (all tiers)
 * - style directives · narrator guidance · norm rule/consequence text
 * - location descriptions · participant snapshot bio/personality/voice
 * - item definition description + sensory text
 *
 * Names are grounding identifiers and are NEVER substituted: location names,
 * item names, participant displayName, schedule locationName. Runtime text
 * (briefs, threads, episodes, narration) is generated downstream of this fill
 * and can never contain the raw token.
 */
export function fillBundlePlayerToken(bundle: SessionBundle): SessionBundle {
  const name = bundlePlayerName(bundle);
  const fill = (text: string): string => fillPlayerToken(text, name);
  const fillOpt = (text: string | undefined): string | undefined => fillPlayerTokenOpt(text, name);

  return {
    ...bundle,
    world: { ...bundle.world, description: fill(bundle.world.description) },
    participants: bundle.participants.map((p) => ({
      ...p,
      snapshot: {
        ...p.snapshot,
        bio: fill(p.snapshot.bio),
        personality: fill(p.snapshot.personality),
        voice: fillOpt(p.snapshot.voice),
      },
    })),
    locations: bundle.locations.map((l) => ({ ...l, description: fill(l.description) })),
    items: bundle.items.map((i) => ({
      ...i,
      definition: {
        ...i.definition,
        description: fill(i.definition.description),
        sensory: {
          ...i.definition.sensory,
          appearance: fillOpt(i.definition.sensory.appearance),
          scent: fillOpt(i.definition.sensory.scent),
          tactile: fillOpt(i.definition.sensory.tactile),
        },
      },
    })),
    loreChunks: bundle.loreChunks.map((c) => ({ ...c, title: fill(c.title), body: fill(c.body) })),
    style: {
      ...bundle.style,
      directives: bundle.style.directives.map(fill),
      narratorGuidance: fillOpt(bundle.style.narratorGuidance),
      norms: bundle.style.norms.map((n) => ({ ...n, rule: fill(n.rule), consequence: fill(n.consequence) })),
    },
    lore: { ...bundle.lore, synopsis: fill(bundle.lore.synopsis) },
  };
}

export interface ActiveLocationView {
  participants: ReadonlyArray<{ isUser: boolean; role: "player" | "companion" | "npc"; locationId: string | null }>;
  locations: ReadonlyArray<{ id: string }>;
}

/**
 * Where the camera is: the player's location when embodied, else the first
 * companion's, else the first placed participant's, else the first location.
 */
export function activeLocationId(bundle: ActiveLocationView): string | null {
  const player = bundle.participants.find((p) => p.isUser);
  if (player?.locationId) return player.locationId;
  const companion = bundle.participants.find((p) => !p.isUser && p.role === "companion");
  if (companion?.locationId) return companion.locationId;
  const placed = bundle.participants.find((p) => p.locationId);
  return placed?.locationId ?? bundle.locations[0]?.id ?? null;
}
