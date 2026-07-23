import { jsonError, jsonOk, withUser } from "@/server/api";
import { readSimChatWorld } from "@/server/engine";
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
 */
export const GET = withUser<Params>(async (user, _req, ctx) => {
  const { chatId } = await ctx.params;
  const gate = await requireSimChat(chatId, user.id);
  if (!gate.ok) return gate.response;
  const world = await readSimChatWorld(chatId);
  if (world === null) return jsonError("world_unavailable", "the world could not be read", 503);
  return jsonOk(world);
});
