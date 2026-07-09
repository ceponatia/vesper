import { and, desc, eq, isNull, lt, ne, or, sql } from "drizzle-orm";
import { z } from "zod";
import { characterProfileSchema, DiagnosticCollector, diag, emptyCharacterProfile, splitStateCues } from "@/contracts";
import { newId } from "@/lib/ids";
import { parseOr } from "@/lib/parse";
import { characterChats, characterChatMessages, chatParticipants, db, images } from "../db";
import { log } from "../log";
import { resolvePlayerPersona } from "../players";
import { streamCharacterChat } from "./character-chat";
import { chatCueInviteLine, detectChatCue } from "./chat-intent";
import { deleteChatMemory, reconcileMessageMemory, retrieveChatMemory, runChatArchivist, writeChatMemory } from "./chat-memory";
import {
  driftChatState,
  finalizeChatState,
  loadChatState,
  loadPreExchangeState,
  persistChatState,
  savePreExchangeSnapshot,
  seedChatState,
  type ChatState,
} from "./chat-state";
import { enqueueChatSummary, loadChatSummary, loadVerbatimWindow } from "./chat-summary";
import { CHARACTER_CHAT_SUMMARIZE_AT, CHAT_REPLY_TAKES_CAP } from "./constants";
import { tryKeyedLock } from "./keyed-lock";
import {
  buildCharacterChatPromptParts,
  buildCharacterChatSystemPrompt,
  chatNotationNote,
  type CharacterChatPromptInput,
} from "./prompts/character-chat";
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
 *
 * Four exchange kinds (spec §4):
 * - **send** — the normal player turn.
 * - **open** — the opening beat ("Prompt character"): no player line, no fan-out.
 * - **continue** — "go on": no player line; the archivist runs (new narrative is
 *   worth remembering) but the reaction pulse is skipped (no player act).
 * - **regenerate** — "another take" on the LAST assistant reply: state rolls back
 *   to the pre-exchange snapshot, the old take's memory is retracted, the reply
 *   row is updated in place with the old take kept browsable (`takes`).
 */

export type ChatExchangeKind = "send" | "open" | "continue" | "regenerate";

export interface SubmitChatMessageInput {
  /** The conversation (already authorized + not archived — the route owns both checks). */
  chatId: string;
  /** The participant's memory group (spec §1.3) — the RAG scope for recall + writes. */
  memoryGroupId: string;
  /** The (v1 single) participant character row slice. */
  character: { id: string; name: string; profile: unknown };
  kind: ChatExchangeKind;
  /** The player's line — required for `send`, ignored for the other kinds. */
  content?: string;
  /** Optional narrator-model override (a curated NARRATIVE_MODELS id). */
  model?: string;
  /**
   * "Has something to say" opener (spec §8.4): the open loop the player tapped,
   * threaded as the continue beat's cue line so the character opens about exactly
   * that. Only read for `kind: "continue"`.
   */
  cue?: string;
  /**
   * "Auto at big moments" hook (slice 9): fired fire-and-forget after the finalizer
   * when the exchange landed a stage crossing / strong reaction AND the chat's
   * `sceneAuto` mode is "milestones". The route owns what happens (queue a scene
   * render anchored to this reply) — the engine only signals.
   */
  onBigMoment?: (info: { assistantMessageId: string }) => void;
}

export type SubmitChatMessageResult =
  | { ok: false; code: "chat_busy" | "nothing_to_regenerate"; message: string }
  | { ok: true; stream: AsyncGenerator<string, void, unknown> };

/** A synthetic, non-persisted cue that gives the model a turn to respond to when the character opens the scene. */
const OPENING_CUE = "(Open the scene. Speak first, in character.)";
/** Synthetic cue for a "go on" continue beat — never persisted into history. */
const CONTINUE_CUE = "(Continue naturally from your last line — one more beat. Do not repeat yourself, and do not speak for the player.)";

const describeError = (error: unknown): string => (error instanceof Error ? error.message : String(error));

// ---------------------------------------------------------------------------
// Reply takes (spec §4.1) — alternate generations browsable on the message row
// ---------------------------------------------------------------------------

const replyTakeSchema = z.object({ id: z.string(), content: z.string(), createdAt: z.string() });
export const replyTakesSchema = z.object({
  takes: z.array(replyTakeSchema).catch([]),
  activeId: z.string().catch(""),
});
export type ReplyTakes = z.infer<typeof replyTakesSchema>;

export const emptyReplyTakes = (): ReplyTakes => ({ takes: [], activeId: "" });

/**
 * Record a fresh take (PURE): the row's current content becomes a browsable entry
 * (seeded lazily on the first regenerate), the new take is appended and made
 * active, and the list is capped at CHAT_REPLY_TAKES_CAP — evicting the oldest
 * non-active entries first.
 */
export function pushReplyTake(
  prior: ReplyTakes,
  currentContent: string,
  newContent: string,
  nowIso: string,
): ReplyTakes {
  let takes = [...prior.takes];
  if (takes.length === 0) {
    takes.push({ id: newId(), content: currentContent, createdAt: nowIso });
  }
  const fresh = { id: newId(), content: newContent, createdAt: nowIso };
  takes.push(fresh);
  while (takes.length > CHAT_REPLY_TAKES_CAP) {
    const evictAt = takes.findIndex((t) => t.id !== fresh.id);
    if (evictAt === -1) break;
    takes.splice(evictAt, 1);
  }
  return { takes, activeId: fresh.id };
}

/**
 * Make one recorded take the displayed reply: the row's `content` is updated to
 * mirror it (spec §4.1 — transcript reads stay one-column). Returns the take's
 * content, or null when the message/take doesn't exist. Display-only: state and
 * memory keep reflecting the last GENERATED take (regenerate to re-run effects).
 */
export async function switchReplyTake(chatId: string, messageId: string, takeId: string): Promise<string | null> {
  const [row] = await db()
    .select({ takes: characterChatMessages.takes })
    .from(characterChatMessages)
    .where(and(eq(characterChatMessages.id, messageId), eq(characterChatMessages.chatId, chatId)))
    .limit(1);
  if (!row) return null;
  const takes = parseOr(replyTakesSchema, row.takes, emptyReplyTakes(), undefined, "character_chat_messages.takes");
  const target = takes.takes.find((t) => t.id === takeId);
  if (!target) return null;
  await db()
    .update(characterChatMessages)
    .set({ content: target.content, takes: { ...takes, activeId: target.id } })
    .where(and(eq(characterChatMessages.id, messageId), eq(characterChatMessages.chatId, chatId)));
  return target.content;
}

// ---------------------------------------------------------------------------
// Stop (spec §4.2) — abort the in-flight reply, keep what streamed
// ---------------------------------------------------------------------------

/** In-flight reply aborts by chat id — in-process, like the exchange lock itself. */
const inflightReplyAborts = new Map<string, AbortController>();

/**
 * Cut the in-flight reply short: the model stream aborts server-side, the
 * accumulated prefix persists as the reply (`meta.stopped`), and the fan-out
 * runs over the truncated text. Returns false when nothing is streaming.
 */
export function stopChatReply(chatId: string): boolean {
  const controller = inflightReplyAborts.get(chatId);
  if (!controller) return false;
  controller.abort();
  return true;
}

// ---------------------------------------------------------------------------
// The exchange
// ---------------------------------------------------------------------------

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
  const { chatId, memoryGroupId, kind } = input;
  const { id: characterId, name: characterName } = input.character;

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
    return await prepareExchange();
  } catch (err) {
    releaseChatLock();
    throw err;
  }

  /** Pre-turn assembly: user line → window/summary → drift → recall → prompt → model stream. */
  async function prepareExchange(): Promise<SubmitChatMessageResult> {
    const sink = new DiagnosticCollector();

    // --- Resolve the exchange's rows per kind -------------------------------
    // send: mint + insert the user guard row and a fresh assistant row id.
    // open/continue: no user line; fresh assistant row id, no guard.
    // regenerate: reuse the LAST assistant row (its id is the provenance anchor);
    //   its prompting user line (when one exists) becomes the guard + player text.
    let promptMessageId: string | null = null;
    let playerContent = "";
    let assistantMessageId = newId();
    /** The synthetic cue appended to history when there is no player line this turn. */
    let syntheticCue: string | null = null;
    /** For regenerate: the current (soon-to-be-old) reply text on the row. */
    let regenerateTarget: { id: string; content: string } | null = null;
    let effectiveKind: ChatExchangeKind = kind;

    if (kind === "send") {
      promptMessageId = newId();
      playerContent = input.content ?? "";
      await db()
        .insert(characterChatMessages)
        .values({ id: promptMessageId, chatId, role: "user", content: playerContent });
    } else if (kind === "open") {
      syntheticCue = OPENING_CUE;
    } else if (kind === "continue") {
      syntheticCue = CONTINUE_CUE;
    } else {
      const target = await lastAssistantMessage(chatId);
      if (!target) {
        releaseChatLock();
        return { ok: false, code: "nothing_to_regenerate", message: "there is no reply to regenerate yet" };
      }
      regenerateTarget = { id: target.id, content: target.content };
      assistantMessageId = target.id;
      const prev = await messageBefore(chatId, target);
      if (prev?.role === "user") {
        promptMessageId = prev.id;
        playerContent = prev.content;
      } else {
        // The reply being regenerated was itself an opening/continue beat.
        syntheticCue = prev ? CONTINUE_CUE : OPENING_CUE;
        effectiveKind = prev ? "continue" : "open";
      }
    }

    const opening = effectiveKind === "open";
    await db().update(characterChats).set({ lastMessageAt: new Date() }).where(eq(characterChats.id, chatId));

    // --- State: load (or roll back), then drift -----------------------------
    // Regenerate restores the pre-exchange snapshot (spec §4.1) so the old take's
    // drift + pulse effects don't double-apply, and retracts the old take's
    // extracted memory (spec §4.3) so it can't prime the new one. A missing
    // snapshot degrades to no-rollback with a diagnostic — never a failed reply.
    let storedState: ChatState | null;
    if (regenerateTarget) {
      const restored = await loadPreExchangeState(chatId, characterId);
      if (restored.found) {
        // A recorded anchor. `state: null` means the anchor was `{}` — a first
        // exchange with no prior state — so drift re-seeds from the authored
        // defaults below, exactly as the original first exchange did (F3).
        storedState = restored.state;
      } else {
        sink.push(
          diag("warn", "chat_state.snapshot.missing", "no pre-exchange snapshot; regenerating without state rollback"),
        );
        storedState = await loadChatState(chatId, characterId, sink);
      }
      await reconcileMessageMemory(regenerateTarget.id, sink);
    } else {
      storedState = await loadChatState(chatId, characterId, sink);
    }

    const profile = parseOr(
      characterProfileSchema,
      input.character.profile ?? {},
      emptyCharacterProfile(),
      undefined,
      "characters.profile",
    );
    const now = new Date();
    const driftedState = driftChatState(storedState ?? seedChatState(profile), profile, { advance: true });

    // --- Window + summary ----------------------------------------------------
    const summaryState = await loadChatSummary(chatId);
    const history = await loadVerbatimWindow(chatId, summaryState?.watermark ?? null);
    // The regenerated reply must not see itself: it is the newest message, so it
    // is the window's last row — drop it (its prompting user line stays).
    if (regenerateTarget && history.length && history.at(-1)?.role === "assistant") history.pop();

    if (history.length >= CHARACTER_CHAT_SUMMARIZE_AT * 2) {
      void enqueueChatSummary({ chatId });
    }

    // The user's default player character (player-character.plan.md), so the
    // character addresses someone by name instead of a faceless "the user".
    const owner = await chatOwnerId(chatId);
    const player = await resolvePlayerPersona(owner);

    // --- RAG recall (spec §2): the participant's memory group ----------------
    const memory = await retrieveChatMemory({
      groupId: memoryGroupId,
      queries: driftedState.memoryQueries,
      input: playerContent,
      sink,
    });

    const system = buildCharacterChatSystemPrompt({
      name: characterName,
      profile,
      priorSummary: summaryState?.summary,
      memory,
      player: { name: player.name, persona: player.persona },
      state: promptStateSlice(driftedState),
      opening,
      narrationShape: narrationShapeId("chat"),
      // One-turn cue invitation (§7): beats without player input have none to read —
      // except a "has something to say" continue (§8.4), whose tapped open loop is
      // threaded here so the character opens about exactly the right thing.
      cueInvite: playerContent
        ? chatCueInviteLine(detectChatCue(playerContent), characterName)
        : effectiveKind === "continue" && input.cue?.trim()
          ? `There is unfinished business you might open about: "${input.cue.trim()}" — bring it up naturally, in your own voice, if the moment allows.`
          : undefined,
      // Derived-fact tail note (player-input-perception.plan.md slice 4): the shared span
      // parser reads the current message's markup and renders a comms/OOC one-liner. The
      // raw message is never touched — this only feeds the prompt tail.
      notationNote: playerContent
        ? chatNotationNote(playerContent, { name: characterName, player: player.name, knownNames: [characterName] })
        : undefined,
    });
    const modelHistory = syntheticCue ? [...history, { role: "user" as const, content: syntheticCue }] : history;

    const abortController = new AbortController();
    inflightReplyAborts.set(chatId, abortController);
    const gen = streamCharacterChat({
      system,
      history: modelHistory,
      name: characterName,
      model: input.model,
      signal: abortController.signal,
    });

    // --- Settle work (runs once the reply has fully streamed) ----------------
    const settle = async (full: string, stopped: boolean): Promise<void> => {
      const meta = stopped ? { stopped: true } : {};
      if (regenerateTarget) {
        // Update the row in place: the old take stays browsable, the new one is
        // active (spec §4.1). Row-existence is the guard — a delete landing
        // mid-stream makes this a no-op.
        const takes = await currentReplyTakes(chatId, regenerateTarget.id);
        if (takes === null) return; // row deleted mid-stream
        const next = pushReplyTake(takes, regenerateTarget.content, full, now.toISOString());
        await db()
          .update(characterChatMessages)
          .set({ content: full, takes: next, meta })
          .where(and(eq(characterChatMessages.id, regenerateTarget.id), eq(characterChatMessages.chatId, chatId)));
      } else {
        await persistAssistantReply({
          id: assistantMessageId,
          chatId,
          speakerCharacterId: characterId,
          promptMessageId,
          content: full,
          meta,
        });
      }

      if (opening) {
        // Opening beat: fold drift into the state — no fan-out, there was no
        // player act and barely any narrative to archive. Record the surfaced
        // bands so the first real turn doesn't re-announce them, clear the
        // one-shot skip note this beat just rendered (spec §8.1), and store the
        // rollback anchor so even an opening beat can be regenerated.
        try {
          const surfacedCues = splitStateCues(driftedState.meters, driftedState.surfacedCues).nextBands;
          await persistChatState(chatId, characterId, { ...driftedState, surfacedCues, pendingSkipNote: "" });
          await savePreExchangeSnapshot(chatId, characterId, storedState);
        } catch (error) {
          log.error("engine.chat", "chat-state opening persist failed", { error: describeError(error) });
        }
        return;
      }

      try {
        const finalized = await finalizeChatState({
          chatId,
          characterId,
          memoryGroupId,
          assistantMessageId,
          preExchangeState: storedState,
          skipPulse: effectiveKind === "continue",
          promptMessageId: promptMessageId ?? assistantMessageId,
          profile,
          characterName,
          playerName: player.name,
          driftedState,
          now,
          exchange: { player: playerContent, assistant: full },
          retrieved: memory,
          sink,
        });
        // "Auto at big moments" (slice 9): opt-in per chat, fire-and-forget — a failed
        // or skipped render never touches the settled reply.
        if (finalized.bigMoment && driftedState.sceneAuto === "milestones") {
          input.onBigMoment?.({ assistantMessageId });
        }
      } catch (error) {
        log.error("engine.chat", "chat-state finalize failed", { error: describeError(error) });
      }
      if (sink.items.length) {
        log.info("engine.chat", "chat-state diagnostics", { codes: sink.items.map((d) => d.code) });
      }
    };

    return { ok: true, stream: streamExchange(gen, settle, abortController) };
  }

  /**
   * Wrap the model stream so persistence + fan-out + lock release ride the
   * generator's own completion: the route (or any consumer) just drains it. A
   * model-stream failure keeps whatever accumulated (persisted if non-empty); a
   * player Stop (spec §4.2) is not a failure — the truncated prefix persists with
   * `meta.stopped`. An empty reply skips settle; the lock releases on every path.
   */
  async function* streamExchange(
    gen: AsyncGenerator<string>,
    settle: (full: string, stopped: boolean) => Promise<void>,
    abortController: AbortController,
  ): AsyncGenerator<string, void, unknown> {
    let full = "";
    let stopped = false;
    try {
      try {
        for await (const delta of gen) {
          full += delta;
          yield delta;
        }
      } catch (error) {
        if (abortController.signal.aborted) {
          stopped = true;
        } else {
          log.warn("engine.chat", "reply stream failed", { error: describeError(error) });
        }
      }
      if (abortController.signal.aborted) stopped = true;
      if (full.trim()) {
        try {
          await settle(full, stopped);
        } catch (error) {
          log.error("engine.chat", "failed to persist assistant reply", { error: describeError(error) });
        }
      }
    } finally {
      inflightReplyAborts.delete(chatId);
      releaseChatLock();
    }
  }
}

/** The newest message when it is an assistant reply — the only regenerable target. */
async function lastAssistantMessage(
  chatId: string,
): Promise<{ id: string; content: string; createdAt: Date } | null> {
  const [row] = await db()
    .select({
      id: characterChatMessages.id,
      role: characterChatMessages.role,
      content: characterChatMessages.content,
      createdAt: characterChatMessages.createdAt,
    })
    .from(characterChatMessages)
    .where(eq(characterChatMessages.chatId, chatId))
    .orderBy(desc(characterChatMessages.createdAt), desc(characterChatMessages.id))
    .limit(1);
  if (!row || row.role !== "assistant") return null;
  return { id: row.id, content: row.content, createdAt: row.createdAt };
}

/** The message immediately before `target`, collision-safe on the (createdAt, id) tuple. */
async function messageBefore(
  chatId: string,
  target: { id: string; createdAt: Date },
): Promise<{ id: string; role: "user" | "assistant"; content: string } | null> {
  const [row] = await db()
    .select({ id: characterChatMessages.id, role: characterChatMessages.role, content: characterChatMessages.content })
    .from(characterChatMessages)
    .where(
      and(
        eq(characterChatMessages.chatId, chatId),
        ne(characterChatMessages.id, target.id),
        or(
          lt(characterChatMessages.createdAt, target.createdAt),
          and(eq(characterChatMessages.createdAt, target.createdAt), lt(characterChatMessages.id, target.id)),
        ),
      ),
    )
    .orderBy(desc(characterChatMessages.createdAt), desc(characterChatMessages.id))
    .limit(1);
  return row ?? null;
}

/** The row's current takes, or null when the row vanished (delete raced the stream). */
async function currentReplyTakes(chatId: string, messageId: string): Promise<ReplyTakes | null> {
  const [row] = await db()
    .select({ takes: characterChatMessages.takes })
    .from(characterChatMessages)
    .where(and(eq(characterChatMessages.id, messageId), eq(characterChatMessages.chatId, chatId)))
    .limit(1);
  if (!row) return null;
  return parseOr(replyTakesSchema, row.takes, emptyReplyTakes(), undefined, "character_chat_messages.takes");
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
 * Persist the assistant reply. With a `promptMessageId` the insert is guarded —
 * only if the user line that prompted it still exists (atomic `INSERT … SELECT …
 * WHERE EXISTS`), so a chat delete or a single-message delete that lands while
 * the stream is still draining can't leave an orphan row. Beat replies
 * (open/continue) have no prompting line and insert unguarded. `id` is supplied
 * explicitly: it is the memory-provenance anchor (spec §4.3), minted before the
 * fan-out needs it.
 *
 * Exported as a test seam: a real mid-stream delete isn't deterministically
 * reproducible through the streaming Response, so the guard is covered directly.
 */
export async function persistAssistantReply(args: {
  id: string;
  chatId: string;
  speakerCharacterId: string;
  promptMessageId: string | null;
  content: string;
  meta?: Record<string, unknown>;
}): Promise<void> {
  const meta = JSON.stringify(args.meta ?? {});
  const guard = args.promptMessageId
    ? sql`exists (select 1 from ${characterChatMessages} where id = ${args.promptMessageId})`
    : sql`true`;
  await db().execute(sql`
    insert into ${characterChatMessages} (id, chat_id, speaker_character_id, role, content, meta)
    select ${args.id}, ${args.chatId}, ${args.speakerCharacterId}, 'assistant', ${args.content}, ${meta}::jsonb
    where ${guard}
  `);
}

/**
 * Memory reconciliation for an edited assistant reply (spec §4.3): retract the
 * old extraction, then re-run the archivist over the edited exchange
 * fire-and-forget — same resilience as the live fan-out (a degraded re-extract
 * just leaves the exchange unremembered, with the retraction already honest).
 */
export async function reextractEditedReply(args: {
  chatId: string;
  messageId: string;
  memoryGroupId: string;
  characterId: string;
  characterName: string;
  playerName: string;
  content: string;
}): Promise<void> {
  const sink = new DiagnosticCollector();
  await reconcileMessageMemory(args.messageId, sink);
  const [row] = await db()
    .select({ id: characterChatMessages.id, createdAt: characterChatMessages.createdAt })
    .from(characterChatMessages)
    .where(and(eq(characterChatMessages.id, args.messageId), eq(characterChatMessages.chatId, args.chatId)))
    .limit(1);
  if (!row) return;
  const prev = await messageBefore(args.chatId, row);
  const archivist = await runChatArchivist({
    characterName: args.characterName,
    playerName: args.playerName,
    exchange: { player: prev?.role === "user" ? prev.content : "", assistant: args.content },
    sink,
  });
  await writeChatMemory({
    groupId: args.memoryGroupId,
    characterId: args.characterId,
    assistantMessageId: args.messageId,
    archivist: archivist.value,
    sink,
  });
  if (sink.items.length) {
    log.info("engine.chat", "edited-reply re-extraction diagnostics", { codes: sink.items.map((d) => d.code) });
  }
}

/** The prompt builder's per-turn state slice from a drifted ChatState — shared by the live exchange and the inspector preview. */
function promptStateSlice(state: ChatState): NonNullable<CharacterChatPromptInput["state"]> {
  return {
    meters: state.meters,
    regard: state.regard,
    familiarity: state.familiarity,
    relationship: state.relationship,
    conditions: state.conditions,
    mindNote: state.mindNote,
    premise: state.premise,
    surfacedCues: state.surfacedCues,
    outfit: state.outfit,
    outfitExposed: state.outfitExposed,
    activeSocialCards: state.activeSocialCards,
    attributeOverlays: state.attributeOverlays,
    openLoops: state.openLoops,
    skipNote: state.pendingSkipNote,
  };
}

/** The dev inspector's "what reaches the narrator" view (spec §5/§6.1). */
export interface ChatPromptPreview {
  prefix: string;
  tail: string;
  memory: { facts: string[]; episodes: string[] };
  memoryQueries: string[];
}

/**
 * Rebuild "what would reach the narrator now" for the dev inspector (spec §5 dev
 * affordance, §6.1): the same assembly as a live exchange — stored state (read-only
 * drift), rolling summary, persona, RAG recall — rendered into the §9 prompt parts,
 * without touching state, history, or the exchange lock. Reflects the POST-exchange
 * state (i.e. the NEXT turn's prompt), which is what comparing live play against the
 * eval fixtures wants.
 */
export async function previewChatPrompt(input: {
  chatId: string;
  memoryGroupId: string;
  character: { id: string; name: string; profile: unknown };
}): Promise<ChatPromptPreview> {
  const sink = new DiagnosticCollector();
  const profile = parseOr(
    characterProfileSchema,
    input.character.profile ?? {},
    emptyCharacterProfile(),
    undefined,
    "characters.profile",
  );
  const stored = await loadChatState(input.chatId, input.character.id, sink);
  const state = driftChatState(stored ?? seedChatState(profile), profile, {});
  const summaryState = await loadChatSummary(input.chatId);
  const player = await resolvePlayerPersona(await chatOwnerId(input.chatId));
  const memory = await retrieveChatMemory({
    groupId: input.memoryGroupId,
    queries: state.memoryQueries,
    input: "",
    sink,
  });
  const parts = buildCharacterChatPromptParts({
    name: input.character.name,
    profile,
    priorSummary: summaryState?.summary,
    memory,
    player: { name: player.name, persona: player.persona },
    state: promptStateSlice(state),
    narrationShape: narrationShapeId("chat"),
  });
  return {
    prefix: parts.prefix,
    tail: parts.tail,
    memory: { facts: memory.facts, episodes: memory.episodes },
    memoryQueries: state.memoryQueries,
  };
}

/**
 * Hard-delete a conversation (character-chat-standalone.spec.md §1.4 — archive is
 * the everyday action; this is the one destructive verb). One transaction: the
 * chat row's FK cascades take the transcript, summary, participant rows, and
 * per-participant state; the scene-image prompt text is scrubbed (assets survive
 * in the Gallery, but their prompts embed chat lines — chat-keyed rows scrub
 * per-conversation; legacy pre-slice-9 rows have no chatId, so those still scrub
 * character-wide, hitting sibling conversations' legacy scenes too); and each
 * participant's memory group is purged **only when no other conversation
 * references it** — shared-history siblings keep the relationship's memory
 * alive (D7).
 */
export async function deleteChat(chat: { id: string; ownerId: string }): Promise<void> {
  const participants = await db()
    .select({ characterId: chatParticipants.characterId, memoryGroupId: chatParticipants.memoryGroupId })
    .from(chatParticipants)
    .where(eq(chatParticipants.chatId, chat.id));

  await db().transaction(async (tx) => {
    await tx.update(images).set({ prompt: "" }).where(eq(images.chatId, chat.id));
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
            isNull(images.chatId),
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
