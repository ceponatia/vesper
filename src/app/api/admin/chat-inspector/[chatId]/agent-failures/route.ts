import { jsonError, jsonOk, withUser } from "@/server/api";
import { agentFailureReport } from "@/server/memory";
import { loadOwnedChat } from "../../../../chats/owned";

type Params = { chatId: string };

/**
 * Agent-health readout for one conversation (the debug surface for
 * `contracts/turns/agent-failure.ts`): which helper legs FAILED behind this chat's replies,
 * how often, and the suspected cause — plus the same tally across every chat, because a
 * timing-out leg is usually an infrastructure story (a slow endpoint, a low token cap), not
 * a per-conversation one.
 *
 * Admin-gated exactly like its siblings — **404 for non-admins** (hidden, never a 403) —
 * plus the ownership check on the chat itself.
 */
const DEFAULT_WINDOW_DAYS = 7;
const MAX_WINDOW_DAYS = 90;

export const GET = withUser<Params>(async (user, req, ctx) => {
  if (user.role !== "admin") return jsonError("not_found", "not found", 404);
  const { chatId } = await ctx.params;
  const owned = await loadOwnedChat(chatId, user.id);
  if (!owned) return jsonError("not_found", "chat not found", 404);

  // A bad/absent `?days=` degrades to the default rather than 400ing a debug page.
  const raw = Number(new URL(req.url).searchParams.get("days"));
  const days = Number.isFinite(raw) && raw > 0 ? Math.min(Math.floor(raw), MAX_WINDOW_DAYS) : DEFAULT_WINDOW_DAYS;
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const [chat, global] = await Promise.all([
    agentFailureReport({ chatId, since }),
    // Every chat (the events stream is not per-owner, but this route is admin-only and the
    // deployment is single-tenant dev — stated here so it isn't mistaken for a leak).
    agentFailureReport({ since, limit: 0 }),
  ]);

  return jsonOk({ days, chat, global });
});
