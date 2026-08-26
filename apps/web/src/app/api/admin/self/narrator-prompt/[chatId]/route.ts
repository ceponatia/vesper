import { selectNarratorPromptRequestSchema } from "@/contracts/narrator-prompts";
import { jsonError, jsonOk, readBody, withOwnerAdminOwnedChat } from "@/server/api";
import { getChatNarratorPromptSelection, setChatNarratorPromptSelection } from "@/server/narrator-prompts";
import { loadOwnedChat } from "@/app/api/chats/owned";

/**
 * Which narrator instruction prompt ONE conversation is experimenting with
 * (narrator-prompt-lab.plan.md §3, slice 4).
 *
 * Per conversation, not per character: the narrator-MODEL pick is character-level
 * because it is a general preference, but prompt experiments need the opposite —
 * two conversations with the same character must be able to run different
 * instruction prompts for a parallel A/B.
 *
 * PATCH accepts `{ promptId: string | null }` and nothing else. A chat send must
 * never carry raw prompt text, a revision body, or a one-call template override:
 * the server resolves the selected template from the owned chat, which is what
 * keeps authorization and take provenance server-owned and makes request-level
 * prompt spoofing impossible.
 *
 * The selection is operational configuration, not story state — no retake,
 * regenerate, rerun, state reset or simulation rollback touches it, and no
 * scenario preset carries it. It applies from the NEXT exchange onward, because
 * an in-flight exchange froze its instruction source under its own lock.
 */

type Params = { chatId: string };
type OwnedChat = NonNullable<Awaited<ReturnType<typeof loadOwnedChat>>>;

const ownedChat = (user: { id: string }, params: Params) => loadOwnedChat(params.chatId, user.id);

/** The current selection, the badge's template, and the owner's selectable prompts. */
export const GET = withOwnerAdminOwnedChat<Params, OwnedChat>(ownedChat, async (user, owned) => {
  const selection = await getChatNarratorPromptSelection(user.id, owned.chat.id);
  return selection === null
    ? jsonError("not_found", "chat not found", 404)
    : jsonOk({ selection });
});

export const PATCH = withOwnerAdminOwnedChat<Params, OwnedChat>(ownedChat, async (user, owned, req) => {
  const body = await readBody(req, selectNarratorPromptRequestSchema);
  if (!body.ok) return body.response;

  // The service re-verifies that the template is this owner's and is not
  // soft-deleted before it writes. A template id in a request body is not
  // evidence of anything, and storing an unresolvable one would put the
  // conversation on the degraded fallback path indefinitely.
  const result = await setChatNarratorPromptSelection(user.id, owned.chat.id, body.value.promptId);
  return result.ok
    ? jsonOk({ selection: result.value })
    : jsonError("not_found", "narrator prompt not found", 404);
});
