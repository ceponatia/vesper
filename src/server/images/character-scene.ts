import fs from "node:fs/promises";
import { and, eq } from "drizzle-orm";
import { resolveAttributes } from "@/contracts/attributes/value";
import { exposedRegions, resolveWardrobeVisibility } from "@/contracts/items/visibility";
import { speciesLabelPhrase } from "@/contracts/species";
import type { CharacterProfile } from "@/contracts/world/profile";
import type { SceneReferenceSource, SceneVisualReference } from "@/contracts/images/scene-reference";
import type { DiagnosticSink } from "@/contracts/diagnostics";
import { hasVenice, isDemoMode } from "../ai";
import { db, images } from "../db";
import { logEvent } from "../events";
import { absoluteImagePath } from "./assets";
import { loadDefaultWardrobe } from "./avatar";
import {
  characterAppearanceSummary,
  sceneRevealAppearance,
  toWornInputs,
  type SceneComposerContext,
  type ScenePresentCharacter,
  type SceneWornItem,
} from "./prompts";
import { composeSceneSpec, renderResolvedScene } from "./scene";

/**
 * Sessionless scene images for the character-chat harness
 * (docs/developer-notes/character-chat.plan.md). Same two-step pipeline as the
 * in-session scene image (compose a spec from the present cast + recent
 * narration, then render with the avatar as the identity anchor) — but there is
 * no session and no location, so the single subject is the library character and
 * a default room description stands in for the place. The asset is filed against
 * the character (`entityKind:"character"`) with no `sessionId`, so it surfaces in
 * the Gallery under "Character chats" and is deletable there like any scene.
 */

/** The stand-in location when the chat has no real place. Overridable per request. */
export const DEFAULT_CHAT_ROOM =
  "A warm, softly lit room — a comfortable couch, a low wooden table, shelves of books along one wall, and a tall window letting in natural light.";

export interface RenderCharacterSceneInput {
  characterId: string;
  userId: string;
  name: string;
  profile: CharacterProfile;
  /** The character's canonical avatar, used as the identity reference when ready. */
  avatarImageId: string | null;
  /** Default-room override; falls back to DEFAULT_CHAT_ROOM. */
  room?: string;
  /** Recent assistant turns (oldest first) for the composer to center the shot on. */
  recentChat?: string[];
  sink?: DiagnosticSink;
}

/**
 * The composer context for a single library character in the default room.
 * Mirrors engine/pipeline.buildSceneComposerContext's per-character mapping
 * (occlusion-filtered wardrobe, exposure, appearance summaries) but sources the
 * outfit from the character's default outfit rather than session item state.
 */
export async function buildCharacterSceneContext(input: {
  name: string;
  profile: CharacterProfile;
  userId: string;
  room: string;
  recentChat: string[];
  sink?: DiagnosticSink;
}): Promise<SceneComposerContext> {
  const wardrobe = await loadDefaultWardrobe(input.userId, input.profile.defaultOutfit, input.sink);
  // Shared with the avatar prompt's outfit gate (images/prompts.ts): instanceId
  // is the wardrobe index, which `wardrobeByIndex` below relies on to recover
  // each item's description/appearance.
  const wornInputs = toWornInputs(wardrobe);
  const views = resolveWardrobeVisibility(wornInputs);
  const exposure = exposedRegions(wornInputs);
  const wardrobeByIndex = new Map(wardrobe.map((item, index) => [String(index), item]));
  const wornVisible: SceneWornItem[] = views
    .filter((v) => v.visibility !== "hidden")
    .map((v) => {
      const item = wardrobeByIndex.get(v.instanceId);
      return {
        name: v.name,
        visibility: v.visibility === "hinted" ? ("hinted" as const) : ("visible" as const),
        ...(item?.description ? { description: item.description } : {}),
        ...(item?.appearance ? { appearance: item.appearance } : {}),
      };
    });

  const resolved = resolveAttributes(input.profile.attributes, []);
  const present: ScenePresentCharacter = {
    name: input.name,
    species: speciesLabelPhrase(input.profile.speciesId, input.profile.heritageId),
    wornVisible,
    exposure,
    // The default outfit is authoritative for this shot — exposedRegions([])
    // (no outfit) must override a clothed reference avatar, same as a session.
    wardrobeTracked: true,
    appearance: characterAppearanceSummary(resolved, undefined, false, input.profile),
    // The chat subject is the identity-locked reference (a waist-up portrait), so
    // supplement it with the figure it can't show: the SFW lower-body shape line
    // (always) and exposure-/silhouette-aware intimate anatomy (uncensored route).
    lowerBody: sceneRevealAppearance(resolved, exposure, input.profile, { intimate: false }),
    intimateAppearance: sceneRevealAppearance(resolved, exposure, input.profile, { intimate: true }),
  };

  return {
    present: [present],
    locationName: "the room",
    locationDescription: input.room,
    timeOfDay: "day",
    recentNarration: input.recentChat,
  };
}

/** Read the character's canonical avatar for reference editing — owned + ready, else null (text-to-image). */
async function loadCharacterAvatar(
  ownerId: string,
  avatarImageId: string | null,
): Promise<{ imageId: string; buffer: Buffer; source: SceneReferenceSource } | null> {
  if (!avatarImageId) return null;
  const [row] = await db()
    .select()
    .from(images)
    .where(and(eq(images.id, avatarImageId), eq(images.ownerId, ownerId)))
    .limit(1);
  if (!row || row.status !== "ready") return null;
  try {
    const buffer = await fs.readFile(absoluteImagePath(row));
    const uploaded =
      row.meta && typeof row.meta === "object" && !Array.isArray(row.meta) && (row.meta as Record<string, unknown>).source === "upload";
    return { imageId: row.id, buffer, source: uploaded ? "uploaded" : "generated" };
  } catch {
    return null; // file lost — fall through to text-to-image
  }
}

/**
 * Render one character-chat scene image. Composes the spec (tool model), then
 * renders through the shared provider chain (scene.renderResolvedScene) with the
 * character's avatar as the single identity reference and the asset filed against
 * the character (no session).
 */
export async function renderCharacterSceneImage(input: RenderCharacterSceneInput): Promise<string> {
  const room = input.room?.trim() || DEFAULT_CHAT_ROOM;
  const context = await buildCharacterSceneContext({
    name: input.name,
    profile: input.profile,
    userId: input.userId,
    room,
    recentChat: (input.recentChat ?? []).filter((t) => t.trim()),
    sink: input.sink,
  });
  const plan = await composeSceneSpec({ ...context, sink: input.sink });

  // Character-chat is a single subject (one library character, no location image),
  // so it always renders single-reference: the avatar anchors the uncensored edit.
  // With an avatar present the render is fail-visible (requireReferenceIdentity) —
  // a failed edit never degrades to a different-looking text-to-image person; only
  // when there's NO usable avatar does Qwen text-to-image stand in.
  const anchor = isDemoMode() || !hasVenice() ? null : await loadCharacterAvatar(input.userId, input.avatarImageId);
  const references: SceneVisualReference[] = [
    {
      kind: "character",
      entityId: input.characterId,
      name: input.name,
      role: "focal",
      allowForIntimate: true,
      ...(anchor ? { imageId: anchor.imageId, source: anchor.source } : {}),
    },
  ];
  const referenceBuffers = new Map<string, Buffer>();
  if (anchor) referenceBuffers.set(anchor.imageId, anchor.buffer);

  return renderResolvedScene({
    plan,
    references,
    referenceBuffers,
    // Fail-visible: with an avatar anchoring the shot, never silently degrade to a
    // text-to-image render of a *different-looking* person — fail and let the tab retry.
    requireReferenceIdentity: true,
    linkage: { ownerId: input.userId, entityKind: "character", entityId: input.characterId },
    logResult: (imageId, status, started) =>
      void logEvent(null, "image.character_scene", {
        imageId,
        characterId: input.characterId,
        status,
        durationMs: Date.now() - started,
      }),
    sink: input.sink,
  });
}
