import { jsonError, jsonOk, withUser } from "@/server/api";
import { compositionFallbackReport } from "@/server/memory";
import { loadOwnedChat } from "../../../../chats/owned";

type Params = { chatId: string };

/**
 * Composed-turn health for one conversation (the debug surface for
 * `contracts/turns/composition-fallback.ts` — C15): which composed legs DEGRADED behind this
 * chat's beats (a scene that wouldn't end, a partner who didn't come, a drain that stopped
 * short), how often, plus the same tally across every chat — a degrading leg is usually a
 * systemic story, not a per-conversation one.
 *
 * Admin-gated exactly like its siblings — **404 for non-admins** (hidden, never a 403) — plus
 * the ownership check on the chat itself. Admin-only per ruling 2 (players never see this).
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

  const RECENT_LIMIT = 250;
  const [chat, global] = await Promise.all([
    compositionFallbackReport({ chatId, since, limit: RECENT_LIMIT }),
    // Every chat (admin-only, single-tenant dev — stated here so it isn't mistaken for a leak).
    compositionFallbackReport({ since, limit: 0 }),
  ]);

  return jsonOk({ days, chat, global });
});
