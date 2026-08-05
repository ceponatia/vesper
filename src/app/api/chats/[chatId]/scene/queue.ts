import { and, desc, eq } from "drizzle-orm";
import {
  characterProfileSchema,
  currentScenePlace,
  emptyCharacterProfile,
  garmentActorForCharacter,
  personaToCharacterProfile,
  resolveAttributes,
  timeOfDayFor,
} from "@/contracts";
import { parseOr } from "@/lib/parse";
import { startJob } from "@/server/api";
import { characterChatMessages, db, hasLiveChatJob } from "@/server/db";
import {
  buildChatGarmentNarration,
  chatGarmentCuesEnabled,
  chatGarmentLookKey,
  enqueueChatPlaceImage,
  loadChatScenario,
  loadChatState,
  resolveChatWardrobe,
  resolvePlayerWardrobe,
} from "@/server/engine";
import { resolveChatPersona } from "@/server/players";
import { chatLookKey, renderCharacterSceneImage } from "@/server/images";
import { log } from "@/server/log";

export const SCENE_CHAT_CONTEXT = 6;

export interface QueueChatSceneArgs {
  userId: string;
  chatId: string;
  character: { id: string; name: string; profile: unknown; avatarImageId: string | null };
  anchorMessageId?: string;
  flavor?: "selfie";
}

export async function hasLiveChatSceneJob(chatId: string): Promise<boolean> {
  return hasLiveChatJob("chat_scene_image", chatId);
}

/** Queue one detached character-chat scene render with its persisted model/provider choice. */
export async function queueChatScene(args: QueueChatSceneArgs): Promise<string | null> {
  try {
    if (await hasLiveChatSceneJob(args.chatId)) return null;

    const profile = parseOr(
      characterProfileSchema,
      args.character.profile ?? {},
      emptyCharacterProfile(),
      undefined,
      "characters.profile",
    );
    const recent = await db()
      .select({ id: characterChatMessages.id, content: characterChatMessages.content })
      .from(characterChatMessages)
      .where(and(eq(characterChatMessages.chatId, args.chatId), eq(characterChatMessages.role, "assistant")))
      .orderBy(desc(characterChatMessages.createdAt))
      .limit(SCENE_CHAT_CONTEXT);
    const recentChat = recent.map((row) => row.content).reverse();
    const anchorMessageId = args.anchorMessageId ?? recent[0]?.id;

    const scenario = await loadChatScenario(args.chatId);
    const stored = await loadChatState(args.chatId, args.character.id);
    const wardrobe = stored
      ? await resolveChatWardrobe(
          {
            ...stored,
            ...(scenario ? { garments: scenario.garments } : {}),
            garmentActorId: garmentActorForCharacter(args.character.id),
          },
          args.userId,
          profile,
        )
      : null;

    const player = await resolveChatPersona({ ownerId: args.userId, chatId: args.chatId });
    const playerWardrobe = scenario
      ? await resolvePlayerWardrobe(scenario.playerState, args.userId, player.profile, undefined, scenario.garments)
      : null;
    const playerProfile = player.profile ? personaToCharacterProfile(player.profile) : undefined;
    const playerResolved = playerProfile ? resolveAttributes(playerProfile.attributes, []) : [];

    const place = scenario ? currentScenePlace(scenario.sceneMemory) : null;
    const room = place
      ? place.sketch?.trim() || [place.name, place.details.join("; ")].filter(Boolean).join(" — ")
      : undefined;

    const characterActor = garmentActorForCharacter(args.character.id);
    const lookKey =
      wardrobe && stored
        ? chatLookKey({
            wornItemIds: wardrobe.wornItemIds,
            overlay: wardrobe.overlay,
            exposure: wardrobe.exposure,
            attributeOverlays: stored.attributeOverlays,
            ...(scenario
              ? { garmentKey: chatGarmentLookKey(scenario.garments, [characterActor], scenario.clockMinutes) }
              : {}),
          })
        : undefined;

    const garmentNotes =
      scenario && chatGarmentCuesEnabled()
        ? buildChatGarmentNarration({
            store: scenario.garments,
            atMinutes: scenario.clockMinutes,
            ...(place ? { placeName: place.name } : {}),
            actors: [
              {
                actorId: characterActor,
                label: args.character.name,
                possessive: `${args.character.name}'s`,
                ...(wardrobe ? { visibility: wardrobe.partVisibility } : {}),
              },
            ],
          }).sceneNotes
        : undefined;
    if (place?.sketch && !place.imageId) {
      void enqueueChatPlaceImage({ chatId: args.chatId, characterId: args.character.id, placeName: place.name });
    }

    const job = await startJob({
      type: "chat_scene_image",
      ownerId: args.userId,
      payload: {
        chatId: args.chatId,
        characterId: args.character.id,
        sceneModel: scenario?.sceneModel ?? "reference",
        ...(args.flavor ? { flavor: args.flavor } : {}),
      },
      run: async () => ({
        imageId: await renderCharacterSceneImage({
          characterId: args.character.id,
          userId: args.userId,
          name: args.character.name,
          profile,
          avatarImageId: args.character.avatarImageId,
          room,
          timeOfDay: scenario ? timeOfDayFor(scenario.clockMinutes, scenario.calendarStart) : undefined,
          recentChat,
          outfit: wardrobe?.garments ?? "",
          outfitExposed: wardrobe?.exposed ?? false,
          exposure: wardrobe?.exposure,
          garmentNotes,
          playerExposure: playerWardrobe?.exposure,
          playerAttributes: playerResolved,
          playerProfile,
          meters: stored?.meters,
          conditions: stored?.conditions,
          chatId: args.chatId,
          anchorMessageId,
          flavor: args.flavor,
          lookKey,
          place: place?.imageId ? { name: place.name, imageId: place.imageId } : undefined,
          sceneModel: scenario?.sceneModel,
        }),
      }),
    });
    if (!job.ok) {
      log.info("chat_scene", "scene render capped by concurrent job limit", {
        chatId: args.chatId,
        active: job.active,
        limit: job.limit,
      });
      return null;
    }
    return job.jobId;
  } catch (error) {
    log.warn("chat_scene", "failed to queue chat scene", {
      chatId: args.chatId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
