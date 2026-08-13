import { and, eq } from "drizzle-orm";
import type { AuthorizedHandler } from "@/server/api";
import { withOwnerAdminOwnedChat, withOwnerAdminResource } from "@/server/api";
import { characterChats, db, simBranches } from "@/server/db";
import { loadOwnedChat } from "@/app/api/chats/owned";

export interface OwnedSimBranch {
  branchId: string;
  worldId: string;
  chatId: string;
}

export async function loadOwnedSimBranch(userId: string, branchId: string): Promise<OwnedSimBranch | null> {
  const [row] = await db()
    .select({ branchId: simBranches.id, worldId: simBranches.worldId, chatId: characterChats.id })
    .from(characterChats)
    .innerJoin(simBranches, eq(simBranches.id, characterChats.simBranchId))
    .where(and(eq(characterChats.ownerId, userId), eq(simBranches.id, branchId)))
    .limit(1);
  return row ?? null;
}

/** Shared owner-admin boundary for branch status and command tools. */
export function withSelfOwnedBranch<P extends { branchId: string }>(
  handler: AuthorizedHandler<P, OwnedSimBranch>,
) {
  return withOwnerAdminResource<P, OwnedSimBranch>(
    "branch",
    (user, params) => loadOwnedSimBranch(user.id, params.branchId),
    handler,
  );
}

type OwnedChat = NonNullable<Awaited<ReturnType<typeof loadOwnedChat>>>;

/** Shared owner-admin boundary for chat-keyed simulation diagnostics. */
export function withSelfOwnedSimChat<P extends { chatId: string }>(handler: AuthorizedHandler<P, OwnedChat>) {
  return withOwnerAdminOwnedChat<P, OwnedChat>(
    (user, params) => loadOwnedChat(params.chatId, user.id),
    handler,
  );
}
