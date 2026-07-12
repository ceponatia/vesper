import fs from "node:fs/promises";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import {
  characterProfileSchema,
  chatSceneMemorySchema,
  emptyCharacterProfile,
  emptyChatSceneMemory,
  samePlaceName,
  withPlaceImage,
} from "@/contracts";
import { parseOr, parseOrNull } from "@/lib/parse";
import { isDemoMode } from "../ai";
import { characterChats, characterChatState, characters, db, images } from "../db";
import { absoluteImagePath, chatHasRenders, chatLookKey, latestChatLook, renderChatLookImage, renderChatPlaceImage } from "../images";
import { loadChatState, resolveSeededOutfit } from "./chat-state";
import { registerJobHandler } from "./jobs";

/**
 * The two detached chat reference-image job HANDLERS (chat-scene-references.plan.md;
 * enqueues live in chat-reference-enqueue.ts to avoid a chat-state import cycle) —
 * the `chat_scene_sketch` shape (deduped one-live-per-chat, never the exchange
 * lock, fire-and-forget, self-healing on any lost race):
 *
 * - `chat_look_image`: mint/refresh the outfit-true look anchor when the
 *   archivist records an outfit/appearance change — image-active chats only
 *   (owner ruling: a chat that never rendered pays nothing).
 * - `chat_place_image`: mint the current place's establishing shot from its
 *   sketch, CAS-written onto `scene_memory` like the sketch itself.
 */

const lookPayloadSchema = z.object({ chatId: z.string().min(1), characterId: z.string().min(1) });
const placePayloadSchema = lookPayloadSchema.extend({ placeName: z.string().min(1) });

/** The chat's owner + the participant character's render inputs, or null when anything is missing. */
async function loadRenderContext(chatId: string, characterId: string) {
  const [chat] = await db()
    .select({ ownerId: characterChats.ownerId })
    .from(characterChats)
    .where(eq(characterChats.id, chatId))
    .limit(1);
  const [character] = await db()
    .select({ profile: characters.profile, avatarImageId: characters.avatarImageId })
    .from(characters)
    .where(eq(characters.id, characterId))
    .limit(1);
  if (!chat || !character) return null;
  const profile = parseOr(characterProfileSchema, character.profile ?? {}, emptyCharacterProfile(), undefined, "characters.profile");
  return { ownerId: chat.ownerId, profile, avatarImageId: character.avatarImageId };
}

/** Run one look mint. Exported for tests. */
export async function runChatLookImage(input: z.infer<typeof lookPayloadSchema>): Promise<void> {
  if (isDemoMode()) return;
  // Image-active gate (ruled): text-only chats never pay for look renders.
  if (!(await chatHasRenders(input.chatId))) return;
  const ctx = await loadRenderContext(input.chatId, input.characterId);
  if (!ctx?.avatarImageId) return; // no identity source — scenes fall back to text anyway
  const stored = await loadChatState(input.chatId, input.characterId);
  if (!stored) return;
  const state = await resolveSeededOutfit(stored, ctx.ownerId, ctx.profile);
  const lookKey = chatLookKey(state);
  if (await latestChatLook(input.chatId, lookKey)) return; // already fresh (a lost race, or a no-op change)

  // The identity source: the canonical avatar's bytes (owned + ready).
  const [avatarRow] = await db()
    .select()
    .from(images)
    .where(and(eq(images.id, ctx.avatarImageId), eq(images.ownerId, ctx.ownerId), eq(images.status, "ready")))
    .limit(1);
  if (!avatarRow) return;
  let avatar: Buffer;
  try {
    avatar = await fs.readFile(absoluteImagePath(avatarRow));
  } catch {
    return; // file lost — the sweep reconciles; the next change re-fires
  }

  await renderChatLookImage({
    chatId: input.chatId,
    userId: ctx.ownerId,
    characterId: input.characterId,
    avatar,
    lookKey,
    outfit: state.outfit,
    outfitExposed: state.outfitExposed,
  });
}

/** Run one place mint + CAS write. Exported for tests. */
export async function runChatPlaceImage(input: z.infer<typeof placePayloadSchema>): Promise<void> {
  if (isDemoMode()) return;
  const ctx = await loadRenderContext(input.chatId, input.characterId);
  if (!ctx) return;
  const stateWhere = and(eq(characterChatState.chatId, input.chatId), eq(characterChatState.characterId, input.characterId));
  const [row] = await db().select({ sceneMemory: characterChatState.sceneMemory }).from(characterChatState).where(stateWhere).limit(1);
  if (!row) return;
  const memory = parseOr(chatSceneMemorySchema, row.sceneMemory ?? {}, emptyChatSceneMemory(), undefined, "character_chat_state.scene_memory");
  const place = memory.places.find((p) => samePlaceName(p.name, input.placeName));
  if (!place?.sketch || place.imageId) return; // unsketchd, evicted, or already imaged

  const imageId = await renderChatPlaceImage({
    chatId: input.chatId,
    userId: ctx.ownerId,
    placeName: place.name,
    sketch: place.sketch,
  });
  if (!imageId) return;

  // Optimistic CAS against the RAW stored jsonb (the chat_scene_sketch shape): a
  // concurrent exchange rewrite makes this match zero rows, and the lazy trigger
  // simply re-fires on the next render there (the orphaned asset sweeps away with
  // the chat; a re-mint replaces the dangling pointer).
  const [fresh] = await db().select({ sceneMemory: characterChatState.sceneMemory }).from(characterChatState).where(stateWhere).limit(1);
  if (!fresh) return;
  const before = parseOr(chatSceneMemorySchema, fresh.sceneMemory ?? {}, emptyChatSceneMemory(), undefined, "character_chat_state.scene_memory");
  const after = withPlaceImage(before, place.name, imageId);
  if (after === before) return;
  const beforeJson = JSON.stringify(fresh.sceneMemory ?? {});
  const afterJson = JSON.stringify(after);
  await db().execute(sql`
    update ${characterChatState}
    set scene_memory = ${afterJson}::jsonb, updated_at = now()
    where chat_id = ${input.chatId} and character_id = ${input.characterId}
      and scene_memory = ${beforeJson}::jsonb
  `);
}

registerJobHandler("chat_look_image", async (job) => {
  const payload = parseOrNull(lookPayloadSchema, job.payload, undefined, "jobs.chat_look_image.payload");
  if (!payload) return;
  await runChatLookImage(payload);
});

registerJobHandler("chat_place_image", async (job) => {
  const payload = parseOrNull(placePayloadSchema, job.payload, undefined, "jobs.chat_place_image.payload");
  if (!payload) return;
  await runChatPlaceImage(payload);
});
