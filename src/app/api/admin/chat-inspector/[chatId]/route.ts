import { eq } from "drizzle-orm";
import { jsonError, jsonOk, withUser } from "@/server/api";
import { characterChatSummaries, db } from "@/server/db";
import { chatScope, listEpisodesForScope, listFactsForScope } from "@/server/memory";
import { loadOwnedChat } from "../../../chats/owned";
import { serializeEpisodeRow, serializeFactRow, toIso } from "../shared";

type Params = { chatId: string };

/**
 * Dev chat-inspector overview (character-chat-standalone.spec.md §6.1): everything
 * stored for one conversation's memory group — ALL facts (active + superseded +
 * retracted, so provenance and supersedence chains are visible), every episode,
 * the rolling-summary row, and the character card for the page header. Gated
 * by role — **404 for non-admins** (hidden, never a 403) — plus the usual
 * ownership resolution (a miss is a 404, never a 403).
 */
export const GET = withUser<Params>(async (user, _req, ctx) => {
  if (user.role !== "admin") return jsonError("not_found", "not found", 404);
  const { chatId } = await ctx.params;
  const owned = await loadOwnedChat(chatId, user.id);
  if (!owned) return jsonError("not_found", "chat not found", 404);

  const scope = chatScope(owned.participant.memoryGroupId);
  const [factRows, episodeRows, [summaryRow]] = await Promise.all([
    listFactsForScope(scope, { includeInactive: true }),
    listEpisodesForScope(scope),
    db()
      .select({
        summary: characterChatSummaries.summary,
        watermarkAt: characterChatSummaries.watermarkAt,
        coveredExchanges: characterChatSummaries.coveredExchanges,
      })
      .from(characterChatSummaries)
      .where(eq(characterChatSummaries.chatId, chatId))
      .limit(1),
  ]);

  return jsonOk({
    facts: factRows.map(serializeFactRow),
    episodes: episodeRows.map(serializeEpisodeRow),
    summary: summaryRow
      ? {
          summary: summaryRow.summary,
          watermarkAt: toIso(summaryRow.watermarkAt),
          coveredExchanges: summaryRow.coveredExchanges,
        }
      : null,
    character: { id: owned.character.id, name: owned.character.name },
  });
});
