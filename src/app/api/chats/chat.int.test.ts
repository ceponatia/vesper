import { and, eq, inArray, sql } from "drizzle-orm";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { newId } from "@/lib/ids";
import {
  characterChatMessages,
  characterChats,
  characterChatState,
  characters,
  chatParticipants,
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

import { persistAssistantReply, replyTakesSchema, submitChatMessage, tryKeyedLock, type ReplyTakes } from "@/server/engine";
import { log } from "@/server/log";
import { POST as chatsCreate } from "./route";
import { DELETE as chatDelete, GET as chatGet, POST as chatSend } from "./[chatId]/route";
import { DELETE as msgDelete, PATCH as msgPatch } from "./[chatId]/messages/[messageId]/route";
import { PATCH as takePatch } from "./[chatId]/messages/[messageId]/take/route";
import { GET as sceneList } from "./[chatId]/scene/route";
import { PATCH as statePatch } from "./[chatId]/state/route";

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
function stateReq(chatId: string, body: unknown): NextRequest {
  return new NextRequest(`http://t/api/chats/${chatId}/state`, {
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
  it("snips only the target's successors, reuses the guard row, and streams a fresh reply", async (t) => {
    if (!ready) return t.skip();
    const chat = await createChat(ids.character);
    await (await chatSend(postReq(chat.id, { content: "first prompt" }), ctx(chat.id))).text();
    await (await chatSend(postReq(chat.id, { content: "second prompt" }), ctx(chat.id))).text();
    expect(await roleCounts(chat.id)).toEqual({ user: 2, assistant: 2 });
    const user1 = (await fullRows(chat.id)).find((m) => m.role === "user" && m.content === "first prompt");
    if (!user1) throw new Error("missing the first user line");

    const res = await chatSend(postReq(chat.id, { kind: "rerun", messageId: user1.id }), ctx(chat.id));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("[Mara]");

    // Everything after user1 (its reply + the whole second exchange) is gone; user1 stays.
    expect(await roleCounts(chat.id)).toEqual({ user: 1, assistant: 1 });
    const after = await fullRows(chat.id);
    const survivor = after.find((m) => m.id === user1.id);
    expect(survivor?.content).toBe("first prompt"); // reused in place — same id + content
    expect(after.filter((m) => m.role === "user")).toHaveLength(1);
    expect(after.some((m) => m.content === "second prompt")).toBe(false); // successor snipped
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

  it("degrades to no state rollback (with a diagnostic) when the target is an earlier exchange", async (t) => {
    if (!ready) return t.skip();
    const chat = await createChat(ids.character);
    expect((await statePatch(stateReq(chat.id, { regard: 5 }), ctx(chat.id))).status).toBe(200);
    await (await chatSend(postReq(chat.id, { content: "first" }), ctx(chat.id))).text();
    const user1 = (await fullRows(chat.id)).find((m) => m.role === "user" && m.content === "first");
    if (!user1) throw new Error("missing first user line");
    await (await chatSend(postReq(chat.id, { content: "second" }), ctx(chat.id))).text();
    expect((await statePatch(stateReq(chat.id, { regard: 90 }), ctx(chat.id))).status).toBe(200); // distinctive current value

    const infoSpy = vi.spyOn(log, "info");
    try {
      const res = await chatSend(postReq(chat.id, { kind: "rerun", messageId: user1.id }), ctx(chat.id));
      expect(res.status).toBe(200);
      await res.text();

      // Fallback: rerunning an OLDER line (successors span two exchanges) can't use the
      // one-exchange snapshot, so state is NOT rolled back — it stays at the current 90,
      // never the stale one-exchange-back value.
      expect(await stateAffinity(chat.id)).toBe(90);
      // …and the degrade is announced (resilience.md §8 — fallback AND diagnostic code).
      const codes = infoSpy.mock.calls.flatMap((call) => {
        const data = call[2] as { codes?: unknown } | undefined;
        return Array.isArray(data?.codes) ? (data.codes as string[]) : [];
      });
      expect(codes).toContain("chat_state.rerun.no_rollback");
    } finally {
      infoSpy.mockRestore();
    }
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
