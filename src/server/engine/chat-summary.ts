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
import { characterChatMessages, characterChatSummaries, characters, db, jobs } from "../db";
import type { ChatTurn } from "./character-chat";
import { CHARACTER_CHAT_HISTORY_TURNS, CHARACTER_CHAT_SUMMARIZE_AT, CHARACTER_CHAT_VERBATIM_KEEP } from "./constants";
import { enqueueJob, registerJobHandler } from "./jobs";
import { buildChatSummaryFoldPrompt, CHAT_SUMMARY_SYSTEM } from "./prompts/chat-summary";

/**
 * The rolling chat-summary engine (docs/developer-notes/character-chat-summary.plan.md).
 * A detached `chat_summary` background job folds the oldest unsummarized
 * exchanges of a sessionless character chat into a running prose summary,
 * advancing a watermark so the chat prompt can carry continuity past the
 * verbatim window. Cloned from the inner-note job shape: a small generateChecked
 * call, clamp-everything, degrade to a no-op (resilience §3) — the worst case is
 * exactly the old flat last-40 window. Never blocks or fails a reply.
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
  ownerId: z.string().min(1),
  characterId: z.string().min(1),
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
export async function loadChatSummary(ownerId: string, characterId: string): Promise<ChatSummaryState | null> {
  const [row] = await db()
    .select({
      summary: characterChatSummaries.summary,
      watermarkAt: characterChatSummaries.watermarkAt,
      watermarkId: characterChatSummaries.watermarkId,
      coveredExchanges: characterChatSummaries.coveredExchanges,
    })
    .from(characterChatSummaries)
    .where(and(eq(characterChatSummaries.ownerId, ownerId), eq(characterChatSummaries.characterId, characterId)))
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
  ownerId: string,
  characterId: string,
  watermark: ChatWatermark,
): Promise<ChatTurn[]> {
  const wmCond = afterWatermark(watermark);
  const rows = await db()
    .select({ role: characterChatMessages.role, content: characterChatMessages.content })
    .from(characterChatMessages)
    .where(and(eq(characterChatMessages.ownerId, ownerId), eq(characterChatMessages.characterId, characterId), ...(wmCond ? [wmCond] : [])))
    .orderBy(desc(characterChatMessages.createdAt))
    .limit(CHARACTER_CHAT_HISTORY_TURNS * 2);
  return rows.reverse();
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
 * rejection. Runs as a `sessionId: null` job ⇒ the existing detached runner path.
 */
export async function enqueueChatSummary(args: { ownerId: string; characterId: string }): Promise<void> {
  try {
    const [pending] = await db()
      .select({ id: jobs.id })
      .from(jobs)
      .where(
        and(
          eq(jobs.type, "chat_summary"),
          or(eq(jobs.status, "queued"), eq(jobs.status, "running")),
          sql`${jobs.payload} ->> 'characterId' = ${args.characterId}`,
          sql`${jobs.payload} ->> 'ownerId' = ${args.ownerId}`,
        ),
      )
      .limit(1);
    if (pending) return;
    await enqueueJob({ sessionId: null, type: "chat_summary", payload: { ...args } });
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
  const { ownerId, characterId } = payload;

  const [character] = await db()
    .select({ name: characters.name })
    .from(characters)
    .where(and(eq(characters.id, characterId), eq(characters.ownerId, ownerId)))
    .limit(1);
  if (!character) {
    log.warn("chat_summary", "character missing; fold dropped", { ownerId, characterId, jobId });
    return;
  }

  const existing = await loadChatSummary(ownerId, characterId);
  const priorSummary = existing?.summary ?? "";
  const watermark = existing?.watermark ?? null;
  const wmCond = afterWatermark(watermark);

  const tailWhere = and(
    eq(characterChatMessages.ownerId, ownerId),
    eq(characterChatMessages.characterId, characterId),
    ...(wmCond ? [wmCond] : []),
  );

  const [counted] = await db()
    .select({ n: sql<number>`count(*)::int` })
    .from(characterChatMessages)
    .where(tailWhere);
  const unsummarized = counted?.n ?? 0;

  const foldCount = planChatFold(unsummarized);
  if (foldCount === null) {
    log.info("chat_summary", "below fold trigger; no-op", { ownerId, characterId, unsummarized, jobId });
    return;
  }

  // The oldest `foldCount` messages are the chunk; the newest stay verbatim.
  const chunkRows = await db()
    .select({ id: characterChatMessages.id, role: characterChatMessages.role, content: characterChatMessages.content, createdAt: characterChatMessages.createdAt })
    .from(characterChatMessages)
    .where(tailWhere)
    .orderBy(asc(characterChatMessages.createdAt), asc(characterChatMessages.id))
    .limit(foldCount);
  const last = chunkRows.at(-1);
  if (!last) return; // raced to empty; nothing to fold

  const chunk: ChatTurn[] = chunkRows.map((r) => ({ role: r.role, content: r.content }));
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
      ownerId,
      characterId,
      degraded,
      diagnostics: sink.items.map((d) => d.code),
    });
    return;
  }

  const coveredExchanges = (existing?.coveredExchanges ?? 0) + Math.floor(foldCount / 2);
  await db()
    .insert(characterChatSummaries)
    .values({
      ownerId,
      characterId,
      summary: folded.summary,
      watermarkAt: last.createdAt,
      watermarkId: last.id,
      coveredExchanges,
    })
    .onConflictDoUpdate({
      target: [characterChatSummaries.ownerId, characterChatSummaries.characterId],
      set: {
        summary: folded.summary,
        watermarkAt: last.createdAt,
        watermarkId: last.id,
        coveredExchanges,
        updatedAt: new Date(),
      },
    });

  log.info("chat_summary", "folded chat tail into summary", {
    ownerId,
    characterId,
    foldedMessages: foldCount,
    coveredExchanges,
    summaryChars: folded.summary.length,
    jobId,
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
  await processChatSummary(payload, job.id);
});
