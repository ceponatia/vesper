import { z } from "zod";
import { factKindSchema, factSubjectKindSchema } from "@/contracts";
import { jsonError, jsonOk, readBody } from "@/server/api";
import { addFacts, chatScope } from "@/server/memory";
import { withSelfOwnedChat } from "../../owned";

type Params = { chatId: string };

const createBodySchema = z.object({
  text: z.string().trim().min(1).max(2000),
  subjectName: z.string().trim().min(1).max(120).optional(),
  subjectKind: factSubjectKindSchema.default("player"),
  kind: factKindSchema.default("knowledge"),
  pinned: z.boolean().default(false),
});

/** Add a development fact to an owner-admin's own conversation only. */
export const POST = withSelfOwnedChat<Params>(async (_user, owned, req) => {
  const body = await readBody(req, createBodySchema);
  if (!body.ok) return body.response;

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
