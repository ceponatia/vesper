import type { NextRequest } from "next/server";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import {
  activeConditionSchema,
  characterProfileSchema,
  deriveEmotionLabel,
  effectiveTraitValue,
  emptyCharacterProfile,
  NEUTRAL_MOOD_METER,
  regardBandForValue,
  regardBandToStageId,
  socialReactionCardSchema,
  authoredRecordToLive,
  authoredRelationshipRecordSchema,
} from "@/contracts";
import { newId } from "@/lib/ids";
import { parseOr } from "@/lib/parse";
import { jsonError, jsonOk, readBody, withUser } from "@/server/api";
import { characterChats, characterChatState, characters, chatParticipants, chatScenarioPresets, db } from "@/server/db";
import { editChatState, seedChatRelationships } from "@/server/engine";
import { resolveChatMemoryGroupId } from "./owned";

/**
 * The conversations collection (docs/character-chat.md; character-chat-standalone.spec.md
 * §2.1). GET lists the user's conversations (the Chats page / the editor tab's picker);
 * POST creates one — with the D7 memory choice: "shared" reuses each character's existing
 * memory group (the relationship remembers), "fresh" mints a clean island (an alternate
 * universe). One character can host many conversations. A conversation can hold a roster
 * of up to 4 characters (multi-character-chat.plan.md groundwork) — the first is the
 * primary participant the exchange pipeline runs against; the rest are inert until the
 * multi-character substrate ships.
 */

/** Cap on listed conversations (recency-ordered; nobody scrolls past this in v1). */
const LIST_LIMIT = 100;

/**
 * Roster cap (multi-character-chat.plan.md — "2–4
 * typical"): creation groundwork accepts up to 4 characters; the conversation
 * experience itself stays 1-on-1 with the primary (sort 0) until the
 * multi-character substrate ships.
 */
const MAX_CHAT_PARTICIPANTS = 4;

const createBodySchema = z.object({
  /** Selection order matters: the first id is the primary participant (sort 0). */
  characterIds: z.array(z.string().min(1)).min(1).max(MAX_CHAT_PARTICIPANTS),
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
      regard: characterChatState.regard,
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
    // One list row per chat: the card shows the PRIMARY participant (sort 0);
    // a multi-character roster must not fan the list out per participant.
    .innerJoin(chatParticipants, and(eq(chatParticipants.chatId, characterChats.id), eq(chatParticipants.sort, 0)))
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
        // Membership filter checks the whole roster, not just the primary.
        ...(characterId
          ? [
              sql`exists (select 1 from chat_participants cp where cp.chat_id = ${characterChats.id} and cp.character_id = ${characterId})`,
            ]
          : []),
      ),
    )
    .orderBy(desc(characterChats.lastMessageAt))
    .limit(LIST_LIMIT);

  const chats = rows.map(({ profile, regard, meters, conditions, openLoops, ...rest }) => {
    // "Has something to say" (spec §8.4, D4): a pure read-time derivation off the open
    // loops — no jobs, no push, never the wall clock. The top loop is the reason.
    const loops = parseOr(listLoopsSchema, openLoops ?? [], [], undefined, "character_chat_state.open_loops");
    const say = loops[0]?.trim() ?? "";
    if (regard === null) return { ...rest, regardBand: null, emotion: null, say };
    const parsedMeters = parseOr(listMetersSchema, meters ?? {}, {}, undefined, "character_chat_state.meters");
    const parsedConditions = parseOr(listConditionsSchema, conditions ?? [], [], undefined, "character_chat_state.conditions");
    const prof = parseOr(characterProfileSchema, profile ?? {}, emptyCharacterProfile(), undefined, "characters.profile");
    const band = regardBandForValue(regard);
    // Mirrors chatStateSnapshot's mood-chip inputs (mood.spec §4): chat is an
    // intimate-capable 1-on-1, dominance tilts a low-valence read angry vs sad.
    const emotion = deriveEmotionLabel({
      mood: parsedMeters.mood ?? NEUTRAL_MOOD_METER,
      arousal: parsedMeters.arousal ?? 0,
      stress: parsedMeters.stress ?? 0,
      energy: parsedMeters.energy ?? 1,
      affinityStage: regardBandToStageId(band.id),
      conditions: parsedConditions,
      intimateContext: true,
      dominance: effectiveTraitValue(prof.traits, "social.dominance"),
    });
    return {
      ...rest,
      regardBand: { id: band.id, label: band.label },
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
  const { memory } = body.value;
  const characterIds = [...new Set(body.value.characterIds)];

  const owned = await db()
    .select({ id: characters.id, name: characters.name, profile: characters.profile })
    .from(characters)
    .where(and(inArray(characters.id, characterIds), eq(characters.ownerId, user.id)));
  const byId = new Map(owned.map((c) => [c.id, c]));
  // Selection order is the roster order: first = primary participant (sort 0).
  const roster = characterIds.flatMap((cid) => byId.get(cid) ?? []);
  const [primary] = roster;
  if (roster.length !== characterIds.length || !primary) return jsonError("not_found", "character not found", 404);

  // "shared" reuses each character's existing group (any of the user's chats with that
  // character carries it); no prior chat — or "fresh" — mints a new island per character.
  const participantRows: Array<{ characterId: string; memoryGroupId: string; sort: number }> = [];
  let primaryMemoryGroupId = "";
  for (const [sort, member] of roster.entries()) {
    const memoryGroupId = await resolveChatMemoryGroupId(user.id, member.id, memory, newId());
    participantRows.push({ characterId: member.id, memoryGroupId, sort });
    if (sort === 0) primaryMemoryGroupId = memoryGroupId;
  }

  // A group chat with no explicit title auto-titles from the roster ("Sabrina & Mara")
  // so the Chats list (which shows the primary's card) still reads as a group.
  const title = body.value.title ?? (roster.length > 1 ? roster.map((c) => c.name).join(" & ").slice(0, 120) : "");

  const chatId = newId();
  await db().transaction(async (tx) => {
    await tx.insert(characterChats).values({ id: chatId, ownerId: user.id, title });
    await tx.insert(chatParticipants).values(participantRows.map((row) => ({ chatId, ...row })));
  });
  // Matrix seeding (relationship-model.plan.md §The matrix): the roster's pairs
  // inherit the library-default edges; the in-chat matrix menu overrides on top.
  await seedChatRelationships(chatId, characterIds);

  // Preset seeding (spec §1.5): write the scenario fields exactly the way the
  // scenario modal does — through the author-edit state path, on top of the
  // authored seed (so the character's own cards apply when the preset has none).
  // Roster semantics (multi-character-chat.plan.md slice 1): the shared scene —
  // premise + cards — seeds EVERY member; the character-specific fields (outfit,
  // exposure, the player-edge starting bands) seed the primary only.
  if (body.value.presetId) {
    const [preset] = await db()
      .select({
        premise: chatScenarioPresets.premise,
        outfit: chatScenarioPresets.outfit,
        outfitExposed: chatScenarioPresets.outfitExposed,
        socialCards: chatScenarioPresets.socialCards,
        startingRelationship: chatScenarioPresets.startingRelationship,
      })
      .from(chatScenarioPresets)
      .where(and(eq(chatScenarioPresets.id, body.value.presetId), eq(chatScenarioPresets.ownerId, user.id)))
      .limit(1);
    if (preset) {
      const cards = parseOr(z.array(socialReactionCardSchema), preset.socialCards, [], undefined, "chat_scenario_presets.social_cards");
      // The preset's full authored record seeds the primary's player edge —
      // both band scalars AND the kind/history/mask texture (followups ruling 4).
      const live = authoredRecordToLive(
        parseOr(
          authoredRelationshipRecordSchema,
          preset.startingRelationship,
          authoredRelationshipRecordSchema.parse({}),
          undefined,
          "chat_scenario_presets.starting_relationship",
        ),
      );
      for (const member of roster) {
        const profile = parseOr(characterProfileSchema, member.profile ?? {}, emptyCharacterProfile(), undefined, "characters.profile");
        const isPrimary = member.id === primary.id;
        await editChatState({
          chatId,
          characterId: member.id,
          ownerId: user.id,
          profile,
          patch: {
            premise: preset.premise,
            ...(cards.length ? { activeSocialCards: cards } : {}),
            ...(isPrimary
              ? {
                  outfit: preset.outfit,
                  outfitExposed: preset.outfitExposed,
                  regard: live.regard,
                  familiarity: live.familiarity,
                  relationship: {
                    kind: live.kind,
                    history: live.history,
                    presented: live.presented,
                    looming: live.looming,
                  },
                }
              : {}),
          },
        });
      }
    }
  }

  // `memoryGroupId` is the primary participant's (the shape callers used pre-roster).
  return jsonOk({ id: chatId, memoryGroupId: primaryMemoryGroupId }, 201);
});
