import { z } from "zod";
import { engineAuthoritySchema } from "@/contracts/simulation";
import { jsonError, jsonOk, readBody, withUser } from "@/server/api";
import { readChatEngineAuthority, setChatEngineAuthority } from "@/server/engine";
import { loadOwnedChat } from "../../../chats/owned";

type Params = { chatId: string };

/**
 * R1 (engine.rollout.plan.md) — the audited per-chat engine-authority dial.
 * Admin-only (404 for non-admins — hidden, never a 403, the chat-inspector
 * idiom) over chats the admin owns. GET reads the current state; PATCH flips
 * lane / RAG eligibility / branch link, landing an `engine_authority_changed`
 * audit row atomically with the write.
 */

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

export const GET = withUser<Params>(async (user, _req, ctx) => {
  if (user.role !== "admin") return jsonError("not_found", "not found", 404);
  const { chatId } = await ctx.params;
  const owned = await loadOwnedChat(chatId, user.id);
  if (!owned) return jsonError("not_found", "chat not found", 404);
  const state = await readChatEngineAuthority(chatId);
  if (!state) return jsonError("not_found", "chat not found", 404);
  return jsonOk(state);
});

export const PATCH = withUser<Params>(async (user, req, ctx) => {
  if (user.role !== "admin") return jsonError("not_found", "not found", 404);
  const { chatId } = await ctx.params;
  const owned = await loadOwnedChat(chatId, user.id);
  if (!owned) return jsonError("not_found", "chat not found", 404);
  const body = await readBody(req, patchBodySchema);
  if (!body.ok) return body.response;

  const result = await setChatEngineAuthority({
    chatId,
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
