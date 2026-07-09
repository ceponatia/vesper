import type { NextRequest } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { jsonError, jsonOk, readBody, withUser } from "@/server/api";
import { db, facts } from "@/server/db";
import { loadOwnedChat } from "../../../../../chats/owned";
import { factReturning, serializeFactRow, tryEmbed } from "../../../shared";

type Params = { chatId: string; factId: string };

const patchBodySchema = z
  .object({
    text: z.string().trim().min(1).max(2000).optional(),
    pinned: z.boolean().optional(),
    status: z.enum(["active", "retracted"]).optional(),
  })
  .refine((b) => b.text !== undefined || b.pinned !== undefined || b.status !== undefined, {
    message: "provide at least one of text, pinned, status",
  });

/**
 * Dev fact CRUD (character-chat-standalone.spec.md §6.1): edit content
 * (re-embeds; an embed failure still saves the text but nulls the vector so the
 * row honestly drops out of similarity retrieval — flagged `embedDegraded`),
 * hard-set `pinned` (the force-include testing lever), retract, or restore
 * (restoring also clears the supersedence marks so the row is fully live
 * again). The UPDATE is keyed on `(id, chat_memory_group_id)` — a fact outside
 * this chat's memory group is a 404, never touched. Dev-only: **404 in
 * production**.
 */
export const PATCH = withUser<Params>(async (user, req: NextRequest, ctx) => {
  if (process.env.NODE_ENV === "production") return jsonError("not_found", "not found", 404);
  const { chatId, factId } = await ctx.params;
  const body = await readBody(req, patchBodySchema);
  if (!body.ok) return body.response;
  const owned = await loadOwnedChat(chatId, user.id);
  if (!owned) return jsonError("not_found", "chat not found", 404);

  const edit = body.value;
  const embed = edit.text !== undefined ? await tryEmbed(edit.text) : null;
  const [updated] = await db()
    .update(facts)
    .set({
      ...(edit.text !== undefined
        ? { text: edit.text, embedding: embed?.vector ?? null, embedder: embed?.embedder ?? null }
        : {}),
      ...(edit.pinned !== undefined ? { pinned: edit.pinned } : {}),
      ...(edit.status !== undefined ? { status: edit.status } : {}),
      ...(edit.status === "active" ? { supersededById: null, supersededAt: null } : {}),
    })
    .where(and(eq(facts.id, factId), eq(facts.chatMemoryGroupId, owned.participant.memoryGroupId)))
    .returning(factReturning);
  if (!updated) return jsonError("not_found", "fact not found", 404);

  return jsonOk({ fact: serializeFactRow(updated), embedDegraded: embed?.degraded ?? false });
});
