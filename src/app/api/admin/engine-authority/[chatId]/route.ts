import { z } from "zod";
import { engineAuthoritySchema } from "@/contracts/simulation";
import { jsonError, jsonOk, readBody, withOwnerAdminOwnedChat } from "@/server/api";
import { readChatEngineAuthority, setChatEngineAuthority } from "@/server/engine";
import { loadOwnedChat } from "@/app/api/chats/owned";

type Params = { chatId: string };
type OwnedChat = NonNullable<Awaited<ReturnType<typeof loadOwnedChat>>>;

const patchBodySchema = z
  .object({
    authority: engineAuthoritySchema.optional(),
    ragEligibility: z.boolean().optional(),
    /** Explicit null unlinks the successor branch; omit to leave untouched. */
    simBranchId: z.string().min(1).max(256).nullable().optional(),
    simPlayerActorId: z.string().min(1).max(256).nullable().optional(),
    simPrimaryActorId: z.string().min(1).max(256).nullable().optional(),
  })
  .strict()
  .refine(
    (body) =>
      body.authority !== undefined ||
      body.ragEligibility !== undefined ||
      body.simBranchId !== undefined ||
      body.simPlayerActorId !== undefined ||
      body.simPrimaryActorId !== undefined,
    { message: "Nothing to change" },
  );

const ownedChat = (user: { id: string }, params: Params) => loadOwnedChat(params.chatId, user.id);

/** Read the engine-authority dial for an owner-admin's own chat only. */
export const GET = withOwnerAdminOwnedChat<Params, OwnedChat>(ownedChat, async (_user, owned) => {
  const state = await readChatEngineAuthority(owned.chat.id);
  if (!state) return jsonError("not_found", "chat not found", 404);
  return jsonOk(state);
});

/** Change the engine-authority dial for an owner-admin's own chat only. */
export const PATCH = withOwnerAdminOwnedChat<Params, OwnedChat>(ownedChat, async (user, owned, req) => {
  const body = await readBody(req, patchBodySchema);
  if (!body.ok) return body.response;

  const result = await setChatEngineAuthority({
    chatId: owned.chat.id,
    byUserId: user.id,
    ...(body.value.authority === undefined ? {} : { authority: body.value.authority }),
    ...(body.value.ragEligibility === undefined ? {} : { ragEligibility: body.value.ragEligibility }),
    ...(body.value.simBranchId === undefined ? {} : { simBranchId: body.value.simBranchId }),
    ...(body.value.simPlayerActorId === undefined ? {} : { simPlayerActorId: body.value.simPlayerActorId }),
    ...(body.value.simPrimaryActorId === undefined
      ? {}
      : { simPrimaryActorId: body.value.simPrimaryActorId }),
  });
  if (!result) return jsonError("not_found", "chat not found", 404);
  return jsonOk(result);
});
