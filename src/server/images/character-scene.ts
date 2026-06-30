import fs from "node:fs/promises";
import { and, eq } from "drizzle-orm";
import { resolveAttributes } from "@/contracts/attributes/value";
import type { ActiveCondition } from "@/contracts/conditions/condition";
import { conditionAttributeOverlays } from "@/contracts/conditions/overlays";
import { exposedRegions, type RegionExposure } from "@/contracts/items/visibility";
import { speciesLabelPhrase } from "@/contracts/species";
import type { CharacterProfile } from "@/contracts/world/profile";
import type { SceneReferenceSource, SceneVisualReference } from "@/contracts/images/scene-reference";
import type { DiagnosticSink } from "@/contracts/diagnostics";
import { hasVenice, isDemoMode } from "../ai";
import { db, images } from "../db";
import { logEvent } from "../events";
import { absoluteImagePath } from "./assets";
import {
  characterAppearanceSummary,
  sceneRevealAppearance,
  type SceneComposerContext,
  type ScenePresentCharacter,
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
  /** Free-text starting outfit from the chat-state scenario modal; "" ⇒ composer-inferred. */
  outfit?: string;
  /** Reveal intimate anatomy (the scenario modal's exposed toggle). */
  outfitExposed?: boolean;
  /** Live chat meters — fold a visible-state note (flushed/tipsy/disheveled/tired) into the shot (D4). */
  meters?: Record<string, number>;
  /** Active conditions — overlay grooming/scent/hair so a "disheveled" character renders that way (D4). */
  conditions?: ActiveCondition[];
  sink?: DiagnosticSink;
}

/**
 * A short **visible-state** phrase for the scene image (character-chat-state-narration.spec.md
 * §8): the meters with a visual signature, in image-appropriate wording (the narrator-facing
 * threshold hints are behavioral, so this is a separate, render-tuned mapping). "" when the
 * character reads rested and presentable. Mood/affect ride the avatar reference, not this note.
 */
export function visualStateNote(meters: Record<string, number> = {}): string {
  const parts: string[] = [];
  const intoxication = meters.intoxication ?? 0;
  if (intoxication > 0.7) parts.push("flushed and visibly unsteady from drink");
  else if (intoxication > 0.35) parts.push("lightly flushed and loose from a drink or two");
  const hygiene = meters.hygiene ?? 1;
  if (hygiene < 0.3) parts.push("unwashed — hair gone lank, skin sheened, clothes rumpled");
  else if (hygiene < 0.55) parts.push("a little disheveled, hair loosened and skin warm");
  const energy = meters.energy ?? 1;
  if (energy < 0.2) parts.push("exhausted and heavy-lidded");
  else if (energy < 0.45) parts.push("tired, eyes heavy");
  const arousal = meters.arousal ?? 0;
  if (arousal > 0.55) parts.push("flushed, eyes bright and breath shallow");
  return parts.join("; ");
}

/** Fully-clothed coverage: the chat's SFW default when the outfit isn't flagged exposed. */
const FULLY_COVERED: RegionExposure = { torso: "covered", pelvis: "covered", legs: "covered", feet: "covered" };

/**
 * The composer context for a single library character in the default room
 * (character-chat-scenario.plan.md). The character chat has **no equippable wardrobe**, so
 * the outfit is the scenario modal's **free text** (`outfit`) and a single `outfitExposed`
 * toggle stands in for region coverage — there are no structured items to derive it from.
 * Exposed ⇒ fully bare (intimate-anatomy reveal on the uncensored route); otherwise fully
 * covered (SFW). `profile.defaultOutfit` is deliberately NOT read here.
 */
export function buildCharacterSceneContext(input: {
  name: string;
  profile: CharacterProfile;
  room: string;
  recentChat: string[];
  outfit: string;
  outfitExposed: boolean;
  meters?: Record<string, number>;
  conditions?: ActiveCondition[];
}): SceneComposerContext {
  const exposure: RegionExposure = input.outfitExposed ? exposedRegions([]) : FULLY_COVERED;

  // Active conditions overlay attributes (grooming/scent/hair) the same way the chat prompt
  // does (character-chat-state-narration.spec.md §2/§8), and a visible-state note layers the
  // meters with a visual signature — so the render reflects how the character actually is now.
  const resolved = resolveAttributes(input.profile.attributes, conditionAttributeOverlays(input.conditions ?? []));
  const stateNote = visualStateNote(input.meters);
  const appearance = [characterAppearanceSummary(resolved, undefined, false, input.profile), stateNote]
    .filter(Boolean)
    .join(". ");
  const present: ScenePresentCharacter = {
    name: input.name,
    species: speciesLabelPhrase(input.profile.speciesId, input.profile.heritageId),
    // No structured items in chat — the free-text outfit overrides the (empty) wardrobe summary.
    wornVisible: [],
    outfitDescription: input.outfit.trim(),
    exposure,
    // Authoritative for this shot: the described outfit / exposed toggle overrides a clothed
    // reference avatar (same role exposedRegions played for the old default-outfit path).
    wardrobeTracked: true,
    appearance,
    // The chat subject is the identity-locked reference (a waist-up portrait), so supplement it
    // with the figure it can't show: the SFW lower-body shape line (always) and exposure-gated
    // intimate anatomy (uncensored route, only when the outfit is flagged exposed).
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
  const context = buildCharacterSceneContext({
    name: input.name,
    profile: input.profile,
    room,
    recentChat: (input.recentChat ?? []).filter((t) => t.trim()),
    outfit: input.outfit ?? "",
    outfitExposed: input.outfitExposed ?? false,
    meters: input.meters,
    conditions: input.conditions,
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
