import { jsonOk } from "@/server/api";
import { compositionFallbackReport } from "@/server/memory";
import { withSelfOwnedChat } from "../../owned";

type Params = { chatId: string };

/** Self-scoped composed-turn health for one owned conversation. */
const DEFAULT_WINDOW_DAYS = 7;
const MAX_WINDOW_DAYS = 90;
const RECENT_LIMIT = 250;

export const GET = withSelfOwnedChat<Params>(async (_user, owned, req) => {
  const raw = Number(new URL(req.url).searchParams.get("days"));
  const days = Number.isFinite(raw) && raw > 0 ? Math.min(Math.floor(raw), MAX_WINDOW_DAYS) : DEFAULT_WINDOW_DAYS;
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const chat = await compositionFallbackReport({ chatId: owned.chat.id, since, limit: RECENT_LIMIT });
  return jsonOk({ days, chat });
});
