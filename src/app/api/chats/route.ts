import type { NextRequest } from "next/server";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import {
  activeConditionSchema,
  characterProfileSchema,
  clampAffinity,
  deriveEmotionLabel,
  effectiveTraitValue,
  emptyCharacterProfile,
  NEUTRAL_MOOD_METER,
  socialReactionCardSchema,
  stageForValue,
  stageMidpoint,
} from "@/contracts";
import { newId } from "@/lib/ids";
import { parseOr } from "@/lib/parse";
import { jsonError, jsonOk, readBody, withUser } from "@/server/api";
import { characterChats, characterChatState, characters, chatParticipants, chatScenarioPresets, db } from "@/server/db";
import { editChatState } from "@/server/engine";

/**
 * The conversations collection (docs/character-chat.md; character-chat-standalone.spec.md
 * §2.1). GET lists the user's conversations (the Chats page / the editor tab's picker);
 * POST creates one — with the D7 memory choice: "shared" reuses the character's existing
 * memory group (the relationship remembers), "fresh" mints a clean island (an alternate
 * universe). One character can host many conversations.
 */

/** Cap on listed conversations (recency-ordered; nobody scrolls past this in v1). */
const LIST_LIMIT = 100;

const createBodySchema = z.object({
  characterId: z.string().min(1),
  title: z.string().trim().max(120).optional(),
  /** D7: continue the shared history, or a vanilla fresh start. */
  memory: z.enum(["shared", "fresh"]),
  /** Seed the new conversation's scenario from a saved preset (spec §1.5). */
  presetId: z.string().min(1).optional(),
});

const listMetersSchema = z.record(z.string(), z.number());
const listConditionsSchema = z.array(activeConditionSchema);
const listLoopsSchema = z.array(z.string());

/**
 * GET /api/chats?characterId=…&archived=1 — the user's conversations, newest first.
 * Each row carries the relationship-stage + mood chips (derived server-side from the
 * participant's last-persisted state row, the same projection as `chatStateSnapshot`
 * — no drift-on-read; a list is a glance, not a turn). No state row yet ⇒ null chips.
 */
export const GET = withUser(async (user, req: NextRequest) => {
  const url = new URL(req.url);
  const characterId = url.searchParams.get("characterId") ?? undefined;
  const archived = url.searchParams.get("archived") === "1";

  const rows = await db()
    .select({
      id: characterChats.id,
      title: characterChats.title,
      archivedAt: characterChats.archivedAt,
      lastMessageAt: characterChats.lastMessageAt,
      characterId: characters.id,
      characterName: characters.name,
      avatarImageId: characters.avatarImageId,
      profile: characters.profile,
      affinity: characterChatState.affinity,
      meters: characterChatState.meters,
      conditions: characterChatState.conditions,
      openLoops: characterChatState.openLoops,
      lastLine: sql<string | null>`(
        select left(m.content, 160) from character_chat_messages m
        where m.chat_id = ${characterChats.id}
        order by m.created_at desc limit 1
      )`,
    })
    .from(characterChats)
    .innerJoin(chatParticipants, eq(chatParticipants.chatId, characterChats.id))
    .innerJoin(characters, eq(characters.id, chatParticipants.characterId))
    .leftJoin(
      characterChatState,
      and(
        eq(characterChatState.chatId, characterChats.id),
        eq(characterChatState.characterId, chatParticipants.characterId),
      ),
    )
    .where(
      and(
        eq(characterChats.ownerId, user.id),
        archived ? sql`${characterChats.archivedAt} is not null` : isNull(characterChats.archivedAt),
        ...(characterId ? [eq(chatParticipants.characterId, characterId)] : []),
      ),
    )
    .orderBy(desc(characterChats.lastMessageAt))
    .limit(LIST_LIMIT);

  const chats = rows.map(({ profile, affinity, meters, conditions, openLoops, ...rest }) => {
    // "Has something to say" (spec §8.4, D4): a pure read-time derivation off the open
    // loops — no jobs, no push, never the wall clock. The top loop is the reason.
    const loops = parseOr(listLoopsSchema, openLoops ?? [], [], undefined, "character_chat_state.open_loops");
    const say = loops[0]?.trim() ?? "";
    if (affinity === null) return { ...rest, stage: null, emotion: null, say };
    const parsedMeters = parseOr(listMetersSchema, meters ?? {}, {}, undefined, "character_chat_state.meters");
    const parsedConditions = parseOr(listConditionsSchema, conditions ?? [], [], undefined, "character_chat_state.conditions");
    const prof = parseOr(characterProfileSchema, profile ?? {}, emptyCharacterProfile(), undefined, "characters.profile");
    const stage = stageForValue(affinity);
    // Mirrors chatStateSnapshot's mood-chip inputs (mood.spec §4): chat is an
    // intimate-capable 1-on-1, dominance tilts a low-valence read angry vs sad.
    const emotion = deriveEmotionLabel({
      mood: parsedMeters.mood ?? NEUTRAL_MOOD_METER,
      arousal: parsedMeters.arousal ?? 0,
      stress: parsedMeters.stress ?? 0,
      energy: parsedMeters.energy ?? 1,
      affinityStage: stage.id,
      conditions: parsedConditions,
      intimateContext: true,
      dominance: effectiveTraitValue(prof.traits, "social.dominance"),
    });
    return {
      ...rest,
      stage: { id: stage.id, label: stage.label },
      emotion: { label: emotion.emotion, intensity: emotion.intensity },
      say,
    };
  });

  return jsonOk({ chats });
});

/** POST /api/chats — create a conversation with the D7 memory choice. */
export const POST = withUser(async (user, req: NextRequest) => {
  const body = await readBody(req, createBodySchema);
  if (!body.ok) return body.response;
  const { characterId, memory } = body.value;

  const [character] = await db()
    .select({ id: characters.id, profile: characters.profile })
    .from(characters)
    .where(and(eq(characters.id, characterId), eq(characters.ownerId, user.id)))
    .limit(1);
  if (!character) return jsonError("not_found", "character not found", 404);

  // "shared" reuses the character's existing group (any of the user's chats with this
  // character carries it); no prior chat — or "fresh" — mints a new island.
  let memoryGroupId = newId();
  if (memory === "shared") {
    const [existing] = await db()
      .select({ memoryGroupId: chatParticipants.memoryGroupId })
      .from(chatParticipants)
      .innerJoin(characterChats, eq(characterChats.id, chatParticipants.chatId))
      .where(and(eq(characterChats.ownerId, user.id), eq(chatParticipants.characterId, characterId)))
      .orderBy(desc(characterChats.createdAt))
      .limit(1);
    if (existing) memoryGroupId = existing.memoryGroupId;
  }

  const chatId = newId();
  await db().transaction(async (tx) => {
    await tx.insert(characterChats).values({ id: chatId, ownerId: user.id, title: body.value.title ?? "" });
    await tx.insert(chatParticipants).values({ chatId, characterId, memoryGroupId, sort: 0 });
  });

  // Preset seeding (spec §1.5): write the scenario fields exactly the way the
  // scenario modal does — through the author-edit state path, on top of the
  // authored seed (so the character's own cards apply when the preset has none).
  if (body.value.presetId) {
    const [preset] = await db()
      .select({
        premise: chatScenarioPresets.premise,
        outfit: chatScenarioPresets.outfit,
        outfitExposed: chatScenarioPresets.outfitExposed,
        socialCards: chatScenarioPresets.socialCards,
        startingStage: chatScenarioPresets.startingStage,
      })
      .from(chatScenarioPresets)
      .where(and(eq(chatScenarioPresets.id, body.value.presetId), eq(chatScenarioPresets.ownerId, user.id)))
      .limit(1);
    if (preset) {
      const profile = parseOr(characterProfileSchema, character.profile ?? {}, emptyCharacterProfile(), undefined, "characters.profile");
      const cards = parseOr(z.array(socialReactionCardSchema), preset.socialCards, [], undefined, "chat_scenario_presets.social_cards");
      await editChatState({
        chatId,
        characterId,
        profile,
        patch: {
          premise: preset.premise,
          outfit: preset.outfit,
          outfitExposed: preset.outfitExposed,
          affinity: clampAffinity(stageMidpoint(preset.startingStage)),
          ...(cards.length ? { activeSocialCards: cards } : {}),
        },
      });
    }
  }

  return jsonOk({ id: chatId, memoryGroupId }, 201);
});
