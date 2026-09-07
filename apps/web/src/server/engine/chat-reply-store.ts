import { and, asc, desc, eq, inArray, lt, ne, or, sql } from "drizzle-orm";
import { z } from "zod";
import {
  chatActionIdSchema,
  type ChatActionId,
  type ChatReplyFailure,
  type ChatReplyFailureCause,
  type ChatReplyFailureCode,
} from "@/contracts";
import {
  narratorPromptAuthorityWeights,
  narratorPromptUnits,
  narratorRunProvenanceSchema,
  type NarratorInstructionSource,
  type NarratorPromptNode,
  type NarratorRunLane,
  type NarratorRunProvenance,
} from "@/contracts/narrator-prompts";
import { fnv1aHex } from "@/lib/hash";
import { newId } from "@/lib/ids";
import { parseOr } from "@/lib/parse";
import { characterChats, characterChatMessages, db } from "../db";
import { log } from "../log";
import { CHAT_REPLY_TAKES_CAP } from "./constants";

const replyTakeSchema = z.object({
  id: z.string(),
  content: z.string(),
  createdAt: z.string(),
  /**
   * What produced this take — the lane,
   * the effective narrator model, and the exact prompt revision when a Prompt Lab
   * template was active.
   *
   * Optional **and** `.catch(undefined)`: every take written before provenance
   * existed has none, and a malformed record must degrade this one take to "unlabelled"
   * rather than reject the whole ring and lose the player's browsable history.
   */
  provenance: narratorRunProvenanceSchema.optional().catch(undefined),
});
export const replyTakesSchema = z.object({
  takes: z.array(replyTakeSchema).catch([]),
  activeId: z.string().catch(""),
});
export type ReplyTakes = z.infer<typeof replyTakesSchema>;

export const emptyReplyTakes = (): ReplyTakes => ({ takes: [], activeId: "" });

/**
 * An assistant row's whole `meta` bag, kept open. Both lanes write different keys
 * into it (the action-beat chip, the stop marker, the successor cut/model/attempts,
 * composition fallbacks), and a take switch has to REWRITE one key while carrying
 * the rest through — so this parse exists to make the merge safe, not to describe
 * the shape. Unreadable meta degrades to an empty bag rather than losing the write.
 */
const replyMetaBagSchema = z.record(z.string(), z.unknown()).catch({});

/**
 * Record a fresh take (PURE): the row's current content becomes a browsable entry
 * (seeded lazily on the first regenerate), the new take is appended and made
 * active, and the list is capped at CHAT_REPLY_TAKES_CAP — evicting the oldest
 * non-active entries first.
 *
 * `provenance.current` is what generated the content ALREADY on the row, and it
 * rides the lazily-seeded historical take: the take that was written under the
 * production prompt has to keep saying so after a retake under a test template,
 * or the Prompt Lab comparison reads both takes as the same experiment. A
 * historical row carries none — that stays legal, and the take is unlabelled.
 */
export function pushReplyTake(
  prior: ReplyTakes,
  currentContent: string,
  newContent: string,
  nowIso: string,
  provenance: { current?: NarratorRunProvenance; fresh?: NarratorRunProvenance } = {},
): ReplyTakes {
  let takes = [...prior.takes];
  if (takes.length === 0) {
    takes.push({
      id: newId(),
      content: currentContent,
      createdAt: nowIso,
      ...(provenance.current === undefined ? {} : { provenance: provenance.current }),
    });
  }
  const fresh = {
    id: newId(),
    content: newContent,
    createdAt: nowIso,
    ...(provenance.fresh === undefined ? {} : { provenance: provenance.fresh }),
  };
  takes.push(fresh);
  while (takes.length > CHAT_REPLY_TAKES_CAP) {
    const evictAt = takes.findIndex((t) => t.id !== fresh.id);
    if (evictAt === -1) break;
    takes.splice(evictAt, 1);
  }
  return { takes, activeId: fresh.id };
}

/**
 * Build one take's narrator-run provenance (PURE) — the record that answers
 * "which prompt and which model wrote this?" months later.
 *
 * Shared by all four prose narrator paths (legacy 1:1/ensemble, successor
 * co-present, successor solo) so the four cannot drift into describing the same
 * fact three different ways. It lives beside the take ring because that carries it.
 *
 * Two hashes, no prompt text. `instructionHash` identifies the instruction body —
 * the immutable revision's own `bodyHash` for a test source, and for production a
 * hash over the classified `behavior` units. `assembledSystemHash` identifies the
 * whole assembly, so takes from the same revision under different runtime state
 * remain distinguishable. Storing the prompt would copy a large runtime value onto
 * every message for a fact these hashes already establish.
 *
 * Metrics are optional. A provider that reports no finish reason or token counts
 * leaves those fields absent rather than requiring new plumbing.
 */
export function buildNarratorRunProvenance(args: {
  lane: NarratorRunLane;
  modelId: string;
  source: NarratorInstructionSource | undefined;
  nodes: readonly NarratorPromptNode[];
  assembled: string;
  attempts?: number;
  finishReason?: string;
  inputTokens?: number;
  outputTokens?: number;
  latencyMs?: number;
}): NarratorRunProvenance {
  const { source } = args;
  const productionInstructionText = narratorPromptUnits(args.nodes)
    .filter((unit) => unit.authority === "behavior")
    .map((unit) => unit.text)
    .join("\n");
  return {
    lane: args.lane,
    modelId: args.modelId,
    promptSource: source?.kind === "test" ? "test" : "production",
    ...(source?.kind === "test"
      ? {
          templateId: source.templateId,
          templateName: source.templateName,
          revisionId: source.revisionId,
          revision: source.revision,
          templateLanguage: source.templateLanguage,
        }
      : {}),
    instructionHash: source?.kind === "test" ? source.bodyHash : fnv1aHex(productionInstructionText),
    assembledSystemHash: fnv1aHex(args.assembled),
    authorityWeights: narratorPromptAuthorityWeights(args.nodes),
    mode: "instruction_override_v1",
    ...(args.attempts === undefined ? {} : { attempts: args.attempts }),
    ...(args.finishReason === undefined ? {} : { finishReason: args.finishReason }),
    ...(args.inputTokens === undefined ? {} : { inputTokens: args.inputTokens }),
    ...(args.outputTokens === undefined ? {} : { outputTokens: args.outputTokens }),
    ...(args.latencyMs === undefined ? {} : { latencyMs: args.latencyMs }),
  };
}

/**
 * Make one recorded take the displayed reply: `content` mirrors it for transcript
 * reads. Returns null when the message/take does not exist. This is display-only:
 * state and memory continue reflecting the last generated take.
 *
 * `meta.narratorRun` moves with the switch. Every other metadata key describes
 * the row and survives untouched; a target with no provenance removes a stale
 * narrator run from the previously displayed take.
 */
export async function switchReplyTake(chatId: string, messageId: string, takeId: string): Promise<string | null> {
  const [row] = await db()
    .select({ takes: characterChatMessages.takes, meta: characterChatMessages.meta })
    .from(characterChatMessages)
    .where(and(eq(characterChatMessages.id, messageId), eq(characterChatMessages.chatId, chatId)))
    .limit(1);
  if (!row) return null;
  const takes = parseOr(replyTakesSchema, row.takes, emptyReplyTakes(), undefined, "character_chat_messages.takes");
  const target = takes.takes.find((t) => t.id === takeId);
  if (!target) return null;
  const meta = parseOr(replyMetaBagSchema, row.meta ?? {}, {}, undefined, "character_chat_messages.meta");
  if (target.provenance === undefined) delete meta.narratorRun;
  else meta.narratorRun = target.provenance;
  await db()
    .update(characterChatMessages)
    .set({ content: target.content, takes: { ...takes, activeId: target.id }, meta })
    .where(and(eq(characterChatMessages.id, messageId), eq(characterChatMessages.chatId, chatId)));
  return target.content;
}

/**
 * Write — or with null, clear — `character_chats.last_reply_failure`. Never
 * throws: losing the record must not break exchange settle or lock release.
 */
export async function saveReplyFailure(
  chatId: string,
  failure: { code: ChatReplyFailureCode; detail: string; cause?: ChatReplyFailureCause } | null,
  model: string,
): Promise<void> {
  const record: ChatReplyFailure | null = failure
    ? {
        code: failure.code,
        detail: failure.detail.slice(0, 500),
        ...(failure.cause === undefined ? {} : { cause: failure.cause }),
        model,
        at: new Date().toISOString(),
      }
    : null;
  try {
    await db().update(characterChats).set({ lastReplyFailure: record }).where(eq(characterChats.id, chatId));
  } catch (error) {
    log.error("engine.chat", "failed to record reply failure", {
      chatId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export const messageAttachmentsMetaSchema = z.object({
  attachments: z
    .object({
      ids: z.array(z.string()).catch([]).default([]),
      descriptions: z.array(z.string()).optional(),
    })
    .optional(),
  /** Narrator-mode marker. */
  inputMode: z.enum(["player", "narrator"]).optional().catch(undefined),
});

/** The prompting line's stored attachment ids + any persisted vision read + its input mode. */
export async function loadMessageAttachments(
  chatId: string,
  messageId: string,
): Promise<{ ids: string[]; descriptions: string[] | null; narrator: boolean }> {
  const [row] = await db()
    .select({ meta: characterChatMessages.meta })
    .from(characterChatMessages)
    .where(and(eq(characterChatMessages.id, messageId), eq(characterChatMessages.chatId, chatId)))
    .limit(1);
  const parsed = parseOr(messageAttachmentsMetaSchema, row?.meta ?? {}, {}, undefined, "character_chat_messages.meta");
  const ids = parsed.attachments?.ids ?? [];
  const descriptions = parsed.attachments?.descriptions;
  return {
    ids,
    descriptions: descriptions && descriptions.length === ids.length ? descriptions : null,
    narrator: parsed.inputMode === "narrator",
  };
}

/**
 * Defensive parse of an assistant reply's meta: the action-beat chip id (regenerate
 * recovery) and the run that produced the content currently on the row — which the
 * first regenerate hands to the historical take it seeds, so the old take keeps
 * saying which prompt actually wrote it. Rows written before provenance existed
 * have none; absent is legal, never an error.
 */
const assistantReplyMetaSchema = z.object({
  actionBeat: chatActionIdSchema.optional().catch(undefined),
  narratorRun: narratorRunProvenanceSchema.optional().catch(undefined),
});

/** The newest message when it is an assistant reply — the only regenerable target. */
export async function lastAssistantMessage(
  chatId: string,
): Promise<{
  id: string;
  content: string;
  createdAt: Date;
  actionBeat?: ChatActionId;
  narratorRun?: NarratorRunProvenance;
} | null> {
  const [row] = await db()
    .select({
      id: characterChatMessages.id,
      role: characterChatMessages.role,
      content: characterChatMessages.content,
      createdAt: characterChatMessages.createdAt,
      meta: characterChatMessages.meta,
    })
    .from(characterChatMessages)
    .where(eq(characterChatMessages.chatId, chatId))
    .orderBy(desc(characterChatMessages.createdAt), desc(characterChatMessages.id))
    .limit(1);
  if (!row || row.role !== "assistant") return null;
  const meta = parseOr(assistantReplyMetaSchema, row.meta ?? {}, {}, undefined, "character_chat_messages.meta");
  return {
    id: row.id,
    content: row.content,
    createdAt: row.createdAt,
    actionBeat: meta.actionBeat,
    narratorRun: meta.narratorRun,
  };
}

/** The message immediately before `target`, collision-safe on the `(createdAt, id)` tuple. */
export async function messageBefore(
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

export type RerunResolution =
  | { ok: false; code: "invalid_rerun_target" | "rerun_requires_branch"; message: string }
  | {
      ok: true;
      target: { id: string; content: string };
      deletedAssistantIds: string[];
      /** EVERY deleted successor id (both roles) — user lines' attachments clean up on these. */
      deletedIds: string[];
    };

/**
 * Resolve + snip a rerun target atomically. In one transaction: confirm the
 * target row exists, is a `role: "user"` line, and belongs to this chat (else
 * `ok: false`, nothing modified — deletion only runs after validation), then
 * delete ONLY its successors ordered after it on `(created_at, id)`. The target
 * stays intact as the caller's prompt guard. In-place rerun is admitted only for
 * the latest exchange: its sole successor is the latest assistant reply, or it
 * has no successors because the reply never persisted. Older reach-back returns
 * `rerun_requires_branch` before deletion because the state store has only one
 * exchange anchor.
 *
 * Successors are computed by ORDERING in SQL at full timestamp precision and
 * slicing after the target. A `created_at > $targetDate` comparison through
 * JavaScript `Date` would truncate Postgres microseconds and could re-select and
 * delete the prompt row itself.
 */
export async function resolveRerunTarget(
  chatId: string,
  targetMessageId: string | undefined,
): Promise<RerunResolution> {
  if (!targetMessageId) {
    return { ok: false, code: "invalid_rerun_target", message: "no target message id for the rerun" };
  }
  return db().transaction(async (tx) => {
    const ordered = await tx
      .select({
        id: characterChatMessages.id,
        role: characterChatMessages.role,
        content: characterChatMessages.content,
      })
      .from(characterChatMessages)
      .where(eq(characterChatMessages.chatId, chatId))
      .orderBy(asc(characterChatMessages.createdAt), asc(characterChatMessages.id));
    const idx = ordered.findIndex((m) => m.id === targetMessageId);
    const target = idx === -1 ? undefined : ordered[idx];
    if (!target || target.role !== "user") {
      return {
        ok: false as const,
        code: "invalid_rerun_target" as const,
        message: "that message can't be rerun (not a player line in this conversation)",
      };
    }
    const successors = ordered.slice(idx + 1);
    const soleLatestReply = successors.length === 1 && successors[0]?.role === "assistant";
    if (successors.length > 0 && !soleLatestReply) {
      return {
        ok: false as const,
        code: "rerun_requires_branch" as const,
        message: "older messages cannot be rerun in place; branch the conversation from this point instead",
      };
    }
    const successorIds = successors.map((s) => s.id);
    if (successorIds.length > 0) {
      await tx.delete(characterChatMessages).where(inArray(characterChatMessages.id, successorIds));
    }
    const deletedAssistantIds = successors.filter((s) => s.role === "assistant").map((s) => s.id);
    return {
      ok: true as const,
      target: { id: target.id, content: target.content },
      deletedAssistantIds,
      deletedIds: successorIds,
    };
  });
}

/** The row's current takes, or null when the row vanished while a stream was draining. */
export async function currentReplyTakes(chatId: string, messageId: string): Promise<ReplyTakes | null> {
  const [row] = await db()
    .select({ takes: characterChatMessages.takes })
    .from(characterChatMessages)
    .where(and(eq(characterChatMessages.id, messageId), eq(characterChatMessages.chatId, chatId)))
    .limit(1);
  if (!row) return null;
  return parseOr(replyTakesSchema, row.takes, emptyReplyTakes(), undefined, "character_chat_messages.takes");
}

/**
 * Persist the assistant reply. With a `promptMessageId` the insert is guarded —
 * only if the user line that prompted it still exists (atomic `INSERT … SELECT …
 * WHERE EXISTS`), so a chat delete or a single-message delete landing while the
 * stream drains cannot leave an orphan row. Beat replies have no prompting line
 * and insert unguarded. `id` is supplied explicitly: it is the memory-provenance
 * anchor minted before the fan-out needs it.
 *
 * Exported as a test seam: a real mid-stream delete is not deterministically
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
