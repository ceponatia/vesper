import { and, eq, sql } from "drizzle-orm";
import { characterProfileSchema, DiagnosticCollector, emptyCharacterProfile, splitStateCues } from "@/contracts";
import { newId } from "@/lib/ids";
import { parseOr } from "@/lib/parse";
import { characterChatMessages, characterChatSummaries, db, images } from "../db";
import { log } from "../log";
import { resolvePlayerPersona } from "../players";
import { streamCharacterChat } from "./character-chat";
import { chatCueInviteLine, detectChatCue } from "./chat-intent";
import { deleteChatMemory, retrieveChatMemory } from "./chat-memory";
import {
  deleteChatState,
  driftChatState,
  finalizeChatState,
  loadChatState,
  persistChatState,
  seedChatState,
} from "./chat-state";
import { enqueueChatSummary, loadChatSummary, loadVerbatimWindow } from "./chat-summary";
import { CHARACTER_CHAT_SUMMARIZE_AT } from "./constants";
import { tryKeyedLock } from "./keyed-lock";
import { buildCharacterChatSystemPrompt } from "./prompts/character-chat";
import { narrationShapeId } from "./prompts/constants";

/**
 * The character-chat exchange pipeline (docs/character-chat.md) — the chat lane's
 * `submitTurn` analogue (character-chat-standalone.spec.md §3, codebase-review D1).
 * Owns everything between "a validated send arrived" and "the reply stream settled":
 * the per-chat exchange lock, the user-line insert, summary + verbatim-window
 * assembly, state drift, RAG recall, prompt build, the model stream, and the settle
 * work (reply persistence + the post-turn fan-out). The HTTP route stays a thin
 * parse → auth → stream shell around `submitChatMessage`.
 */

export interface SubmitChatMessageInput {
  ownerId: string;
  /** The already-authorized character row slice (the route owns the ownership check). */
  character: { id: string; name: string; profile: unknown };
  /** The player's line; ignored (and typically absent) when `open` is true. */
  content?: string;
  /** Optional narrator-model override (a curated NARRATIVE_MODELS id). */
  model?: string;
  /**
   * Opening beat (character-chat-state.spec.md slice 4 "Prompt Character"): no
   * player line — the character opens the scene from the premise + seeded warmth.
   */
  open?: boolean;
}

export type SubmitChatMessageResult =
  | { ok: false; code: "chat_busy"; message: string }
  | { ok: true; stream: AsyncGenerator<string, void, unknown> };

/** A synthetic, non-persisted cue that gives the model a turn to respond to when the character opens the scene. */
const OPENING_CUE = "(Open the scene. Speak first, in character.)";

/** One exchange in flight per chat; the second concurrent submit sees `chat_busy`. */
function chatExchangeLockKey(ownerId: string, characterId: string): string {
  return `chat_exchange:${ownerId}:${characterId}`;
}

const describeError = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * Run one chat exchange. Returns `chat_busy` if a reply is still streaming for this
 * chat (codebase-review A6 — without the lock, two concurrent submits each load +
 * drift the same state row and the finalizers land last-write-wins). On success the
 * returned generator streams reply tokens; when it is drained to completion — the
 * route keeps draining even after a client disconnect (docs/resilience.md §5) — the
 * reply persists, the post-turn fan-out runs, and the exchange lock releases. The
 * lock is released on every path (including an assembly throw before streaming).
 */
export async function submitChatMessage(input: SubmitChatMessageInput): Promise<SubmitChatMessageResult> {
  const { ownerId } = input;
  const { id: characterId, name: characterName } = input.character;
  const opening = input.open === true;
  const content = input.content ?? "";

  let releaseChatLock!: () => void;
  const chatLockGate = new Promise<void>((resolve) => {
    releaseChatLock = resolve;
  });
  const chatLock = tryKeyedLock(chatExchangeLockKey(ownerId, characterId), () => chatLockGate);
  if (chatLock === null) {
    return { ok: false, code: "chat_busy", message: "a reply is still streaming for this chat; wait for it to finish" };
  }
  void chatLock; // resolves via releaseChatLock; never rejects

  try {
    return { ok: true, stream: await prepareExchange() };
  } catch (err) {
    releaseChatLock();
    throw err;
  }

  /** Pre-turn assembly: user line → window/summary → drift → recall → prompt → model stream. */
  async function prepareExchange(): Promise<AsyncGenerator<string, void, unknown>> {
    // Normal turn: mint the user line's id up front so the assistant persist can be
    // guarded against it (persistAssistantReply): if a concurrent clear or
    // single-message delete removes this row mid-stream, the reply is dropped rather
    // than orphaned. The opening beat has no player line, so no guard row.
    const promptMessageId = newId();
    if (!opening) {
      await db()
        .insert(characterChatMessages)
        .values({ id: promptMessageId, ownerId, characterId, role: "user", content });
    }

    // The running summary covers everything up to its watermark; the verbatim
    // window is every message after it (includes the line just inserted). No
    // summary row ⇒ the old last-40 behavior, unchanged
    // (docs/developer-notes/finished/character-chat-summary.plan.md).
    const summaryState = await loadChatSummary(ownerId, characterId);
    const history = await loadVerbatimWindow(ownerId, characterId, summaryState?.watermark ?? null);

    // The verbatim tail has grown to the fold trigger → fold the oldest exchanges
    // into the running summary. Fire-and-forget: a detached job that runs
    // concurrently with this reply and never adds latency to it.
    if (history.length >= CHARACTER_CHAT_SUMMARIZE_AT * 2) {
      void enqueueChatSummary({ ownerId, characterId });
    }

    const profile = parseOr(
      characterProfileSchema,
      input.character.profile ?? {},
      emptyCharacterProfile(),
      undefined,
      "characters.profile",
    );
    // The user's default player character (player-character.plan.md), so the
    // character addresses someone by name instead of a faceless "the user".
    const player = await resolvePlayerPersona(ownerId);

    // Light chat state (character-chat-state.spec.md §5): load (or lazily seed from
    // the authored defaults), then recompute drift — between-visit recovery toward
    // rested + this exchange's within-visit tick. Pure; persisted once at turn end.
    const now = new Date();
    const sink = new DiagnosticCollector();
    const storedState = await loadChatState(ownerId, characterId, sink);
    const driftedState = driftChatState(storedState ?? seedChatState(profile), now, profile, { advance: true });

    // RAG long-term memory (character-chat-primary.spec.md §2): recall the chat's own facts +
    // episodes, keyed on last turn's memory queries + this input. A failed leg degrades to []
    // with a diagnostic (never a failed reply); an opening beat has no input yet but may still
    // recall via stored queries. Runs before prompt build so hits ride in as a recall block.
    const memory = await retrieveChatMemory({
      ownerId,
      characterId,
      queries: driftedState.memoryQueries,
      input: opening ? "" : content,
      sink,
    });

    const system = buildCharacterChatSystemPrompt({
      name: characterName,
      profile,
      priorSummary: summaryState?.summary,
      memory,
      player: { name: player.name, persona: player.persona },
      state: {
        meters: driftedState.meters,
        affinity: driftedState.affinity,
        conditions: driftedState.conditions,
        mindNote: driftedState.mindNote,
        premise: driftedState.premise,
        surfacedCues: driftedState.surfacedCues,
        outfit: driftedState.outfit,
        outfitExposed: driftedState.outfitExposed,
        activeSocialCards: driftedState.activeSocialCards,
        attributeOverlays: driftedState.attributeOverlays,
      },
      opening,
      narrationShape: narrationShapeId("chat"),
      // One-turn cue invitation (§7): an opening beat has no player input to read.
      cueInvite: opening ? undefined : chatCueInviteLine(detectChatCue(content), characterName),
    });
    // The opening beat has no player turn — give the model a synthetic (non-persisted)
    // cue to respond to so it produces the character's first line.
    const modelHistory = opening ? [...history, { role: "user" as const, content: OPENING_CUE }] : history;
    const gen = streamCharacterChat({ system, history: modelHistory, name: characterName, model: input.model });

    // Settle work (runs once the reply has fully streamed):
    // - opening beat: persist only the character's line (no guard row exists), then fold
    //   drift into the state — no pulse, since there was no player act to react to. The
    //   opening beat shows state to the narrator too, so record the bands surfaced so the
    //   first real turn doesn't re-announce them (character-chat-state-narration.spec.md §5).
    // - normal turn: persist the reply (guarded), then run the post-turn fan-out. The reply
    //   has already flushed to the client, so this is invisible to perceived latency; a
    //   pulse failure degrades to drift-only state and never affects the saved reply.
    const settle = opening
      ? async (full: string): Promise<void> => {
          await db().insert(characterChatMessages).values({ ownerId, characterId, role: "assistant", content: full });
          try {
            const surfacedCues = splitStateCues(driftedState.meters, driftedState.surfacedCues).nextBands;
            await persistChatState(ownerId, characterId, { ...driftedState, surfacedCues, lastInteractionAt: now });
          } catch (error) {
            log.error("engine.chat", "chat-state opening persist failed", { error: describeError(error) });
          }
        }
      : async (full: string): Promise<void> => {
          await persistAssistantReply({ ownerId, characterId, promptMessageId, content: full });
          try {
            await finalizeChatState({
              ownerId,
              characterId,
              promptMessageId,
              profile,
              characterName,
              playerName: player.name,
              driftedState,
              now,
              exchange: { player: content, assistant: full },
              retrieved: memory,
              sink,
            });
          } catch (error) {
            log.error("engine.chat", "chat-state finalize failed", { error: describeError(error) });
          }
          if (sink.items.length) {
            log.info("engine.chat", "chat-state diagnostics", { codes: sink.items.map((d) => d.code) });
          }
        };

    return streamExchange(gen, settle);
  }

  /**
   * Wrap the model stream so persistence + fan-out + lock release ride the
   * generator's own completion: the route (or any consumer) just drains it. A
   * model-stream failure keeps whatever accumulated (persisted if non-empty); an
   * empty reply skips settle; the lock releases on every path.
   */
  async function* streamExchange(
    gen: AsyncGenerator<string>,
    settle: (full: string) => Promise<void>,
  ): AsyncGenerator<string, void, unknown> {
    let full = "";
    try {
      try {
        for await (const delta of gen) {
          full += delta;
          yield delta;
        }
      } catch (error) {
        log.warn("engine.chat", "reply stream failed", { error: describeError(error) });
      }
      if (full.trim()) {
        try {
          await settle(full);
        } catch (error) {
          log.error("engine.chat", "failed to persist assistant reply", { error: describeError(error) });
        }
      }
    } finally {
      releaseChatLock();
    }
  }
}

/**
 * Persist the assistant reply, but only if the user line that prompted it still
 * exists — an atomic `INSERT … SELECT … WHERE EXISTS`. The reply is written when
 * the stream settles (even after a client disconnect, docs/resilience.md §5), so
 * a clear (`DELETE /chat`) or a single-message delete that lands while the stream
 * is still draining would otherwise leave an orphan row in a "cleared"
 * conversation. Keying the guard on the prompting row makes the write no-op in
 * that race. `id` is JS-generated (cuid2 `$defaultFn`, no DB default), so it must
 * be supplied explicitly in the raw insert; `created_at` defaults in the DB.
 *
 * Exported as a test seam: a real mid-stream clear isn't deterministically
 * reproducible through the streaming Response, so the guard is covered directly.
 */
export async function persistAssistantReply(args: {
  ownerId: string;
  characterId: string;
  promptMessageId: string;
  content: string;
}): Promise<void> {
  await db().execute(sql`
    insert into ${characterChatMessages} (id, owner_id, character_id, role, content)
    select ${newId()}, ${args.ownerId}, ${args.characterId}, 'assistant', ${args.content}
    where exists (
      select 1 from ${characterChatMessages} where id = ${args.promptMessageId}
    )
  `);
}

/**
 * The single **Clear Chat** (character-chat-primary.spec.md §4, D4): one action that
 * wipes EVERYTHING for this conversation. It supersedes the old three-scope reset
 * (all/chat/state) — testing showed no value in clearing chat or state alone. One
 * transaction (codebase-review A9): a crash mid-clear must not leave a half-cleared
 * conversation (transcript gone, memory still recalling it). It deletes, in order:
 *
 * - the transcript (`character_chat_messages`) and the running summary
 *   (`character_chat_summaries` — its watermark + recap are this chat's short-term memory);
 * - the light-state row (`deleteChatState`);
 * - the RAG long-term memory — this chat's facts + episodes (`deleteChatMemory`, §2);
 * - the scene-image prompt text (kind="scene"): the assets survive, but their prompts embed
 *   recent chat lines, so a cleared conversation must not leave old context visible in the
 *   gallery enlarge view. Only the derived `prompt` is reset (column default "").
 *
 * State + memory then re-seed lazily from the authored defaults on the next exchange.
 */
export async function clearCharacterChat(ownerId: string, characterId: string): Promise<void> {
  await db().transaction(async (tx) => {
    await tx
      .delete(characterChatMessages)
      .where(and(eq(characterChatMessages.ownerId, ownerId), eq(characterChatMessages.characterId, characterId)));
    await tx
      .delete(characterChatSummaries)
      .where(and(eq(characterChatSummaries.ownerId, ownerId), eq(characterChatSummaries.characterId, characterId)));
    await deleteChatState(ownerId, characterId, tx);
    await deleteChatMemory(ownerId, characterId, tx);
    await tx
      .update(images)
      .set({ prompt: "" })
      .where(
        and(
          eq(images.ownerId, ownerId),
          eq(images.kind, "scene"),
          eq(images.entityKind, "character"),
          eq(images.entityId, characterId),
        ),
      );
  });
}
