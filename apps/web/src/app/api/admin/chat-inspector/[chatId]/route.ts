import { eq } from "drizzle-orm";
import { jsonOk } from "@/server/api";
import { characterChatSummaries, db } from "@/server/db";
import { chatScope, listEpisodesForScope, listFactsForScope } from "@/server/memory";
import { serializeEpisodeRow, serializeFactRow, toIso } from "../shared";
import { withSelfOwnedChat } from "../owned";

type Params = { chatId: string };

/**
 * Self-scoped developer chat-inspector overview: everything stored for the
 * administrator's own conversation memory group. Cross-account inspection is
 * impossible through this route family; future support access uses the distinct
 * audited `/api/admin/support` boundary.
 */
export const GET = withSelfOwnedChat<Params>(async (_user, owned) => {
  const chatId = owned.chat.id;
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
