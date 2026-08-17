import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { jsonOk, readBody, withOwnedChat } from "@/server/api";
import { characterChats, db } from "@/server/db";
import { loadOwnedChat } from "@/app/api/chats/owned";

type Params = { chatId: string };
type OwnedChat = NonNullable<Awaited<ReturnType<typeof loadOwnedChat>>>;

const ownedChat = (user: { id: string }, params: Params) => loadOwnedChat(params.chatId, user.id);
const patchSchema = z.object({ enabled: z.boolean() }).strict();

/**
 * The per-conversation visual-state narration switch (visual-state.plan.md
 * slice 7; owner ruling 2026-08-17).
 *
 * Its own tiny route rather than a field on the chat-state PATCH, for the same
 * reason `agentReasoningProfile` has one: this is OPERATIONAL configuration, not
 * story state. It does not ride `ChatScenario`, so "another take" and state
 * rollback leave it exactly where the owner set it — which is what makes it
 * usable as a thing to switch on mid-conversation and read.
 *
 * Owner-scoped, not admin-gated: it changes what the narrator is told about a
 * conversation the owner owns.
 */
export const GET = withOwnedChat<Params, OwnedChat>(ownedChat, async (_user, owned) => {
  const [row] = await db()
    .select({ enabled: characterChats.visualStateNarration })
    .from(characterChats)
    .where(eq(characterChats.id, owned.chat.id))
    .limit(1);

  return jsonOk({ enabled: row?.enabled ?? false });
});

/** Applies from the next exchange; nothing already written is re-narrated. */
export const PATCH = withOwnedChat<Params, OwnedChat>(ownedChat, async (user, owned, req) => {
  const body = await readBody(req, patchSchema);
  if (!body.ok) return body.response;

  await db()
    .update(characterChats)
    .set({ visualStateNarration: body.value.enabled })
    .where(and(eq(characterChats.id, owned.chat.id), eq(characterChats.ownerId, user.id)));

  return jsonOk({ enabled: body.value.enabled });
});
