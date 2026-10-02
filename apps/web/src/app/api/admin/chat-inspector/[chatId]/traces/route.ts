import type { NextRequest } from "next/server";
import { buildExchangeTraceJsonOutput } from "@/contracts/turns/chat-exchange-trace";
import { jsonError, jsonOk } from "@/server/api";
import { loadChatExchangeTraces } from "@/server/memory";
import { withSelfOwnedChat } from "../../owned";

type Params = { chatId: string };

/**
 * Exchange-trace read surface (#637): one chat's recent exchange traces,
 * newest first, exactly the versioned JSON shape the CLI's `--json` output
 * also emits (`buildExchangeTraceJsonOutput` — contracts/turns/chat-exchange-trace.ts),
 * so the inspector and the CLI read identical data.
 */

const DEFAULT_LIMIT = 10;
const MIN_LIMIT = 1;
const MAX_LIMIT = 50;

interface TracesQuery {
  limit: number;
  traceId?: string;
  messageId?: string;
}

type QueryResult = { ok: true; value: TracesQuery } | { ok: false; response: ReturnType<typeof jsonError> };

/**
 * `limit` out of [1, 50] CLAMPS into range (a generous bound, not a contract —
 * same rule the other inspector panels' `days` param uses); a value that
 * cannot be read as a number at all is a different failure, the standard 400,
 * because silently defaulting it would hide a caller's typo as an empty
 * result. `traceId` / `messageId` pass straight through — an unknown id
 * already degrades to an empty result in `loadChatExchangeTraces`, never an
 * error.
 */
function parseTracesQuery(req: NextRequest): QueryResult {
  const params = req.nextUrl.searchParams;
  const rawLimit = params.get("limit");
  let limit = DEFAULT_LIMIT;
  if (rawLimit !== null) {
    const parsed = Number(rawLimit);
    if (!Number.isFinite(parsed)) {
      return { ok: false, response: jsonError("invalid_query", "limit must be a number", 400) };
    }
    limit = Math.max(MIN_LIMIT, Math.min(Math.trunc(parsed), MAX_LIMIT));
  }
  const traceId = params.get("traceId")?.trim();
  const messageId = params.get("messageId")?.trim();
  return {
    ok: true,
    value: {
      limit,
      ...(traceId ? { traceId } : {}),
      ...(messageId ? { messageId } : {}),
    },
  };
}

export const GET = withSelfOwnedChat<Params>(async (_user, owned, req) => {
  const parsed = parseTracesQuery(req);
  if (!parsed.ok) return parsed.response;
  const chatId = owned.chat.id;
  const traces = await loadChatExchangeTraces({ chatId, ...parsed.value });
  return jsonOk(buildExchangeTraceJsonOutput(chatId, traces));
});
