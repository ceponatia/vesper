import type { NextRequest } from "next/server";
import { z } from "zod";
import { factKindSchema, factSubjectKindSchema } from "@/contracts";
import { jsonError, jsonOk, readBody, withUser } from "@/server/api";
import { addFacts, chatScope } from "@/server/memory";
import { loadOwnedChat } from "../../../../chats/owned";

type Params = { chatId: string };

const createBodySchema = z.object({
  text: z.string().trim().min(1).max(2000),
  subjectName: z.string().trim().min(1).max(120).optional(),
  subjectKind: factSubjectKindSchema.default("player"),
  kind: factKindSchema.default("knowledge"),
  pinned: z.boolean().default(false),
});

/**
 * Ad-hoc dev fact (character-chat-standalone.spec.md §6.1): a testing lever for
 * seeding memory — goes through the real `addFacts` (embedding + supersedence),
 * stamped `origin: "dev"` / confidence 1 with no source anchor, so provenance
 * stays honest and reconciliation never retracts it. `subjectName` defaults to
 * the conversation's character. Admin-only: **404 for non-admin roles**.
 */
export const POST = withUser<Params>(async (user, req: NextRequest, ctx) => {
  if (user.role !== "admin") return jsonError("not_found", "not found", 404);
  const { chatId } = await ctx.params;
  const body = await readBody(req, createBodySchema);
  if (!body.ok) return body.response;
  const owned = await loadOwnedChat(chatId, user.id);
  if (!owned) return jsonError("not_found", "chat not found", 404);

  const result = await addFacts(
    chatScope(owned.participant.memoryGroupId),
    [
      {
        kind: body.value.kind,
        subjectName: body.value.subjectName ?? owned.character.name,
        subjectKind: body.value.subjectKind,
        text: body.value.text,
        tags: [],
        confidence: 1,
        pinned: body.value.pinned,
        origin: "dev",
      },
    ],
    null,
  );
  const id = result.insertedIds[0];
  if (!id) return jsonError("internal", "fact insert failed", 500);
  return jsonOk({ id }, 201);
});
