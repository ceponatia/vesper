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

/** One roster member as the scene queue needs them (the `OwnedChatMember.character` slice). */
export interface QueueChatSceneMember {
  id: string;
  name: string;
  profile: unknown;
  avatarImageId: string | null;
}

export interface QueueChatSceneArgs {
  userId: string;
  chatId: string;
  /** The character the scene row is FILED against — the strip reads by this id. */
  character: QueueChatSceneMember;
  /**
   * The full sort-ordered roster. Absent (or empty) ⇒ the primary alone, which is
   * what a classic 1-on-1 chat is and what every pre-roster call site sent.
   */
  roster?: readonly QueueChatSceneMember[];
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

    const recent = await db()
      .select({ id: characterChatMessages.id, content: characterChatMessages.content })
      .from(characterChatMessages)
      .where(and(eq(characterChatMessages.chatId, args.chatId), eq(characterChatMessages.role, "assistant")))
      .orderBy(desc(characterChatMessages.createdAt))
      .limit(SCENE_CHAT_CONTEXT);
    const recentChat = recent.map((row) => row.content).reverse();
    const anchorMessageId = args.anchorMessageId ?? recent[0]?.id;

    const scenario = await loadChatScenario(args.chatId);

    // Who is in the shot. Chat tracks no per-character location — `presence` is
    // its only location-like state, so "both in the same room" and "both present"
    // are the same claim (owner ruling, qwen-advanced-image-subsystem.plan.md
    // Stage 7). An away member is offstage living their own life and is not drawn
    // into the picture. A selfie is the sender's own phone camera, so it stays
    // single-subject whoever else is in the room.
    const roster = args.roster?.length ? args.roster : [args.character];
    const states = await Promise.all(
      roster.map(async (member) => ({ member, stored: await loadChatState(args.chatId, member.id) })),
    );
    const subject = states.find((entry) => entry.member.id === args.character.id);
    const onlySubject = subject ? [subject] : [{ member: args.character, stored: null }];
    const present = states.filter((entry) => (entry.stored?.presence ?? "present") === "present");
    // Everyone away is not a reason to render an empty room here: fall back to the
    // filing subject, which is exactly what a pre-roster queue always sent. The
    // cast is never empty — a subject with no state row still renders.
    const castStates = args.flavor === "selfie" ? onlySubject : present.length > 0 ? present : onlySubject;

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

    // Wardrobe, look key and garment notes are all per-person, so they resolve per
    // cast member rather than once for the chat. The garment narration is called
    // one actor at a time deliberately: its notes are possessive-labelled, and a
    // single combined call returns one flat list that the composer would then
    // attach to whichever character it was handed to — dressing one person in
    // another's clothes.
    const cast = await Promise.all(
      castStates.map(async ({ member, stored }) => {
        const profile = parseOr(
          characterProfileSchema,
          member.profile ?? {},
          emptyCharacterProfile(),
          undefined,
          "characters.profile",
        );
        const actor = garmentActorForCharacter(member.id);
        const wardrobe = stored
          ? await resolveChatWardrobe(
              {
                ...stored,
                ...(scenario ? { garments: scenario.garments } : {}),
                garmentActorId: actor,
              },
              args.userId,
              profile,
            )
          : null;
        const lookKey =
          wardrobe && stored
            ? chatLookKey({
                wornItemIds: wardrobe.wornItemIds,
                overlay: wardrobe.overlay,
                exposure: wardrobe.exposure,
                attributeOverlays: stored.attributeOverlays,
                ...(scenario
                  ? { garmentKey: chatGarmentLookKey(scenario.garments, [actor], scenario.clockMinutes) }
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
                    actorId: actor,
                    label: member.name,
                    possessive: `${member.name}'s`,
                    ...(wardrobe ? { visibility: wardrobe.partVisibility } : {}),
                  },
                ],
              }).sceneNotes
            : undefined;
        return {
          characterId: member.id,
          name: member.name,
          profile,
          avatarImageId: member.avatarImageId,
          outfit: wardrobe?.garments ?? "",
          outfitExposed: wardrobe?.exposed ?? false,
          exposure: wardrobe?.exposure,
          garmentNotes,
          meters: stored?.meters,
          conditions: stored?.conditions,
          lookKey,
        };
      }),
    );
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
          cast,
          room,
          timeOfDay: scenario ? timeOfDayFor(scenario.clockMinutes, scenario.calendarStart) : undefined,
          recentChat,
          playerExposure: playerWardrobe?.exposure,
          playerAttributes: playerResolved,
          playerProfile,
          chatId: args.chatId,
          anchorMessageId,
          flavor: args.flavor,
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
