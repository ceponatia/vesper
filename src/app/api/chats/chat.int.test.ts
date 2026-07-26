import { and, eq, inArray, sql } from "drizzle-orm";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { newId } from "@/lib/ids";
import {
  characterChatMessages,
  characterChats,
  characterChatState,
  characters,
  chatParticipants,
  characterRelationships,
  chatScenarioPresets,
  db,
  episodes,
  facts,
  images,
  users,
} from "@/server/db";

// Conversation-route integration suite (character-chat-standalone.spec.md §1–§2):
// the /api/chats create handler plus the /api/chats/[chatId] GET/POST/DELETE and
// per-message PATCH/DELETE handlers invoked directly with mocked auth against
// DATABASE_URL. AI_FAKE forces demo mode, so the streamed reply is the
// deterministic placeholder — no provider key or network. Self-skips when the
// database is unreachable.

process.env.AI_FAKE = "1";

const authState = vi.hoisted(() => ({
  user: { id: "", email: "", name: "Chat Int", role: "admin" as const },
}));

vi.mock("@/server/auth", () => ({
  USER_COOKIE: "vesper_user",
  getCurrentUser: async () => authState.user,
  ensureDefaultUser: async () => authState.user,
  listUsers: async () => [authState.user],
}));

import {
  deleteChat,
  loadChatState,
  loadPreExchangeState,
  persistAssistantReply,
  replyTakesSchema,
  submitChatMessage,
  tryKeyedLock,
  type ReplyTakes,
} from "@/server/engine";
import { resetRateLimits } from "@/server/api";
import { log } from "@/server/log";
import { POST as chatsCreate } from "./route";
import { DELETE as characterDelete } from "../characters/[id]/route";
import { DELETE as chatDelete, GET as chatGet, POST as chatSend } from "./[chatId]/route";
import { DELETE as msgDelete, PATCH as msgPatch } from "./[chatId]/messages/[messageId]/route";
import { PATCH as takePatch } from "./[chatId]/messages/[messageId]/take/route";
import { GET as sceneList } from "./[chatId]/scene/route";
import { GET as stateGet, PATCH as statePatch } from "./[chatId]/state/route";
import { POST as participantAdd } from "./[chatId]/participants/route";
import { GET as matrixGet, PUT as matrixPut } from "./[chatId]/relationships/route";
import { GET as libGet, PUT as libPut } from "../characters/[id]/relationships/route";
import { DELETE as participantRemove, PATCH as participantPatch } from "./[chatId]/participants/[characterId]/route";

async function probe(): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      db().execute(sql`select 1 from character_chats limit 1`),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("connect timeout")), 4000);
      }),
    ]);
    return true;
  } catch (err) {
    process.stderr.write(`[chat.int.test] skipping: database unreachable: ${err instanceof Error ? err.message : String(err)}\n`);
    return false;
  } finally {
    clearTimeout(timer);
  }
}

const ready = await probe();

// The whole suite drives one user through one process, so the in-memory per-user
// chat cap (CHAT_RATE_LIMIT, 30/min) is shared across every test — reset it per
// test so adding an exchange to one test can't 429 an unrelated one.
beforeEach(() => resetRateLimits());

const collectionCtx = { params: Promise.resolve({}) };
const ctx = (chatId: string) => ({ params: Promise.resolve({ chatId }) });
const msgCtx = (chatId: string, messageId: string) => ({ params: Promise.resolve({ chatId, messageId }) });

function createReq(body: unknown): NextRequest {
  return new NextRequest("http://t/api/chats", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
function postReq(chatId: string, body: unknown): NextRequest {
  return new NextRequest(`http://t/api/chats/${chatId}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
const getReq = (chatId: string) => new NextRequest(`http://t/api/chats/${chatId}`);
const delReq = (chatId: string) => new NextRequest(`http://t/api/chats/${chatId}`, { method: "DELETE" });
function patchMsgReq(chatId: string, messageId: string, body: unknown): NextRequest {
  return new NextRequest(`http://t/api/chats/${chatId}/messages/${messageId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
const delMsgReq = (chatId: string, messageId: string) =>
  new NextRequest(`http://t/api/chats/${chatId}/messages/${messageId}`, { method: "DELETE" });
function stateReq(chatId: string, body: unknown, characterId?: string): NextRequest {
  const target = characterId ? `?characterId=${encodeURIComponent(characterId)}` : "";
  return new NextRequest(`http://t/api/chats/${chatId}/state${target}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
function takeReq(chatId: string, messageId: string, body: unknown): NextRequest {
  return new NextRequest(`http://t/api/chats/${chatId}/messages/${messageId}/take`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Retry a probe until it returns non-null (fire-and-forget follow-ups), or null after ~3s. */
async function pollUntil<T>(probe: () => Promise<T | null>): Promise<T | null> {
  for (let attempt = 0; attempt < 60; attempt++) {
    const value = await probe();
    if (value !== null) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return null;
}

/** Create a conversation through the real POST /api/chats handler (the D7 memory choice). */
async function createChat(characterId: string, memory: "shared" | "fresh" = "fresh"): Promise<{ id: string; memoryGroupId: string }> {
  const res = await chatsCreate(createReq({ characterIds: [characterId], memory }), collectionCtx);
  if (res.status !== 201) throw new Error(`chat create failed: ${res.status}`);
  return (await res.json()) as { id: string; memoryGroupId: string };
}

async function createGroupChat(characterIds: string[]): Promise<{ id: string; memoryGroupId: string }> {
  const res = await chatsCreate(createReq({ characterIds, memory: "fresh" }), collectionCtx);
  if (res.status !== 201) throw new Error(`group chat create failed: ${res.status}`);
  return (await res.json()) as { id: string; memoryGroupId: string };
}

async function insertMessage(chatId: string, role: "user" | "assistant", content: string): Promise<string> {
  const [row] = await db()
    .insert(characterChatMessages)
    .values({ chatId, role, content })
    .returning({ id: characterChatMessages.id });
  if (!row) throw new Error("failed to seed chat message");
  return row.id;
}

const ids = { character: "", chat: "", otherUser: "", otherCharacter: "", otherChat: "" };
/** Memory groups this suite planted facts/episodes into directly (cleaned in afterAll). */
const plantedGroups: string[] = [];

beforeAll(async () => {
  if (!ready) return;
  const stamp = Date.now();
  const [user] = await db().insert(users).values({ email: `chat-int-${stamp}@test.local`, name: "Chat Int", role: "admin" }).returning();
  const [other] = await db().insert(users).values({ email: `chat-int-other-${stamp}@test.local`, name: "Other" }).returning();
  if (!user || !other) throw new Error("failed to create test users");
  authState.user = { ...authState.user, id: user.id, email: user.email };
  ids.otherUser = other.id;

  const [character] = await db().insert(characters).values({ ownerId: user.id, name: "Mara", profile: {} }).returning();
  const [otherCharacter] = await db().insert(characters).values({ ownerId: other.id, name: "NotYours", profile: {} }).returning();
  if (!character || !otherCharacter) throw new Error("failed to seed characters");
  ids.character = character.id;
  ids.otherCharacter = otherCharacter.id;

  ids.chat = (await createChat(ids.character)).id;
  // The other user's conversation is seeded directly — the mocked auth is pinned
  // to the main user, so the create handler can't act as them.
  const [otherChat] = await db().insert(characterChats).values({ ownerId: other.id }).returning({ id: characterChats.id });
  if (!otherChat) throw new Error("failed to seed foreign chat");
  await db().insert(chatParticipants).values({ chatId: otherChat.id, characterId: otherCharacter.id, memoryGroupId: newId() });
  ids.otherChat = otherChat.id;
});

afterAll(async () => {
  if (!ready) return;
  // Facts/episodes have no FK to chats (purge is app-level in deleteChat), so
  // directly-planted rows need explicit cleanup.
  if (plantedGroups.length) {
    await db().delete(facts).where(inArray(facts.chatMemoryGroupId, plantedGroups));
    await db().delete(episodes).where(inArray(episodes.chatMemoryGroupId, plantedGroups));
  }
  // images.owner_id has no ON DELETE cascade, so clear test assets before users;
  // chats own the transcript/state/summary cascades and users FK them (no cascade).
  await db().delete(images).where(eq(images.ownerId, authState.user.id));
  await db().delete(images).where(eq(images.ownerId, ids.otherUser));
  await db().delete(characterChats).where(eq(characterChats.ownerId, authState.user.id));
  await db().delete(characterChats).where(eq(characterChats.ownerId, ids.otherUser));
  await db().delete(characters).where(eq(characters.ownerId, authState.user.id));
  await db().delete(characters).where(eq(characters.ownerId, ids.otherUser));
  await db().delete(chatScenarioPresets).where(eq(chatScenarioPresets.ownerId, authState.user.id));
  await db().delete(users).where(eq(users.id, authState.user.id));
  await db().delete(users).where(eq(users.id, ids.otherUser));
  await globalThis.__vesperPool?.end();
});

async function rows(chatId: string) {
  return db()
    .select({
      role: characterChatMessages.role,
      content: characterChatMessages.content,
      speakerCharacterId: characterChatMessages.speakerCharacterId,
    })
    .from(characterChatMessages)
    .where(eq(characterChatMessages.chatId, chatId))
    .orderBy(characterChatMessages.createdAt);
}

/** All rows as {id, role, content}, ordered by (createdAt, id) — the transcript's own order (for byte-identical comparisons). */
async function fullRows(chatId: string): Promise<{ id: string; role: string; content: string }[]> {
  return db()
    .select({ id: characterChatMessages.id, role: characterChatMessages.role, content: characterChatMessages.content })
    .from(characterChatMessages)
    .where(eq(characterChatMessages.chatId, chatId))
    .orderBy(characterChatMessages.createdAt, characterChatMessages.id);
}

async function messageCount(chatId: string): Promise<number> {
  const [row] = await db()
    .select({ n: sql<number>`count(*)::int` })
    .from(characterChatMessages)
    .where(eq(characterChatMessages.chatId, chatId));
  return row?.n ?? 0;
}

async function factCount(groupId: string): Promise<number> {
  const [row] = await db()
    .select({ n: sql<number>`count(*)::int` })
    .from(facts)
    .where(eq(facts.chatMemoryGroupId, groupId));
  return row?.n ?? 0;
}

/** The chat's single assistant reply row with its parsed takes (regenerate updates in place). */
async function assistantReply(chatId: string): Promise<{ id: string; content: string; takes: ReplyTakes }> {
  const [row] = await db()
    .select({ id: characterChatMessages.id, content: characterChatMessages.content, takes: characterChatMessages.takes })
    .from(characterChatMessages)
    .where(and(eq(characterChatMessages.chatId, chatId), eq(characterChatMessages.role, "assistant")))
    .limit(1);
  if (!row) throw new Error("no assistant reply row");
  return { id: row.id, content: row.content, takes: replyTakesSchema.parse(row.takes ?? {}) };
}

async function roleCounts(chatId: string): Promise<{ user: number; assistant: number }> {
  const all = await rows(chatId);
  return {
    user: all.filter((m) => m.role === "user").length,
    assistant: all.filter((m) => m.role === "assistant").length,
  };
}

async function stateAffinity(chatId: string): Promise<number | null> {
  const [row] = await db()
    .select({ regard: characterChatState.regard })
    .from(characterChatState)
    .where(eq(characterChatState.chatId, chatId))
    .limit(1);
  return row?.regard ?? null;
}

/** Plant the fact + episode the archivist would have extracted (demo mode skips it). */
async function plantMemory(groupId: string, messageId: string): Promise<void> {
  plantedGroups.push(groupId);
  await db().insert(facts).values({
    chatMemoryGroupId: groupId,
    kind: "knowledge",
    subjectName: "mara",
    text: "planted fact from the old take",
    sourceMessageId: messageId,
  });
  await db().insert(episodes).values({
    chatMemoryGroupId: groupId,
    turnNumber: 1,
    summary: "planted episode from the old take",
    sourceMessageId: messageId,
  });
}

describe("POST /api/chats/:chatId — send", () => {
  it("streams a demo reply and persists both the user line and the speaker-tagged reply", async (t) => {
    if (!ready) return t.skip();
    const res = await chatSend(postReq(ids.chat, { content: "Hello there" }), ctx(ids.chat));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");

    const text = await res.text();
    expect(text).toContain("[Mara]");
    expect(text).toContain("Demo mode");

    // The stream settles only after the reply is persisted, so it's queryable now.
    const persisted = await rows(ids.chat);
    expect(persisted.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(persisted[0]?.content).toBe("Hello there");
    expect(persisted[1]?.content).toContain("[Mara]");
    expect(persisted[1]?.speakerCharacterId).toBe(ids.character); // the participant spoke it
  });

  it("404s for a chat the user does not own", async (t) => {
    if (!ready) return t.skip();
    const res = await chatSend(postReq(ids.otherChat, { content: "hi" }), ctx(ids.otherChat));
    expect(res.status).toBe(404);
  });

  it("400s on an empty message", async (t) => {
    if (!ready) return t.skip();
    const res = await chatSend(postReq(ids.chat, { content: "   " }), ctx(ids.chat));
    expect(res.status).toBe(400);
  });
});

describe("GET /api/chats/:chatId — transcript pagination (ux-improvements slice 2)", () => {
  interface Page {
    messages: { id: string; content: string }[];
    hasMore: boolean;
    nextBefore: string | null;
  }
  const getPage = async (chatId: string, before?: string): Promise<Page> => {
    const url = `http://t/api/chats/${chatId}${before ? `?before=${before}` : ""}`;
    const res = await chatGet(new NextRequest(url), ctx(chatId));
    expect(res.status).toBe(200);
    return (await res.json()) as Page;
  };

  it("pages the whole history via ?before with no gaps or duplicates, ties included", async (t) => {
    if (!ready) return t.skip();
    const chat = await createChat(ids.character);
    // 250 rows, mostly 1s apart — except a same-millisecond cluster (rows
    // 100–104) so the (createdAt, id) tiebreak is exercised across a boundary.
    const base = Date.now() - 400_000;
    const values = Array.from({ length: 250 }, (_, i) => ({
      chatId: chat.id,
      role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
      content: `line-${i}`,
      createdAt: new Date(base + (i >= 100 && i < 105 ? 100_000 : i * 1000)),
    }));
    await db().insert(characterChatMessages).values(values);

    const first = await getPage(chat.id);
    expect(first.messages).toHaveLength(100); // CHAT_PAGE_SIZE
    expect(first.hasMore).toBe(true);
    expect(first.nextBefore).toBe(first.messages[0]?.id); // cursor = oldest returned row

    const second = await getPage(chat.id, first.nextBefore ?? undefined);
    expect(second.messages).toHaveLength(100);
    expect(second.hasMore).toBe(true);

    const third = await getPage(chat.id, second.nextBefore ?? undefined);
    expect(third.messages).toHaveLength(50);
    expect(third.hasMore).toBe(false);
    expect(third.nextBefore).toBeNull();

    // Reassembled pages are exactly the transcript in its own (createdAt, id) order.
    const reassembled = [...third.messages, ...second.messages, ...first.messages];
    const persisted = await fullRows(chat.id);
    expect(reassembled.map((m) => m.id)).toEqual(persisted.map((m) => m.id));
    expect(new Set(reassembled.map((m) => m.id)).size).toBe(250);

    await chatDelete(delReq(chat.id), ctx(chat.id));
  });

  it("400s on a cursor that is not a message of this chat", async (t) => {
    if (!ready) return t.skip();
    const chat = await createChat(ids.character);
    const foreign = await insertMessage(ids.chat, "user", "someone else's line");
    const bad = await chatGet(new NextRequest(`http://t/api/chats/${chat.id}?before=${foreign}`), ctx(chat.id));
    expect(bad.status).toBe(400);
    const nonsense = await chatGet(new NextRequest(`http://t/api/chats/${chat.id}?before=nope`), ctx(chat.id));
    expect(nonsense.status).toBe(400);
    await chatDelete(delReq(chat.id), ctx(chat.id));
  });
});

describe("GET + DELETE /api/chats/:chatId", () => {
  it("returns the transcript oldest-first with the chat + character envelope, then hard-deletes", async (t) => {
    if (!ready) return t.skip();
    const chat = await createChat(ids.character);
    await insertMessage(chat.id, "user", "first line");
    await insertMessage(chat.id, "assistant", "second line");

    const got = (await (await chatGet(getReq(chat.id), ctx(chat.id))).json()) as {
      messages: { role: string; content: string }[];
      chat: { id: string };
      character: { id: string; name: string };
    };
    expect(got.messages.length).toBeGreaterThanOrEqual(2);
    expect(got.messages[0]?.role).toBe("user");
    expect(got.chat.id).toBe(chat.id);
    expect(got.character).toEqual({ id: ids.character, name: "Mara", avatarImageId: null, chatModel: "" });

    const del = await chatDelete(delReq(chat.id), ctx(chat.id));
    expect(del.status).toBe(200);
    expect(await rows(chat.id)).toEqual([]); // transcript cascaded with the chat row
    const gone = await chatGet(getReq(chat.id), ctx(chat.id));
    expect(gone.status).toBe(404); // the conversation itself is gone
  });

  it("scrubs surviving scene-image prompts so deleted chat context isn't shown", async (t) => {
    if (!ready) return t.skip();
    // A chat scene's prompt embeds recent chat lines; the asset must survive a
    // delete, but its chat-derived prompt must not (gallery enlarge shows it).
    const chat = await createChat(ids.character);
    await db().insert(images).values({
      ownerId: authState.user.id,
      kind: "scene",
      entityKind: "character",
      entityId: ids.character,
      path: "images/test/scene.webp",
      prompt: "Mara leans close, whispering the secret she just told you.",
    });

    const del = await chatDelete(delReq(chat.id), ctx(chat.id));
    expect(del.status).toBe(200);

    const [scene] = await db()
      .select({ id: images.id, prompt: images.prompt })
      .from(images)
      .where(and(eq(images.ownerId, authState.user.id), eq(images.entityId, ids.character), eq(images.kind, "scene")));
    expect(scene).toBeDefined(); // asset itself survives the delete
    expect(scene?.prompt).toBe(""); // but its chat-derived prompt is blanked
  });

  it("chat-keyed scenes scrub per conversation — a sibling chat's scenes keep their prompts (slice 9)", async (t) => {
    if (!ready) return t.skip();
    const chatA = await createChat(ids.character);
    const chatB = await createChat(ids.character);
    const [sceneA] = await db()
      .insert(images)
      .values({
        ownerId: authState.user.id,
        kind: "scene",
        entityKind: "character",
        entityId: ids.character,
        chatId: chatA.id,
        anchorMessageId: "anchor-a",
        path: "images/test/scene-a.webp",
        prompt: "Chat A's secret moment.",
      })
      .returning();
    const [sceneB] = await db()
      .insert(images)
      .values({
        ownerId: authState.user.id,
        kind: "scene",
        entityKind: "character",
        entityId: ids.character,
        chatId: chatB.id,
        anchorMessageId: "anchor-b",
        path: "images/test/scene-b.webp",
        prompt: "Chat B's secret moment.",
      })
      .returning();

    const del = await chatDelete(delReq(chatA.id), ctx(chatA.id));
    expect(del.status).toBe(200);

    const [a] = await db().select({ prompt: images.prompt, chatId: images.chatId }).from(images).where(eq(images.id, sceneA!.id));
    const [b] = await db().select({ prompt: images.prompt, chatId: images.chatId }).from(images).where(eq(images.id, sceneB!.id));
    expect(a?.prompt).toBe(""); // A's scene scrubbed…
    expect(a?.chatId).toBeNull(); // …and its FK SET NULL by the chat delete (asset survives)
    expect(b?.prompt).toBe("Chat B's secret moment."); // the sibling conversation is untouched
    await chatDelete(delReq(chatB.id), ctx(chatB.id));
  });

  it("scene list is scoped to the conversation — sibling and un-chat-keyed scenes never leak in", async (t) => {
    if (!ready) return t.skip();
    const chatA = await createChat(ids.character);
    const chatB = await createChat(ids.character);
    const seed = (chatId: string | null, path: string) =>
      db()
        .insert(images)
        .values({
          ownerId: authState.user.id,
          kind: "scene",
          entityKind: "character",
          entityId: ids.character,
          chatId,
          path,
          prompt: "moment",
        })
        .returning({ id: images.id });
    const [[sceneA], [sceneB]] = await Promise.all([
      seed(chatA.id, "images/test/scoped-a.webp"),
      seed(chatB.id, "images/test/scoped-b.webp"),
      seed(null, "images/test/scoped-legacy.webp"), // gallery-only; must not surface in any chat
    ]);

    const res = await sceneList(getReq(chatA.id), ctx(chatA.id));
    expect(res.status).toBe(200);
    const { scenes } = (await res.json()) as { scenes: { id: string }[] };
    expect(scenes.map((s) => s.id)).toEqual([sceneA!.id]); // A's own scene only — no sibling, no legacy

    const resB = await sceneList(getReq(chatB.id), ctx(chatB.id));
    const { scenes: scenesB } = (await resB.json()) as { scenes: { id: string }[] };
    expect(scenesB.map((s) => s.id)).toEqual([sceneB!.id]);

    await chatDelete(delReq(chatA.id), ctx(chatA.id));
    await chatDelete(delReq(chatB.id), ctx(chatB.id));
  });
});

describe("PATCH + DELETE /api/chats/:chatId/messages/:messageId", () => {
  it("overwrites one message's text in place (rewrite a refusal)", async (t) => {
    if (!ready) return t.skip();
    const messageId = await insertMessage(ids.chat, "assistant", "I cannot continue this roleplay.");
    const res = await msgPatch(patchMsgReq(ids.chat, messageId, { content: '[Mara] "Mmm — come closer."' }), msgCtx(ids.chat, messageId));
    expect(res.status).toBe(200);

    const after = await rows(ids.chat);
    expect(after.some((m) => m.content.includes("come closer"))).toBe(true);
    expect(after.some((m) => m.content.includes("cannot continue"))).toBe(false);
  });

  it("deletes a single message, leaving the rest (snip a refusal out of the window)", async (t) => {
    if (!ready) return t.skip();
    await insertMessage(ids.chat, "user", "keep me");
    const drop = await insertMessage(ids.chat, "assistant", "remove me");
    const res = await msgDelete(delMsgReq(ids.chat, drop), msgCtx(ids.chat, drop));
    expect(res.status).toBe(200);

    const after = await rows(ids.chat);
    expect(after.some((m) => m.content === "remove me")).toBe(false);
    expect(after.some((m) => m.content === "keep me")).toBe(true);
  });

  it("404s editing a message in a chat the user does not own, leaving it untouched", async (t) => {
    if (!ready) return t.skip();
    const foreign = await insertMessage(ids.otherChat, "assistant", "not yours");
    const res = await msgPatch(patchMsgReq(ids.otherChat, foreign, { content: "hijacked" }), msgCtx(ids.otherChat, foreign));
    expect(res.status).toBe(404);

    const [check] = await db()
      .select({ content: characterChatMessages.content })
      .from(characterChatMessages)
      .where(eq(characterChatMessages.id, foreign));
    expect(check?.content).toBe("not yours");
  });
});

describe("assistant-reply persist guard (delete-mid-stream race)", () => {
  it("persists the reply when its prompting line still exists", async (t) => {
    if (!ready) return t.skip();
    const promptId = await insertMessage(ids.chat, "user", "race: keep me");
    await persistAssistantReply({
      id: newId(),
      chatId: ids.chat,
      speakerCharacterId: ids.character,
      promptMessageId: promptId,
      content: "[Mara] persisted reply",
    });
    const after = await rows(ids.chat);
    expect(after.some((m) => m.role === "assistant" && m.content === "[Mara] persisted reply")).toBe(true);
    // Reset for the next case so the guard test below starts clean.
    await db().delete(characterChatMessages).where(eq(characterChatMessages.chatId, ids.chat));
  });

  it("drops the reply when its prompting line was deleted mid-stream", async (t) => {
    if (!ready) return t.skip();
    const promptId = await insertMessage(ids.chat, "user", "race: gone");
    // Simulate a delete (whole-chat or single-message) landing before the stream settles.
    await db().delete(characterChatMessages).where(eq(characterChatMessages.id, promptId));
    await persistAssistantReply({
      id: newId(),
      chatId: ids.chat,
      speakerCharacterId: ids.character,
      promptMessageId: promptId,
      content: "[Mara] orphan reply",
    });
    const after = await rows(ids.chat);
    expect(after.some((m) => m.content === "[Mara] orphan reply")).toBe(false);
    expect(after).toEqual([]); // nothing resurrected the cleared conversation
  });
});

describe("one exchange in flight per chat (codebase-review A6)", () => {
  it("409s while the chat lock is held, without inserting the second user line, then recovers", async (t) => {
    if (!ready) return t.skip();
    // Hold the exact lock the pipeline acquires — deterministic stand-in for a
    // still-streaming first exchange (racing two real streams is timing-flaky).
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const held = tryKeyedLock(`chat_exchange:${ids.chat}`, () => gate);
    expect(held).not.toBeNull();

    const before = await messageCount(ids.chat);
    const busy = await chatSend(postReq(ids.chat, { content: "double send" }), ctx(ids.chat));
    expect(busy.status).toBe(409);
    expect(((await busy.json()) as { error: { code: string } }).error.code).toBe("chat_busy");
    expect(await messageCount(ids.chat)).toBe(before); // rejected before the user line landed

    release();
    await held;
    const ok = await chatSend(postReq(ids.chat, { content: "after release" }), ctx(ids.chat));
    expect(ok.status).toBe(200);
    await ok.text(); // drain so the lock releases before the suite ends
  });
});

describe("memory-choice semantics (character-chat-standalone.spec.md §1.3, D7)", () => {
  it("shared chats share a group, fresh mints an island, and delete purges only unreferenced groups", async (t) => {
    if (!ready) return t.skip();
    // A dedicated character so this test owns its whole memory-group history.
    const [nyx] = await db().insert(characters).values({ ownerId: authState.user.id, name: "Nyx", profile: {} }).returning();
    if (!nyx) throw new Error("failed to seed character");

    const first = await createChat(nyx.id, "shared"); // no prior chats ⇒ mints a group
    const sibling = await createChat(nyx.id, "shared"); // continues the shared history
    const island = await createChat(nyx.id, "fresh"); // a clean-slate AU
    expect(sibling.memoryGroupId).toBe(first.memoryGroupId);
    expect(island.memoryGroupId).not.toBe(first.memoryGroupId);

    // Durable memory keyed by group (facts.chat_memory_group_id, session NULL).
    await db().insert(facts).values({ chatMemoryGroupId: first.memoryGroupId, kind: "knowledge", subjectName: "nyx", text: "the player brings nyx tea every visit" });
    await db().insert(facts).values({ chatMemoryGroupId: island.memoryGroupId, kind: "knowledge", subjectName: "nyx", text: "in this universe nyx has never met the player" });

    // Deleting the only chat of a group purges the group's memory…
    expect((await chatDelete(delReq(island.id), ctx(island.id))).status).toBe(200);
    expect(await factCount(island.memoryGroupId)).toBe(0);
    expect(await factCount(first.memoryGroupId)).toBe(1);

    // …but deleting one of two shared-history siblings keeps the relationship's memory alive…
    expect((await chatDelete(delReq(sibling.id), ctx(sibling.id))).status).toBe(200);
    expect(await factCount(first.memoryGroupId)).toBe(1);

    // …until the last referencing conversation goes.
    expect((await chatDelete(delReq(first.id), ctx(first.id))).status).toBe(200);
    expect(await factCount(first.memoryGroupId)).toBe(0);
  });
});

describe("DELETE /api/characters/:id — conversations go through deleteChat (deletion-leak audit 2026-07-10)", () => {
  it("hard-deletes the character's chats: transcript gone, memory group purged, no orphaned rows", async (t) => {
    if (!ready) return t.skip();
    const [vex] = await db().insert(characters).values({ ownerId: authState.user.id, name: "Vex", profile: {} }).returning();
    if (!vex) throw new Error("failed to seed character");
    const chat = await createChat(vex.id, "shared");
    await insertMessage(chat.id, "user", "hello");
    await insertMessage(chat.id, "assistant", "hi there");
    await db()
      .insert(facts)
      .values({ chatMemoryGroupId: chat.memoryGroupId, kind: "knowledge", subjectName: "vex", text: "vex likes rooftop rain" });
    plantedGroups.push(chat.memoryGroupId); // afterAll safety net if this test fails mid-way

    const res = await characterDelete(new NextRequest(`http://t/api/characters/${vex.id}`, { method: "DELETE" }), {
      params: Promise.resolve({ id: vex.id }),
    });
    expect(res.status).toBe(200);

    // Pre-fix, deleting the character cascaded participants/state away and stranded the
    // chat row + transcript + memory group (the 2026-07-10 audit's leak) — invisible in
    // the hub (it inner-joins participants) but fully stored.
    const [chatRow] = await db()
      .select({ id: characterChats.id })
      .from(characterChats)
      .where(eq(characterChats.id, chat.id))
      .limit(1);
    expect(chatRow).toBeUndefined();
    expect(await messageCount(chat.id)).toBe(0);
    expect(await factCount(chat.memoryGroupId)).toBe(0);
  });

  it("leaves another owner's conversation intact when the character anomalously participates in it", async (t) => {
    if (!ready) return t.skip();
    // The cross-owner participant row violates today's "chat owner == character owner"
    // invariant, so it is seeded directly — no route can produce it. That is the shape
    // security-authz.plan.md slice 2 hardens against.
    const [mole] = await db().insert(characters).values({ ownerId: authState.user.id, name: "Mole", profile: {} }).returning();
    if (!mole) throw new Error("failed to seed character");
    const [foreignChat] = await db().insert(characterChats).values({ ownerId: ids.otherUser }).returning({ id: characterChats.id });
    if (!foreignChat) throw new Error("failed to seed foreign chat");
    const foreignGroup = newId();
    await db().insert(chatParticipants).values([
      { chatId: foreignChat.id, characterId: ids.otherCharacter, memoryGroupId: foreignGroup, sort: 0 },
      { chatId: foreignChat.id, characterId: mole.id, memoryGroupId: foreignGroup, sort: 1 },
    ]);
    await insertMessage(foreignChat.id, "user", "the other owner's transcript");
    await db()
      .insert(facts)
      .values({ chatMemoryGroupId: foreignGroup, kind: "knowledge", subjectName: "other", text: "the other owner's memory" });
    plantedGroups.push(foreignGroup);

    const res = await characterDelete(new NextRequest(`http://t/api/characters/${mole.id}`, { method: "DELETE" }), {
      params: Promise.resolve({ id: mole.id }),
    });
    expect(res.status).toBe(200);

    // The owned character is gone; the foreign conversation, its transcript and its
    // memory survive (the traversal skipped it, and `deleteChat` would have refused).
    expect(await db().select({ id: characters.id }).from(characters).where(eq(characters.id, mole.id))).toHaveLength(0);
    expect(await db().select({ id: characterChats.id }).from(characterChats).where(eq(characterChats.id, foreignChat.id))).toHaveLength(1);
    expect(await messageCount(foreignChat.id)).toBe(1);
    expect(await factCount(foreignGroup)).toBe(1);
  });

  it("deleteChat refuses a chat the caller does not own: no-op plus a warn diagnostic (docs/resilience.md)", async (t) => {
    if (!ready) return t.skip();
    const [foreignChat] = await db().insert(characterChats).values({ ownerId: ids.otherUser }).returning({ id: characterChats.id });
    if (!foreignChat) throw new Error("failed to seed foreign chat");
    await db().insert(chatParticipants).values({ chatId: foreignChat.id, characterId: ids.otherCharacter, memoryGroupId: newId() });
    await insertMessage(foreignChat.id, "user", "still here");

    const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    try {
      await deleteChat(foreignChat.id, authState.user.id);
      expect(warnSpy).toHaveBeenCalledWith(
        "engine.chat",
        expect.any(String),
        expect.objectContaining({ code: "chat.delete_denied", chatId: foreignChat.id, ownerId: authState.user.id }),
      );
    } finally {
      warnSpy.mockRestore();
    }
    expect(await db().select({ id: characterChats.id }).from(characterChats).where(eq(characterChats.id, foreignChat.id))).toHaveLength(1);
    expect(await messageCount(foreignChat.id)).toBe(1);
  });
});

describe("POST /api/chats/:chatId — kind=regenerate (another take, spec §4.1)", () => {
  it("replaces the reply in place, keeps the old take browsable, rolls back state, and retracts the old take's memory", async (t) => {
    if (!ready) return t.skip();
    const chat = await createChat(ids.character);
    // A stored state BEFORE the first exchange gives the pre-exchange snapshot a
    // distinctive value to roll back to (the demo pulse degrades to drift-only,
    // and drift never moves regard, so it only moves via PATCH here).
    expect((await statePatch(stateReq(chat.id, { regard: 10 }), ctx(chat.id))).status).toBe(200);

    await (await chatSend(postReq(chat.id, { content: "Tell me a secret" }), ctx(chat.id))).text();
    const reply = await assistantReply(chat.id);
    // Make take 1 distinguishable (demo replies are deterministic) and plant the
    // memory the archivist would have extracted from it (demo mode skips it).
    await db().update(characterChatMessages).set({ content: "OLD TAKE" }).where(eq(characterChatMessages.id, reply.id));
    await plantMemory(chat.memoryGroupId, reply.id);
    // Perturb the state AFTER the exchange — the exact drift+pulse effects a
    // regenerate must not double-apply.
    expect((await statePatch(stateReq(chat.id, { regard: 77 }), ctx(chat.id))).status).toBe(200);

    const res = await chatSend(postReq(chat.id, { kind: "regenerate" }), ctx(chat.id));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Demo mode");

    const after = await assistantReply(chat.id);
    expect(after.id).toBe(reply.id); // updated in place, never a new row
    expect(after.content).not.toBe("OLD TAKE");
    expect(after.content).toContain("[Mara]");
    expect(after.takes.takes).toHaveLength(2);
    expect(after.takes.takes[0]?.content).toBe("OLD TAKE"); // seeded lazily on the first regenerate
    expect(after.takes.activeId).toBe(after.takes.takes[1]?.id); // the fresh take is active
    expect(after.takes.takes[1]?.content).toBe(after.content); // content mirrors the active take

    // Memory rollback (spec §4.3): the old take's fact retracted, its episode gone.
    const [fact] = await db().select({ status: facts.status }).from(facts).where(eq(facts.sourceMessageId, reply.id));
    expect(fact?.status).toBe("retracted");
    expect(await db().select({ id: episodes.id }).from(episodes).where(eq(episodes.sourceMessageId, reply.id))).toHaveLength(0);

    // State rollback: the post-exchange perturbation (77) is undone; the
    // pre-exchange snapshot value (10) is back.
    expect(await stateAffinity(chat.id)).toBe(10);

    // No stray rows: still exactly one user line + one reply.
    expect(await roleCounts(chat.id)).toEqual({ user: 1, assistant: 1 });
  });

  it("restores and re-snapshots every roster member from the same exchange boundary", async (t) => {
    if (!ready) return t.skip();
    const [nia, oren] = await db()
      .insert(characters)
      .values([
        { ownerId: authState.user.id, name: "Nia", profile: {} },
        { ownerId: authState.user.id, name: "Oren", profile: {} },
      ])
      .returning();
    if (!nia || !oren) throw new Error("failed to seed group members");

    const chat = await createGroupChat([ids.character, nia.id, oren.id]);
    const members = [
      { id: ids.character, name: "Mara", regard: 11 },
      { id: nia.id, name: "Nia", regard: 22 },
      { id: oren.id, name: "Oren", regard: 33 },
    ];
    const baselines = new Map<string, NonNullable<Awaited<ReturnType<typeof loadChatState>>>>();

    // Give every participant a distinctive, valid state before the exchange. The
    // exchange snapshot must preserve the whole object, not only relationship meters.
    for (const [index, member] of members.entries()) {
      const patched = await statePatch(
        stateReq(
          chat.id,
          {
            regard: member.regard,
            familiarity: index + 3,
            mindNote: `baseline-${member.name}`,
            outfit: `baseline-outfit-${member.name}`,
            memoryQueries: [`baseline-query-${member.name}`],
            openLoops: [`baseline-loop-${member.name}`],
            surfacedCues: { energy: `baseline-band-${member.name}` },
            callbackHistory: [{ ref: `baseline-callback-${member.name}`, atClockMinutes: index }],
          },
          member.id,
        ),
        ctx(chat.id),
      );
      expect(patched.status).toBe(200);
      const baseline = await loadChatState(chat.id, member.id);
      if (!baseline) throw new Error(`missing baseline for ${member.name}`);
      baselines.set(member.id, baseline);
    }

    await (
      await chatSend(
        postReq(chat.id, { content: "Mara, Nia, and Oren: tell me what happened." }),
        ctx(chat.id),
      )
    ).text();

    // The first settle records an anchor for PRIMARY and non-primary members alike.
    for (const member of members) {
      expect(await loadPreExchangeState(chat.id, member.id)).toEqual({
        found: true,
        state: baselines.get(member.id),
      });
    }

    // Simulate every category of discarded-take contamination with valid state:
    // scalar, note, wardrobe, retrieval carry-over, open loop, cue and callback ring.
    for (const [index, member] of members.entries()) {
      const marker = `DISCARDED-${member.name}`;
      const patched = await statePatch(
        stateReq(
          chat.id,
          {
            regard: 90 + index,
            mindNote: marker,
            outfit: marker,
            memoryQueries: [marker],
            openLoops: [marker],
            surfacedCues: { energy: marker },
            callbackHistory: [{ ref: marker, atClockMinutes: 99 }],
          },
          member.id,
        ),
        ctx(chat.id),
      );
      expect(patched.status).toBe(200);
      await db()
        .update(characterChatState)
        .set({
          relationshipHistory: [
            { at: new Date(0).toISOString(), clockMinutes: 99, regard: 99, band: marker, familiarity: 99 },
          ],
          milestones: [{ at: new Date(0).toISOString(), kind: "player_marked", label: marker }],
          feeling: {
            current: { label: "angry", intensity: 0.9, cause: marker },
            bruise: { remaining: 9 },
          },
          drives: [
            {
              want: marker,
              why: marker,
              secrecy: "open",
              progress: marker,
              revealed: false,
              resolved: false,
            },
          ],
        })
        .where(and(eq(characterChatState.chatId, chat.id), eq(characterChatState.characterId, member.id)));
    }

    const regenerated = await chatSend(postReq(chat.id, { kind: "regenerate" }), ctx(chat.id));
    expect(regenerated.status).toBe(200);
    await regenerated.text();

    for (const [index, member] of members.entries()) {
      const baseline = baselines.get(member.id);
      expect(await loadPreExchangeState(chat.id, member.id)).toEqual({ found: true, state: baseline });
      const settled = await loadChatState(chat.id, member.id);
      if (!settled) throw new Error(`missing settled state for ${member.name}`);
      expect(JSON.stringify(settled)).not.toContain(`DISCARDED-${member.name}`);
      expect(settled.regard).not.toBe(90 + index);
    }
  });

  it("caps browsable takes at 4 across repeated regenerates, newest take always active", async (t) => {
    if (!ready) return t.skip();
    const chat = await createChat(ids.character);
    await (await chatSend(postReq(chat.id, { content: "cap me" }), ctx(chat.id))).text();
    for (let i = 0; i < 4; i++) {
      const res = await chatSend(postReq(chat.id, { kind: "regenerate" }), ctx(chat.id));
      expect(res.status).toBe(200);
      await res.text(); // drain so the exchange settles + the lock releases
    }
    const reply = await assistantReply(chat.id);
    // 5 takes were minted (the seed + 4 regenerates); the oldest was evicted.
    expect(reply.takes.takes).toHaveLength(4);
    expect(reply.takes.activeId).toBe(reply.takes.takes.at(-1)?.id);
    expect(reply.takes.takes.find((tk) => tk.id === reply.takes.activeId)?.content).toBe(reply.content);
  });

  it("400s nothing_to_regenerate on an empty chat", async (t) => {
    if (!ready) return t.skip();
    const chat = await createChat(ids.character);
    const res = await chatSend(postReq(chat.id, { kind: "regenerate" }), ctx(chat.id));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("nothing_to_regenerate");
  });
});

describe("PATCH /api/chats/:chatId/messages/:messageId/take (spec §4.1)", () => {
  it("flips content to the picked take without minting one, and 404s a bogus takeId", async (t) => {
    if (!ready) return t.skip();
    const chat = await createChat(ids.character);
    await (await chatSend(postReq(chat.id, { content: "switch me" }), ctx(chat.id))).text();
    const reply = await assistantReply(chat.id);
    await db().update(characterChatMessages).set({ content: "FIRST TAKE" }).where(eq(characterChatMessages.id, reply.id));
    await (await chatSend(postReq(chat.id, { kind: "regenerate" }), ctx(chat.id))).text();

    const regenerated = await assistantReply(chat.id);
    const firstTake = regenerated.takes.takes[0];
    if (!firstTake) throw new Error("missing seeded take");
    expect(firstTake.content).toBe("FIRST TAKE");
    expect(regenerated.content).not.toBe("FIRST TAKE"); // the fresh take is displayed

    const res = await takePatch(takeReq(chat.id, reply.id, { takeId: firstTake.id }), msgCtx(chat.id, reply.id));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { content: string }).content).toBe("FIRST TAKE");

    const flipped = await assistantReply(chat.id);
    expect(flipped.content).toBe("FIRST TAKE"); // the row's content mirrors the pick
    expect(flipped.takes.activeId).toBe(firstTake.id);
    expect(flipped.takes.takes).toHaveLength(2); // switching never mints a take

    const bogus = await takePatch(takeReq(chat.id, reply.id, { takeId: "no-such-take" }), msgCtx(chat.id, reply.id));
    expect(bogus.status).toBe(404);
  });
});

describe("POST /api/chats/:chatId — kind=continue (go on, spec §4.2)", () => {
  it("adds an assistant beat with no new user row and never persists the synthetic cue", async (t) => {
    if (!ready) return t.skip();
    const chat = await createChat(ids.character);
    await (await chatSend(postReq(chat.id, { content: "say more" }), ctx(chat.id))).text();
    expect(await roleCounts(chat.id)).toEqual({ user: 1, assistant: 1 });

    const res = await chatSend(postReq(chat.id, { kind: "continue" }), ctx(chat.id));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("[Mara]");

    expect(await roleCounts(chat.id)).toEqual({ user: 1, assistant: 2 }); // a beat, not a turn
    // The one user row is still the player's line — the continue cue was never persisted.
    const all = await rows(chat.id);
    expect(all.filter((m) => m.role === "user").map((m) => m.content)).toEqual(["say more"]);
    // The beat is speaker-tagged like any reply.
    expect(all.filter((m) => m.role === "assistant").every((m) => m.speakerCharacterId === ids.character)).toBe(true);
  });
});

describe("message delete reconciles provenanced memory (spec §4.3)", () => {
  it("retracts the fact and deletes the episode sourced from the snipped assistant line", async (t) => {
    if (!ready) return t.skip();
    const chat = await createChat(ids.character);
    const messageId = await insertMessage(chat.id, "assistant", "she admits she's afraid of storms");
    await plantMemory(chat.memoryGroupId, messageId);

    expect((await msgDelete(delMsgReq(chat.id, messageId), msgCtx(chat.id, messageId))).status).toBe(200);

    // The reconcile is fire-and-forget behind the response — poll, don't sleep blind.
    const factStatus = await pollUntil(async () => {
      const [fact] = await db().select({ status: facts.status }).from(facts).where(eq(facts.sourceMessageId, messageId));
      return fact?.status === "retracted" ? fact.status : null;
    });
    expect(factStatus).toBe("retracted");
    const episodesGone = await pollUntil(async () => {
      const remaining = await db().select({ id: episodes.id }).from(episodes).where(eq(episodes.sourceMessageId, messageId));
      return remaining.length === 0 ? true : null;
    });
    expect(episodesGone).toBe(true);
  });
});

describe("POST /api/chats/:chatId — kind=rerun (atomic re-send, data-loss-rerun fix)", () => {
  it("snips the latest reply, reuses its player guard row, and streams a fresh reply", async (t) => {
    if (!ready) return t.skip();
    const chat = await createChat(ids.character);
    await (await chatSend(postReq(chat.id, { content: "latest prompt" }), ctx(chat.id))).text();
    expect(await roleCounts(chat.id)).toEqual({ user: 1, assistant: 1 });
    const before = await fullRows(chat.id);
    const user1 = before.find((m) => m.role === "user");
    const oldReply = before.find((m) => m.role === "assistant");
    if (!user1 || !oldReply) throw new Error("missing latest exchange");

    const res = await chatSend(postReq(chat.id, { kind: "rerun", messageId: user1.id }), ctx(chat.id));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("[Mara]");

    expect(await roleCounts(chat.id)).toEqual({ user: 1, assistant: 1 });
    const after = await fullRows(chat.id);
    const survivor = after.find((m) => m.role === "user");
    const freshReply = after.find((m) => m.role === "assistant");
    expect(survivor).toEqual(user1); // same id + byte-identical player line
    expect(freshReply?.id).not.toBe(oldReply.id);
  });

  it("stops an in-flight reply, re-acquires the lock, and completes the rerun", async (t) => {
    if (!ready) return t.skip();
    const chat = await createChat(ids.character);
    // Drive the pipeline directly and pull ONE token, so the exchange is genuinely
    // mid-stream: holding the lock and registered for abort (the route eagerly drains,
    // which would settle a demo reply before we could freeze it).
    const first = await submitChatMessage({
      chatId: chat.id,
      memoryGroupId: chat.memoryGroupId,
      character: { id: ids.character, name: "Mara", profile: {} },
      kind: "send",
      content: "hold the line",
    });
    if (!first.ok) throw new Error("first send was rejected");
    expect((await first.stream.next()).done).toBe(false); // mid-stream now
    const [user1] = await db()
      .select({ id: characterChatMessages.id })
      .from(characterChatMessages)
      .where(and(eq(characterChatMessages.chatId, chat.id), eq(characterChatMessages.role, "user")))
      .limit(1);
    if (!user1) throw new Error("no user line for the in-flight send");

    // Firing the rerun synchronously stops `first` (its first poll aborts the stream),
    // then it waits for the lock. Draining `first` lets it settle (as stopped) and drop
    // the lock, which the waiting rerun then acquires.
    const rerunPromise = submitChatMessage({
      chatId: chat.id,
      memoryGroupId: chat.memoryGroupId,
      character: { id: ids.character, name: "Mara", profile: {} },
      kind: "rerun",
      targetMessageId: user1.id,
    });
    let drainedFirst = "";
    for await (const chunk of first.stream) drainedFirst += chunk; // settle + release
    expect(drainedFirst).toContain("Demo mode"); // the stopped exchange streamed its content

    const rr = await rerunPromise;
    expect(rr.ok).toBe(true);
    if (!rr.ok) return;
    let drainedRerun = "";
    for await (const chunk of rr.stream) drainedRerun += chunk; // drain the fresh reply
    expect(drainedRerun).toContain("[Mara]");

    // The stopped exchange's reply was snipped; the rerun produced exactly one fresh reply
    // against the reused user line — no stray rows.
    expect(await roleCounts(chat.id)).toEqual({ user: 1, assistant: 1 });
    const after = await fullRows(chat.id);
    expect(after.find((m) => m.role === "user")?.id).toBe(user1.id); // reused, not re-inserted
    const [reply] = await db()
      .select({ meta: characterChatMessages.meta })
      .from(characterChatMessages)
      .where(and(eq(characterChatMessages.chatId, chat.id), eq(characterChatMessages.role, "assistant")))
      .limit(1);
    expect(reply?.meta).toEqual({}); // the surviving reply is the complete rerun, not the stopped partial
  });

  it("409s chat_busy with the transcript byte-identical when the lock can't be re-acquired", async (t) => {
    if (!ready) return t.skip();
    const chat = await createChat(ids.character);
    await (await chatSend(postReq(chat.id, { content: "leave me be" }), ctx(chat.id))).text();
    const user1 = (await fullRows(chat.id)).find((m) => m.role === "user");
    if (!user1) throw new Error("missing user line");
    const before = await fullRows(chat.id);

    // Hold the exact lock and never release it within the (shrunk) wait window. There is
    // no registered in-flight reply, so the rerun's stop is a no-op and it can never win.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const held = tryKeyedLock(`chat_exchange:${chat.id}`, () => gate);
    expect(held).not.toBeNull();

    const result = await submitChatMessage({
      chatId: chat.id,
      memoryGroupId: chat.memoryGroupId,
      character: { id: ids.character, name: "Mara", profile: {} },
      kind: "rerun",
      targetMessageId: user1.id,
      rerunLockWaitMs: 150, // keep the test fast — the null→chat_busy path is the point
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("chat_busy");
    expect(await fullRows(chat.id)).toEqual(before); // nothing deleted: same rows, ids, order

    release();
    await held;
  });

  it("rejects an absent / bogus / non-user / foreign rerun target and modifies nothing", async (t) => {
    if (!ready) return t.skip();
    const chat = await createChat(ids.character);
    await (await chatSend(postReq(chat.id, { content: "keep me" }), ctx(chat.id))).text();
    const asst = (await fullRows(chat.id)).find((m) => m.role === "assistant");
    if (!asst) throw new Error("missing assistant reply");
    const sibling = await createChat(ids.character);
    const foreignUserId = await insertMessage(sibling.id, "user", "sibling line");
    const before = await fullRows(chat.id);

    // (a) messageId omitted entirely → route validation 400.
    expect((await chatSend(postReq(chat.id, { kind: "rerun" }), ctx(chat.id))).status).toBe(400);
    // (b) a bogus id → invalid_rerun_target 400.
    const missing = await chatSend(postReq(chat.id, { kind: "rerun", messageId: "no-such-id" }), ctx(chat.id));
    expect(missing.status).toBe(400);
    expect(((await missing.json()) as { error: { code: string } }).error.code).toBe("invalid_rerun_target");
    // (c) an assistant line (not a player line) → 400.
    expect((await chatSend(postReq(chat.id, { kind: "rerun", messageId: asst.id }), ctx(chat.id))).status).toBe(400);
    // (d) a user line from a sibling conversation → 400 (scoped by chatId).
    expect((await chatSend(postReq(chat.id, { kind: "rerun", messageId: foreignUserId }), ctx(chat.id))).status).toBe(400);

    expect(await fullRows(chat.id)).toEqual(before); // not one attempt touched the transcript
    await chatDelete(delReq(sibling.id), ctx(sibling.id));
  });

  it("rolls back to the pre-exchange snapshot when the target is the latest exchange's prompt", async (t) => {
    if (!ready) return t.skip();
    const chat = await createChat(ids.character);
    expect((await statePatch(stateReq(chat.id, { regard: 12 }), ctx(chat.id))).status).toBe(200); // pre-exchange baseline
    await (await chatSend(postReq(chat.id, { content: "tell me" }), ctx(chat.id))).text();
    const user1 = (await fullRows(chat.id)).find((m) => m.role === "user");
    if (!user1) throw new Error("missing user line");
    expect((await statePatch(stateReq(chat.id, { regard: 80 }), ctx(chat.id))).status).toBe(200); // perturb AFTER

    const res = await chatSend(postReq(chat.id, { kind: "rerun", messageId: user1.id }), ctx(chat.id));
    expect(res.status).toBe(200);
    await res.text();

    // The rerun IS the last exchange (its only successor was the newest reply), so it rolls
    // back the post-exchange perturbation to the snapshot, exactly like regenerate.
    expect(await stateAffinity(chat.id)).toBe(12);
  });

  it("reruns a prompt whose reply never persisted (zero successors) without a false rollback", async (t) => {
    if (!ready) return t.skip();
    const chat = await createChat(ids.character);
    expect((await statePatch(stateReq(chat.id, { regard: 12 }), ctx(chat.id))).status).toBe(200);
    await (await chatSend(postReq(chat.id, { content: "first" }), ctx(chat.id))).text(); // settles: anchor holds regard 12
    expect((await statePatch(stateReq(chat.id, { regard: 64 }), ctx(chat.id))).status).toBe(200); // live state moves on
    // A failed exchange: the player line persisted but the model produced no text, so
    // no assistant row and no settle — exactly what a stream failure/timeout leaves.
    const orphanId = await insertMessage(chat.id, "user", "no reply came");

    const res = await chatSend(postReq(chat.id, { kind: "rerun", messageId: orphanId }), ctx(chat.id));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("[Mara]");

    // The orphan line was reused (not re-inserted) and got its fresh reply.
    expect(await roleCounts(chat.id)).toEqual({ user: 2, assistant: 2 });
    const after = await fullRows(chat.id);
    expect(after.filter((m) => m.role === "user").map((m) => m.id)).toContain(orphanId);
    // No false rollback: the failed exchange never settled, so the rerun starts from
    // the LIVE state — the stored anchor (regard 12) belongs to the PREVIOUS exchange.
    expect(await stateAffinity(chat.id)).toBe(64);
  });

  it("rejects an earlier exchange with rerun_requires_branch and modifies nothing", async (t) => {
    if (!ready) return t.skip();
    const chat = await createChat(ids.character);
    expect((await statePatch(stateReq(chat.id, { regard: 5 }), ctx(chat.id))).status).toBe(200);
    await (await chatSend(postReq(chat.id, { content: "first" }), ctx(chat.id))).text();
    const user1 = (await fullRows(chat.id)).find((m) => m.role === "user" && m.content === "first");
    if (!user1) throw new Error("missing first user line");
    await (await chatSend(postReq(chat.id, { content: "second" }), ctx(chat.id))).text();
    expect((await statePatch(stateReq(chat.id, { regard: 90 }), ctx(chat.id))).status).toBe(200);
    const before = await fullRows(chat.id);

    const res = await chatSend(postReq(chat.id, { kind: "rerun", messageId: user1.id }), ctx(chat.id));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("rerun_requires_branch");

    // No false rollback and no destructive reach-back: transcript and live state
    // remain exactly as they were until a real branch operation exists.
    expect(await fullRows(chat.id)).toEqual(before);
    expect(await stateAffinity(chat.id)).toBe(90);
  });
});

describe("stopped replies (spec §4.2)", () => {
  it("persists meta.stopped and the transcript GET carries it", async (t) => {
    if (!ready) return t.skip();
    const chat = await createChat(ids.character);
    const promptId = await insertMessage(chat.id, "user", "keep going");
    const replyId = newId();
    // A live mid-stream abort isn't deterministically reproducible through the
    // streaming Response, so the meta path is covered at the persist seam the
    // pipeline's settle uses when `stopChatReply` aborted the stream.
    await persistAssistantReply({
      id: replyId,
      chatId: chat.id,
      speakerCharacterId: ids.character,
      promptMessageId: promptId,
      content: '[Mara] "I was just about to—"',
      meta: { stopped: true },
    });

    const got = (await (await chatGet(getReq(chat.id), ctx(chat.id))).json()) as {
      messages: { id: string; meta: unknown }[];
    };
    const reply = got.messages.find((m) => m.id === replyId);
    expect(reply).toBeDefined();
    expect(reply?.meta).toEqual({ stopped: true });
  });
});

describe("roster — participants add/remove/presence (multi-character-chat.plan.md slice 1)", () => {
  const pCtx = (chatId: string, characterId: string) => ({ params: Promise.resolve({ chatId, characterId }) });
  const addReq = (chatId: string, body: unknown) =>
    new NextRequest(`http://t/api/chats/${chatId}/participants`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const presenceReq = (chatId: string, characterId: string, presence: string) =>
    new NextRequest(`http://t/api/chats/${chatId}/participants/${characterId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ presence }),
    });
  const removeReq = (chatId: string, characterId: string) =>
    new NextRequest(`http://t/api/chats/${chatId}/participants/${characterId}`, { method: "DELETE" });

  const mkCharacter = async (name: string): Promise<string> => {
    const [row] = await db().insert(characters).values({ ownerId: authState.user.id, name, profile: {} }).returning();
    if (!row) throw new Error("failed to seed character");
    return row.id;
  };

  it("adds a member, reflects it in the GET roster, and flips presence through the state row", async (t) => {
    if (!ready) return t.skip();
    const chat = await createChat(ids.character);
    const joinerId = await mkCharacter("Rhett");

    const added = await participantAdd(addReq(chat.id, { characterId: joinerId }), ctx(chat.id));
    expect(added.status).toBe(201);

    const got = (await (await chatGet(getReq(chat.id), ctx(chat.id))).json()) as {
      roster: Array<{ characterId: string; sort: number; presence: string }>;
    };
    expect(got.roster.map((m) => m.characterId)).toEqual([ids.character, joinerId]);
    expect(got.roster.map((m) => m.sort)).toEqual([0, 1]);
    expect(got.roster.every((m) => m.presence === "present")).toBe(true);

    // A duplicate add is refused.
    expect((await participantAdd(addReq(chat.id, { characterId: joinerId }), ctx(chat.id))).status).toBe(409);

    // Presence flip persists on the (lazily seeded) state row and rides the GET.
    const flipped = await participantPatch(presenceReq(chat.id, joinerId, "away"), pCtx(chat.id, joinerId));
    expect(flipped.status).toBe(200);
    const after = (await (await chatGet(getReq(chat.id), ctx(chat.id))).json()) as {
      roster: Array<{ characterId: string; presence: string }>;
    };
    expect(after.roster.find((m) => m.characterId === joinerId)?.presence).toBe("away");
    const [stateRow] = await db()
      .select({ presence: characterChatState.presence })
      .from(characterChatState)
      .where(and(eq(characterChatState.chatId, chat.id), eq(characterChatState.characterId, joinerId)));
    expect(stateRow?.presence).toBe("away");
  });

  it("state GET/PATCH target any roster member via ?characterId= (followups ruling 13)", async (t) => {
    if (!ready) return t.skip();
    const chat = await createChat(ids.character);
    const joinerId = await mkCharacter("Sheet Target");
    await participantAdd(addReq(chat.id, { characterId: joinerId }), ctx(chat.id));

    const targetPatch = new NextRequest(`http://t/api/chats/${chat.id}/state?characterId=${joinerId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ regard: 33, outfit: "a borrowed jacket" }),
    });
    expect((await statePatch(targetPatch, ctx(chat.id))).status).toBe(200);
    const [row] = await db()
      .select({ regard: characterChatState.regard, outfit: characterChatState.outfit })
      .from(characterChatState)
      .where(and(eq(characterChatState.chatId, chat.id), eq(characterChatState.characterId, joinerId)));
    expect(row?.regard).toBe(33);
    expect(row?.outfit).toBe("a borrowed jacket");

    // GET returns the member's own snapshot…
    const get = await stateGet(new NextRequest(`http://t/api/chats/${chat.id}/state?characterId=${joinerId}`), ctx(chat.id));
    expect(get.status).toBe(200);
    expect(((await get.json()) as { regard: number }).regard).toBe(33);
    // …and an out-of-roster id 404s.
    const bad = await stateGet(
      new NextRequest(`http://t/api/chats/${chat.id}/state?characterId=${ids.otherCharacter}`),
      ctx(chat.id),
    );
    expect(bad.status).toBe(404);
  });

  it("caps the roster at 4 and refuses foreign characters", async (t) => {
    if (!ready) return t.skip();
    const chat = await createChat(ids.character);
    for (const name of ["Cap B", "Cap C", "Cap D"]) {
      const memberId = await mkCharacter(name);
      expect((await participantAdd(addReq(chat.id, { characterId: memberId }), ctx(chat.id))).status).toBe(201);
    }
    const overflowId = await mkCharacter("Cap E");
    expect((await participantAdd(addReq(chat.id, { characterId: overflowId }), ctx(chat.id))).status).toBe(409);
    // Another owner's character is unreachable regardless of the cap.
    const fresh = await createChat(ids.character);
    expect((await participantAdd(addReq(fresh.id, { characterId: ids.otherCharacter }), ctx(fresh.id))).status).toBe(404);
  });

  it("never removes the last member; removing the primary promotes the next (sort renumbers)", async (t) => {
    if (!ready) return t.skip();
    const chat = await createChat(ids.character);
    expect((await participantRemove(removeReq(chat.id, ids.character), pCtx(chat.id, ids.character))).status).toBe(409);

    const joinerId = await mkCharacter("Heir");
    await participantAdd(addReq(chat.id, { characterId: joinerId }), ctx(chat.id));
    const removed = await participantRemove(removeReq(chat.id, ids.character), pCtx(chat.id, ids.character));
    expect(removed.status).toBe(200);
    const got = (await (await chatGet(getReq(chat.id), ctx(chat.id))).json()) as {
      roster: Array<{ characterId: string; sort: number }>;
      character: { id: string };
    };
    expect(got.roster).toEqual([expect.objectContaining({ characterId: joinerId, sort: 0 })]);
    // The promoted member is now the envelope's primary character card.
    expect(got.character.id).toBe(joinerId);
  });

  it("seeds a preset's premise onto the shared scenario; outfit/bands to the primary only", async (t) => {
    if (!ready) return t.skip();
    const [preset] = await db()
      .insert(chatScenarioPresets)
      .values({
        ownerId: authState.user.id,
        name: "Group scene",
        premise: "A rain-soaked rooftop bar.",
        outfit: "a red slip dress",
        startingRelationship: { familiarity: "acquainted", regard: "warm", kind: "old regulars", history: "", looming: false },
      })
      .returning({ id: chatScenarioPresets.id });
    if (!preset) throw new Error("failed to seed preset");
    const secondId = await mkCharacter("Second Seat");

    const res = await chatsCreate(
      createReq({ characterIds: [ids.character, secondId], memory: "fresh", presetId: preset.id }),
      collectionCtx,
    );
    expect(res.status).toBe(201);
    const { id: chatId } = (await res.json()) as { id: string };

    // The premise lives once on the chat row (followups ruling 8) — every
    // roster member reads the same scenario.
    const [scenario] = await db()
      .select({ premise: characterChats.premise })
      .from(characterChats)
      .where(eq(characterChats.id, chatId));
    expect(scenario?.premise).toBe("A rain-soaked rooftop bar.");

    const states = await db()
      .select({
        characterId: characterChatState.characterId,
        outfit: characterChatState.outfit,
      })
      .from(characterChatState)
      .where(eq(characterChatState.chatId, chatId));
    const primary = states.find((s) => s.characterId === ids.character);
    const second = states.find((s) => s.characterId === secondId);
    expect(primary?.outfit).toBe("a red slip dress");
    expect(second?.outfit).not.toBe("a red slip dress");
  });
});

describe("relationship matrix — seeding + routes (relationship-model.plan.md slice 6)", () => {
  const mkCharacter = async (name: string): Promise<string> => {
    const [row] = await db().insert(characters).values({ ownerId: authState.user.id, name, profile: {} }).returning();
    if (!row) throw new Error("failed to seed character");
    return row.id;
  };
  const matrixReq = (chatId: string, body: unknown) =>
    new NextRequest(`http://t/api/chats/${chatId}/relationships`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const libReq = (id: string, body: unknown) =>
    new NextRequest(`http://t/api/characters/${id}/relationships`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const idCtx = (id: string) => ({ params: Promise.resolve({ id }) });

  it("creation seeds the matrix from library defaults at band midpoints", async (t) => {
    if (!ready) return t.skip();
    const aId = await mkCharacter("Edge A");
    const bId = await mkCharacter("Edge B");
    await db().insert(characterRelationships).values({
      fromCharacterId: aId,
      toCharacterId: bId,
      record: { familiarity: "deeply_known", regard: "cool", kind: "estranged friends", history: "", looming: false },
    });

    const res = await chatsCreate(createReq({ characterIds: [aId, bId], memory: "fresh" }), collectionCtx);
    expect(res.status).toBe(201);
    const { id: chatId } = (await res.json()) as { id: string };

    const got = await matrixGet(new NextRequest(`http://t/api/chats/${chatId}/relationships`), ctx(chatId));
    const body = (await got.json()) as { edges: Array<{ fromCharacterId: string; toCharacterId: string; record: { familiarity: number; regard: number; kind: string } }> };
    const edge = body.edges.find((e) => e.fromCharacterId === aId && e.toCharacterId === bId);
    expect(edge).toBeDefined();
    expect(edge!.record.kind).toBe("estranged friends");
    expect(edge!.record.familiarity).toBeGreaterThan(50); // deeply_known midpoint
    expect(edge!.record.regard).toBeLessThan(0); // cool midpoint
  });

  it("PUT upserts roster edges and refuses foreign characters", async (t) => {
    if (!ready) return t.skip();
    const aId = await mkCharacter("Put A");
    const bId = await mkCharacter("Put B");
    const res = await chatsCreate(createReq({ characterIds: [aId, bId], memory: "fresh" }), collectionCtx);
    const { id: chatId } = (await res.json()) as { id: string };

    const put = await matrixPut(
      matrixReq(chatId, {
        edges: [
          { fromCharacterId: aId, toCharacterId: bId, record: { familiarity: "familiar", regard: "warm", kind: "old flames", history: "", looming: true } },
        ],
      }),
      ctx(chatId),
    );
    expect(put.status).toBe(200);
    const body = (await put.json()) as { edges: Array<{ record: { kind: string; looming: boolean } }> };
    expect(body.edges[0]?.record.kind).toBe("old flames");
    expect(body.edges[0]?.record.looming).toBe(true);

    const bad = await matrixPut(
      matrixReq(chatId, {
        edges: [{ fromCharacterId: aId, toCharacterId: ids.otherCharacter, record: { familiarity: "strangers", regard: "neutral", kind: "", history: "", looming: false } }],
      }),
      ctx(chatId),
    );
    expect(bad.status).toBe(404);
  });

  it("library defaults PUT/GET roundtrip with replace-set semantics", async (t) => {
    if (!ready) return t.skip();
    const aId = await mkCharacter("Lib A");
    const bId = await mkCharacter("Lib B");
    const cId = await mkCharacter("Lib C");

    const put1 = await libPut(
      libReq(aId, {
        edges: [
          { toCharacterId: bId, record: { familiarity: "acquainted", regard: "friendly", kind: "coworkers", history: "", looming: false } },
          { toCharacterId: cId, record: { familiarity: "strangers", regard: "neutral", kind: "", history: "", looming: false } },
        ],
      }),
      idCtx(aId),
    );
    expect(put1.status).toBe(200);

    // Replace-set: dropping C keeps only B.
    await libPut(
      libReq(aId, {
        edges: [{ toCharacterId: bId, record: { familiarity: "familiar", regard: "warm", kind: "coworkers", history: "", looming: false } }],
      }),
      idCtx(aId),
    );
    const got = (await (await libGet(new NextRequest(`http://t/api/characters/${aId}/relationships`), idCtx(aId))).json()) as {
      edges: Array<{ toCharacterId: string; toName: string; record: { familiarity: string } }>;
    };
    expect(got.edges).toHaveLength(1);
    expect(got.edges[0]?.toCharacterId).toBe(bId);
    expect(got.edges[0]?.toName).toBe("Lib B");
    expect(got.edges[0]?.record.familiarity).toBe("familiar");
  });
});
