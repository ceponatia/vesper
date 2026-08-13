import { newId } from "@/lib/ids";
import { jsonError, jsonOk, withOwnedChat } from "@/server/api";
import { readSimChatWorld, readTimeJobForChat, runDueTimeJobs } from "@/server/engine";
import { loadOwnedChat } from "../../owned";
import { requireSimChat } from "../sim-shared";

type Params = { chatId: string };

export const GET = withOwnedChat<Params, NonNullable<Awaited<ReturnType<typeof loadOwnedChat>>>>(
  (user, params) => loadOwnedChat(params.chatId, user.id),
  async (user, owned, _req, ctx) => {
    const { chatId } = await ctx.params;
    const gate = await requireSimChat(chatId, user.id, owned);
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
  },
);
