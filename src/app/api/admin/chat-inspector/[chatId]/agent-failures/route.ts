import { jsonOk } from "@/server/api";
import { agentFailureReport, agentRunReport } from "@/server/memory";
import { withSelfOwnedChat } from "../../owned";

type Params = { chatId: string };

/**
 * Self-scoped agent-health readout for one owned conversation. It deliberately
 * excludes all-chat/global telemetry so an owner-admin inspector cannot infer
 * another account's activity through aggregate or recent-event fields.
 */
const DEFAULT_WINDOW_DAYS = 7;
const MAX_WINDOW_DAYS = 90;
const RECENT_LIMIT = 250;

export const GET = withSelfOwnedChat<Params>(async (_user, owned, req) => {
  const chatId = owned.chat.id;
  const raw = Number(new URL(req.url).searchParams.get("days"));
  const days = Number.isFinite(raw) && raw > 0 ? Math.min(Math.floor(raw), MAX_WINDOW_DAYS) : DEFAULT_WINDOW_DAYS;
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const [chat, runs] = await Promise.all([
    agentFailureReport({ chatId, since, limit: RECENT_LIMIT }),
    agentRunReport({ chatId, since, limit: RECENT_LIMIT }),
  ]);

  return jsonOk({ days, chat, runs });
});
