import type { NextRequest } from "next/server";
import { z } from "zod";
import { DiagnosticCollector } from "@/contracts";
import { dailyBudgetRejection, jsonError, jsonOk, readBody, withUser } from "@/server/api";
import { addFacts, chatScope } from "@/server/memory";
import { resolveChatPersona } from "@/server/players";
import { loadOwnedChat } from "../../owned";

type Params = { chatId: string };

/**
 * "Remember this" (D15): the one player-facing
 * memory affordance — write-only (no browsing, D2). The note lands as a normal fact via
 * `addFacts` (so retrieval, supersedence, embedding, and delete all just work) marked
 * `pinned` + `origin:"player"`: always retrieved ahead of the top-k, exempt from the
 * relevance floor, and never superseded or retracted by an archivist-extracted fact —
 * only the player (or a dev in the inspector) can retire it. `source_message_id` stays
 * null: the note is the player's, not an exchange extraction, so message deletes never
 * reap it. The standard supersedence pass still runs, so a sufficiently similar older
 * fact is retired the moment the note lands ("updated memory replaces old").
 */

/** Cap matches a compact note — pinned memory is a lever, not a journal. */
const rememberBodySchema = z.object({
  content: z.string().trim().min(1).max(500),
});

export const POST = withUser<Params>(async (user, req: NextRequest, ctx) => {
  const { chatId } = await ctx.params;
  const body = await readBody(req, rememberBodySchema);
  if (!body.ok) return body.response;

  const owned = await loadOwnedChat(chatId, user.id);
  if (!owned) return jsonError("not_found", "chat not found", 404);
  if (owned.chat.archivedAt) {
    return jsonError("chat_archived", "this conversation is archived; restore it to continue", 409);
  }

  // Storing a note embeds it, so this route spends on the embedding lane.
  const blocked = await dailyBudgetRejection("provider_embed_day", user, req);
  if (blocked) return blocked;

  const sink = new DiagnosticCollector();
  const player = await resolveChatPersona({ ownerId: user.id, chatId });
  const result = await addFacts(
    chatScope(owned.participant.memoryGroupId),
    [
      {
        kind: "knowledge",
        subjectKind: "player",
        subjectName: player.name.trim() || "the player",
        text: body.value.content,
        tags: ["player-note"],
        confidence: 1,
        pinned: true,
        origin: "player",
      },
    ],
    null,
    sink,
  );
  return jsonOk(
    {
      id: result.insertedIds[0] ?? null,
      superseded: result.supersededIds.length,
      diagnostics: sink.items.map((d) => d.code),
    },
    201,
  );
}, { limit: "embed" });
