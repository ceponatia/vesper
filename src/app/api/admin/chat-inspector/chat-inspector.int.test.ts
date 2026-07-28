import { eq, inArray, sql } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { newId } from "@/lib/ids";
import { characterChats, characters, chatParticipants, db, episodes, events, facts } from "@/server/db";

const authState = vi.hoisted(() => ({
  user: { id: "", email: "", name: "Inspector Int", role: "admin" as const },
}));

vi.mock("@/server/auth", async () => (await import("@/server/test-support")).routeAuthModule(authState));

import { recordAgentFailure } from "@/server/ai";
import {
  apiRequest,
  bindAuthUser,
  endTestPool,
  expectJson,
  probeIntegrationDb,
  purgeOwnerRows,
  routeCtx,
  seedTestUser,
  withAuthUser,
} from "@/server/test-support";
import { POST as chatsCreate } from "../../chats/route";
import { GET as inspectorGet } from "./[chatId]/route";
import { GET as failuresGet } from "./[chatId]/agent-failures/route";
import { GET as promptGet } from "./[chatId]/prompt/route";
import { POST as factCreate } from "./[chatId]/facts/route";
import { PATCH as factPatch } from "./[chatId]/facts/[factId]/route";
import { DELETE as episodeDelete, PATCH as episodePatch } from "./[chatId]/episodes/[episodeId]/route";
import { GET as scoreGet } from "./[chatId]/episodes/score/route";
import { PATCH as summaryPatch } from "./[chatId]/summary/route";

const ready = await probeIntegrationDb("chat-inspector.int.test", "character_chats");

const ctx = (chatId: string) => routeCtx({ chatId });
const factCtx = (chatId: string, factId: string) => routeCtx({ chatId, factId });
const episodeCtx = (chatId: string, episodeId: string) => routeCtx({ chatId, episodeId });
const inspectorPath = (chatId: string, suffix = "") => `/api/admin/self/chat-inspector/${chatId}${suffix}`;

const jsonReq = (path: string, method: string, body: unknown): NextRequest => apiRequest(path, { method, body });
const getReq = (path: string): NextRequest => apiRequest(path);
const delReq = (path: string): NextRequest => apiRequest(path, { method: "DELETE" });

async function createChat(characterId: string): Promise<{ id: string; memoryGroupId: string }> {
  const response = await chatsCreate(
    apiRequest("/api/chats", { body: { characterIds: [characterId], memory: "fresh" } }),
    routeCtx(),
  );
  return expectJson<{ id: string; memoryGroupId: string }>(response, 201);
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
  return expectJson<{
    facts: OverviewFact[];
    episodes: { id: string; turnNumber: number; summary: string; embedded: boolean }[];
    summary: { summary: string; watermarkAt: string | null; coveredExchanges: number } | null;
    character: { id: string; name: string };
  }>(response, 200);
}

const ids = { character: "", chat: "", memoryGroupId: "", otherUser: "", otherCharacter: "", otherChat: "" };
const plantedGroups: string[] = [];

beforeAll(async () => {
  if (!ready) return;
  const user = await seedTestUser("inspector-int", { name: "Inspector Int", role: "admin" });
  const other = await seedTestUser("inspector-int-other", { name: "Other" });
  bindAuthUser(authState, user);
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
  await purgeOwnerRows([authState.user.id, ids.otherUser]);
  await endTestPool();
});

let devFactId = "";

describe.runIf(ready)("self-scoped chat inspector memory tools", () => {
  it("creates, edits, retracts, restores, and lists a development fact", async () => {
    const created = await factCreate(
      jsonReq(inspectorPath(ids.chat, "/facts"), "POST", {
        text: "the player always brings mara tea",
        pinned: true,
      }),
      ctx(ids.chat),
    );
    devFactId = (await expectJson<{ id: string }>(created, 201)).id;

    let fact = (await overviewFor(ids.chat)).facts.find((row) => row.id === devFactId);
    expect(fact).toMatchObject({ origin: "dev", pinned: true, confidence: 1, subjectName: "mara" });

    const toggled = await factPatch(
      jsonReq(inspectorPath(ids.chat, `/facts/${devFactId}`), "PATCH", { pinned: false }),
      factCtx(ids.chat, devFactId),
    );
    expect((await expectJson<{ fact: { pinned: boolean } }>(toggled, 200)).fact.pinned).toBe(false);

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
    const restoredBody = await expectJson<{ fact: OverviewFact; embedDegraded: boolean }>(restored, 200);
    expect(restoredBody.fact).toMatchObject({
      status: "active",
      supersededById: null,
      text: "the player switched from tea to coffee",
    });
    expect(restoredBody.embedDegraded).toBe(false);

    fact = (await overviewFor(ids.chat)).facts.find((row) => row.id === devFactId);
    expect(fact?.status).toBe("active");
  });

  it("edits, scores, and deletes an owned episode", async () => {
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
    expect(await expectJson(edited, 200)).toMatchObject({
      episode: { id: row.id, summary: "she confessed her fear of storms", embedded: true },
      embedDegraded: false,
    });

    const scored = await scoreGet(
      getReq(`${inspectorPath(ids.chat, "/episodes/score")}?q=storms`),
      ctx(ids.chat),
    );
    expect((await expectJson<{ scores: { id: string }[] }>(scored, 200)).scores.some((score) => score.id === row.id)).toBe(
      true,
    );

    const deleted = await episodeDelete(
      delReq(inspectorPath(ids.chat, `/episodes/${row.id}`)),
      episodeCtx(ids.chat, row.id),
    );
    expect(deleted.status).toBe(200);
    expect((await overviewFor(ids.chat)).episodes.some((episode) => episode.id === row.id)).toBe(false);
  });

  it("round-trips the rolling summary and prompt preview", async () => {
    const summary = await summaryPatch(
      jsonReq(inspectorPath(ids.chat, "/summary"), "PATCH", { summary: "A quiet evening of confessions." }),
      ctx(ids.chat),
    );
    expect(await expectJson(summary, 200)).toMatchObject({
      summary: "A quiet evening of confessions.",
      watermarkAt: null,
      coveredExchanges: 0,
    });

    const prompt = await promptGet(getReq(inspectorPath(ids.chat, "/prompt")), ctx(ids.chat));
    expect(await expectJson(prompt, 200)).toMatchObject({ prefix: expect.stringContaining("Mara") });
  });
});

describe.runIf(ready)("self-admin route boundary", () => {
  it("hides foreign chats, the old namespace, and non-admin access", async () => {

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

    await withAuthUser(authState, { role: "user" }, async () => {
      const denied = await inspectorGet(getReq(inspectorPath(ids.chat)), ctx(ids.chat));
      expect(denied.status).toBe(404);
    });
    expect((await inspectorGet(getReq(inspectorPath(ids.chat)), ctx(ids.chat))).status).toBe(200);
  });
});

describe.runIf(ready)("self-scoped agent telemetry", () => {
  it("returns only the owned chat's failures and omits global telemetry fields", async () => {
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
      const body = await expectJson<{
        days: number;
        chat: { total: number; recent: { legId: string; cause: string }[]; byLeg: { key: string; count: number }[] };
        runs: { recent: unknown[]; total: number; byLeg: unknown[] };
      }>(response, 200);
      expect(Object.keys(body).sort()).toEqual(["chat", "days", "runs"]);
      expect(body.chat.recent.some((failure) => failure.legId === "chat_state.pulse")).toBe(false);
      expect(body.chat.recent.find((failure) => failure.legId === "chat_continuity")?.cause).toBe("prompt_too_large");
      expect(body.chat.byLeg.some((row) => row.key === "chat_continuity")).toBe(true);
      expect(body).not.toHaveProperty("global");
      expect(body).not.toHaveProperty("runsGlobal");
    });
  });
});
