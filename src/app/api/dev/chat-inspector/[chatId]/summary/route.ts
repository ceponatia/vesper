import type { NextRequest } from "next/server";
import { z } from "zod";
import { jsonError, jsonOk, readBody, withUser } from "@/server/api";
import { characterChatSummaries, db } from "@/server/db";
import { loadOwnedChat } from "../../../../chats/owned";
import { toIso } from "../../shared";

type Params = { chatId: string };

const patchBodySchema = z.object({
  summary: z.string().max(4000),
});

/**
 * Dev rolling-summary edit (character-chat-standalone.spec.md §6.1): upsert the
 * `character_chat_summaries` row's prose — deliberately WITHOUT touching the
 * watermark columns, so the verbatim-window boundary (what the fold job covers
 * next) is unchanged; only the recap text the prompt sends is. Empty string
 * clears it. Dev-only: **404 in production**.
 */
export const PATCH = withUser<Params>(async (user, req: NextRequest, ctx) => {
  if (process.env.NODE_ENV === "production") return jsonError("not_found", "not found", 404);
  const { chatId } = await ctx.params;
  const body = await readBody(req, patchBodySchema);
  if (!body.ok) return body.response;
  if (!(await loadOwnedChat(chatId, user.id))) return jsonError("not_found", "chat not found", 404);

  const [row] = await db()
    .insert(characterChatSummaries)
    .values({ chatId, summary: body.value.summary })
    .onConflictDoUpdate({
      target: characterChatSummaries.chatId,
      set: { summary: body.value.summary, updatedAt: new Date() },
    })
    .returning({
      summary: characterChatSummaries.summary,
      watermarkAt: characterChatSummaries.watermarkAt,
      coveredExchanges: characterChatSummaries.coveredExchanges,
    });
  if (!row) return jsonError("internal", "summary upsert failed", 500);

  return jsonOk({
    summary: row.summary,
    watermarkAt: toIso(row.watermarkAt),
    coveredExchanges: row.coveredExchanges,
  });
});
