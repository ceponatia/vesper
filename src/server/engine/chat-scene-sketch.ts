import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import {
  CHAT_DEFAULT_CALENDAR_START,
  chatSceneMemorySchema,
  chatSceneSketchSchema,
  degradedChatSceneSketch,
  emptyChatSceneMemory,
  samePlaceName,
  timeOfDayFor,
  withPlaceSketch,
  type ChatSceneSketch,
} from "@/contracts";
import { calendarStartSchema } from "@/lib/clock";
import { parseOr, parseOrNull } from "@/lib/parse";
import { agentModelId, generateChecked, isDemoMode, withGenerateTimeout } from "../ai";
import { characterChatMessages, characterChats, db, hasLiveChatJob } from "../db";
import { log } from "../log";
import { CHAT_SCENE_SKETCH_MAX_OUTPUT_TOKENS, CHAT_SCENE_SKETCH_TIMEOUT_MS } from "./constants";
import { enqueueJob, registerJobHandler } from "./jobs";
import { buildChatSceneSketchPrompt, CHAT_SCENE_SKETCH_SYSTEM } from "./prompts/chat-scene-sketch";

/**
 * The chat location-sketch job (chat-scene-fidelity.plan.md slice 2b): when the
 * conversation introduces a place, a detached background agent expands it into a compact
 * visual sketch stored on the place's scene-memory record — consumed by the scene image
 * (`room`) and the narrator's Scene block. Fired from `finalizeChatState` AFTER the state
 * write (so the job reads the just-merged memory); never on the reply path.
 *
 * The write-back is an optimistic compare-and-swap on the raw `scene_memory` jsonb —
 * deliberately NOT the exchange keyed lock, so this background write can never 409 a
 * player's send. A lost race (an exchange saving state between our read and write) is
 * self-healing: the absent-sketch trigger re-fires on the next exchange. "Another take"
 * rolling the memory back likewise just re-triggers.
 */

/** How many recent assistant lines ground the sketch in the fiction's own painting of the place. */
const SKETCH_NARRATION_CONTEXT = 3;

export interface EnqueueChatSceneSketchArgs {
  chatId: string;
  characterId: string;
  characterName: string;
  placeName: string;
}

/**
 * Enqueue one sketch job for the chat (detached — no session queue). Deduped like
 * `enqueueChatSummary`: at most one live sketch job per chat. Never throws — the caller
 * is the exchange finalizer, and a failed enqueue only costs a sketch that will re-fire.
 */
export async function enqueueChatSceneSketch(args: EnqueueChatSceneSketchArgs): Promise<void> {
  try {
    if (await hasLiveChatJob("chat_scene_sketch", args.chatId)) return;
    await enqueueJob({ type: "chat_scene_sketch", payload: { ...args } });
  } catch (err) {
    log.warn("chat_scene_sketch", "failed to enqueue sketch", {
      chatId: args.chatId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

const sketchJobPayloadSchema = z.object({
  chatId: z.string().min(1),
  characterId: z.string().min(1),
  characterName: z.string().catch(""),
  placeName: z.string().min(1),
});

/** Run one sketch: read the place, generate, CAS-write. Exported for the int/unit tests. */
export async function runChatSceneSketch(input: z.infer<typeof sketchJobPayloadSchema>): Promise<void> {
  if (isDemoMode()) return;

  // The scene memory + premise live on the CHAT row (the shared scenario,
  // followups ruling 8) — one imagined setting for the whole roster.
  const [row] = await db()
    .select({
      sceneMemory: characterChats.sceneMemory,
      premise: characterChats.premise,
      clockMinutes: characterChats.clockMinutes,
      calendarStart: characterChats.calendarStart,
    })
    .from(characterChats)
    .where(eq(characterChats.id, input.chatId))
    .limit(1);
  if (!row) return;
  const memory = parseOr(
    chatSceneMemorySchema,
    row.sceneMemory ?? {},
    emptyChatSceneMemory(),
    undefined,
    "character_chats.scene_memory",
  );
  const place = memory.places.find((p) => samePlaceName(p.name, input.placeName));
  if (!place || place.sketch) return; // place evicted, renamed, or already sketched

  const recent = await db()
    .select({ content: characterChatMessages.content })
    .from(characterChatMessages)
    .where(and(eq(characterChatMessages.chatId, input.chatId), eq(characterChatMessages.role, "assistant")))
    .orderBy(desc(characterChatMessages.createdAt))
    .limit(SKETCH_NARRATION_CONTEXT);
  const recentNarration = recent.map((r) => r.content).reverse();

  const controller = new AbortController();
  const work = generateChecked<ChatSceneSketch>({
    schema: chatSceneSketchSchema,
    system: CHAT_SCENE_SKETCH_SYSTEM,
    prompt: buildChatSceneSketchPrompt({
      placeName: place.name,
      details: place.details,
      connections: place.connections,
      // Derived from the story clock (chat-clock-calendar.plan.md).
      timeOfDay: timeOfDayFor(
        row.clockMinutes,
        parseOr(calendarStartSchema, row.calendarStart, CHAT_DEFAULT_CALENDAR_START, undefined, "character_chats.calendar_start"),
      ),
      premise: row.premise || undefined,
      characterName: input.characterName,
      recentNarration,
    }),
    modelId: agentModelId(),
    temperature: 0,
    maxOutputTokens: CHAT_SCENE_SKETCH_MAX_OUTPUT_TOKENS,
    code: "chat_scene_sketch.generate",
    fallback: degradedChatSceneSketch,
    signal: controller.signal,
    disableReasoning: true,
    lowLatencyRouting: true,
    repair: false,
    degradeSeverity: "warn",
  });
  const { value, degraded } = await withGenerateTimeout(
    work,
    controller,
    CHAT_SCENE_SKETCH_TIMEOUT_MS,
    "chat_scene_sketch.timeout",
  );
  const sketch = degraded || !value ? "" : value.sketch;
  if (!sketch) return;

  // Optimistic CAS against the RAW stored jsonb (jsonb equality is structural, so key
  // order never matters): if an exchange rewrote scene_memory since our read, the update
  // matches zero rows and the absent-sketch trigger re-fires next exchange.
  const [fresh] = await db()
    .select({ sceneMemory: characterChats.sceneMemory })
    .from(characterChats)
    .where(eq(characterChats.id, input.chatId))
    .limit(1);
  if (!fresh) return;
  const before = parseOr(
    chatSceneMemorySchema,
    fresh.sceneMemory ?? {},
    emptyChatSceneMemory(),
    undefined,
    "character_chats.scene_memory",
  );
  const after = withPlaceSketch(before, place.name, sketch);
  if (after === before) return; // place vanished or got a sketch meanwhile
  const beforeJson = JSON.stringify(fresh.sceneMemory ?? {});
  const afterJson = JSON.stringify(after);
  await db().execute(sql`
    update ${characterChats}
    set scene_memory = ${afterJson}::jsonb
    where id = ${input.chatId}
      and scene_memory = ${beforeJson}::jsonb
  `);
}

registerJobHandler("chat_scene_sketch", async (job) => {
  const payload = parseOrNull(sketchJobPayloadSchema, job.payload, undefined, "jobs.chat_scene_sketch.payload");
  if (!payload) return;
  await runChatSceneSketch(payload);
});
