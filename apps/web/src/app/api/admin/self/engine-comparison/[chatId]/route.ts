import { jsonError, jsonOk, withOwnerAdminOwnedChat } from "@/server/api";
import {
  readEngineComparisonStatus,
  startEngineComparison,
  stopEngineComparison,
} from "@/server/engine";
import { loadOwnedChat } from "@/app/api/chats/owned";

type Params = { chatId: string };
type OwnedChat = NonNullable<Awaited<ReturnType<typeof loadOwnedChat>>>;

const ownedChat = (user: { id: string }, params: Params) => loadOwnedChat(params.chatId, user.id);

/** Current owner-admin Engine Comparison state for one conversation. */
export const GET = withOwnerAdminOwnedChat<Params, OwnedChat>(ownedChat, async (_user, owned) =>
  jsonOk(await readEngineComparisonStatus(owned.chat.id)),
);

/** Build a fresh mirror from current legacy state and begin comparison. */
export const POST = withOwnerAdminOwnedChat<Params, OwnedChat>(ownedChat, async (user, owned) => {
  const result = await startEngineComparison(owned.chat.id, user.id);
  if (!result.ok) {
    const status = result.code === "not_found" ? 404 : 409;
    return jsonError(result.code, result.message, status);
  }
  return jsonOk(result.status);
});

/** Stop comparison, keep recorded findings, and return to plain legacy authority. */
export const DELETE = withOwnerAdminOwnedChat<Params, OwnedChat>(ownedChat, async (user, owned) => {
  const result = await stopEngineComparison(owned.chat.id, user.id);
  if (!result.ok) {
    const status = result.code === "not_found" ? 404 : 409;
    return jsonError(result.code, result.message, status);
  }
  return jsonOk(result.status);
});
