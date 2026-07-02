import { and, eq, sql } from "drizzle-orm";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { newId } from "@/lib/ids";
import {
  characterChatMessages,
  characterChats,
  characters,
  chatParticipants,
  db,
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

import { persistAssistantReply, tryKeyedLock } from "@/server/engine";
import { POST as chatsCreate } from "./route";
import { DELETE as chatDelete, GET as chatGet, POST as chatSend } from "./[chatId]/route";
import { DELETE as msgDelete, PATCH as msgPatch } from "./[chatId]/messages/[messageId]/route";

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

/** Create a conversation through the real POST /api/chats handler (the D7 memory choice). */
async function createChat(characterId: string, memory: "shared" | "fresh" = "fresh"): Promise<{ id: string; memoryGroupId: string }> {
  const res = await chatsCreate(createReq({ characterId, memory }), collectionCtx);
  if (res.status !== 201) throw new Error(`chat create failed: ${res.status}`);
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
  // images.owner_id has no ON DELETE cascade, so clear test assets before users;
  // chats own the transcript/state/summary cascades and users FK them (no cascade).
  await db().delete(images).where(eq(images.ownerId, authState.user.id));
  await db().delete(images).where(eq(images.ownerId, ids.otherUser));
  await db().delete(characterChats).where(eq(characterChats.ownerId, authState.user.id));
  await db().delete(characterChats).where(eq(characterChats.ownerId, ids.otherUser));
  await db().delete(characters).where(eq(characters.ownerId, authState.user.id));
  await db().delete(characters).where(eq(characters.ownerId, ids.otherUser));
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
