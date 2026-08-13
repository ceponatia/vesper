import { eq } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { newId } from "@/lib/ids";
import { characterChats, characters, chatParticipants, db, simBranches, simShadowDivergences } from "@/server/db";

const authState = vi.hoisted(() => ({
  user: { id: "", email: "", name: "Sim Shadow Int", role: "admin" as const },
}));

vi.mock("@/server/auth", async () => (await import("@/server/test-support")).routeAuthModule(authState));

import { ROLLOUT_BRANCH_ID } from "@/server/engine";
import {
  apiRequest,
  drainStream,
  dropRoutedSimChat,
  emptyRoutedSimChat,
  expectJson,
  probeIntegrationDb,
  routeCtx,
  routeSimChat,
  seedRoutedSimChat,
  seedTestUser,
} from "@/server/test-support";
import { POST as chatsCreate } from "./route";
import { POST as chatSend } from "./[chatId]/route";
import { POST as legacyTimeSkip } from "./[chatId]/time-skip/route";
import { GET as shadowList } from "../admin/sim/shadow/route";
import { GET as shadowGet, PATCH as shadowPatch } from "../admin/sim/shadow/[chatId]/route";
import { GET as shadowReport } from "../admin/sim/shadow/[chatId]/report/route";

const ready = await probeIntegrationDb("sim-shadow.int.test", "sim_shadow_divergences");

const ctx = (chatId: string) => routeCtx({ chatId });
const shadowPath = (chatId?: string, suffix = "") =>
  `/api/admin/self/sim/shadow${chatId ? `/${chatId}` : ""}${suffix}`;
const jsonReq = (path: string, body: unknown, method = "POST"): NextRequest => apiRequest(path, { method, body });

async function waitForRows(chatId: string, count: number): Promise<(typeof simShadowDivergences.$inferSelect)[]> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const rows = await db().select().from(simShadowDivergences).where(eq(simShadowDivergences.chatId, chatId));
    if (rows.length >= count) return rows;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return db().select().from(simShadowDivergences).where(eq(simShadowDivergences.chatId, chatId));
}

const ids = { chat: "", legacyChat: "", foreignUser: "", foreignChat: "" };
let fixture = emptyRoutedSimChat(chatsCreate);

beforeAll(async () => {
  if (!ready) return;
  // Two conversations off one character: `chat` is shadowed below, `legacyChat`
  // stays legacy so the suite can prove nothing is recorded for it.
  fixture = await seedRoutedSimChat({ slug: "sim-shadow", authState, chatsCreate, chats: 2 });
  ids.chat = fixture.chatIds[0] ?? "";
  ids.legacyChat = fixture.chatIds[1] ?? "";

  const foreignUser = await seedTestUser("sim-shadow-foreign", { name: "Foreign Shadow" });
  ids.foreignUser = foreignUser.id;
  const [foreignCharacter] = await db()
    .insert(characters)
    .values({ ownerId: foreignUser.id, name: "Foreign Ana", profile: {} })
    .returning();
  if (!foreignCharacter) throw new Error("failed to seed the foreign character");
  const [foreignChat] = await db()
    .insert(characterChats)
    .values({ ownerId: foreignUser.id })
    .returning({ id: characterChats.id });
  if (!foreignChat) throw new Error("failed to seed foreign chat");
  ids.foreignChat = foreignChat.id;
  await db()
    .insert(chatParticipants)
    .values({ chatId: foreignChat.id, characterId: foreignCharacter.id, memoryGroupId: newId() });

  await routeSimChat({ chatId: ids.chat, byUserId: fixture.userId, authority: "successor_shadow" });

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
  await dropRoutedSimChat(fixture, { ownerIds: [ids.foreignUser] });
});

describe.runIf(ready)("R4 shadow mode under chat", () => {
  it("records divergence rows for a shadowed exchange while the chat lane stays legacy", async () => {
    const send = await chatSend(jsonReq(`/api/chats/${ids.chat}`, { content: "Good morning, Ana." }), ctx(ids.chat));
    expect(send.status).toBe(200);
    expect(await drainStream(send)).toContain("Demo mode");

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
    await drainStream(legacySend);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(
      await db().select().from(simShadowDivergences).where(eq(simShadowDivergences.chatId, ids.legacyChat)),
    ).toHaveLength(0);

    const list = await shadowGet(apiRequest(shadowPath(ids.chat)), ctx(ids.chat));
    const { rows } = await expectJson<{ rows: { id: string; domain: string; verdict: string }[] }>(list, 200);
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

    const reportResponse = await shadowReport(apiRequest(shadowPath(ids.chat, "/report")), ctx(ids.chat));
    const { report } = await expectJson<{
      report: {
        totals: { rows: number; byVerdict: Record<string, number> };
        prose: { rendered: number };
        clock: { latestSuccessorClock: string | null };
      };
    }>(reportResponse, 200);
    expect(report.totals.rows).toBeGreaterThanOrEqual(4);
    expect(report.totals.byVerdict.intentional).toBeGreaterThanOrEqual(1);
    expect(report.prose.rendered).toBeGreaterThanOrEqual(1);
    expect(report.clock.latestSuccessorClock).toContain("Day");

    const indexResponse = await shadowList(apiRequest(shadowPath()), routeCtx());
    const { chats } = await expectJson<{
      chats: { chatId: string; characterName: string; total: number; open: number }[];
    }>(indexResponse, 200);
    const listed = chats.find((chat) => chat.chatId === ids.chat);
    if (!listed) throw new Error("shadow chat missing from the index");
    expect(listed.characterName).toBe("Ana");
    expect(listed.open).toBeLessThan(listed.total);
    expect(chats.some((chat) => chat.chatId === ids.foreignChat)).toBe(false);

    expect((await shadowGet(apiRequest(shadowPath(ids.foreignChat)), ctx(ids.foreignChat))).status).toBe(404);
    expect((await shadowGet(apiRequest(`/api/admin/sim/shadow/${ids.chat}`), ctx(ids.chat))).status).toBe(404);
  });
});
