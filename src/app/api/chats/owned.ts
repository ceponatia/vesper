import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { characterChats, characters, chatParticipants, db } from "@/server/db";
import { CHAT_LOCK_LABEL_WORLD, chatExchangeLockKey, keyedLockBusy, keyedLockHolderLabel } from "@/server/engine";
import { jsonError } from "@/server/api";

/**
 * Resolve a conversation the user owns, with its full sort-ordered ROSTER
 * (multi-character-chat.plan.md) and, for the routes that still run 1-on-1, the
 * primary participant's (sort 0) slices under the pre-roster field names — the
 * one indexed lookup every /api/chats/[chatId] route runs before doing anything
 * (ownership lives on the chat row; character-chat-standalone.spec.md §1.2).
 */
export interface OwnedChatMember {
  characterId: string;
  memoryGroupId: string;
  sort: number;
  character: { id: string; name: string; profile: unknown; avatarImageId: string | null; chatModel: string };
}

export interface OwnedChat {
  chat: {
    id: string;
    ownerId: string;
    title: string;
    archivedAt: Date | null;
    lastMessageAt: Date;
    /** ChatReplyFailure | null (raw column) — why the last exchange produced no reply. */
    lastReplyFailure: unknown;
  };
  /** The primary participant (sort 0) — the pre-roster shape 1-on-1 call sites keep using. */
  participant: { characterId: string; memoryGroupId: string };
  /** The primary participant's character slice (pre-roster shape). */
  character: { id: string; name: string; profile: unknown; avatarImageId: string | null; chatModel: string };
  /** The whole roster, sort-ordered (first = primary). Length 1 for a classic 1-on-1. */
  roster: OwnedChatMember[];
}

export async function loadOwnedChat(chatId: string, userId: string): Promise<OwnedChat | null> {
  const rows = await db()
    .select({
      chatId: characterChats.id,
      ownerId: characterChats.ownerId,
      title: characterChats.title,
      archivedAt: characterChats.archivedAt,
      lastMessageAt: characterChats.lastMessageAt,
      lastReplyFailure: characterChats.lastReplyFailure,
      memoryGroupId: chatParticipants.memoryGroupId,
      sort: chatParticipants.sort,
      characterId: characters.id,
      characterName: characters.name,
      profile: characters.profile,
      avatarImageId: characters.avatarImageId,
      chatModel: characters.chatModel,
    })
    .from(characterChats)
    .innerJoin(chatParticipants, eq(chatParticipants.chatId, characterChats.id))
    .innerJoin(characters, eq(characters.id, chatParticipants.characterId))
    .where(and(eq(characterChats.id, chatId), eq(characterChats.ownerId, userId)))
    .orderBy(asc(chatParticipants.sort));
  const [primary] = rows;
  if (!primary) return null;
  const roster: OwnedChatMember[] = rows.map((row) => ({
    characterId: row.characterId,
    memoryGroupId: row.memoryGroupId,
    sort: row.sort,
    character: {
      id: row.characterId,
      name: row.characterName,
      profile: row.profile,
      avatarImageId: row.avatarImageId,
      chatModel: row.chatModel,
    },
  }));
  return {
    chat: {
      id: primary.chatId,
      ownerId: primary.ownerId,
      title: primary.title,
      archivedAt: primary.archivedAt,
      lastMessageAt: primary.lastMessageAt,
      lastReplyFailure: primary.lastReplyFailure,
    },
    participant: { characterId: primary.characterId, memoryGroupId: primary.memoryGroupId },
    character: {
      id: primary.characterId,
      name: primary.characterName,
      profile: primary.profile,
      avatarImageId: primary.avatarImageId,
      chatModel: primary.chatModel,
    },
    roster,
  };
}

/** One roster member as chat creation needs it (selection order = roster order). */
export interface OwnedRosterMember {
  id: string;
  name: string;
  /** Raw `characters.profile` column — the caller parses it through the contract. */
  profile: unknown;
}

/**
 * Resolve the requested characters as a roster the user OWNS, in the order they
 * were requested (first = primary participant, sort 0). `null` when any
 * requested id is not the caller's — the count must match the request exactly,
 * so one foreign id fails the whole create, which `POST /api/chats` surfaces as
 * 404 `character not found`. Public visibility is no help here: public widens
 * READS, never writes.
 *
 * Extracted from the create handler (it was inline, so the authorization matrix
 * could only reproduce it) — the route and
 * `src/server/api/authz-matrix.int.test.ts` now run the same query and the same
 * count check (security-authz.plan.md slice 5 follow-up).
 */
export async function loadOwnedRoster(userId: string, characterIds: string[]): Promise<OwnedRosterMember[] | null> {
  const owned = await db()
    .select({ id: characters.id, name: characters.name, profile: characters.profile })
    .from(characters)
    .where(and(inArray(characters.id, characterIds), eq(characters.ownerId, userId)));
  const byId = new Map(owned.map((c) => [c.id, c]));
  const roster = characterIds.flatMap((cid) => byId.get(cid) ?? []);
  return roster.length === characterIds.length && roster.length > 0 ? roster : null;
}

/**
 * The D7 memory choice for one character joining a conversation: "shared" reuses
 * the character's most-recent existing memory group (the relationship remembers
 * across conversations), "fresh" — or no prior chat — mints a new island.
 * `newGroupId` is passed in so callers control id minting. Shared by the
 * create-conversation route and the roster add-participant route.
 */
export async function resolveChatMemoryGroupId(
  userId: string,
  characterId: string,
  memory: "shared" | "fresh",
  newGroupId: string,
): Promise<string> {
  if (memory !== "shared") return newGroupId;
  const [existing] = await db()
    .select({ memoryGroupId: chatParticipants.memoryGroupId })
    .from(chatParticipants)
    .innerJoin(characterChats, eq(characterChats.id, chatParticipants.chatId))
    .where(and(eq(characterChats.ownerId, userId), eq(chatParticipants.characterId, characterId)))
    .orderBy(desc(characterChats.createdAt))
    .limit(1);
  return existing?.memoryGroupId ?? newGroupId;
}

/**
 * 409 while a reply is streaming for this chat (character-chat-standalone.followups
 * F1): the exchange holds the `chat_exchange:<id>` lock across the whole stream, and
 * its finalizer rewrites the full state-row column list from the pre-exchange
 * snapshot. So a state mutation that lands mid-stream — a time skip, a marked moment,
 * an author edit, an action chip — would be silently clobbered by the finalize save
 * (the skip note cleared unrendered, the clock reverted). The mutation routes call
 * this before touching the state row; `null` ⇒ clear to proceed. Matches the
 * exchange's own `chat_busy` code so the client handles both the same way.
 */
export function chatBusyResponse(chatId: string): ReturnType<typeof jsonError> | null {
  const key = chatExchangeLockKey(chatId);
  if (!keyedLockBusy(key)) return null;
  // Name the ACTUAL holder, the way `chatBusyBounce` already does for the sim
  // routes. This used to always blame a streaming reply, which was wrong
  // whenever a world command held the lock — and its "before changing the
  // scene" wording read as image generation on the scene strip's model picker,
  // which is how the owner's 2026-08-05 report came in as a phantom
  // "generation in progress" (image-model-registry.spec.md).
  return keyedLockHolderLabel(key) === CHAT_LOCK_LABEL_WORLD
    ? jsonError("chat_busy", "the world is catching up on this chat; try again in a moment", 409)
    : jsonError("chat_busy", "a reply is still streaming for this chat; wait for it to finish", 409);
}
