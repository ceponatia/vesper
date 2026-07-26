import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { jsonError, jsonOk, readBody } from "@/server/api";
import { db, facts } from "@/server/db";
import { factReturning, serializeFactRow, tryEmbed } from "../../../shared";
import { withSelfOwnedChat } from "../../../owned";

type Params = { chatId: string; factId: string };

const patchBodySchema = z
  .object({
    text: z.string().trim().min(1).max(2000).optional(),
    pinned: z.boolean().optional(),
    status: z.enum(["active", "retracted"]).optional(),
  })
  .refine((body) => body.text !== undefined || body.pinned !== undefined || body.status !== undefined, {
    message: "provide at least one of text, pinned, status",
  });

/** Edit one fact inside an owner-admin's own chat memory group. */
export const PATCH = withSelfOwnedChat<Params>(async (_user, owned, req, ctx) => {
  const { factId } = await ctx.params;
  const body = await readBody(req, patchBodySchema);
  if (!body.ok) return body.response;

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
