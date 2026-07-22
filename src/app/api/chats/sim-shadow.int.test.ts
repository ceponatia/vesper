import { eq, sql } from "drizzle-orm";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { characterChats, characters, db, simBranches, simShadowDivergences, simWorlds, users } from "@/server/db";

// R4 shadow mode (engine.rollout.plan.md) — a `successor_shadow` chat runs the
// legacy pipeline untouched while the detached shadow leg records divergence
// rows (prose · presence · meters · clock) against the mirror branch, legacy
// time skips mirror onto the branch clock, and the admin surface rules
// verdicts. AI_FAKE end to end — zero live model calls. Self-skips without a
// database.

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
function jsonReq(path: string, body: unknown, method = "POST"): NextRequest {
  return new NextRequest(`http://t${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Poll until the detached shadow leg has landed at least `count` rows. */
async function waitForRows(chatId: string, count: number): Promise<(typeof simShadowDivergences.$inferSelect)[]> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const rows = await db().select().from(simShadowDivergences).where(eq(simShadowDivergences.chatId, chatId));
    if (rows.length >= count) return rows;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return db().select().from(simShadowDivergences).where(eq(simShadowDivergences.chatId, chatId));
}

const ids = { chat: "", legacyChat: "", user: "" };

beforeAll(async () => {
  if (!ready) return;
  await db().delete(simWorlds).where(eq(simWorlds.id, ROLLOUT_WORLD_ID));
  const stamp = Date.now();
  const [user] = await db()
    .insert(users)
    .values({ email: `sim-shadow-${stamp}@test.local`, name: "Sim Shadow" })
    .returning();
  if (!user) throw new Error("failed to create test user");
  authState.user = { ...authState.user, id: user.id, email: user.email };
  ids.user = user.id;
  const [character] = await db()
    .insert(characters)
    .values({ ownerId: user.id, name: "Ana", profile: {} })
    .returning();
  if (!character) throw new Error("failed to seed character");
  for (const key of ["chat", "legacyChat"] as const) {
    const res = await chatsCreate(
      jsonReq("/api/chats", { characterIds: [character.id], memory: "fresh" }),
      { params: Promise.resolve({}) },
    );
    if (res.status !== 201) throw new Error(`chat create failed: ${res.status}`);
    ids[key] = ((await res.json()) as { id: string }).id;
  }
  await seedRolloutTestWorld();
  await setChatEngineAuthority({
    chatId: ids.chat,
    byUserId: ids.user,
    authority: "successor_shadow",
    simBranchId: ROLLOUT_BRANCH_ID,
    simPlayerActorId: ROLLOUT_ACTORS.mara,
    simPrimaryActorId: ROLLOUT_ACTORS.ana,
  });
});

afterAll(async () => {
  if (!ready || !ids.user) return;
  await db().delete(simWorlds).where(eq(simWorlds.id, ROLLOUT_WORLD_ID));
  await db().delete(characterChats).where(eq(characterChats.ownerId, ids.user));
  await db().delete(characters).where(eq(characters.ownerId, ids.user));
  await db().delete(users).where(eq(users.id, ids.user));
});

describe.runIf(ready)("R4 shadow mode under chat", () => {
  it("records divergence rows for a shadowed exchange while the chat lane stays legacy", async () => {
    const send = await chatSend(jsonReq(`/api/chats/${ids.chat}`, { content: "Good morning, Ana." }), ctx(ids.chat));
    expect(send.status).toBe(200);
    const prose = await send.text();
    // The LEGACY lane answered (demo mode), not the successor's plain-chunk shape.
    expect(prose).toContain("Demo mode");

    const rows = await waitForRows(ids.chat, 4);
    const domains = rows.map((row) => row.domain).sort();
    expect(domains).toEqual(["clock", "meters", "presence", "prose"]);
    const proseRow = rows.find((row) => row.domain === "prose");
    // The successor rendered its OWN prose from the same utterance (AI_FAKE
    // deterministic fallback) — and none of it touched the transcript.
    expect(JSON.stringify(proseRow?.successor)).toContain("rendered");
    expect(rows.every((row) => row.verdict === "open")).toBe(true);
  });

  it("mirrors a legacy time skip onto the shadow branch clock", async () => {
    const [before] = await db()
      .select({ storySecond: simBranches.storySecond })
      .from(simBranches)
      .where(eq(simBranches.id, ROLLOUT_BRANCH_ID));
    if (!before) throw new Error("rollout branch missing");
    const skip = await legacyTimeSkip(jsonReq(`/api/chats/${ids.chat}/time-skip`, { amount: "hours" }), ctx(ids.chat));
    expect(skip.status).toBe(200);
    // The mirror advance is detached — poll the branch clock.
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

  it("stays silent for legacy chats and rules verdicts through the admin surface", async () => {
    const send = await chatSend(jsonReq(`/api/chats/${ids.legacyChat}`, { content: "hi" }), ctx(ids.legacyChat));
    expect(send.status).toBe(200);
    await send.text();
    await new Promise((resolve) => setTimeout(resolve, 500));
    const legacyRows = await db()
      .select()
      .from(simShadowDivergences)
      .where(eq(simShadowDivergences.chatId, ids.legacyChat));
    expect(legacyRows).toHaveLength(0);

    const list = await shadowGet(
      new NextRequest(`http://t/api/admin/sim/shadow/${ids.chat}`),
      ctx(ids.chat),
    );
    expect(list.status).toBe(200);
    const { rows } = (await list.json()) as { rows: { id: string; domain: string; verdict: string }[] };
    expect(rows.length).toBeGreaterThanOrEqual(4);
    const clockRow = rows.find((row) => row.domain === "clock");
    if (!clockRow) throw new Error("clock row missing");
    const ruled = await shadowPatch(
      jsonReq(`/api/admin/sim/shadow/${ids.chat}`, { id: clockRow.id, verdict: "intentional" }, "PATCH"),
      ctx(ids.chat),
    );
    expect(ruled.status).toBe(200);
    const [persisted] = await db()
      .select({ verdict: simShadowDivergences.verdict })
      .from(simShadowDivergences)
      .where(eq(simShadowDivergences.id, clockRow.id));
    expect(persisted?.verdict).toBe("intentional");

    // The computed parity report (slice 2): totals over the recorded rows,
    // ruled rows counted but out of findings.
    const reportRes = await shadowReport(
      new NextRequest(`http://t/api/admin/sim/shadow/${ids.chat}/report`),
      ctx(ids.chat),
    );
    expect(reportRes.status).toBe(200);
    const { report } = (await reportRes.json()) as {
      report: {
        totals: { rows: number; byVerdict: Record<string, number> };
        prose: { pairs: number; rendered: number };
        clock: { latestSuccessorClock: string | null };
      };
    };
    expect(report.totals.rows).toBeGreaterThanOrEqual(4);
    expect(report.totals.byVerdict.intentional).toBeGreaterThanOrEqual(1);
    expect(report.prose.rendered).toBeGreaterThanOrEqual(1);
    expect(report.clock.latestSuccessorClock).toContain("Day");

    // The index (the admin screen's front page): this chat listed with counts.
    const listRes = await shadowList(new NextRequest("http://t/api/admin/sim/shadow"), {
      params: Promise.resolve({}),
    });
    expect(listRes.status).toBe(200);
    const { chats } = (await listRes.json()) as {
      chats: { chatId: string; characterName: string; total: number; open: number }[];
    };
    const listed = chats.find((chat) => chat.chatId === ids.chat);
    if (!listed) throw new Error("shadow chat missing from the index");
    expect(listed.characterName).toBe("Ana");
    expect(listed.total).toBeGreaterThanOrEqual(4);
    expect(listed.open).toBeLessThan(listed.total); // one row was ruled intentional above
  });
});
