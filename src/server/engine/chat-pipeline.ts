import { and, eq, ne, sql } from "drizzle-orm";
import { characterProfileSchema, DiagnosticCollector, emptyCharacterProfile, splitStateCues } from "@/contracts";
import { newId } from "@/lib/ids";
import { parseOr } from "@/lib/parse";
import { characterChats, characterChatMessages, chatParticipants, db, images } from "../db";
import { log } from "../log";
import { resolvePlayerPersona } from "../players";
import { streamCharacterChat } from "./character-chat";
import { chatCueInviteLine, detectChatCue } from "./chat-intent";
import { deleteChatMemory, retrieveChatMemory } from "./chat-memory";
import { driftChatState, finalizeChatState, loadChatState, persistChatState, seedChatState } from "./chat-state";
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
 * parse → auth → stream shell. Keyed on the conversation (spec §1): the route
 * resolves chat + participant + character and hands their slices in.
 */

export interface SubmitChatMessageInput {
  /** The conversation (already authorized + not archived — the route owns both checks). */
  chatId: string;
  /** The participant's memory group (spec §1.3) — the RAG scope for recall + writes. */
  memoryGroupId: string;
  /** The (v1 single) participant character row slice. */
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
  const { chatId, memoryGroupId } = input;
  const { id: characterId, name: characterName } = input.character;
  const opening = input.open === true;
  const content = input.content ?? "";

  let releaseChatLock!: () => void;
  const chatLockGate = new Promise<void>((resolve) => {
    releaseChatLock = resolve;
  });
  const chatLock = tryKeyedLock(`chat_exchange:${chatId}`, () => chatLockGate);
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
    // guarded against it (persistAssistantReply): if a concurrent delete removes this
    // row mid-stream, the reply is dropped rather than orphaned. The opening beat has
    // no player line, so no guard row. Every exchange bumps the Chats-list recency.
    const promptMessageId = newId();
    if (!opening) {
      await db().insert(characterChatMessages).values({ id: promptMessageId, chatId, role: "user", content });
    }
    await db().update(characterChats).set({ lastMessageAt: new Date() }).where(eq(characterChats.id, chatId));

    // The running summary covers everything up to its watermark; the verbatim
    // window is every message after it (includes the line just inserted). No
    // summary row ⇒ the old last-40 behavior, unchanged.
    const summaryState = await loadChatSummary(chatId);
    const history = await loadVerbatimWindow(chatId, summaryState?.watermark ?? null);

    // The verbatim tail has grown to the fold trigger → fold the oldest exchanges
    // into the running summary. Fire-and-forget: a detached job that runs
    // concurrently with this reply and never adds latency to it.
    if (history.length >= CHARACTER_CHAT_SUMMARIZE_AT * 2) {
      void enqueueChatSummary({ chatId });
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
    const owner = await chatOwnerId(chatId);
    const player = await resolvePlayerPersona(owner);

    // Chat state (character-chat-state.spec.md §5), per participant (spec §1.2): load
    // (or lazily seed from the authored defaults), then recompute drift — between-visit
    // recovery toward rested + this exchange's within-visit tick. Pure; persisted once
    // at turn end.
    const now = new Date();
    const sink = new DiagnosticCollector();
    const storedState = await loadChatState(chatId, characterId, sink);
    const driftedState = driftChatState(storedState ?? seedChatState(profile), now, profile, { advance: true });

    // RAG long-term memory (character-chat-primary.spec.md §2): recall the participant's
    // memory group, keyed on last turn's memory queries + this input. A failed leg
    // degrades to [] with a diagnostic (never a failed reply).
    const memory = await retrieveChatMemory({
      groupId: memoryGroupId,
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
          await db()
            .insert(characterChatMessages)
            .values({ chatId, speakerCharacterId: characterId, role: "assistant", content: full });
          try {
            const surfacedCues = splitStateCues(driftedState.meters, driftedState.surfacedCues).nextBands;
            await persistChatState(chatId, characterId, { ...driftedState, surfacedCues, lastInteractionAt: now });
          } catch (error) {
            log.error("engine.chat", "chat-state opening persist failed", { error: describeError(error) });
          }
        }
      : async (full: string): Promise<void> => {
          await persistAssistantReply({ chatId, speakerCharacterId: characterId, promptMessageId, content: full });
          try {
            await finalizeChatState({
              chatId,
              characterId,
              memoryGroupId,
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

/** The chat's owner id (for persona resolution) — one indexed lookup. */
async function chatOwnerId(chatId: string): Promise<string> {
  const [row] = await db()
    .select({ ownerId: characterChats.ownerId })
    .from(characterChats)
    .where(eq(characterChats.id, chatId))
    .limit(1);
  if (!row) throw new Error(`chat ${chatId} vanished mid-exchange`);
  return row.ownerId;
}

/**
 * Persist the assistant reply, but only if the user line that prompted it still
 * exists — an atomic `INSERT … SELECT … WHERE EXISTS`. The reply is written when
 * the stream settles (even after a client disconnect, docs/resilience.md §5), so
 * a chat delete or a single-message delete that lands while the stream is still
 * draining would otherwise leave an orphan row. Keying the guard on the prompting
 * row makes the write no-op in that race. `id` is JS-generated (cuid2
 * `$defaultFn`, no DB default), so it must be supplied explicitly in the raw
 * insert; `created_at` defaults in the DB.
 *
 * Exported as a test seam: a real mid-stream delete isn't deterministically
 * reproducible through the streaming Response, so the guard is covered directly.
 */
export async function persistAssistantReply(args: {
  chatId: string;
  speakerCharacterId: string;
  promptMessageId: string;
  content: string;
}): Promise<void> {
  await db().execute(sql`
    insert into ${characterChatMessages} (id, chat_id, speaker_character_id, role, content)
    select ${newId()}, ${args.chatId}, ${args.speakerCharacterId}, 'assistant', ${args.content}
    where exists (
      select 1 from ${characterChatMessages} where id = ${args.promptMessageId}
    )
  `);
}

/**
 * Hard-delete a conversation (character-chat-standalone.spec.md §1.4 — archive is
 * the everyday action; this is the one destructive verb). One transaction: the
 * chat row's FK cascades take the transcript, summary, participant rows, and
 * per-participant state; the scene-image prompt text is scrubbed (assets survive,
 * but their prompts embed chat lines — still character-keyed, so scenes from a
 * sibling conversation with the same character are scrubbed too; acceptable until
 * scene images are chat-keyed); and each participant's memory group is purged
 * **only when no other conversation references it** — shared-history siblings
 * keep the relationship's memory alive (D7).
 */
export async function deleteChat(chat: { id: string; ownerId: string }): Promise<void> {
  const participants = await db()
    .select({ characterId: chatParticipants.characterId, memoryGroupId: chatParticipants.memoryGroupId })
    .from(chatParticipants)
    .where(eq(chatParticipants.chatId, chat.id));

  await db().transaction(async (tx) => {
    for (const p of participants) {
      await tx
        .update(images)
        .set({ prompt: "" })
        .where(
          and(
            eq(images.ownerId, chat.ownerId),
            eq(images.kind, "scene"),
            eq(images.entityKind, "character"),
            eq(images.entityId, p.characterId),
          ),
        );
    }
    await tx.delete(characterChats).where(eq(characterChats.id, chat.id));
    for (const p of participants) {
      const [survivor] = await tx
        .select({ chatId: chatParticipants.chatId })
        .from(chatParticipants)
        .where(and(eq(chatParticipants.memoryGroupId, p.memoryGroupId), ne(chatParticipants.chatId, chat.id)))
        .limit(1);
      if (!survivor) await deleteChatMemory(p.memoryGroupId, tx);
    }
  });
}
