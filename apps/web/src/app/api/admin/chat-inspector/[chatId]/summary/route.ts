import { z } from "zod";
import { jsonError, jsonOk, readBody } from "@/server/api";
import { characterChatSummaries, db } from "@/server/db";
import { toIso } from "../../shared";
import { withSelfOwnedChat } from "../../owned";

type Params = { chatId: string };

const patchBodySchema = z.object({
  summary: z.string().max(4000),
});

/** Edit the rolling summary for an owner-admin's own chat only. */
export const PATCH = withSelfOwnedChat<Params>(async (_user, owned, req) => {
  const body = await readBody(req, patchBodySchema);
  if (!body.ok) return body.response;

  const [row] = await db()
    .insert(characterChatSummaries)
    .values({ chatId: owned.chat.id, summary: body.value.summary })
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
