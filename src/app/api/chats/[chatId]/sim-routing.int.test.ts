import { eq, sql } from "drizzle-orm";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { characterProfileSchema } from "@/contracts";
import { parseOr } from "@/lib/parse";
import { replyTakesSchema } from "@/server/engine";
import {
  characterChats,
  characterChatMessages,
  characters,
  db,
  simBranches,
  simEvents,
  simWorlds,
  users,
} from "@/server/db";

/**
 * Routing parity (presentation-charter.plan.md §4; engine.spec.operations.md §39
 * rulings 18-19): on a sim-routed chat every POST kind either has successor
 * semantics or is refused — never the legacy narrator. AI_FAKE ⇒ zero live model
 * calls (the deterministic render). Self-skips without a database.
 */

process.env.AI_FAKE = "1";

const authState = vi.hoisted(() => ({
  user: { id: "", email: "", name: "Routing Parity", role: "user" as "admin" | "user" },
}));

vi.mock("@/server/auth", () => ({
  USER_COOKIE: "vesper_user",
  getCurrentUser: async () => authState.user,
  ensureDefaultUser: async () => authState.user,
  listUsers: async () => [authState.user],
}));

import { GET as chatGet, POST as chatSend } from "./route";
import { POST as successorCreate } from "../../successor-chats/route";

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
      `[sim-routing.int.test] skipping: database unreachable: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return false;
  } finally {
    clearTimeout(timer);
  }
}

const ready = await probe();
const ctx = (chatId: string) => ({ params: Promise.resolve({ chatId }) });
function jsonReq(path: string, body: unknown): NextRequest {
  return new NextRequest(`http://t${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const cutIdMetaSchema = z.object({ cutId: z.string().catch("") }).catch({ cutId: "" });
const ids = { user: "", characterId: "" };
const worldIds: string[] = [];

beforeAll(async () => {
  if (!ready) return;
  const stamp = Date.now();
  const [user] = await db()
    .insert(users)
    .values({ email: `routing-parity-${stamp}@test.local`, name: "Routing Parity" })
    .returning();
  if (!user) throw new Error("failed to create test user");
  authState.user = { ...authState.user, id: user.id, email: user.email };
  ids.user = user.id;
  const profile = characterProfileSchema.parse({ playerRelationship: { familiarity: "close", regard: "warm" } });
  const [character] = await db().insert(characters).values({ ownerId: user.id, name: "Abigail", profile }).returning();
  if (!character) throw new Error("failed to seed character");
  ids.characterId = character.id;
});

afterAll(async () => {
  if (!ready || !ids.user) return;
  for (const worldId of worldIds) await db().delete(simWorlds).where(eq(simWorlds.id, worldId));
  await db().delete(characterChats).where(eq(characterChats.ownerId, ids.user));
  await db().delete(characters).where(eq(characters.ownerId, ids.user));
  await db().delete(users).where(eq(users.id, ids.user));
});

async function provision(title: string): Promise<{ chatId: string; branchId: string }> {
  const created = await successorCreate(
    // slice 3: `requestId` is the required per-intent idempotency key.
    jsonReq("/api/successor-chats", { characterId: ids.characterId, title, requestId: `routing-${title.toLowerCase().replace(/\s+/gu, "-")}-${Date.now()}` }),
    { params: Promise.resolve({}) },
  );
  expect(created.status).toBe(201);
  const body = (await created.json()) as { id: string; worldId: string; branchId: string };
  worldIds.push(body.worldId);
  return { chatId: body.id, branchId: body.branchId };
}

/** Post one exchange and drain the stream so the reply settles server-side. */
async function post(chatId: string, body: unknown): Promise<Response> {
  const res = await chatSend(jsonReq(`/api/chats/${chatId}`, body), ctx(chatId));
  if (res.body) await res.text();
  return res;
}

async function messageRoles(chatId: string): Promise<string[]> {
  const rows = await db()
    .select({ role: characterChatMessages.role })
    .from(characterChatMessages)
    .where(eq(characterChatMessages.chatId, chatId));
  return rows.map((r) => r.role);
}

async function lastAssistant(
  chatId: string,
): Promise<{ id: string; content: string; takes: unknown; meta: unknown } | undefined> {
  const rows = await db()
    .select({
      id: characterChatMessages.id,
      role: characterChatMessages.role,
      content: characterChatMessages.content,
      takes: characterChatMessages.takes,
      meta: characterChatMessages.meta,
    })
    .from(characterChatMessages)
    .where(eq(characterChatMessages.chatId, chatId))
    .orderBy(sql`${characterChatMessages.createdAt} desc, ${characterChatMessages.id} desc`);
  const a = rows.find((r) => r.role === "assistant");
  return a ? { id: a.id, content: a.content, takes: a.takes, meta: a.meta } : undefined;
}

async function eventCount(branchId: string): Promise<number> {
  const rows = await db().select({ id: simEvents.id }).from(simEvents).where(eq(simEvents.branchId, branchId));
  return rows.length;
}

async function branchSecond(branchId: string): Promise<number> {
  const [row] = await db()
    .select({ storySecond: simBranches.storySecond })
    .from(simBranches)
    .where(eq(simBranches.id, branchId));
  return row?.storySecond ?? 0;
}

function metaCutId(meta: unknown): string {
  return parseOr(cutIdMetaSchema, meta, { cutId: "" }, undefined, "meta").cutId;
}

describe.runIf(ready)("sim routing parity", () => {
  it("regenerate re-renders the SAME cut in place: no new rows, no truth growth, a take recorded", async () => {
    const { chatId, branchId } = await provision("Regen Test");
    expect((await post(chatId, { kind: "send", content: "I look around our new home." })).status).toBe(200);

    expect((await messageRoles(chatId)).sort()).toEqual(["assistant", "user"]);
    const eventsAfterSend = await eventCount(branchId);
    const replyBefore = await lastAssistant(chatId);
    if (!replyBefore) throw new Error("no reply after send");
    const cutIdSend = metaCutId(replyBefore.meta);
    expect(cutIdSend).not.toBe("");

    const regen = await post(chatId, { kind: "regenerate" });
    expect(regen.status).toBe(200);

    // No new transcript rows (the assistant row is replaced in place).
    expect((await messageRoles(chatId)).sort()).toEqual(["assistant", "user"]);
    // No event/truth growth — a retake creates nothing (ruling 18 / §22.3).
    expect(await eventCount(branchId)).toBe(eventsAfterSend);

    const replyAfter = await lastAssistant(chatId);
    if (!replyAfter) throw new Error("no reply after regenerate");
    expect(replyAfter.id).toBe(replyBefore.id); // same row, updated in place
    expect(metaCutId(replyAfter.meta)).toBe(cutIdSend); // the SAME committed cut
    // A fresh take was recorded (the prior take stays browsable).
    const takes = parseOr(replyTakesSchema, replyAfter.takes, { takes: [], activeId: "" }, undefined, "takes");
    expect(takes.takes.length).toBeGreaterThanOrEqual(2);
    expect(takes.activeId).not.toBe("");
  });

  it("continue advances time with NO player utterance (ruling 19)", async () => {
    const { chatId, branchId } = await provision("Continue Test");
    expect((await post(chatId, { kind: "send", content: "Good morning." })).status).toBe(200);

    const rolesBefore = await messageRoles(chatId);
    const usersBefore = rolesBefore.filter((r) => r === "user").length;
    const assistantsBefore = rolesBefore.filter((r) => r === "assistant").length;
    const secondBefore = await branchSecond(branchId);

    const cont = await post(chatId, { kind: "continue" });
    expect(cont.status).toBe(200);

    const rolesAfter = await messageRoles(chatId);
    expect(rolesAfter.filter((r) => r === "user").length).toBe(usersBefore); // no user row
    expect(rolesAfter.filter((r) => r === "assistant").length).toBe(assistantsBefore + 1); // a fresh reply
    expect(await branchSecond(branchId)).toBeGreaterThan(secondBefore); // the span advanced (time moved)
  });

  it("refuses attachments and legacy action chips with 409 and no writes", async () => {
    const { chatId } = await provision("Refuse Test");
    // The GET envelope's client-facing routing flag (the UI hides the affordances off it).
    const envelope = (await (await chatGet(new NextRequest(`http://t/api/chats/${chatId}`), ctx(chatId))).json()) as {
      chat: { simRouted: boolean };
    };
    expect(envelope.chat.simRouted).toBe(true);

    expect((await post(chatId, { kind: "send", content: "Hi." })).status).toBe(200);
    const before = (await messageRoles(chatId)).length;

    const att = await chatSend(
      jsonReq(`/api/chats/${chatId}`, { kind: "send", content: "look at this", attachmentIds: ["not-a-real-upload"] }),
      ctx(chatId),
    );
    expect(att.status).toBe(409);
    expect(((await att.json()) as { error: { code: string } }).error.code).toBe("sim_unsupported_operation");
    expect((await messageRoles(chatId)).length).toBe(before); // nothing written

    const act = await chatSend(jsonReq(`/api/chats/${chatId}`, { kind: "action_beat", action: "rest" }), ctx(chatId));
    expect(act.status).toBe(409);
    expect(((await act.json()) as { error: { code: string } }).error.code).toBe("sim_unsupported_operation");
    expect((await messageRoles(chatId)).length).toBe(before); // nothing written
  });
});
