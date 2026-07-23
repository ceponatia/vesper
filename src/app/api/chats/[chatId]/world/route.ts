import { newId } from "@/lib/ids";
import { jsonError, jsonOk, withUser } from "@/server/api";
import { readSimChatWorld, readTimeJobForChat, runDueTimeJobs } from "@/server/engine";
import { requireSimChat } from "../sim-shared";

type Params = { chatId: string };

/**
 * world-ui.plan.md slice 1 — the player-facing world read for a routed chat:
 * where the player is (or is walking to), the cast's whereabouts, the open
 * destinations, held items, and whether a scene is standing. Gated by
 * `requireSimChat` (legacy/shadow chats 409 → the card doesn't render). A
 * degraded projection returns `null` from the read, which surfaces as a 503 the
 * client treats as "no card" (ruling-18-style affordance hiding); it never
 * throws (docs/resilience.md).
 *
 * Drain-hardening A5 slice 4/5: the read is also the next-request SWEEP (re-drive any due
 * time job whose worker crashed or whose backoff elapsed — fire-and-forget, never delays the
 * read) and it surfaces the durable time job's progress as `catchingUp` so the world card can
 * render staged catch-up ("Day 12 of 30…") while the server owns completion.
 */
export const GET = withUser<Params>(async (user, _req, ctx) => {
  const { chatId } = await ctx.params;
  const gate = await requireSimChat(chatId, user.id);
  if (!gate.ok) return gate.response;
  void runDueTimeJobs(`world-read-sweep-${newId()}`).catch(() => undefined);
  const world = await readSimChatWorld(chatId);
  if (world === null) return jsonError("world_unavailable", "the world could not be read", 503);
  const timeJob = await readTimeJobForChat(chatId);
  const catchingUp = timeJob !== null && (timeJob.state === "pending" || timeJob.state === "processing");
  return jsonOk({
    ...world,
    ...(catchingUp
      ? { catchingUp: { targetStorySecond: timeJob.targetStorySecond, reachedStorySecond: timeJob.reachedStorySecond } }
      : {}),
  });
});
