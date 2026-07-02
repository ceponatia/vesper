import { and, eq, sql } from "drizzle-orm";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { characterChatMessages, characters, db, images, users } from "@/server/db";

// Character-chat route integration suite (docs/developer-notes/character-chat.plan.md):
// the GET/POST/DELETE handlers invoked directly with mocked auth against
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

import { persistAssistantReply } from "@/server/engine";
import { DELETE as chatDelete, GET as chatGet, POST as chatPost } from "./[id]/chat/route";
import { DELETE as msgDelete, PATCH as msgPatch } from "./[id]/chat/[messageId]/route";

async function probe(): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      db().execute(sql`select 1 from character_chat_messages limit 1`),
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
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const ctx2 = (id: string, messageId: string) => ({ params: Promise.resolve({ id, messageId }) });

function postReq(id: string, body: unknown): NextRequest {
  return new NextRequest(`http://t/api/characters/${id}/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
const getReq = () => new NextRequest("http://t/api/characters/x/chat");
function patchReq(id: string, messageId: string, body: unknown): NextRequest {
  return new NextRequest(`http://t/api/characters/${id}/chat/${messageId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
const delReq = (id: string, messageId: string) =>
  new NextRequest(`http://t/api/characters/${id}/chat/${messageId}`, { method: "DELETE" });

async function insertMessage(characterId: string, ownerId: string, role: "user" | "assistant", content: string): Promise<string> {
  const [row] = await db()
    .insert(characterChatMessages)
    .values({ ownerId, characterId, role, content })
    .returning({ id: characterChatMessages.id });
  if (!row) throw new Error("failed to seed chat message");
  return row.id;
}

const ids = { character: "", otherUser: "", otherCharacter: "" };

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
});

afterAll(async () => {
  if (!ready) return;
  // images.owner_id has no ON DELETE cascade, so clear test assets before users.
  await db().delete(images).where(eq(images.ownerId, authState.user.id));
  await db().delete(images).where(eq(images.ownerId, ids.otherUser));
  await db().delete(characters).where(eq(characters.ownerId, authState.user.id));
  await db().delete(characters).where(eq(characters.ownerId, ids.otherUser));
  await db().delete(users).where(eq(users.id, authState.user.id));
  await db().delete(users).where(eq(users.id, ids.otherUser));
  await globalThis.__vesperPool?.end();
});

async function rows(characterId: string) {
  return db()
    .select({ role: characterChatMessages.role, content: characterChatMessages.content })
    .from(characterChatMessages)
    .where(and(eq(characterChatMessages.ownerId, authState.user.id), eq(characterChatMessages.characterId, characterId)))
    .orderBy(characterChatMessages.createdAt);
}

describe("POST /api/characters/:id/chat", () => {
  it("streams a demo reply and persists both the user line and the reply", async (t) => {
    if (!ready) return t.skip();
    const res = await chatPost(postReq(ids.character, { content: "Hello there" }), ctx(ids.character));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");

    const text = await res.text();
    expect(text).toContain("[Mara]");
    expect(text).toContain("Demo mode");

    // The stream settles only after the reply is persisted, so it's queryable now.
    const persisted = await rows(ids.character);
    expect(persisted.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(persisted[0]?.content).toBe("Hello there");
    expect(persisted[1]?.content).toContain("[Mara]");
  });

  it("404s for a character the user does not own", async (t) => {
    if (!ready) return t.skip();
    const res = await chatPost(postReq(ids.otherCharacter, { content: "hi" }), ctx(ids.otherCharacter));
    expect(res.status).toBe(404);
  });

  it("400s on an empty message", async (t) => {
    if (!ready) return t.skip();
    const res = await chatPost(postReq(ids.character, { content: "   " }), ctx(ids.character));
    expect(res.status).toBe(400);
  });
});

describe("GET + DELETE /api/characters/:id/chat", () => {
  it("returns the transcript oldest-first, then clears it", async (t) => {
    if (!ready) return t.skip();
    const got = (await (await chatGet(getReq(), ctx(ids.character))).json()) as { messages: { role: string; content: string }[] };
    expect(got.messages.length).toBeGreaterThanOrEqual(2);
    expect(got.messages[0]?.role).toBe("user");

    const del = await chatDelete(getReq(), ctx(ids.character));
    expect(del.status).toBe(200);
    expect(await rows(ids.character)).toEqual([]);
  });

  it("scrubs surviving scene-image prompts so cleared chat context isn't shown", async (t) => {
    if (!ready) return t.skip();
    // A chat scene's prompt embeds recent chat lines; the asset must survive a
    // clear, but its chat-derived prompt must not (gallery enlarge shows it).
    await db().insert(images).values({
      ownerId: authState.user.id,
      kind: "scene",
      entityKind: "character",
      entityId: ids.character,
      path: "images/test/scene.webp",
      prompt: "Mara leans close, whispering the secret she just told you.",
    });

    const del = await chatDelete(getReq(), ctx(ids.character));
    expect(del.status).toBe(200);

    const [scene] = await db()
      .select({ id: images.id, prompt: images.prompt })
      .from(images)
      .where(and(eq(images.ownerId, authState.user.id), eq(images.entityId, ids.character), eq(images.kind, "scene")));
    expect(scene).toBeDefined(); // asset itself survives the clear
    expect(scene?.prompt).toBe(""); // but its chat-derived prompt is blanked
  });
});

describe("PATCH + DELETE /api/characters/:id/chat/:messageId", () => {
  it("overwrites one message's text in place (rewrite a refusal)", async (t) => {
    if (!ready) return t.skip();
    const messageId = await insertMessage(ids.character, authState.user.id, "assistant", "I cannot continue this roleplay.");
    const res = await msgPatch(patchReq(ids.character, messageId, { content: '[Mara] "Mmm — come closer."' }), ctx2(ids.character, messageId));
    expect(res.status).toBe(200);

    const after = await rows(ids.character);
    expect(after.some((m) => m.content.includes("come closer"))).toBe(true);
    expect(after.some((m) => m.content.includes("cannot continue"))).toBe(false);
  });

  it("deletes a single message, leaving the rest (snip a refusal out of the window)", async (t) => {
    if (!ready) return t.skip();
    await insertMessage(ids.character, authState.user.id, "user", "keep me");
    const drop = await insertMessage(ids.character, authState.user.id, "assistant", "remove me");
    const res = await msgDelete(delReq(ids.character, drop), ctx2(ids.character, drop));
    expect(res.status).toBe(200);

    const after = await rows(ids.character);
    expect(after.some((m) => m.content === "remove me")).toBe(false);
    expect(after.some((m) => m.content === "keep me")).toBe(true);
  });

  it("404s editing a message the user does not own, leaving it untouched", async (t) => {
    if (!ready) return t.skip();
    const foreign = await insertMessage(ids.otherCharacter, ids.otherUser, "assistant", "not yours");
    const res = await msgPatch(patchReq(ids.otherCharacter, foreign, { content: "hijacked" }), ctx2(ids.otherCharacter, foreign));
    expect(res.status).toBe(404);

    const [check] = await db()
      .select({ content: characterChatMessages.content })
      .from(characterChatMessages)
      .where(eq(characterChatMessages.id, foreign));
    expect(check?.content).toBe("not yours");
  });
});

describe("assistant-reply persist guard (clear-mid-stream race)", () => {
  it("persists the reply when its prompting line still exists", async (t) => {
    if (!ready) return t.skip();
    const promptId = await insertMessage(ids.character, authState.user.id, "user", "race: keep me");
    await persistAssistantReply({
      ownerId: authState.user.id,
      characterId: ids.character,
      promptMessageId: promptId,
      content: "[Mara] persisted reply",
    });
    const after = await rows(ids.character);
    expect(after.some((m) => m.role === "assistant" && m.content === "[Mara] persisted reply")).toBe(true);
    // Reset for the next case so the guard test below starts clean.
    await db()
      .delete(characterChatMessages)
      .where(and(eq(characterChatMessages.ownerId, authState.user.id), eq(characterChatMessages.characterId, ids.character)));
  });

  it("drops the reply when its prompting line was cleared mid-stream", async (t) => {
    if (!ready) return t.skip();
    const promptId = await insertMessage(ids.character, authState.user.id, "user", "race: gone");
    // Simulate a clear (or single-message delete) landing before the stream settles.
    await db().delete(characterChatMessages).where(eq(characterChatMessages.id, promptId));
    await persistAssistantReply({
      ownerId: authState.user.id,
      characterId: ids.character,
      promptMessageId: promptId,
      content: "[Mara] orphan reply",
    });
    const after = await rows(ids.character);
    expect(after.some((m) => m.content === "[Mara] orphan reply")).toBe(false);
    expect(after).toEqual([]); // nothing resurrected the cleared conversation
  });
});
