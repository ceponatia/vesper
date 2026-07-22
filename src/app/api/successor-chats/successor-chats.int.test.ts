import { eq, sql } from "drizzle-orm";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { characterChats, characterChatMessages, characters, db, simBranches, simWorlds, users } from "@/server/db";

// The successor front door (engine.rollout.plan.md, owner ask 2026-07-22):
// one POST provisions a fresh starter world, creates the chat, and routes it
// to the successor lane — then an ordinary send plays a full sim turn in it
// (AI_FAKE; zero live calls). Self-skips without a database.

process.env.AI_FAKE = "1";

const authState = vi.hoisted(() => ({
  user: { id: "", email: "", name: "Front Door", role: "user" as "admin" | "user" },
}));

vi.mock("@/server/auth", () => ({
  USER_COOKIE: "vesper_user",
  getCurrentUser: async () => authState.user,
  ensureDefaultUser: async () => authState.user,
  listUsers: async () => [authState.user],
}));

import { STARTER_CALENDAR_START, STARTER_ORIGIN_STORY_SECOND } from "@/server/engine";
import { GET as successorList, POST as successorCreate } from "./route";
import { PATCH as calendarPatch } from "./[chatId]/route";
import { POST as chatSend } from "../chats/[chatId]/route";
import { GET as stateGet } from "../chats/[chatId]/state/route";

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
      `[successor-chats.int.test] skipping: database unreachable: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return false;
  } finally {
    clearTimeout(timer);
  }
}

const ready = await probe();
const ctx = (chatId: string) => ({ params: Promise.resolve({ chatId }) });
function jsonReq(path: string, body: unknown, method = "POST"): NextRequest {
  return new NextRequest(`http://t${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const ids = { user: "", characterId: "", worldId: "" };

beforeAll(async () => {
  if (!ready) return;
  const stamp = Date.now();
  const [user] = await db()
    .insert(users)
    .values({ email: `front-door-${stamp}@test.local`, name: "Front Door" })
    .returning();
  if (!user) throw new Error("failed to create test user");
  authState.user = { ...authState.user, id: user.id, email: user.email };
  ids.user = user.id;
  const [character] = await db()
    .insert(characters)
    .values({ ownerId: user.id, name: "Abigail", profile: {} })
    .returning();
  if (!character) throw new Error("failed to seed character");
  ids.characterId = character.id;
});

afterAll(async () => {
  if (!ready || !ids.user) return;
  if (ids.worldId) await db().delete(simWorlds).where(eq(simWorlds.id, ids.worldId));
  await db().delete(characterChats).where(eq(characterChats.ownerId, ids.user));
  await db().delete(characters).where(eq(characters.ownerId, ids.user));
  await db().delete(users).where(eq(users.id, ids.user));
});

describe.runIf(ready)("successor-chats front door", () => {
  it("provisions a fresh world, routes the chat, and plays a full sim turn", async () => {
    const created = await successorCreate(
      jsonReq("/api/successor-chats", { characterId: ids.characterId, title: "Front Door Test" }),
      { params: Promise.resolve({}) },
    );
    expect(created.status).toBe(201);
    const body = (await created.json()) as { id: string; worldId: string; branchId: string };
    ids.worldId = body.worldId;

    // The chat is routed with both actors mapped, and the fresh branch sits
    // at the starter origin (Day 1 · 8:00am).
    const [chatRow] = await db()
      .select({
        authority: characterChats.engineAuthority,
        simBranchId: characterChats.simBranchId,
        simPlayerActorId: characterChats.simPlayerActorId,
        simPrimaryActorId: characterChats.simPrimaryActorId,
      })
      .from(characterChats)
      .where(eq(characterChats.id, body.id));
    expect(chatRow).toMatchObject({ authority: "successor_narrative_view", simBranchId: body.branchId });
    expect(chatRow?.simPlayerActorId).toBeTruthy();
    expect(chatRow?.simPrimaryActorId).toBeTruthy();
    const [branch] = await db()
      .select({ storySecond: simBranches.storySecond })
      .from(simBranches)
      .where(eq(simBranches.id, body.branchId));
    expect(branch?.storySecond).toBe(STARTER_ORIGIN_STORY_SECOND);

    // An ordinary send plays a successor turn in the fresh world.
    const send = await chatSend(
      jsonReq(`/api/chats/${body.id}`, { kind: "send", content: "I look around our new home." }),
      ctx(body.id),
    );
    expect(send.status).toBe(200);
    expect((await send.text()).replace(/\u200B/g, "").length).toBeGreaterThan(0);
    const lines = await db()
      .select({ role: characterChatMessages.role })
      .from(characterChatMessages)
      .where(eq(characterChatMessages.chatId, body.id));
    expect(lines.map((line) => line.role).sort()).toEqual(["assistant", "user"]);

    // The list shows it with the character's name and the world clock.
    const listRes = await successorList(new NextRequest("http://t/api/successor-chats"), { params: Promise.resolve({}) });
    expect(listRes.status).toBe(200);
    const { chats } = (await listRes.json()) as {
      chats: { id: string; characterName: string; storySecond: number | null }[];
    };
    const listed = chats.find((chat) => chat.id === body.id);
    if (!listed) throw new Error("successor chat missing from the list");
    expect(listed.characterName).toBe("Abigail");
    // The turn's 60s span moved the clock past the origin.
    expect(listed.storySecond).toBeGreaterThanOrEqual(STARTER_ORIGIN_STORY_SECOND);

    // R5 calendar (ruling 17): fresh worlds carry the default anchor, the
    // state envelope serves it, and the editor PATCH replaces (or clears) it.
    const [world] = await db()
      .select({ calendarStart: simWorlds.calendarStart })
      .from(simWorlds)
      .where(eq(simWorlds.id, body.worldId));
    expect(world?.calendarStart).toEqual(STARTER_CALENDAR_START);
    const stateRes = await stateGet(new NextRequest(`http://t/api/chats/${body.id}/state`), ctx(body.id));
    const stateBody = (await stateRes.json()) as {
      simClock: { storySecond: number; calendarStart: { year: number } | null } | null;
    };
    expect(stateBody.simClock?.calendarStart).toEqual(STARTER_CALENDAR_START);
    const patched = await calendarPatch(
      jsonReq(`/api/successor-chats/${body.id}`, { calendarStart: { year: 2027, month: 1, day: 15 } }, "PATCH"),
      ctx(body.id),
    );
    expect(patched.status).toBe(200);
    const [worldAfter] = await db()
      .select({ calendarStart: simWorlds.calendarStart })
      .from(simWorlds)
      .where(eq(simWorlds.id, body.worldId));
    expect(worldAfter?.calendarStart).toEqual({ year: 2027, month: 1, day: 15 });
  });

  it("rejects a character outside the caller's library", async () => {
    const res = await successorCreate(jsonReq("/api/successor-chats", { characterId: "not-a-real-id" }), { params: Promise.resolve({}) });
    expect(res.status).toBe(404);
  });
});
