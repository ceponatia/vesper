import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import {
  characterProfileSchema,
  chatSceneMemorySchema,
  diag,
  DiagnosticCollector,
  emptyCharacterProfile,
  emptyChatSceneMemory,
  garmentActorForCharacter,
  samePlaceName,
  teeSink,
  withPlaceImage,
  type DiagnosticSink,
} from "@/contracts";
import { parseOr, parseOrNull } from "@/lib/parse";
import { logDiagnostics } from "@/server/log";
import { isDemoMode } from "../ai";
import { characterChats, characters, chatParticipants, db } from "../db";
import { chatHasRenders, chatLookKey, latestChatLook, renderChatLookImage, renderChatPlaceImage } from "../images";
import { chatGarmentLookKey } from "./chat-garments";
import { chatVisualStateShadowInput } from "./chat-pipeline";
import { loadChatScenario, loadChatState, seedChatScenario } from "./chat-state";
import { resolveChatWardrobe } from "./chat-wardrobe";
import { registerJobHandler } from "./jobs";

/**
 * The two detached chat reference-image job HANDLERS (enqueues live in
 * chat-reference-enqueue.ts to avoid a chat-state import cycle) —
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

/** Run one look mint. Exported for tests, which may pass a sink to watch the job's diagnostics. */
export async function runChatLookImage(input: z.infer<typeof lookPayloadSchema>, sink?: DiagnosticSink): Promise<void> {
  if (isDemoMode()) return;
  // Image-active gate (ruled): text-only chats never pay for look renders.
  if (!(await chatHasRenders(input.chatId))) return;
  const ctx = await loadRenderContext(input.chatId, input.characterId);
  if (!ctx?.avatarImageId) return; // no identity source — scenes fall back to text anyway
  const stored = await loadChatState(input.chatId, input.characterId);
  if (!stored) return;
  // Detached job, so its own collector drains into the process log (the render
  // lanes' `DiagnosticCollector` + `logDiagnostics` pattern): the wardrobe
  // resolve and the skip decision below used to degrade with NO sink at all,
  // which made a wrong look mint untraceable.
  const collected = new DiagnosticCollector();
  const jobSink: DiagnosticSink = sink ? teeSink(sink, collected) : collected;
  try {
    // Structured wardrobe: resolve the worn state to its rendered look +
    // coverage-computed exposure, and key on the sorted worn ids + overlay + exposure fingerprint.
    // The garment store is the worn truth once the actor is modelled (slice 2) — this job read
    // only the projection column until slice 6, so an arrangement change could not reach it at all.
    const scenario = await loadChatScenario(input.chatId);
    const actorId = garmentActorForCharacter(input.characterId);
    const wardrobe = await resolveChatWardrobe(
      { ...stored, ...(scenario ? { garments: scenario.garments } : {}), garmentActorId: actorId },
      ctx.ownerId,
      ctx.profile,
      jobSink,
    );
    // A resolve marked unreliable is a covered-degraded stand-in, not the
    // wardrobe truth. Minting from it would cache a WRONG look under a key the
    // degraded resolve produced — and the keep-latest purge would then delete
    // the correct anchor. No render, no purge: the next outfit/appearance
    // change re-fires the enqueue and retries against a healthy load.
    if (wardrobe.unreliable === true) {
      jobSink.push(
        diag("warn", "images.chat_look.wardrobe_unreliable", "wardrobe resolve degraded — look mint skipped; the next outfit or appearance change retries", {
          path: "images.chat_look",
          context: { chatId: input.chatId, characterId: input.characterId },
        }),
      );
      return;
    }
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

    // The look mint's digest cut (image-lane-consolidation Stage 4): the SAME
    // committed-cut factory the scene queue and the visual-state inspector use,
    // over the state, scenario and wardrobe THIS job already resolved above —
    // never a second load that could disagree with the key it just hashed.
    //
    // Deliberately AFTER the unreliable-wardrobe skip: the digest re-derives
    // coverage from the garment store internally, and building it before that
    // gate would route around the one check that stops a degraded resolve from
    // minting a wrong anchor and purging the right one.
    //
    // `memoryGroupId` is the only input the job did not already have; the scene
    // queue takes the same select. A missing row is corrupt membership: the
    // mint then receives no cut and refuses before reserving a row
    // (`images.chat_look.visual_cut_missing`), because the compiled program is
    // the only prompt a look can send and there is nothing to compile it over.
    // The next outfit or appearance change re-fires the job.
    const [participant] = await db()
      .select({ memoryGroupId: chatParticipants.memoryGroupId })
      .from(chatParticipants)
      .where(and(eq(chatParticipants.chatId, input.chatId), eq(chatParticipants.characterId, input.characterId)))
      .limit(1);
    if (!participant) {
      jobSink.push(
        diag("warn", "images.chat_look.participant_missing", "no participant row for the look subject — the mint has no cut to compile and will refuse", {
          path: "images.chat_look",
          context: { chatId: input.chatId, characterId: input.characterId },
        }),
      );
    }
    const visual = participant
      ? chatVisualStateShadowInput({
          characterId: input.characterId,
          memoryGroupId: participant.memoryGroupId,
          // A job-local cut id: the mint realizes the cut it assembles, so the
          // digest's `forCutId` gate matches by construction and the row's
          // provenance names the key the anchor was minted under.
          cutId: `chat_look:${lookKey}`,
          cut: {
            profile: ctx.profile,
            state: stored,
            scenario: scenario ?? seedChatScenario(ctx.profile),
            wardrobe,
            owner: ctx.ownerId,
          },
          sink: jobSink,
        })
      : undefined;

    // Identity sourcing lives in the render lane itself (chat-look.ts): the pack
    // service evaluates the character's canonical portrait for the resolved
    // profile, and an ineligible pack reserves nothing — the next change
    // re-fires. The lane drains its OWN diagnostics into the process log, which
    // is why it gets no sink here: teeing this job's collector in would log
    // every render diagnostic twice.
    await renderChatLookImage({
      chatId: input.chatId,
      userId: ctx.ownerId,
      characterId: input.characterId,
      lookKey,
      outfit: wardrobe.garments,
      outfitExposed: wardrobe.exposed,
      // The SAME coverage readout the key above hashed, so the anchor's
      // coverage reads and its cache key cannot disagree.
      exposure: wardrobe.exposure,
      hairOcclusion: wardrobe.hairOcclusion,
      ...(visual === undefined ? {} : { visual }),
      // Visible age comes from the portrait reference itself. Scene-supporting
      // look renders never receive chronological or apparent-age fields.
    });
  } finally {
    logDiagnostics("images.chat_look_image", collected.items, {
      chatId: input.chatId,
      characterId: input.characterId,
    });
  }
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
