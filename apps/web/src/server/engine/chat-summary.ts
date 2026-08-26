import { and, asc, desc, eq, gt, or, type SQL, sql } from "drizzle-orm";
import { z } from "zod";
import { diag, DiagnosticCollector, type DiagnosticSink } from "@/contracts/diagnostics";
import {
  CHAT_SUMMARY_MAX_CHARS,
  chatSummaryFoldSchema,
  type ChatSummaryFold,
  degradedChatSummaryFold,
} from "@/contracts/turns/chat-summary";
import { parseOrNull } from "@/lib/parse";
import { log } from "@/server/log";
import { generateChecked } from "../ai";
import { characterChatMessages, characterChatSummaries, characters, chatParticipants, db, hasLiveChatJob } from "../db";
import type { ChatTurn } from "./character-chat";
import { CHARACTER_CHAT_HISTORY_TURNS, CHARACTER_CHAT_SUMMARIZE_AT, CHARACTER_CHAT_VERBATIM_KEEP } from "./constants";
import { enqueueJob, registerJobHandler } from "./jobs";
import { withKeyedLock } from "./keyed-lock";
import { buildChatSummaryFoldPrompt, CHAT_SUMMARY_SYSTEM } from "./prompts/chat-summary";

/**
 * The rolling chat-summary engine. A detached `chat_summary` background job
 * folds the oldest unsummarized exchanges of a sessionless character chat into
 * a running prose summary, advancing a watermark so the chat prompt can carry
 * continuity past the verbatim window. Cloned from the inner-note job shape: a
 * small generateChecked call, clamp-everything, degrade to a no-op (resilience
 * §3) — the worst case is exactly the old flat last-40 window. Never blocks or
 * fails a reply.
 */

/** The seam between summarized (≤ watermark) and verbatim (> watermark) messages. */
export type ChatWatermark = { at: Date; id: string } | null;

/** A loaded summary row in the shape the chat route needs. */
export interface ChatSummaryState {
  summary: string;
  watermark: ChatWatermark;
  coveredExchanges: number;
}

export const chatSummaryJobPayloadSchema = z.object({
  chatId: z.string().min(1),
});

export type ChatSummaryJobPayload = z.infer<typeof chatSummaryJobPayloadSchema>;

/**
 * Drizzle condition for "message is after the watermark" (the unsummarized tail),
 * collision-safe on the (createdAt, id) tuple because cuid2 ids are not
 * time-sortable. Undefined when nothing has been folded yet ⇒ all messages are
 * verbatim. Shared by the route's window load and the job's fold load so the
 * seam is defined in exactly one place.
 */
export function afterWatermark(watermark: ChatWatermark): SQL | undefined {
  if (!watermark) return undefined;
  return or(
    gt(characterChatMessages.createdAt, watermark.at),
    and(eq(characterChatMessages.createdAt, watermark.at), gt(characterChatMessages.id, watermark.id)),
  );
}

/** Load the running summary + watermark for a chat, or null when none exists yet. */
export async function loadChatSummary(chatId: string): Promise<ChatSummaryState | null> {
  const [row] = await db()
    .select({
      summary: characterChatSummaries.summary,
      watermarkAt: characterChatSummaries.watermarkAt,
      watermarkId: characterChatSummaries.watermarkId,
      coveredExchanges: characterChatSummaries.coveredExchanges,
    })
    .from(characterChatSummaries)
    .where(eq(characterChatSummaries.chatId, chatId))
    .limit(1);
  if (!row) return null;
  return {
    summary: row.summary,
    watermark: row.watermarkAt && row.watermarkId ? { at: row.watermarkAt, id: row.watermarkId } : null,
    coveredExchanges: row.coveredExchanges,
  };
}

/**
 * The verbatim window the chat prompt replays: every message AFTER the watermark
 * (oldest first), capped at the ceiling — the degraded floor when summarization
 * is off/lagging (= the old flat last-N window). Owns the seam so the route and
 * the int suite agree on exactly one definition.
 */
export async function loadVerbatimWindow(
  chatId: string,
  watermark: ChatWatermark,
): Promise<ChatTurn[]> {
  const wmCond = afterWatermark(watermark);
  const rows = await db()
    .select({ role: characterChatMessages.role, content: characterChatMessages.content, meta: characterChatMessages.meta })
    .from(characterChatMessages)
    .where(and(eq(characterChatMessages.chatId, chatId), ...(wmCond ? [wmCond] : [])))
    .orderBy(desc(characterChatMessages.createdAt))
    .limit(CHARACTER_CHAT_HISTORY_TURNS * 2);
  return rows.reverse().map((r) => {
    // Narrator-mode flag (chat-supporting-cast.plan.md §Narrator input): read leniently off
    // the meta jsonb — the pipeline wraps flagged lines at the model boundary.
    const narrator =
      r.role === "user" &&
      typeof r.meta === "object" &&
      r.meta !== null &&
      (r.meta as Record<string, unknown>).inputMode === "narrator";
    return { role: r.role, content: r.content, ...(narrator ? { narrator: true } : {}) };
  });
}

/**
 * Decide a fold purely from the unsummarized message count (PURE — the testable
 * core). Returns the number of OLDEST messages to fold, or null when below the
 * trigger. Folds down to CHARACTER_CHAT_VERBATIM_KEEP verbatim, capping a single
 * fold at the window ceiling's worth so a degraded backlog can't blow one call.
 */
export function planChatFold(unsummarizedMessages: number): number | null {
  if (unsummarizedMessages < CHARACTER_CHAT_SUMMARIZE_AT * 2) return null;
  const fold = unsummarizedMessages - CHARACTER_CHAT_VERBATIM_KEEP * 2;
  return Math.min(fold, CHARACTER_CHAT_HISTORY_TURNS * 2);
}

/** Clamp the stored summary to its char cap, trimming at a sentence boundary when possible (PURE). */
export function clampSummary(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= CHAT_SUMMARY_MAX_CHARS) return trimmed;
  const cut = trimmed.slice(0, CHAT_SUMMARY_MAX_CHARS);
  const lastStop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("\n"));
  return (lastStop > CHAT_SUMMARY_MAX_CHARS * 0.6 ? cut.slice(0, lastStop + 1) : cut).trimEnd();
}

export interface NormalizedFold {
  summary: string;
  /** Only advance the watermark when the model genuinely produced a new fold. */
  advance: boolean;
}

/**
 * Clamp the model output to the feature's invariants (trust nothing, §3). A
 * degraded result (demo / twice-failed) or an empty summary keeps the prior
 * summary and does NOT advance the watermark — the chunk stays verbatim and we
 * retry next cycle, so a bad fold can never replace a good summary (PURE).
 */
export function normalizeChatSummary(
  priorSummary: string,
  raw: ChatSummaryFold | null,
  degraded: boolean,
  sink?: DiagnosticSink,
): NormalizedFold {
  if (degraded || !raw) {
    sink?.push(
      diag("warn", "chat_summary.fold.degraded", "fold degraded; keeping prior summary, watermark unchanged"),
    );
    return { summary: priorSummary.trim(), advance: false };
  }
  const next = raw.summary.trim();
  if (!next) {
    sink?.push(diag("warn", "chat_summary.fold.empty", "fold produced an empty summary; watermark unchanged"));
    return { summary: priorSummary.trim(), advance: false };
  }
  return { summary: clampSummary(next), advance: true };
}

/**
 * Enqueue the detached fold job, guarded so at most one is queued/running per
 * chat (the job is idempotent anyway — it recomputes and no-ops below the
 * trigger). Self-contained: swallows and logs its own errors so callers can
 * fire-and-forget (`void enqueueChatSummary(...)`) without an unhandled
 * rejection. Runs through the existing detached runner path.
 */
export async function enqueueChatSummary(args: { chatId: string }): Promise<void> {
  try {
    if (await hasLiveChatJob("chat_summary", args.chatId)) return;
    await enqueueJob({ type: "chat_summary", payload: { ...args } });
  } catch (err) {
    log.warn("chat_summary", "failed to enqueue fold", { ...args, error: errorText(err) });
  }
}

/**
 * Fold the oldest unsummarized exchanges into the running summary. Idempotent by
 * recompute: re-reads the count and no-ops below the trigger (a concurrent fold
 * or a message delete may have already drained it). A missing character (deleted
 * mid-flight) is a logged no-op, never a crash loop.
 */
export async function processChatSummary(payload: ChatSummaryJobPayload, jobId?: string): Promise<void> {
  const sink = new DiagnosticCollector();
  const { chatId } = payload;

  // The PRIMARY participant (sort 0) names the fold prompt's character; a chat
  // deleted mid-flight is a logged no-op, never a crash loop.
  const [character] = await db()
    .select({ name: characters.name })
    .from(chatParticipants)
    .innerJoin(characters, eq(characters.id, chatParticipants.characterId))
    .where(eq(chatParticipants.chatId, chatId))
    .orderBy(asc(chatParticipants.sort))
    .limit(1);
  if (!character) {
    log.warn("chat_summary", "chat/participant missing; fold dropped", { chatId, jobId });
    return;
  }

  const existing = await loadChatSummary(chatId);
  const priorSummary = existing?.summary ?? "";
  const watermark = existing?.watermark ?? null;
  const wmCond = afterWatermark(watermark);

  const tailWhere = and(eq(characterChatMessages.chatId, chatId), ...(wmCond ? [wmCond] : []));

  const [counted] = await db()
    .select({ n: sql<number>`count(*)::int` })
    .from(characterChatMessages)
    .where(tailWhere);
  const unsummarized = counted?.n ?? 0;

  const foldCount = planChatFold(unsummarized);
  if (foldCount === null) {
    log.info("chat_summary", "below fold trigger; no-op", { chatId, unsummarized, jobId });
    return;
  }

  // The oldest `foldCount` messages are the chunk; the newest stay verbatim.
  const chunkRows = await db()
    .select({ id: characterChatMessages.id, role: characterChatMessages.role, content: characterChatMessages.content, createdAt: characterChatMessages.createdAt, meta: characterChatMessages.meta })
    .from(characterChatMessages)
    .where(tailWhere)
    .orderBy(asc(characterChatMessages.createdAt), asc(characterChatMessages.id))
    .limit(foldCount);
  const last = chunkRows.at(-1);
  if (!last) return; // raced to empty; nothing to fold

  // Narrator-mode player lines fold as labeled story narration so the summary never
  // attributes authored events to the player (chat-supporting-cast.plan.md).
  const chunk: ChatTurn[] = chunkRows.map((r) => {
    const narrator =
      r.role === "user" &&
      typeof r.meta === "object" &&
      r.meta !== null &&
      (r.meta as Record<string, unknown>).inputMode === "narrator";
    return {
      role: r.role,
      content: narrator ? `[story narration, written by the player as storyteller]\n${r.content}` : r.content,
    };
  });
  const { value, degraded } = await generateChecked<ChatSummaryFold>({
    schema: chatSummaryFoldSchema,
    system: CHAT_SUMMARY_SYSTEM,
    prompt: buildChatSummaryFoldPrompt({ characterName: character.name, priorSummary, chunk }),
    temperature: 0.2,
    maxOutputTokens: CHAT_SUMMARY_MAX_OUTPUT_TOKENS,
    code: "chat_summary.fold",
    sink,
    fallback: () => degradedChatSummaryFold(priorSummary),
  });

  const folded = normalizeChatSummary(priorSummary, value, degraded, sink);
  if (!folded.advance) {
    log.warn("chat_summary", "fold did not advance", {
      chatId,
      degraded,
      diagnostics: sink.items.map((d) => d.code),
    });
    return;
  }

  const coveredExchanges = (existing?.coveredExchanges ?? 0) + Math.floor(foldCount / 2);
  await db()
    .insert(characterChatSummaries)
    .values({
      chatId,
      summary: folded.summary,
      watermarkAt: last.createdAt,
      watermarkId: last.id,
      coveredExchanges,
    })
    .onConflictDoUpdate({
      target: [characterChatSummaries.chatId],
      set: {
        summary: folded.summary,
        watermarkAt: last.createdAt,
        watermarkId: last.id,
        coveredExchanges,
        updatedAt: new Date(),
      },
    });

  log.info("chat_summary", "folded chat tail into summary", {
    chatId,
    foldedMessages: foldCount,
    coveredExchanges,
    summaryChars: folded.summary.length,
    jobId,
  });
}

/** Backstop on rebuild fold iterations (a 35-exchange trigger × 50 folds ≫ any real chat). */
const REBUILD_MAX_FOLDS = 50;

/**
 * Re-fold the running summary from the FULL transcript (character-chat-standalone.spec.md
 * §7.3 — the recovery lever for folded-then-deleted lines). Under the same per-chat
 * keyed lock as the fold job: resets the summary row (empty summary, null watermark ⇒
 * every message is unsummarized again), then folds repeatedly until the tail is below
 * the trigger. A degraded/empty fold stalls the watermark, which ends the loop honestly
 * (partial rebuild + diagnostics) instead of spinning on a failing model. Returns the
 * final summary text and the fold count.
 */
export async function rebuildChatSummary(chatId: string): Promise<{ summary: string; folds: number }> {
  return withKeyedLock(`chat_summary:${chatId}`, async () => {
    await db()
      .insert(characterChatSummaries)
      .values({ chatId, summary: "", watermarkAt: null, watermarkId: null, coveredExchanges: 0 })
      .onConflictDoUpdate({
        target: [characterChatSummaries.chatId],
        set: { summary: "", watermarkAt: null, watermarkId: null, coveredExchanges: 0, updatedAt: new Date() },
      });
    let folds = 0;
    for (; folds < REBUILD_MAX_FOLDS; folds++) {
      const before = await loadChatSummary(chatId);
      await processChatSummary({ chatId });
      const after = await loadChatSummary(chatId);
      if ((after?.watermark?.id ?? null) === (before?.watermark?.id ?? null)) break; // below trigger or degraded
    }
    const final = await loadChatSummary(chatId);
    return { summary: final?.summary ?? "", folds };
  });
}

/** Output-token cap for the fold — the summary targets ~400 words; keep it cheap. */
const CHAT_SUMMARY_MAX_OUTPUT_TOKENS = 800;

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

registerJobHandler("chat_summary", async (job) => {
  const payload = parseOrNull(chatSummaryJobPayloadSchema, job.payload);
  if (!payload) throw new Error("chat_summary job missing payload");
  // Serialize folds per chat (codebase-review A8): the enqueue dedupe is
  // check-then-insert, so two near-simultaneous exchanges can both enqueue.
  // Under the lock the second fold re-reads the advanced watermark and no-ops
  // below the trigger instead of paying a duplicate LLM call.
  await withKeyedLock(`chat_summary:${payload.chatId}`, () => processChatSummary(payload, job.id));
});
