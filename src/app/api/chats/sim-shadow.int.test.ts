import { eq, sql } from "drizzle-orm";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { newId } from "@/lib/ids";
import {
  characterChats,
  characters,
  chatParticipants,
  db,
  simBranches,
  simShadowDivergences,
  simWorlds,
  users,
} from "@/server/db";

process.env.AI_FAKE = "1";

const authState = vi.hoisted(() => ({
  user: { id: "", email: "", name: "Sim Shadow Int", role: "admin" as "admin" | "user" },
}));

vi.mock("@/server/auth", () => ({
  USER_COOKIE: "vesper_user",
  getCurrentUser: async () => authState.user,
  ensureDefaultUser: async () => authState.user,
  listUsers: async () => [authState.user],
}));

import {
  ROLLOUT_ACTORS,
  ROLLOUT_BRANCH_ID,
  ROLLOUT_WORLD_ID,
  seedRolloutTestWorld,
  setChatEngineAuthority,
} from "@/server/engine";
import { POST as chatsCreate } from "./route";
import { POST as chatSend } from "./[chatId]/route";
import { POST as legacyTimeSkip } from "./[chatId]/time-skip/route";
import { GET as shadowList } from "../admin/sim/shadow/route";
import { GET as shadowGet, PATCH as shadowPatch } from "../admin/sim/shadow/[chatId]/route";
import { GET as shadowReport } from "../admin/sim/shadow/[chatId]/report/route";

async function probe(): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      db().execute(sql`select 1 from sim_shadow_divergences limit 1`),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("connect timeout")), 4_000);
      }),
    ]);
    return true;
  } catch (err) {
    process.stderr.write(
      `[sim-shadow.int.test] skipping: database unreachable: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return false;
  } finally {
    clearTimeout(timer);
  }
}

const ready = await probe();
const ctx = (chatId: string) => ({ params: Promise.resolve({ chatId }) });
const shadowPath = (chatId?: string, suffix = "") =>
  `/api/admin/self/sim/shadow${chatId ? `/${chatId}` : ""}${suffix}`;
function jsonReq(path: string, body: unknown, method = "POST"): NextRequest {
  return new NextRequest(`http://t${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function waitForRows(chatId: string, count: number): Promise<(typeof simShadowDivergences.$inferSelect)[]> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const rows = await db().select().from(simShadowDivergences).where(eq(simShadowDivergences.chatId, chatId));
    if (rows.length >= count) return rows;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return db().select().from(simShadowDivergences).where(eq(simShadowDivergences.chatId, chatId));
}

const ids = { chat: "", legacyChat: "", user: "", foreignUser: "", foreignChat: "" };

beforeAll(async () => {
  if (!ready) return;
  await db().delete(simWorlds).where(eq(simWorlds.id, ROLLOUT_WORLD_ID));
  const stamp = Date.now();
  const [user] = await db()
    .insert(users)
    .values({ email: `sim-shadow-${stamp}@test.local`, name: "Sim Shadow" })
    .returning();
  const [foreignUser] = await db()
    .insert(users)
    .values({ email: `sim-shadow-foreign-${stamp}@test.local`, name: "Foreign Shadow" })
    .returning();
  if (!user || !foreignUser) throw new Error("failed to create test users");
  authState.user = { ...authState.user, id: user.id, email: user.email };
  ids.user = user.id;
  ids.foreignUser = foreignUser.id;

  const [character] = await db()
    .insert(characters)
    .values({ ownerId: user.id, name: "Ana", profile: {} })
    .returning();
  const [foreignCharacter] = await db()
    .insert(characters)
    .values({ ownerId: foreignUser.id, name: "Foreign Ana", profile: {} })
    .returning();
  if (!character || !foreignCharacter) throw new Error("failed to seed characters");

  for (const key of ["chat", "legacyChat"] as const) {
    const response = await chatsCreate(
      jsonReq("/api/chats", { characterIds: [character.id], memory: "fresh" }),
      { params: Promise.resolve({}) },
    );
    if (response.status !== 201) throw new Error(`chat create failed: ${response.status}`);
    ids[key] = ((await response.json()) as { id: string }).id;
  }

  const [foreignChat] = await db()
    .insert(characterChats)
    .values({ ownerId: foreignUser.id })
    .returning({ id: characterChats.id });
  if (!foreignChat) throw new Error("failed to seed foreign chat");
  ids.foreignChat = foreignChat.id;
  await db()
    .insert(chatParticipants)
    .values({ chatId: foreignChat.id, characterId: foreignCharacter.id, memoryGroupId: newId() });

  await seedRolloutTestWorld();
  await setChatEngineAuthority({
    chatId: ids.chat,
    byUserId: ids.user,
    authority: "successor_shadow",
    simBranchId: ROLLOUT_BRANCH_ID,
    simPlayerActorId: ROLLOUT_ACTORS.mara,
    simPrimaryActorId: ROLLOUT_ACTORS.ana,
  });

  await db().insert(simShadowDivergences).values({
    id: newId(),
    chatId: ids.foreignChat,
    messageId: "foreign-message",
    branchId: ROLLOUT_BRANCH_ID,
    domain: "prose",
    legacy: { private: "foreign legacy" },
    successor: { private: "foreign successor" },
    detail: "foreign detail",
  });
});

afterAll(async () => {
  if (!ready) return;
  await db().delete(simWorlds).where(eq(simWorlds.id, ROLLOUT_WORLD_ID));
  if (ids.user) await db().delete(characterChats).where(eq(characterChats.ownerId, ids.user));
  if (ids.foreignUser) await db().delete(characterChats).where(eq(characterChats.ownerId, ids.foreignUser));
  if (ids.user) await db().delete(characters).where(eq(characters.ownerId, ids.user));
  if (ids.foreignUser) await db().delete(characters).where(eq(characters.ownerId, ids.foreignUser));
  if (ids.user) await db().delete(users).where(eq(users.id, ids.user));
  if (ids.foreignUser) await db().delete(users).where(eq(users.id, ids.foreignUser));
});

describe.runIf(ready)("R4 shadow mode under chat", () => {
  it("records divergence rows for a shadowed exchange while the chat lane stays legacy", async () => {
    const send = await chatSend(jsonReq(`/api/chats/${ids.chat}`, { content: "Good morning, Ana." }), ctx(ids.chat));
    expect(send.status).toBe(200);
    expect(await send.text()).toContain("Demo mode");

    const rows = await waitForRows(ids.chat, 4);
    expect(rows.map((row) => row.domain).sort()).toEqual(["clock", "meters", "presence", "prose"]);
    expect(JSON.stringify(rows.find((row) => row.domain === "prose")?.successor)).toContain("rendered");
    expect(rows.every((row) => row.verdict === "open")).toBe(true);
  });

  it("mirrors a legacy time skip onto the shadow branch clock", async () => {
    const [before] = await db()
      .select({ storySecond: simBranches.storySecond })
      .from(simBranches)
      .where(eq(simBranches.id, ROLLOUT_BRANCH_ID));
    if (!before) throw new Error("rollout branch missing");
    const skip = await legacyTimeSkip(
      jsonReq(`/api/chats/${ids.chat}/time-skip`, { amount: "hours" }),
      ctx(ids.chat),
    );
    expect(skip.status).toBe(200);

    let after = before.storySecond;
    for (let attempt = 0; attempt < 50 && after < before.storySecond + 180 * 60; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      const [row] = await db()
        .select({ storySecond: simBranches.storySecond })
        .from(simBranches)
        .where(eq(simBranches.id, ROLLOUT_BRANCH_ID));
      after = row?.storySecond ?? after;
    }
    expect(after).toBeGreaterThanOrEqual(before.storySecond + 180 * 60);
  });

  it("rules verdicts and reports only through the self-scoped admin surface", async () => {
    const legacySend = await chatSend(jsonReq(`/api/chats/${ids.legacyChat}`, { content: "hi" }), ctx(ids.legacyChat));
    expect(legacySend.status).toBe(200);
    await legacySend.text();
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(
      await db().select().from(simShadowDivergences).where(eq(simShadowDivergences.chatId, ids.legacyChat)),
    ).toHaveLength(0);

    const list = await shadowGet(new NextRequest(`http://t${shadowPath(ids.chat)}`), ctx(ids.chat));
    expect(list.status).toBe(200);
    const { rows } = (await list.json()) as { rows: { id: string; domain: string; verdict: string }[] };
    const clockRow = rows.find((row) => row.domain === "clock");
    if (!clockRow) throw new Error("clock row missing");

    const ruled = await shadowPatch(
      jsonReq(shadowPath(ids.chat), { id: clockRow.id, verdict: "intentional" }, "PATCH"),
      ctx(ids.chat),
    );
    expect(ruled.status).toBe(200);
    const [persisted] = await db()
      .select({ verdict: simShadowDivergences.verdict })
      .from(simShadowDivergences)
      .where(eq(simShadowDivergences.id, clockRow.id));
    expect(persisted?.verdict).toBe("intentional");

    const reportResponse = await shadowReport(
      new NextRequest(`http://t${shadowPath(ids.chat, "/report")}`),
      ctx(ids.chat),
    );
    expect(reportResponse.status).toBe(200);
    const { report } = (await reportResponse.json()) as {
      report: {
        totals: { rows: number; byVerdict: Record<string, number> };
        prose: { rendered: number };
        clock: { latestSuccessorClock: string | null };
      };
    };
    expect(report.totals.rows).toBeGreaterThanOrEqual(4);
    expect(report.totals.byVerdict.intentional).toBeGreaterThanOrEqual(1);
    expect(report.prose.rendered).toBeGreaterThanOrEqual(1);
    expect(report.clock.latestSuccessorClock).toContain("Day");

    const indexResponse = await shadowList(new NextRequest(`http://t${shadowPath()}`), {
      params: Promise.resolve({}),
    });
    expect(indexResponse.status).toBe(200);
    const { chats } = (await indexResponse.json()) as {
      chats: { chatId: string; characterName: string; total: number; open: number }[];
    };
    const listed = chats.find((chat) => chat.chatId === ids.chat);
    if (!listed) throw new Error("shadow chat missing from the index");
    expect(listed.characterName).toBe("Ana");
    expect(listed.open).toBeLessThan(listed.total);
    expect(chats.some((chat) => chat.chatId === ids.foreignChat)).toBe(false);

    expect(
      (await shadowGet(new NextRequest(`http://t${shadowPath(ids.foreignChat)}`), ctx(ids.foreignChat))).status,
    ).toBe(404);
    expect(
      (
        await shadowGet(
          new NextRequest(`http://t/api/admin/sim/shadow/${ids.chat}`),
          ctx(ids.chat),
        )
      ).status,
    ).toBe(404);
  });
});
