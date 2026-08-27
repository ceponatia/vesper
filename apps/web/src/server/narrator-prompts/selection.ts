import { and, eq, isNull } from "drizzle-orm";
import {
  narratorPromptLanguageSchema,
  productionInstructionSource,
  NARRATOR_INSTRUCTION_FALLBACK_CODE,
  type NarratorInstructionFallbackReason,
  type NarratorInstructionSource,
  type NarratorPromptTemplateSummary,
} from "@/contracts/narrator-prompts";
import { diag, type DiagnosticSink } from "@/contracts/diagnostics";
import { parseOrNull } from "@/lib/parse";
import { characterChats, db, narratorPromptRevisions, narratorPromptTemplates } from "@/server/db";
import { listNarratorPromptTemplates } from "./templates";

/**
 * The per-conversation half of the Narrator Prompt Lab: which template a chat is
 * experimenting with, and the one function that turns that selection into the
 * instruction source an exchange runs on.
 *
 * The selection is **operational configuration, not story state** — it is not on
 * the scenario, no preset carries it, and no retake, regenerate, rerun, state
 * reset or simulation rollback touches it.
 */

/**
 * The only two answers `setChatNarratorPromptSelection` can give. Deliberately
 * narrower than `NarratorPromptResult`: neither a revision conflict nor a name
 * collision is reachable here, and offering the route those cases would ask it
 * to map statuses that can never occur.
 */
export type ChatNarratorPromptSelectionResult =
  | { ok: true; value: ChatNarratorPromptSelection }
  | { ok: false; code: "not_found" };

/** Everything the conversation menu's selector and its active-test badge need, in one read. */
export interface ChatNarratorPromptSelection {
  chatId: string;
  /** The stored selection. `null` ⇒ Vesper production instructions. */
  promptId: string | null;
  /**
   * The selected template as the badge renders it (`name` + `currentRevision`).
   * `null` when the chat is on production — and also when the stored selection no
   * longer resolves, which is exactly what the next exchange will fall back from.
   */
  selected: NarratorPromptTemplateSummary | null;
  /** The owner's active templates, newest-edited first — the selector's options. */
  available: NarratorPromptTemplateSummary[];
}

/** `null` when the conversation is not this owner's — the route turns that into a 404. */
export async function getChatNarratorPromptSelection(
  ownerId: string,
  chatId: string,
): Promise<ChatNarratorPromptSelection | null> {
  const [chat] = await db()
    .select({ promptId: characterChats.narratorPromptTemplateId })
    .from(characterChats)
    .where(and(eq(characterChats.id, chatId), eq(characterChats.ownerId, ownerId)))
    .limit(1);
  if (!chat) return null;

  const available = await listNarratorPromptTemplates(ownerId);
  const selected = available.find((template) => template.id === chat.promptId) ?? null;
  return { chatId, promptId: chat.promptId, selected, available };
}

/**
 * Point one conversation at a template, or back at production instructions.
 *
 * The template is re-verified as this owner's and NOT soft-deleted before the
 * write. A template id in a request body is not evidence of anything: without
 * this check an administrator could attach another account's prompt — or a
 * deleted one — to a conversation and every exchange would then take the
 * degraded fallback path for a selection that should never have been stored.
 */
export async function setChatNarratorPromptSelection(
  ownerId: string,
  chatId: string,
  promptId: string | null,
): Promise<ChatNarratorPromptSelectionResult> {
  if (promptId !== null) {
    const [template] = await db()
      .select({ id: narratorPromptTemplates.id })
      .from(narratorPromptTemplates)
      .where(
        and(
          eq(narratorPromptTemplates.id, promptId),
          eq(narratorPromptTemplates.ownerId, ownerId),
          isNull(narratorPromptTemplates.deletedAt),
        ),
      )
      .limit(1);
    if (!template) return { ok: false, code: "not_found" };
  }

  const updated = await db()
    .update(characterChats)
    .set({ narratorPromptTemplateId: promptId })
    .where(and(eq(characterChats.id, chatId), eq(characterChats.ownerId, ownerId)))
    .returning({ id: characterChats.id });
  if (!updated[0]) return { ok: false, code: "not_found" };

  const selection = await getChatNarratorPromptSelection(ownerId, chatId);
  return selection === null ? { ok: false, code: "not_found" } : { ok: true, value: selection };
}

// ---------------------------------------------------------------------------
// Exchange-time resolution
// ---------------------------------------------------------------------------

/**
 * The chat's selection joined to its template and that template's current
 * revision, in one round trip. Every join is LEFT so the four distinguishable
 * failures stay distinguishable — an inner join would collapse "gone",
 * "deleted" and "no revision" into one indistinguishable empty result.
 */
async function readSelectionRow(ownerId: string, chatId: string) {
  const [row] = await db()
    .select({
      promptId: characterChats.narratorPromptTemplateId,
      templateId: narratorPromptTemplates.id,
      templateName: narratorPromptTemplates.name,
      deletedAt: narratorPromptTemplates.deletedAt,
      revisionId: narratorPromptRevisions.id,
      revision: narratorPromptRevisions.revision,
      body: narratorPromptRevisions.body,
      bodyHash: narratorPromptRevisions.bodyHash,
      templateLanguage: narratorPromptRevisions.templateLanguage,
    })
    .from(characterChats)
    // Owner-scoped in the JOIN as well as the WHERE: a selection that somehow
    // points at another account's template must read as missing, not resolve.
    .leftJoin(
      narratorPromptTemplates,
      and(
        eq(narratorPromptTemplates.id, characterChats.narratorPromptTemplateId),
        eq(narratorPromptTemplates.ownerId, ownerId),
      ),
    )
    // Deliberately NOT filtered on `deleted_at` — a soft-deleted template still
    // joins, so `template_deleted` and `template_missing` stay separate answers.
    .leftJoin(narratorPromptRevisions, eq(narratorPromptRevisions.id, narratorPromptTemplates.currentRevisionId))
    .where(and(eq(characterChats.id, chatId), eq(characterChats.ownerId, ownerId)))
    .limit(1);
  return row;
}

function fallback(
  sink: DiagnosticSink | undefined,
  chatId: string,
  reason: NarratorInstructionFallbackReason,
  templateId: string,
): NarratorInstructionSource {
  sink?.push(
    diag("warn", NARRATOR_INSTRUCTION_FALLBACK_CODE, `narrator prompt override unavailable: ${reason}`, {
      path: "character_chats.narrator_prompt_template_id",
      context: { chatId, templateId, reason },
    }),
  );
  return productionInstructionSource();
}

/**
 * Resolve the ONE instruction source this exchange runs on. Slice 5 calls it
 * **after the exchange lock is acquired** and before any narrator prompt is
 * built; the returned value is then reused unchanged by the first call, every
 * hidden retry, the audit, settlement and provenance, so a save landing in
 * another browser tab mid-stream cannot reach the reply being written.
 *
 * **This function never throws and never returns nothing.** Every way a
 * selection can fail to resolve — the template gone, soft-deleted, its current
 * revision missing, or written in a language this build does not know — degrades
 * to production instructions and emits `narrator_prompt_override_unavailable`
 * with the reason. That is a hard rule: a prompt experiment must never be able
 * to dead-end a conversation.
 *
 * A chat with no selection is the ordinary case, not a degradation, and emits
 * nothing.
 */
export async function resolveNarratorInstructionSource(
  ownerId: string,
  chatId: string,
  sink?: DiagnosticSink,
): Promise<NarratorInstructionSource> {
  let row: Awaited<ReturnType<typeof readSelectionRow>>;
  try {
    row = await readSelectionRow(ownerId, chatId);
  } catch (err) {
    // An unreadable database is not one of the four selection failures, so no
    // `reason` is claimed — but the exchange still narrates on production
    // instructions rather than failing.
    sink?.push(
      diag("error", NARRATOR_INSTRUCTION_FALLBACK_CODE, "narrator prompt selection could not be read", {
        path: "character_chats.narrator_prompt_template_id",
        context: { chatId, error: err instanceof Error ? err.message : String(err) },
      }),
    );
    return productionInstructionSource();
  }

  // No chat row (not this owner's, or gone) and no selection are both simply
  // "production", and neither is a degradation worth a diagnostic.
  if (!row || row.promptId === null) return productionInstructionSource();

  if (row.templateId === null) return fallback(sink, chatId, "template_missing", row.promptId);
  if (row.deletedAt !== null) return fallback(sink, chatId, "template_deleted", row.promptId);
  if (row.revisionId === null || row.revision === null || row.body === null || row.bodyHash === null) {
    return fallback(sink, chatId, "revision_missing", row.promptId);
  }

  // The stored language is a trust boundary: an unknown future language never
  // executes as `plain_v0` by guess (docs/resilience.md §1).
  const language = parseOrNull(narratorPromptLanguageSchema, row.templateLanguage);
  if (language === null) return fallback(sink, chatId, "unknown_language", row.promptId);

  return {
    kind: "test",
    templateId: row.templateId,
    templateName: row.templateName ?? "",
    revisionId: row.revisionId,
    revision: row.revision,
    body: row.body,
    bodyHash: row.bodyHash,
    templateLanguage: language,
  };
}
