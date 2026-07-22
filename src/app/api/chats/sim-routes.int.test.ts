import { and, eq, sql } from "drizzle-orm";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  characterChatMessages,
  characterChats,
  characters,
  db,
  simBranches,
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
import { POST as chatSend } from "./[chatId]/route";
import { POST as simCommand } from "./[chatId]/sim-command/route";
import { POST as simTurn } from "./[chatId]/sim-turn/route";
import { GET as stateGet } from "./[chatId]/state/route";
import { POST as legacyTimeSkip } from "./[chatId]/time-skip/route";

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

const ids = { chat: "", user: "", characterId: "" };

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
  ids.characterId = character.id;
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

    // The ADMISSION WIRING: the ordinary send endpoint — the one the chat UI
    // (mobile included) actually calls — forks the same message into the
    // successor lane for a routed chat, returning plain text and landing
    // both lines in the transcript.
    const uiSend = await chatSend(
      jsonReq(`/api/chats/${ids.chat}`, { kind: "send", content: "I stretch and glance out the window." }),
      ctx(ids.chat),
    );
    expect(uiSend.status).toBe(200);
    expect(uiSend.headers.get("content-type")).toContain("text/plain");
    const uiProse = await uiSend.text();
    expect(uiProse.length).toBeGreaterThan(0);
    const afterUiSend = await db()
      .select({ role: characterChatMessages.role })
      .from(characterChatMessages)
      .where(eq(characterChatMessages.chatId, ids.chat));
    expect(afterUiSend.filter((row) => row.role === "user")).toHaveLength(2);
    expect(afterUiSend.filter((row) => row.role === "assistant")).toHaveLength(2);

    // A SECOND chat mapped to the same actor pair must FIND the standing
    // scene, not fight the claim law for a chat-scoped new one (the R3
    // live-session bug: every send was refused participant_already_engaged
    // and the player's line silently vanished).
    const res2 = await chatsCreate(
      jsonReq("/api/chats", { characterIds: [ids.characterId], memory: "fresh" }),
      { params: Promise.resolve({}) },
    );
    expect(res2.status).toBe(201);
    const chat2 = ((await res2.json()) as { id: string }).id;
    await setChatEngineAuthority({
      chatId: chat2,
      byUserId: ids.user,
      authority: "successor_narrative_view",
      simBranchId: ROLLOUT_BRANCH_ID,
      simPlayerActorId: ROLLOUT_ACTORS.mara,
      simPrimaryActorId: ROLLOUT_ACTORS.ana,
    });
    const secondChatSend = await chatSend(
      jsonReq(`/api/chats/${chat2}`, { kind: "send", content: "I wave from the doorway." }),
      ctx(chat2),
    );
    expect(secondChatSend.status).toBe(200);
    expect((await secondChatSend.text()).replace(/\u200B/g, "").length).toBeGreaterThan(0);
    const chat2Messages = await db()
      .select({ role: characterChatMessages.role })
      .from(characterChatMessages)
      .where(eq(characterChatMessages.chatId, chat2));
    expect(chat2Messages.filter((row) => row.role === "user")).toHaveLength(1);
    expect(chat2Messages.filter((row) => row.role === "assistant")).toHaveLength(1);

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

    // Ending the scene must not strand the pair: the next send opens a FRESH
    // engagement (the head-scoped open command) instead of deduping into the
    // ended one — and ending THAT scene resolves the live engagement, not a
    // chat-derived id.
    const reopened = await simTurn(
      jsonReq(`/api/chats/${ids.chat}/sim-turn`, { message: "Wait — one more thing." }),
      ctx(ids.chat),
    );
    expect(reopened.status).toBe(200);
    const reEnded = await simCommand(jsonReq(`/api/chats/${ids.chat}/sim-command`, { kind: "end_scene" }), ctx(ids.chat));
    expect(reEnded.status).toBe(200);

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

    // A refused scene open (rest holds full attention) keeps the player's
    // line and records the public-faced failure for the client popup —
    // never a silent delete (the vanishing-message half of the R3 bug).
    const before = await db()
      .select({ role: characterChatMessages.role })
      .from(characterChatMessages)
      .where(eq(characterChatMessages.chatId, ids.chat));
    const refusedSend = await chatSend(
      jsonReq(`/api/chats/${ids.chat}`, { kind: "send", content: "Are you asleep?" }),
      ctx(ids.chat),
    );
    expect(refusedSend.status).toBe(200);
    expect((await refusedSend.text()).replace(/\u200B/g, "")).toBe("");
    const after = await db()
      .select({ role: characterChatMessages.role })
      .from(characterChatMessages)
      .where(eq(characterChatMessages.chatId, ids.chat));
    expect(after.filter((row) => row.role === "user")).toHaveLength(before.filter((row) => row.role === "user").length + 1);
    expect(after.filter((row) => row.role === "assistant")).toHaveLength(before.filter((row) => row.role === "assistant").length);
    const [chatRow] = await db()
      .select({ lastReplyFailure: characterChats.lastReplyFailure })
      .from(characterChats)
      .where(eq(characterChats.id, ids.chat));
    expect(JSON.stringify(chatRow?.lastReplyFailure ?? null)).toContain("the scene could not open");

    // R3 slice 4 (ruling 17): the player's time skip — advance_time drains the
    // bounded story-time advance (completing the rest above), the state
    // envelope carries the WORLD clock, and the next send opens fresh.
    const [beforeAdvance] = await db()
      .select({ storySecond: simBranches.storySecond })
      .from(simBranches)
      .where(eq(simBranches.id, ROLLOUT_BRANCH_ID));
    if (!beforeAdvance) throw new Error("rollout branch missing");
    const advanced = await simCommand(
      jsonReq(`/api/chats/${ids.chat}/sim-command`, { kind: "advance_time", minutes: 720 }),
      ctx(ids.chat),
    );
    expect(advanced.status).toBe(200);
    const advancedBody = (await advanced.json()) as { status: string; toStorySecond: number };
    expect(advancedBody.status).toBe("advanced");
    expect(advancedBody.toStorySecond).toBe(beforeAdvance.storySecond + 720 * 60);
    const stateRes = await stateGet(new NextRequest(`http://t/api/chats/${ids.chat}/state`), ctx(ids.chat));
    expect(stateRes.status).toBe(200);
    const stateBody = (await stateRes.json()) as { simClock: number | null };
    expect(stateBody.simClock).toBe(advancedBody.toStorySecond);
    const afterSkipSend = await chatSend(
      jsonReq(`/api/chats/${ids.chat}`, { kind: "send", content: "That was a good rest." }),
      ctx(ids.chat),
    );
    expect(afterSkipSend.status).toBe(200);
    expect((await afterSkipSend.text()).replace(/\u200B/g, "").length).toBeGreaterThan(0);

    // The legacy time-skip lane is closed for a routed chat — lanes stay separate.
    const legacySkip = await legacyTimeSkip(
      jsonReq(`/api/chats/${ids.chat}/time-skip`, { amount: "hours" }),
      ctx(ids.chat),
    );
    expect(legacySkip.status).toBe(409);
  });
});
