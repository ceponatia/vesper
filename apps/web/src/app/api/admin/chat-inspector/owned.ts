import type { AuthorizedHandler } from "@/server/api";
import { withOwnerAdminOwnedChat } from "@/server/api";
import { loadOwnedChat } from "@/app/api/chats/owned";

type OwnedInspectorChat = NonNullable<Awaited<ReturnType<typeof loadOwnedChat>>>;

/** Shared self-scoped boundary for every chat-inspector handler. */
export function withSelfOwnedChat<P extends { chatId: string }>(
  handler: AuthorizedHandler<P, OwnedInspectorChat>,
) {
  return withOwnerAdminOwnedChat<P, OwnedInspectorChat>(
    (user, params) => loadOwnedChat(params.chatId, user.id),
    handler,
  );
}
