import { and, desc, eq } from "drizzle-orm";
import {
  affordanceSubjectId,
  characterProfileSchema,
  type CommittedSceneFacts,
  committedSceneFactsFor,
  currentScenePlace,
  emptyCharacterProfile,
  garmentActorForCharacter,
  personaToCharacterProfile,
  resolveAttributes,
  timeOfDayFor,
} from "@/contracts";
import { parseOr } from "@/lib/parse";
import { startJob } from "@/server/api";
import { characterChatMessages, chatParticipants, db, hasLiveChatJob } from "@/server/db";
import {
  buildChatGarmentNarration,
  CHAT_CONTACT_PLAYER_SUBJECT,
  chatGarmentCuesEnabled,
  chatGarmentLookKey,
  chatVisualStateShadowInput,
  enqueueChatPlaceImage,
  loadChatComposerModel,
  loadChatScenario,
  loadChatState,
  resolveChatWardrobe,
  resolvePlayerWardrobe,
  seedChatScenario,
  seedChatState,
} from "@/server/engine";
import { resolveChatPersona } from "@/server/players";
import { chatLookKey, normalizeName, renderCharacterSceneImage } from "@/server/images";
import type { VisualStateShadowInput } from "@/server/visual-state";
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

    // BOTH roles now, on the same total row budget (scene-composition.plan.md slice 1): the
    // shot planner used to read only the narrator's replies, and "I come up behind her" is
    // almost always the PLAYER's sentence — so a camera it could never learn about was the
    // single largest source of the front-facing default being wrong. The two lists stay
    // separate; `recentChat` keeps its meaning of assistant rows only, unchanged for every
    // consumer, and the anchor keeps pointing at the newest assistant row.
    const recent = await db()
      .select({
        id: characterChatMessages.id,
        content: characterChatMessages.content,
        role: characterChatMessages.role,
      })
      .from(characterChatMessages)
      .where(eq(characterChatMessages.chatId, args.chatId))
      .orderBy(desc(characterChatMessages.createdAt))
      .limit(SCENE_CHAT_CONTEXT);
    const recentChat = recent
      .filter((row) => row.role === "assistant")
      .map((row) => row.content)
      .reverse();
    const recentPlayerChat = recent
      .filter((row) => row.role === "user")
      .map((row) => row.content)
      .reverse();
    const anchorMessageId = args.anchorMessageId ?? recent.find((row) => row.role === "assistant")?.id;

    const scenario = await loadChatScenario(args.chatId);
    // Read separately from the scenario, and outside it, on purpose: the composer-model
    // override is operational config that a retake must not revert (chat-state.ts).
    const composerModel = await loadChatComposerModel(args.chatId);

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
    // Character names are NOT unique, and every downstream binding is by name —
    // the plan's roster map, the composer's dedupe, the prompt's reference set.
    // Two same-named people collapse into one there, so the model cannot tie each
    // face to its own reference and the cast clause never fires. The lab refuses
    // this outright, which is right for an experiment; a player-facing render
    // degrades instead (docs/resilience.md) and draws the first of the pair.
    const castNames = new Set<string>();
    const cleanCast = castStates.filter(({ member }) => {
      const key = member.name.trim().toLowerCase();
      if (key && castNames.has(key)) {
        log.warn("chat_scene", "two present characters share a name — rendering only the first", {
          chatId: args.chatId,
          name: member.name,
        });
        return false;
      }
      castNames.add(key);
      return true;
    });

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
    const castDetail = await Promise.all(
      cleanCast.map(async ({ member, stored }) => {
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
          member: {
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
            // The same persisted overlays the look key above hashes — the render
            // has to RESOLVE them too, or a recorded haircut invalidates the
            // anchor without ever reaching the prompt that describes the hair.
            attributeOverlays: stored?.attributeOverlays,
            lookKey,
          },
          // Kept beside the member for the cast-1 visual cut below — the SAME
          // state and wardrobe resolution the member's fields came from, never
          // a second load that could disagree with them.
          stored,
          wardrobe,
        };
      }),
    );
    const cast = castDetail.map((detail) => detail.member);

    // The cast-1 digest cut (image-lane-consolidation Stage 3, WP-C): when one
    // subject will be drawn — a lone present member, or any selfie — hand the
    // render their committed chat cut as a camera-less shadow input through the
    // SHARED factory the inspector preview uses. The render binds the resolved
    // plan's committed camera into the one selection pass and produces the
    // focal spec's character fields from the digest; a cast of 2+ passes
    // nothing and keeps the legacy field production untouched (Stage 4).
    let subjectVisual: Omit<VisualStateShadowInput, "sink" | "camera"> | undefined;
    const sole = cast.length === 1 ? castDetail[0] : undefined;
    if (sole !== undefined) {
      const [participant] = await db()
        .select({ memoryGroupId: chatParticipants.memoryGroupId })
        .from(chatParticipants)
        .where(
          and(eq(chatParticipants.chatId, args.chatId), eq(chatParticipants.characterId, sole.member.characterId)),
        )
        .limit(1);
      if (participant) {
        subjectVisual = chatVisualStateShadowInput({
          characterId: sole.member.characterId,
          memoryGroupId: participant.memoryGroupId,
          // A job-local cut id: the render realizes the cut it assembles, so
          // the digest's `forCutId` gate matches by construction and the row's
          // provenance names the moment it was asked over.
          cutId: `chat_scene:${anchorMessageId ?? args.chatId}`,
          cut: {
            profile: sole.member.profile,
            // The raw stored cut the member's own fields resolve from, seeded
            // exactly as a first exchange would seed it when no row exists yet.
            state: sole.stored ?? seedChatState(sole.member.profile),
            scenario: scenario ?? seedChatScenario(sole.member.profile),
            ...(sole.wardrobe === null ? {} : { wardrobe: sole.wardrobe }),
            owner: args.userId,
          },
        });
      } else {
        // A structurally guaranteed row is missing — corrupt membership.
        // Degrade to the legacy field production (a degraded default over a
        // failed turn) rather than refusing over a continuity id.
        log.warn("chat_scene", "no participant row for scene subject — visual digest skipped", {
          chatId: args.chatId,
          characterId: sole.member.characterId,
        });
      }
    }
    // What the chat's typed movements have actually COMMITTED about each cast member and the
    // player (scene-composition.plan.md slice 3) — posture, facing, distance, touch. A
    // provenance-carrying fact outranks anything the shot planner infers from prose, so these
    // reach it as authoritative context and clamp its camera proposal. Sparse coverage is
    // expected while the typed-movement lane gathers data: a member with nothing committed is
    // simply absent from the map, and an empty map behaves exactly like slices 1–2. Nothing
    // is written back — the resolved camera lives and dies inside one render job.
    const committedScene = new Map<string, CommittedSceneFacts>();
    if (scenario) {
      for (const member of cast) {
        const facts = committedSceneFactsFor(
          scenario.scene,
          affordanceSubjectId(member.characterId),
          CHAT_CONTACT_PLAYER_SUBJECT,
        );
        if (Object.keys(facts).length > 0) committedScene.set(normalizeName(member.name), facts);
      }
    }

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
        // Only when overridden: on the default this key is absent, so a job row can be
        // read as "whatever the app default was" rather than pinning a value nobody chose.
        ...(composerModel ? { composerModel } : {}),
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
          recentPlayerChat,
          committedScene,
          playerExposure: playerWardrobe?.exposure,
          playerAttributes: playerResolved,
          playerProfile,
          chatId: args.chatId,
          anchorMessageId,
          flavor: args.flavor,
          place: place?.imageId ? { name: place.name, imageId: place.imageId } : undefined,
          sceneModel: scenario?.sceneModel,
          composerModel,
          subjectVisual,
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
