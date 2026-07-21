import { and, eq, sql } from "drizzle-orm";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  characterChatMessages,
  characterChats,
  characters,
  db,
  simItemHoldings,
  simWorlds,
  users,
} from "@/server/db";

// R3 slices 1–2 (engine.rollout.plan.md) — the sim routes under /chat/: the
// gate (409 for unrouted chats), one full turn through prepare → render
// (AI_FAKE demo fallback; zero live calls) landing in the transcript, and
// typed player commands with §14.4 public-face refusals. Self-skips without
// a database.

process.env.AI_FAKE = "1";

const authState = vi.hoisted(() => ({
  user: { id: "", email: "", name: "Sim Routes Int", role: "user" as "admin" | "user" },
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
  ROLLOUT_KEEPSAKE_ID,
  ROLLOUT_REST_ACTION_ID,
  ROLLOUT_WORLD_ID,
  ROLLOUT_ZONES,
  seedRolloutTestWorld,
  setChatEngineAuthority,
} from "@/server/engine";
import { POST as chatsCreate } from "./route";
import { POST as simCommand } from "./[chatId]/sim-command/route";
import { POST as simTurn } from "./[chatId]/sim-turn/route";

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
      `[sim-routes.int.test] skipping: database unreachable: ${err instanceof Error ? err.message : String(err)}\n`,
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

const ids = { chat: "", user: "" };

beforeAll(async () => {
  if (!ready) return;
  await db().delete(simWorlds).where(eq(simWorlds.id, ROLLOUT_WORLD_ID));
  const stamp = Date.now();
  const [user] = await db()
    .insert(users)
    .values({ email: `sim-routes-${stamp}@test.local`, name: "Sim Routes" })
    .returning();
  if (!user) throw new Error("failed to create test user");
  authState.user = { ...authState.user, id: user.id, email: user.email };
  ids.user = user.id;
  const [character] = await db()
    .insert(characters)
    .values({ ownerId: user.id, name: "Ana", profile: {} })
    .returning();
  if (!character) throw new Error("failed to seed character");
  const res = await chatsCreate(
    jsonReq("/api/chats", { characterIds: [character.id], memory: "fresh" }),
    { params: Promise.resolve({}) },
  );
  if (res.status !== 201) throw new Error(`chat create failed: ${res.status}`);
  ids.chat = ((await res.json()) as { id: string }).id;
  await seedRolloutTestWorld();
});

afterAll(async () => {
  if (!ready || !ids.user) return;
  await db().delete(simWorlds).where(eq(simWorlds.id, ROLLOUT_WORLD_ID));
  await db().delete(characterChats).where(eq(characterChats.ownerId, ids.user));
  await db().delete(characters).where(eq(characters.ownerId, ids.user));
  await db().delete(users).where(eq(users.id, ids.user));
});

describe.runIf(ready)("R3 sim routes under /chat/", () => {
  it("gates unrouted chats, runs a full turn into the transcript, and admits typed commands", async () => {
    // Unrouted: the gate holds.
    const gated = await simTurn(jsonReq(`/api/chats/${ids.chat}/sim-turn`, { message: "hello" }), ctx(ids.chat));
    expect(gated.status).toBe(409);

    // Route the chat to the successor view lane with the Mara/Ana mapping.
    const flipped = await setChatEngineAuthority({
      chatId: ids.chat,
      byUserId: ids.user,
      authority: "successor_narrative_view",
      simBranchId: ROLLOUT_BRANCH_ID,
      simPlayerActorId: ROLLOUT_ACTORS.mara,
      simPrimaryActorId: ROLLOUT_ACTORS.ana,
    });
    expect(flipped?.after.authority).toBe("successor_narrative_view");

    // One full turn: player line + narrated assistant line in the transcript.
    const turn = await simTurn(
      jsonReq(`/api/chats/${ids.chat}/sim-turn`, { message: "I look around the kitchen." }),
      ctx(ids.chat),
    );
    expect(turn.status).toBe(200);
    const turnBody = (await turn.json()) as { prose: string; degraded: boolean; cutId: string };
    expect(turnBody.degraded).toBe(true); // AI_FAKE: the deterministic fallback rendered
    expect(turnBody.prose.length).toBeGreaterThan(0);
    const messages = await db()
      .select({ role: characterChatMessages.role, meta: characterChatMessages.meta })
      .from(characterChatMessages)
      .where(eq(characterChatMessages.chatId, ids.chat));
    expect(messages.filter((row) => row.role === "user")).toHaveLength(1);
    const assistant = messages.filter((row) => row.role === "assistant");
    expect(assistant).toHaveLength(1);
    expect(assistant[0]?.meta).toMatchObject({ simTurn: true, cutId: turnBody.cutId });

    // give_item: not-held is the public face; the held keepsake transfers.
    const notHeld = await simCommand(
      jsonReq(`/api/chats/${ids.chat}/sim-command`, { kind: "give_item", itemId: "rollout-item-loaf" }),
      ctx(ids.chat),
    );
    expect(notHeld.status).toBe(409);
    expect(await notHeld.json()).toMatchObject({ status: "rejected", code: "not_held" });
    const gave = await simCommand(
      jsonReq(`/api/chats/${ids.chat}/sim-command`, { kind: "give_item", itemId: ROLLOUT_KEEPSAKE_ID }),
      ctx(ids.chat),
    );
    expect(gave.status).toBe(200);
    const [holding] = await db()
      .select({ actorId: simItemHoldings.actorId })
      .from(simItemHoldings)
      .where(
        and(eq(simItemHoldings.branchId, ROLLOUT_BRANCH_ID), eq(simItemHoldings.itemId, ROLLOUT_KEEPSAKE_ID)),
      );
    expect(holding?.actorId).toBe(ROLLOUT_ACTORS.ana);

    // End the scene, rest at home, and hit the claim law moving mid-rest —
    // a §14.4 public refusal with a reason, never a private cause.
    const ended = await simCommand(jsonReq(`/api/chats/${ids.chat}/sim-command`, { kind: "end_scene" }), ctx(ids.chat));
    expect(ended.status).toBe(200);
    const rested = await simCommand(
      jsonReq(`/api/chats/${ids.chat}/sim-command`, { kind: "start_activity", actionDefinitionId: ROLLOUT_REST_ACTION_ID }),
      ctx(ids.chat),
    );
    expect(rested.status).toBe(200);
    const blocked = await simCommand(
      jsonReq(`/api/chats/${ids.chat}/sim-command`, { kind: "move", toZoneId: ROLLOUT_ZONES.square }),
      ctx(ids.chat),
    );
    expect(blocked.status).toBe(409);
    const blockedBody = (await blocked.json()) as { status: string; code: string; publicReason?: string };
    expect(blockedBody).toMatchObject({ status: "rejected", code: "activity_conflict" });
    expect(blockedBody.publicReason?.length ?? 0).toBeGreaterThan(0);
  });
});
