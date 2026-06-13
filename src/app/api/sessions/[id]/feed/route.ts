import { and, desc, eq, lt, type SQL } from "drizzle-orm";
import { jsonError, jsonOk, withUser } from "@/server/api";
import { db, turnMessages, turns } from "@/server/db";
import { findOwnedSession } from "../../_shared/access";

type Params = { id: string };

const FEED_PAGE_SIZE = 80;

interface FeedMessage {
  messageId: string;
  turnId: string;
  turnNumber: number;
  seq: number;
  role: "player" | "narrator" | "character" | "system";
  speaker: string | null;
  content: string;
  createdAt: Date;
}

/**
 * GET /api/sessions/:id/feed — latest 80 turn messages ascending by
 * (turn.number, seq), `?before=<turnNumber>` cursor for older pages
 * (docs/streaming-api.md §Pagination). A page never splits a turn: when the
 * size cap lands mid-turn, that turn is deferred whole to the next page
 * (unless it alone exceeds the page). `system`-role messages are the feed's
 * dividers. `tailTurn` carries the latest turn's status for the retry
 * affordance.
 */
export const GET = withUser<Params>(async (user, req, ctx) => {
  const { id } = await ctx.params;
  const session = await findOwnedSession(user.id, id);
  if (!session) return jsonError("not_found", "session not found", 404);

  const beforeRaw = req.nextUrl.searchParams.get("before");
  let before: number | null = null;
  if (beforeRaw !== null) {
    before = Number.parseInt(beforeRaw, 10);
    if (!Number.isFinite(before) || before < 1 || String(before) !== beforeRaw.trim()) {
      return jsonError("invalid_query", "before must be a positive turn number", 400);
    }
  }

  const filters: SQL[] = [eq(turns.sessionId, id)];
  if (before !== null) filters.push(lt(turns.number, before));

  const rows: FeedMessage[] = await db()
    .select({
      messageId: turnMessages.id,
      turnId: turns.id,
      turnNumber: turns.number,
      seq: turnMessages.seq,
      role: turnMessages.role,
      speaker: turnMessages.speaker,
      content: turnMessages.content,
      createdAt: turnMessages.createdAt,
    })
    .from(turnMessages)
    .innerJoin(turns, eq(turnMessages.turnId, turns.id))
    .where(and(...filters))
    .orderBy(desc(turns.number), desc(turnMessages.seq))
    .limit(FEED_PAGE_SIZE + 1);

  const hasMore = rows.length > FEED_PAGE_SIZE;
  let page = rows.slice(0, FEED_PAGE_SIZE);
  if (hasMore) {
    const boundary = rows[FEED_PAGE_SIZE];
    const oldest = page[page.length - 1];
    if (boundary && oldest && boundary.turnNumber === oldest.turnNumber) {
      const trimmed = page.filter((r) => r.turnNumber !== oldest.turnNumber);
      if (trimmed.length > 0) page = trimmed;
    }
  }
  page.reverse(); // (turn.number, seq) ascending

  const [latest] = await db()
    .select({ id: turns.id, number: turns.number, status: turns.status })
    .from(turns)
    .where(eq(turns.sessionId, id))
    .orderBy(desc(turns.number))
    .limit(1);

  return jsonOk({
    messages: page,
    hasMore,
    nextBefore: hasMore ? (page[0]?.turnNumber ?? null) : null,
    tailTurn: latest ?? null,
  });
});
