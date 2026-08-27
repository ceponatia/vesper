import { backpressureRejection, dailyBudgetRejection, jsonError, jsonOk, withUser } from "@/server/api";
import { rebuildChatSummary } from "@/server/engine";
import { loadOwnedChat } from "../../../owned";

type Params = { chatId: string };

/**
 * Rebuild the rolling summary from the full transcript — the recovery lever for
 * folded-then-deleted lines. Runs inline (a handful of fold calls under the per-chat
 * summary lock); heavy-write rate limited since each fold is a model call.
 */
export const POST = withUser<Params>(
  async (user, req, ctx) => {
    const { chatId } = await ctx.params;
    const owned = await loadOwnedChat(chatId, user.id);
    if (!owned) return jsonError("not_found", "chat not found", 404);

    const shed = await backpressureRejection("text", user, req);
    if (shed) return shed;

    // A rebuild is several folds, so it charges the text lane more than once.
    const overBudget = await dailyBudgetRejection("provider_text_day", user, req, 5);
    if (overBudget) return overBudget;

    const result = await rebuildChatSummary(chatId);
    return jsonOk(result);
  },
  { limit: "heavy_write" },
);
