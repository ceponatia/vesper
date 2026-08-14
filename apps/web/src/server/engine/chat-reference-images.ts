import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import {
  characterProfileSchema,
  chatSceneMemorySchema,
  emptyCharacterProfile,
  emptyChatSceneMemory,
  garmentActorForCharacter,
  resolveAttributes,
  samePlaceName,
  withPlaceImage,
} from "@/contracts";
import { parseOr, parseOrNull } from "@/lib/parse";
import { isDemoMode } from "../ai";
import { characterChats, characters, db } from "../db";
import { apparentAgeAnchor, chatHasRenders, chatLookKey, latestChatLook, renderChatLookImage, renderChatPlaceImage } from "../images";
import { chatGarmentLookKey } from "./chat-garments";
import { loadChatScenario, loadChatState } from "./chat-state";
import { resolveChatWardrobe } from "./chat-wardrobe";
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
    .select({ name: characters.name, profile: characters.profile, avatarImageId: characters.avatarImageId })
    .from(characters)
    .where(eq(characters.id, characterId))
    .limit(1);
  if (!chat || !character) return null;
  const profile = parseOr(characterProfileSchema, character.profile ?? {}, emptyCharacterProfile(), undefined, "characters.profile");
  return { ownerId: chat.ownerId, name: character.name, profile, avatarImageId: character.avatarImageId };
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
  // Structured wardrobe (chat-wardrobe-parity): resolve the worn state to its rendered look +
  // coverage-computed exposure, and key on the sorted worn ids + overlay + exposure fingerprint.
  // The garment store is the worn truth once the actor is modelled (slice 2) — this job read
  // only the projection column until slice 6, so an arrangement change could not reach it at all.
  const scenario = await loadChatScenario(input.chatId);
  const actorId = garmentActorForCharacter(input.characterId);
  const wardrobe = await resolveChatWardrobe(
    { ...stored, ...(scenario ? { garments: scenario.garments } : {}), garmentActorId: actorId },
    ctx.ownerId,
    ctx.profile,
  );
  const lookKey = chatLookKey({
    wornItemIds: wardrobe.wornItemIds,
    overlay: wardrobe.overlay,
    exposure: wardrobe.exposure,
    attributeOverlays: stored.attributeOverlays,
    // OQ8: the two gates must agree, or the enqueue fires and the job no-ops.
    ...(scenario ? { garmentKey: chatGarmentLookKey(scenario.garments, [actorId], scenario.clockMinutes) } : {}),
  });
  // Scoped to THIS character: a chat-wide freshness read would see a roster
  // sibling's look and skip minting one for the member whose outfit moved.
  if (await latestChatLook(input.chatId, input.characterId, lookKey)) return; // already fresh (a lost race, or a no-op change)

  // Identity sourcing lives in the render lane itself (chat-look.ts): the pack
  // service evaluates the character's canonical portrait for the resolved
  // profile, and an ineligible pack reserves nothing — the next change
  // re-fires. The lane drains its own diagnostics into the process log, so a
  // pack refusal leaves a record even though this detached job has no sink to
  // hand it.
  await renderChatLookImage({
    chatId: input.chatId,
    userId: ctx.ownerId,
    characterId: input.characterId,
    lookKey,
    outfit: wardrobe.garments,
    outfitExposed: wardrobe.exposed,
    // The sheet's age overrules the reference's apparent age (owner ruling
    // 2026-07-29) — without it every look mint drifts a step older.
    ageAnchor: apparentAgeAnchor(ctx.name, resolveAttributes(ctx.profile.attributes, [])),
  });
}

/** Run one place mint + CAS write. Exported for tests. */
export async function runChatPlaceImage(input: z.infer<typeof placePayloadSchema>): Promise<void> {
  if (isDemoMode()) return;
  const ctx = await loadRenderContext(input.chatId, input.characterId);
  if (!ctx) return;
  // Scene memory lives on the CHAT row (the shared scenario, followups ruling 8).
  const [row] = await db().select({ sceneMemory: characterChats.sceneMemory }).from(characterChats).where(eq(characterChats.id, input.chatId)).limit(1);
  if (!row) return;
  const memory = parseOr(chatSceneMemorySchema, row.sceneMemory ?? {}, emptyChatSceneMemory(), undefined, "character_chats.scene_memory");
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
  const [fresh] = await db().select({ sceneMemory: characterChats.sceneMemory }).from(characterChats).where(eq(characterChats.id, input.chatId)).limit(1);
  if (!fresh) return;
  const before = parseOr(chatSceneMemorySchema, fresh.sceneMemory ?? {}, emptyChatSceneMemory(), undefined, "character_chats.scene_memory");
  const after = withPlaceImage(before, place.name, imageId);
  if (after === before) return;
  const beforeJson = JSON.stringify(fresh.sceneMemory ?? {});
  const afterJson = JSON.stringify(after);
  await db().execute(sql`
    update ${characterChats}
    set scene_memory = ${afterJson}::jsonb
    where id = ${input.chatId}
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
