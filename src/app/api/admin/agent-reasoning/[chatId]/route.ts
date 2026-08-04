import { eq } from "drizzle-orm";
import { z } from "zod";
import {
  AGENT_REASONING_PROFILES,
  resolveAgentReasoningProfile,
  strictAgentReasoningProfileSchema,
} from "@/lib/agent-reasoning";
import { jsonOk, readBody, withOwnerAdminOwnedChat } from "@/server/api";
import { characterChats, db } from "@/server/db";
import { loadOwnedChat } from "@/app/api/chats/owned";

type Params = { chatId: string };
type OwnedChat = NonNullable<Awaited<ReturnType<typeof loadOwnedChat>>>;

const ownedChat = (user: { id: string }, params: Params) => loadOwnedChat(params.chatId, user.id);
const patchSchema = z.object({ profile: strictAgentReasoningProfileSchema }).strict();

/** Read the current admin-only experiment setting for an owned conversation. */
export const GET = withOwnerAdminOwnedChat<Params, OwnedChat>(ownedChat, async (_user, owned) =>
  jsonOk({
    profile: resolveAgentReasoningProfile(owned.chat.agentReasoningProfile),
    profiles: AGENT_REASONING_PROFILES,
  }),
);

/** Apply beginning with the next helper-agent call; story rollback never touches it. */
export const PATCH = withOwnerAdminOwnedChat<Params, OwnedChat>(ownedChat, async (_user, owned, req) => {
  const body = await readBody(req, patchSchema);
  if (!body.ok) return body.response;

  await db()
    .update(characterChats)
    .set({ agentReasoningProfile: body.value.profile })
    .where(eq(characterChats.id, owned.chat.id));

  return jsonOk({
    profile: body.value.profile,
    profiles: AGENT_REASONING_PROFILES,
  });
});
