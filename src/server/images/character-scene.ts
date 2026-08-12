import { and, eq } from "drizzle-orm";
import { resolveAttributes, type AttributeValue } from "@/contracts/attributes/value";
import type { ActiveCondition } from "@/contracts/conditions/condition";
import { conditionAttributeOverlays } from "@/contracts/conditions/overlays";
import { resolveImageProfileForTask } from "./model-profiles";
import { exposedRegions, FULLY_COVERED, type RegionExposure } from "@/contracts/items/visibility";
import { speciesLabelPhrase } from "@/contracts/species";
import type { CharacterProfile } from "@/contracts/world/profile";
import type { SceneReferenceSource } from "@vesper/image-core";
import type { DiagnosticSink } from "@/contracts/diagnostics";
import { diag } from "@/contracts/diagnostics";
import { classifyImageFailure, hasReplicate, isDemoMode } from "../ai";
import { db, images } from "../db";
import { logEvent } from "../events";
import { deleteOwnedImage, imageMeta, readImageBytes } from "./assets";
import { latestChatLook } from "./chat-look";
import {
  apparentAgeAnchor,
  characterAppearanceSummary,
  identityAnchorSummary,
  sceneRevealAppearance,
  type SceneComposerContext,
  type ScenePresentCharacter,
  type SceneRenderPlan,
} from "./prompts";
import { composeSceneSpec, renderResolvedScene } from "./scene";

export const DEFAULT_CHAT_ROOM =
  "A warm, softly lit room — a comfortable couch, a low wooden table, shelves of books along one wall, and a tall window letting in natural light.";

export interface RenderCharacterSceneInput {
  characterId: string;
  userId: string;
  name: string;
  profile: CharacterProfile;
  avatarImageId: string | null;
  room?: string;
  timeOfDay?: string;
  recentChat?: string[];
  outfit?: string;
  outfitExposed?: boolean;
  exposure?: RegionExposure;
  garmentNotes?: readonly string[];
  playerExposure?: RegionExposure;
  playerAttributes?: ReadonlyArray<AttributeValue>;
  playerProfile?: CharacterProfile;
  meters?: Record<string, number>;
  conditions?: ActiveCondition[];
  chatId?: string;
  anchorMessageId?: string;
  flavor?: "selfie";
  lookKey?: string;
  place?: { name: string; imageId: string };
  /** Persisted registry model id; unknown/absent values fall back to the scene default. */
  sceneModel?: string;
  sink?: DiagnosticSink;
}

/** A compact image-specific description of visible meter state. */
export function visualStateNote(meters: Record<string, number> = {}): string {
  const parts: string[] = [];
  const intoxication = meters.intoxication ?? 0;
  if (intoxication > 0.7) parts.push("visibly unsteady from drink, eyes glassy and unfocused, posture slack");
  else if (intoxication > 0.35) parts.push("loose and warm from a drink or two, gaze a little unfocused");
  const hygiene = meters.hygiene ?? 1;
  if (hygiene < 0.3) parts.push("unwashed — hair gone lank, skin sheened, clothes rumpled");
  else if (hygiene < 0.55) parts.push("a little disheveled, hair loosened and skin damp");
  const energy = meters.energy ?? 1;
  if (energy < 0.2) parts.push("exhausted and heavy-lidded");
  else if (energy < 0.45) parts.push("tired, eyes heavy");
  const arousal = meters.arousal ?? 0;
  if (arousal > 0.55) parts.push("eyes bright and heavy-lidded, lips parted, breath shallow, a faint sheen of sweat");
  return parts.join("; ");
}

export function buildCharacterSceneContext(input: {
  name: string;
  profile: CharacterProfile;
  room: string;
  timeOfDay?: string;
  recentChat: string[];
  outfit: string;
  outfitExposed: boolean;
  exposure?: RegionExposure;
  garmentNotes?: readonly string[];
  playerExposure?: RegionExposure;
  playerAttributes?: ReadonlyArray<AttributeValue>;
  playerProfile?: CharacterProfile;
  meters?: Record<string, number>;
  conditions?: ActiveCondition[];
}): SceneComposerContext {
  const exposure: RegionExposure = input.exposure ?? (input.outfitExposed ? exposedRegions([]) : FULLY_COVERED);
  const resolved = resolveAttributes(input.profile.attributes, conditionAttributeOverlays(input.conditions ?? []));
  const stateNote = visualStateNote(input.meters);
  const appearance = [characterAppearanceSummary(resolved, undefined, false, input.profile), stateNote]
    .filter(Boolean)
    .join(". ");
  const present: ScenePresentCharacter = {
    name: input.name,
    species: speciesLabelPhrase(input.profile.speciesId, input.profile.heritageId),
    wornVisible: [],
    outfitDescription: [input.outfit.trim(), ...(input.garmentNotes ?? []).map((note) => note.trim())]
      .filter(Boolean)
      .join("; "),
    exposure,
    wardrobeTracked: true,
    appearance,
    identityAnchors: identityAnchorSummary(resolved, input.profile),
    ageAnchor: apparentAgeAnchor(input.name, resolved),
    lowerBody: sceneRevealAppearance(resolved, exposure, input.profile, { intimate: false }),
    intimateAppearance: sceneRevealAppearance(resolved, exposure, input.profile, { intimate: true }),
  };

  return {
    present: [present],
    locationName: "the room",
    locationDescription: input.room,
    timeOfDay: input.timeOfDay?.trim() || "day",
    recentNarration: input.recentChat,
    embodiedViewer: true,
    ...(input.playerExposure ? { playerExposure: input.playerExposure } : {}),
    ...(input.playerAttributes ? { playerAttributes: input.playerAttributes } : {}),
    ...(input.playerProfile ? { playerProfile: input.playerProfile } : {}),
    ...(input.playerProfile && input.playerExposure
      ? {
          playerIntimateAppearance: sceneRevealAppearance(
            resolveAttributes(input.playerProfile.attributes, []),
            input.playerExposure,
            input.playerProfile,
            { intimate: true },
          ),
        }
      : {}),
  };
}

async function loadChatPlaceImage(ownerId: string, imageId: string): Promise<{ imageId: string; buffer: Buffer } | null> {
  const [row] = await db()
    .select()
    .from(images)
    .where(and(eq(images.id, imageId), eq(images.ownerId, ownerId), eq(images.kind, "chat_place"), eq(images.status, "ready")))
    .limit(1);
  if (!row) return null;
  const buffer = await readImageBytes(row);
  return buffer ? { imageId: row.id, buffer } : null;
}

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
  const buffer = await readImageBytes(row);
  if (!buffer) return null;
  const uploaded = imageMeta(row.meta).source === "upload";
  return { imageId: row.id, buffer, source: uploaded ? "uploaded" : "generated" };
}

/** Compose and render one character-chat scene with the persisted provider choice. */
export async function renderCharacterSceneImage(input: RenderCharacterSceneInput): Promise<string> {
  const selfie = input.flavor === "selfie";
  const room = input.room?.trim() || DEFAULT_CHAT_ROOM;
  const context = buildCharacterSceneContext({
    name: input.name,
    profile: input.profile,
    room,
    timeOfDay: input.timeOfDay,
    recentChat: (input.recentChat ?? []).filter((text) => text.trim()),
    outfit: input.outfit ?? "",
    outfitExposed: input.outfitExposed ?? false,
    exposure: input.exposure,
    garmentNotes: input.garmentNotes,
    playerExposure: input.playerExposure,
    playerAttributes: input.playerAttributes,
    playerProfile: input.playerProfile,
    meters: input.meters,
    conditions: input.conditions,
  });
  const plan = await composeSceneSpec({ ...context, sink: input.sink });

  // The chat's stored scene-model pick, resolved against the profile registry. A
  // pick that no longer exists degrades to the scene task's default (owner ruling
  // 5) — the legacy Venice keys on pre-registry rows land here and are simply
  // replaced, and a stored MODEL id still resolves to that model's own scene
  // profile rather than moving the chat onto a different model.
  const imageProfile = isDemoMode() ? null : await resolveImageProfileForTask("scene", input.sceneModel, input.sink);
  const model = imageProfile?.model ?? null;
  const referenceRoute = !isDemoMode() && hasReplicate() && model !== null && model.canEdit;
  const look = referenceRoute && input.chatId && input.lookKey ? await latestChatLook(input.chatId, input.lookKey) : null;
  const anchor = look
    ? { imageId: look.imageId, buffer: look.buffer, source: "generated" as SceneReferenceSource }
    : referenceRoute
      ? await loadCharacterAvatar(input.userId, input.avatarImageId)
      : null;
  const referenceBuffers = new Map<string, Buffer>();
  if (anchor) referenceBuffers.set(anchor.imageId, anchor.buffer);

  const placeRef =
    !selfie && anchor && input.place && input.chatId ? await loadChatPlaceImage(input.userId, input.place.imageId) : null;
  if (placeRef) referenceBuffers.set(placeRef.imageId, placeRef.buffer);

  const renderOnce = (attemptPlan: SceneRenderPlan, allowIntimate: boolean): Promise<string> =>
    renderResolvedScene({
      plan: attemptPlan,
      references: [
        {
          kind: "character",
          entityId: input.characterId,
          name: input.name,
          role: "focal",
          allowForIntimate: allowIntimate,
          ...(anchor ? { imageId: anchor.imageId, source: anchor.source } : {}),
        },
        ...(placeRef
          ? [
              {
                kind: "location" as const,
                name: input.place?.name ?? "the place",
                role: "location",
                allowForIntimate: true,
                imageId: placeRef.imageId,
                source: "generated" as SceneReferenceSource,
              },
            ]
          : []),
      ],
      referenceBuffers,
      mode: placeRef ? "multi" : "single",
      profile: imageProfile,
      framing: selfie ? "selfie" : undefined,
      flavor: input.flavor,
      linkage: {
        ownerId: input.userId,
        entityKind: "character",
        entityId: input.characterId,
        chatId: input.chatId,
        anchorMessageId: input.anchorMessageId,
      },
      logResult: (imageId, status, started) =>
        void logEvent("image.character_scene", {
          imageId,
          characterId: input.characterId,
          status,
          durationMs: Date.now() - started,
        }),
      sink: input.sink,
    });

  const first = await renderOnce(plan, true);
  if (!selfie) return first;

  const firstError = await imageFailure(first);
  if (firstError === null) return first;
  const reason = classifyImageFailure(new Error(firstError || "render failed"));
  input.sink?.push(
    diag("info", "images.selfie.retry", `first selfie attempt failed (${reason}) — retrying${reason === "content_rejection" ? " sanitized" : ""}`),
  );
  const retryPlan = reason === "content_rejection" ? sanitizeScenePlan(plan) : plan;
  const second = await renderOnce(retryPlan, reason !== "content_rejection");
  await deleteOwnedImage(first, input.userId, { kind: "scene" });
  return second;
}

async function imageFailure(imageId: string): Promise<string | null> {
  const [row] = await db().select({ status: images.status, meta: images.meta }).from(images).where(eq(images.id, imageId)).limit(1);
  if (!row || row.status !== "failed") return null;
  const error = imageMeta(row.meta).error;
  return typeof error === "string" ? error : "";
}

function sanitizeScenePlan(plan: SceneRenderPlan): SceneRenderPlan {
  const scrub = <T extends { exposure?: string; intimateAppearance?: string }>(spec: T): T => ({
    ...spec,
    exposure: undefined,
    intimateAppearance: undefined,
  });
  return {
    ...plan,
    focal: plan.focal ? scrub(plan.focal) : null,
    others: plan.others.map(scrub),
  };
}
