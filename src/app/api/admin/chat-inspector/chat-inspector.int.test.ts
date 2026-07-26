import { eq, inArray, sql } from "drizzle-orm";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { newId } from "@/lib/ids";
import {
  characterChats,
  characters,
  chatParticipants,
  db,
  episodes,
  events,
  facts,
  images,
  users,
} from "@/server/db";

process.env.AI_FAKE = "1";

const authState = vi.hoisted(() => ({
  user: { id: "", email: "", name: "Inspector Int", role: "admin" as "admin" | "user" },
}));

vi.mock("@/server/auth", () => ({
  USER_COOKIE: "vesper_user",
  getCurrentUser: async () => authState.user,
  ensureDefaultUser: async () => authState.user,
  listUsers: async () => [authState.user],
}));

import { recordAgentFailure } from "@/server/ai";
import { POST as chatsCreate } from "../../chats/route";
import { GET as inspectorGet } from "./[chatId]/route";
import { GET as failuresGet } from "./[chatId]/agent-failures/route";
import { GET as promptGet } from "./[chatId]/prompt/route";
import { POST as factCreate } from "./[chatId]/facts/route";
import { PATCH as factPatch } from "./[chatId]/facts/[factId]/route";
import { DELETE as episodeDelete, PATCH as episodePatch } from "./[chatId]/episodes/[episodeId]/route";
import { GET as scoreGet } from "./[chatId]/episodes/score/route";
import { PATCH as summaryPatch } from "./[chatId]/summary/route";

async function probe(): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      db().execute(sql`select 1 from character_chats limit 1`),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("connect timeout")), 4_000);
      }),
    ]);
    return true;
  } catch (err) {
    process.stderr.write(
      `[chat-inspector.int.test] skipping: database unreachable: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return false;
  } finally {
    clearTimeout(timer);
  }
}

const ready = await probe();
const collectionCtx = { params: Promise.resolve({}) };
const ctx = (chatId: string) => ({ params: Promise.resolve({ chatId }) });
const factCtx = (chatId: string, factId: string) => ({ params: Promise.resolve({ chatId, factId }) });
const episodeCtx = (chatId: string, episodeId: string) => ({ params: Promise.resolve({ chatId, episodeId }) });
const inspectorPath = (chatId: string, suffix = "") => `/api/admin/self/chat-inspector/${chatId}${suffix}`;

function jsonReq(path: string, method: string, body: unknown): NextRequest {
  return new NextRequest(`http://t${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
const getReq = (path: string) => new NextRequest(`http://t${path}`);
const delReq = (path: string) => new NextRequest(`http://t${path}`, { method: "DELETE" });

async function createChat(characterId: string): Promise<{ id: string; memoryGroupId: string }> {
  const response = await chatsCreate(
    jsonReq("/api/chats", "POST", { characterIds: [characterId], memory: "fresh" }),
    collectionCtx,
  );
  if (response.status !== 201) throw new Error(`chat create failed: ${response.status}`);
  return (await response.json()) as { id: string; memoryGroupId: string };
}

interface OverviewFact {
  id: string;
  origin: string;
  pinned: boolean;
  status: string;
  subjectName: string;
  confidence: number;
  supersededById: string | null;
  text: string;
}

async function overviewFor(chatId: string) {
  const response = await inspectorGet(getReq(inspectorPath(chatId)), ctx(chatId));
  expect(response.status).toBe(200);
  return (await response.json()) as {
    facts: OverviewFact[];
    episodes: { id: string; turnNumber: number; summary: string; embedded: boolean }[];
    summary: { summary: string; watermarkAt: string | null; coveredExchanges: number } | null;
    character: { id: string; name: string };
  };
}

const ids = { character: "", chat: "", memoryGroupId: "", otherUser: "", otherCharacter: "", otherChat: "" };
const plantedGroups: string[] = [];

beforeAll(async () => {
  if (!ready) return;
  const stamp = Date.now();
  const [user] = await db()
    .insert(users)
    .values({ email: `inspector-int-${stamp}@test.local`, name: "Inspector Int", role: "admin" })
    .returning();
  const [other] = await db()
    .insert(users)
    .values({ email: `inspector-int-other-${stamp}@test.local`, name: "Other" })
    .returning();
  if (!user || !other) throw new Error("failed to create test users");
  authState.user = { ...authState.user, id: user.id, email: user.email };
  ids.otherUser = other.id;

  const [character] = await db()
    .insert(characters)
    .values({ ownerId: user.id, name: "Mara", profile: {} })
    .returning();
  const [otherCharacter] = await db()
    .insert(characters)
    .values({ ownerId: other.id, name: "NotYours", profile: {} })
    .returning();
  if (!character || !otherCharacter) throw new Error("failed to seed characters");
  ids.character = character.id;
  ids.otherCharacter = otherCharacter.id;

  const chat = await createChat(ids.character);
  ids.chat = chat.id;
  ids.memoryGroupId = chat.memoryGroupId;
  plantedGroups.push(chat.memoryGroupId);

  const otherMemoryGroupId = newId();
  const [otherChat] = await db()
    .insert(characterChats)
    .values({ ownerId: other.id })
    .returning({ id: characterChats.id });
  if (!otherChat) throw new Error("failed to seed foreign chat");
  await db()
    .insert(chatParticipants)
    .values({ chatId: otherChat.id, characterId: otherCharacter.id, memoryGroupId: otherMemoryGroupId });
  ids.otherChat = otherChat.id;
  plantedGroups.push(otherMemoryGroupId);
});

afterAll(async () => {
  if (!ready) return;
  if (plantedGroups.length > 0) {
    await db().delete(facts).where(inArray(facts.chatMemoryGroupId, plantedGroups));
    await db().delete(episodes).where(inArray(episodes.chatMemoryGroupId, plantedGroups));
  }
  await db()
    .delete(events)
    .where(sql`${events.type} = 'agent_failure' and ${events.payload} ->> 'chatId' in (${ids.chat}, ${ids.otherChat})`);
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

let devFactId = "";

describe("self-scoped chat inspector memory tools", () => {
  it("creates, edits, retracts, restores, and lists a development fact", async (test) => {
    if (!ready) return test.skip();
    const created = await factCreate(
      jsonReq(inspectorPath(ids.chat, "/facts"), "POST", {
        text: "the player always brings mara tea",
        pinned: true,
      }),
      ctx(ids.chat),
    );
    expect(created.status).toBe(201);
    devFactId = ((await created.json()) as { id: string }).id;

    let fact = (await overviewFor(ids.chat)).facts.find((row) => row.id === devFactId);
    expect(fact).toMatchObject({ origin: "dev", pinned: true, confidence: 1, subjectName: "mara" });

    const toggled = await factPatch(
      jsonReq(inspectorPath(ids.chat, `/facts/${devFactId}`), "PATCH", { pinned: false }),
      factCtx(ids.chat, devFactId),
    );
    expect(toggled.status).toBe(200);
    expect(((await toggled.json()) as { fact: { pinned: boolean } }).fact.pinned).toBe(false);

    const retracted = await factPatch(
      jsonReq(inspectorPath(ids.chat, `/facts/${devFactId}`), "PATCH", { status: "retracted" }),
      factCtx(ids.chat, devFactId),
    );
    expect(retracted.status).toBe(200);

    await db()
      .update(facts)
      .set({ status: "superseded", supersededById: "newer", supersededAt: new Date() })
      .where(eq(facts.id, devFactId));
    const restored = await factPatch(
      jsonReq(inspectorPath(ids.chat, `/facts/${devFactId}`), "PATCH", {
        status: "active",
        text: "the player switched from tea to coffee",
      }),
      factCtx(ids.chat, devFactId),
    );
    expect(restored.status).toBe(200);
    const restoredBody = (await restored.json()) as { fact: OverviewFact; embedDegraded: boolean };
    expect(restoredBody.fact).toMatchObject({
      status: "active",
      supersededById: null,
      text: "the player switched from tea to coffee",
    });
    expect(restoredBody.embedDegraded).toBe(false);

    fact = (await overviewFor(ids.chat)).facts.find((row) => row.id === devFactId);
    expect(fact?.status).toBe("active");
  });

  it("edits, scores, and deletes an owned episode", async (test) => {
    if (!ready) return test.skip();
    const [row] = await db()
      .insert(episodes)
      .values({ chatMemoryGroupId: ids.memoryGroupId, turnNumber: 1, summary: "she asked about the weather" })
      .returning({ id: episodes.id });
    if (!row) throw new Error("failed to seed episode");

    const edited = await episodePatch(
      jsonReq(inspectorPath(ids.chat, `/episodes/${row.id}`), "PATCH", {
        summary: "she confessed her fear of storms",
      }),
      episodeCtx(ids.chat, row.id),
    );
    expect(edited.status).toBe(200);
    expect((await edited.json()) as unknown).toMatchObject({
      episode: { id: row.id, summary: "she confessed her fear of storms", embedded: true },
      embedDegraded: false,
    });

    const scored = await scoreGet(
      getReq(`${inspectorPath(ids.chat, "/episodes/score")}?q=storms`),
      ctx(ids.chat),
    );
    expect(scored.status).toBe(200);
    expect(((await scored.json()) as { scores: { id: string }[] }).scores.some((score) => score.id === row.id)).toBe(true);

    const deleted = await episodeDelete(
      delReq(inspectorPath(ids.chat, `/episodes/${row.id}`)),
      episodeCtx(ids.chat, row.id),
    );
    expect(deleted.status).toBe(200);
    expect((await overviewFor(ids.chat)).episodes.some((episode) => episode.id === row.id)).toBe(false);
  });

  it("round-trips the rolling summary and prompt preview", async (test) => {
    if (!ready) return test.skip();
    const summary = await summaryPatch(
      jsonReq(inspectorPath(ids.chat, "/summary"), "PATCH", { summary: "A quiet evening of confessions." }),
      ctx(ids.chat),
    );
    expect(summary.status).toBe(200);
    expect(await summary.json()).toMatchObject({
      summary: "A quiet evening of confessions.",
      watermarkAt: null,
      coveredExchanges: 0,
    });

    const prompt = await promptGet(getReq(inspectorPath(ids.chat, "/prompt")), ctx(ids.chat));
    expect(prompt.status).toBe(200);
    expect(await prompt.json()).toMatchObject({ prefix: expect.stringContaining("Mara") });
  });
});

describe("self-admin route boundary", () => {
  it("hides foreign chats, the old namespace, and non-admin access", async (test) => {
    if (!ready) return test.skip();

    const foreign = await inspectorGet(getReq(inspectorPath(ids.otherChat)), ctx(ids.otherChat));
    expect(foreign.status).toBe(404);
    const foreignWrite = await factCreate(
      jsonReq(inspectorPath(ids.otherChat, "/facts"), "POST", { text: "must not land" }),
      ctx(ids.otherChat),
    );
    expect(foreignWrite.status).toBe(404);

    const oldNamespace = await inspectorGet(
      getReq(`/api/admin/chat-inspector/${ids.chat}`),
      ctx(ids.chat),
    );
    expect(oldNamespace.status).toBe(404);

    authState.user = { ...authState.user, role: "user" };
    try {
      const denied = await inspectorGet(getReq(inspectorPath(ids.chat)), ctx(ids.chat));
      expect(denied.status).toBe(404);
    } finally {
      authState.user = { ...authState.user, role: "admin" };
    }
    expect((await inspectorGet(getReq(inspectorPath(ids.chat)), ctx(ids.chat))).status).toBe(200);
  });
});

describe("self-scoped agent telemetry", () => {
  it("returns only the owned chat's failures and omits global telemetry fields", async (test) => {
    if (!ready) return test.skip();
    recordAgentFailure({
      legId: "chat_continuity",
      chatId: ids.chat,
      messageId: "msg-int-1",
      kind: "timeout",
      timeoutMs: 6000,
      modelId: "some/agent-model",
      promptChars: 30_000,
      maxOutputTokens: 400,
    });
    recordAgentFailure({
      legId: "chat_state.pulse",
      chatId: ids.otherChat,
      kind: "api_error",
      providerCode: "rate_limited",
    });

    await vi.waitFor(async () => {
      const response = await failuresGet(
        getReq(inspectorPath(ids.chat, "/agent-failures")),
        ctx(ids.chat),
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        days: number;
        chat: { total: number; recent: { legId: string; cause: string }[]; byLeg: { key: string; count: number }[] };
        runs: { recent: unknown[]; total: number; byLeg: unknown[] };
      };
      expect(Object.keys(body).sort()).toEqual(["chat", "days", "runs"]);
      expect(body.chat.recent.some((failure) => failure.legId === "chat_state.pulse")).toBe(false);
      expect(body.chat.recent.find((failure) => failure.legId === "chat_continuity")?.cause).toBe("prompt_too_large");
      expect(body.chat.byLeg.some((row) => row.key === "chat_continuity")).toBe(true);
      expect(body).not.toHaveProperty("global");
      expect(body).not.toHaveProperty("runsGlobal");
    });
  });
});
