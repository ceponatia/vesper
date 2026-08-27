import { DiagnosticCollector } from "@/contracts";
import { jsonOk } from "@/server/api";
import { newestChatNpcSceneDecision } from "@/server/engine";
import { withSelfOwnedChat } from "../../owned";

type Params = { chatId: string };

/**
 * The NPC reply-scene decision TRACE for an owner-admin's own chat: the newest
 * non-pruned envelope, read straight off `chat_npc_scene_decisions`. The
 * envelope IS the trace — there is deliberately no `lastSceneDecisionTrace`
 * field on the chat to fall out of date — so this route computes nothing and
 * stores nothing. `decision` is `null` for a chat
 * that never ran the leg; `diagnostics` carries any boundary degradation the
 * read absorbed (a malformed payload arrives as the empty payload plus the
 * diagnostic that says so, never a 500). Same self-scoped boundary as every
 * other inspector handler.
 */
export const GET = withSelfOwnedChat<Params>(async (_user, owned) => {
  const sink = new DiagnosticCollector();
  const decision = await newestChatNpcSceneDecision(owned.chat.id, sink);
  return jsonOk({ decision, diagnostics: sink.items });
});
