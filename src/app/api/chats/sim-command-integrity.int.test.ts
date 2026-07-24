import { and, eq, sql } from "drizzle-orm";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { composeSimulationId } from "@/contracts/simulation/identity";
import { simulationHash } from "@/lib/simulation";
import {
  characterChatMessages,
  characterChats,
  characters,
  db,
  simBranches,
  simCommandRequests,
  simWorlds,
  users,
} from "@/server/db";
import { log } from "@/server/log";

// command-integrity.plan.md A1 (slices 1, 3, 4) — the per-chat lock, the
// holder-labelled busy face, and the `(chatId, requestId)` idempotency replay
// record. Every command is serialized under `chat_exchange:<chatId>`; a retry of
// the same request replays the recorded response verbatim (one drain, one beat);
// a crash mid-composition resumes through the request-derived step + beat ids.
// Self-skips without a database (AI_FAKE keeps it zero live model calls).

process.env.AI_FAKE = "1";

const authState = vi.hoisted(() => ({
  user: { id: "", email: "", name: "Cmd Integrity Int", role: "user" as "admin" | "user" },
}));

vi.mock("@/server/auth", () => ({
  USER_COOKIE: "vesper_user",
  getCurrentUser: async () => authState.user,
  ensureDefaultUser: async () => authState.user,
  listUsers: async () => [authState.user],
}));

import {
  CHAT_LOCK_LABEL_REPLY,
  CHAT_LOCK_LABEL_WORLD,
  ROLLOUT_ACTORS,
  ROLLOUT_BRANCH_ID,
  ROLLOUT_WORLD_ID,
  ROLLOUT_ZONES,
  drainBranchTo,
  moveArrivalTarget,
  readDurableSpaceBranch,
  seedRolloutTestWorld,
  setChatEngineAuthority,
  submitDurableMoveActor,
  tryKeyedLock,
  writeWorldBeat,
} from "@/server/engine";
import { POST as chatsCreate } from "./route";
import { POST as simCommand } from "./[chatId]/sim-command/route";

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
      `[sim-command-integrity.int.test] skipping: database unreachable: ${err instanceof Error ? err.message : String(err)}\n`,
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

const ids = { user: "", characterId: "" };

/** A fresh successor chat mapped to the shared rollout branch (Mara player / Ana primary). */
async function freshChat(): Promise<string> {
  const res = await chatsCreate(
    jsonReq("/api/chats", { characterIds: [ids.characterId], memory: "fresh" }),
    { params: Promise.resolve({}) },
  );
  if (res.status !== 201) throw new Error(`chat create failed: ${res.status}`);
  const chat = ((await res.json()) as { id: string }).id;
  await setChatEngineAuthority({
    chatId: chat,
    byUserId: ids.user,
    authority: "successor_narrative_view",
    simBranchId: ROLLOUT_BRANCH_ID,
    simPlayerActorId: ROLLOUT_ACTORS.mara,
    simPrimaryActorId: ROLLOUT_ACTORS.ana,
  });
  return chat;
}

async function clock(): Promise<number> {
  const [row] = await db()
    .select({ storySecond: simBranches.storySecond })
    .from(simBranches)
    .where(eq(simBranches.id, ROLLOUT_BRANCH_ID))
    .limit(1);
  return row?.storySecond ?? 0;
}

async function maraZone(): Promise<string | null> {
  const space = await readDurableSpaceBranch(ROLLOUT_BRANCH_ID);
  const locus = space.loci.find((l) => l.actorId === ROLLOUT_ACTORS.mara);
  return locus?.kind === "at" ? locus.zoneId : null;
}

async function beatsOfKind(chatId: string, kind: string): Promise<number> {
  const rows = await db()
    .select({ meta: characterChatMessages.meta })
    .from(characterChatMessages)
    .where(eq(characterChatMessages.chatId, chatId));
  return rows.filter((r) => (r.meta as { worldBeat?: { kind?: string } } | null)?.worldBeat?.kind === kind).length;
}

async function requestRow(chatId: string, requestId: string) {
  const [row] = await db()
    .select()
    .from(simCommandRequests)
    .where(and(eq(simCommandRequests.chatId, chatId), eq(simCommandRequests.requestId, requestId)))
    .limit(1);
  return row;
}

/** A player-principal move envelope with a caller-chosen id (to pre-seed a crash remnant). */
function moveEnvelope(chatId: string, commandId: string, toZoneId: string) {
  return {
    id: commandId,
    branchId: ROLLOUT_BRANCH_ID,
    expectedVersion: 0,
    idempotencyKey: commandId,
    principal: { kind: "player" as const, principalId: ids.user, controlledActorIds: [ROLLOUT_ACTORS.mara] },
    submittedAtWallClock: new Date().toISOString(),
    correlationId: `sim-${chatId}`,
    schemaVersion: 1,
    type: "move_actor" as const,
    payload: { actorId: ROLLOUT_ACTORS.mara, destinationZoneId: toZoneId, travelMode: "walk" as const },
  };
}

beforeAll(async () => {
  if (!ready) return;
  await db().delete(simWorlds).where(eq(simWorlds.id, ROLLOUT_WORLD_ID));
  const stamp = Date.now();
  const [user] = await db()
    .insert(users)
    .values({ email: `cmd-integrity-${stamp}@test.local`, name: "Cmd Integrity" })
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
});

// Each test starts from a freshly-seeded world (Mara/Ana co-present at home, Day 2 10:00).
beforeEach(async () => {
  if (!ready) return;
  await db().delete(simWorlds).where(eq(simWorlds.id, ROLLOUT_WORLD_ID));
  await seedRolloutTestWorld();
});

afterAll(async () => {
  if (!ready || !ids.user) return;
  await db().delete(simWorlds).where(eq(simWorlds.id, ROLLOUT_WORLD_ID));
  await db().delete(characterChats).where(eq(characterChats.ownerId, ids.user));
  await db().delete(characters).where(eq(characters.ownerId, ids.user));
  await db().delete(users).where(eq(users.id, ids.user));
});

describe.runIf(ready)("command-integrity A1: lock + busy face + idempotency", () => {
  // Slice 1 (A1-1/A1-2): the per-chat lock serializes; contention bounces.
  it("serializes concurrent travels — one lands, one bounces chat_busy, the world advances once", async () => {
    const chat = await freshChat();
    const [a, b] = await Promise.all([
      simCommand(
        jsonReq(`/api/chats/${chat}/sim-command`, { kind: "travel", toZoneId: ROLLOUT_ZONES.square, requestId: "conc-a" }),
        ctx(chat),
      ),
      simCommand(
        jsonReq(`/api/chats/${chat}/sim-command`, { kind: "travel", toZoneId: ROLLOUT_ZONES.square, requestId: "conc-b" }),
        ctx(chat),
      ),
    ]);
    expect([a, b].filter((r) => r.status === 200)).toHaveLength(1);
    expect([a, b].filter((r) => r.status === 409)).toHaveLength(1);
    const landed = [a, b].find((r) => r.status === 200);
    const bounced = [a, b].find((r) => r.status === 409);
    if (!landed || !bounced) throw new Error("expected exactly one landed + one bounced");
    expect(((await bounced.json()) as { error: { code: string } }).error.code).toBe("chat_busy");
    expect(((await landed.json()) as { status: string }).status).toBe("traveled");
    // Exactly one drain / one beat: the loser never ran.
    expect(await beatsOfKind(chat, "traveled")).toBe(1);
    expect(await maraZone()).toBe(ROLLOUT_ZONES.square);
  });

  // Slice 3 (A2-2): the busy copy names its cause from the current lock holder's label.
  it("names a streaming reply vs. a world catch-up in the busy face", async () => {
    const replyChat = await freshChat();
    let releaseReply!: () => void;
    const replyHeld = tryKeyedLock(
      `chat_exchange:${replyChat}`,
      () => new Promise<void>((r) => (releaseReply = r)),
      CHAT_LOCK_LABEL_REPLY,
    );
    expect(replyHeld).not.toBeNull();
    const duringReply = await simCommand(
      jsonReq(`/api/chats/${replyChat}/sim-command`, { kind: "advance_time", minutes: 30, requestId: "busy-reply" }),
      ctx(replyChat),
    );
    expect(duringReply.status).toBe(409);
    const replyBody = (await duringReply.json()) as { error: { code: string; message: string } };
    expect(replyBody.error.code).toBe("chat_busy");
    expect(replyBody.error.message).toContain("reply");
    releaseReply();
    await replyHeld;

    const worldChat = await freshChat();
    let releaseWorld!: () => void;
    const worldHeld = tryKeyedLock(
      `chat_exchange:${worldChat}`,
      () => new Promise<void>((r) => (releaseWorld = r)),
      CHAT_LOCK_LABEL_WORLD,
    );
    expect(worldHeld).not.toBeNull();
    const duringWorld = await simCommand(
      jsonReq(`/api/chats/${worldChat}/sim-command`, { kind: "advance_time", minutes: 30, requestId: "busy-world" }),
      ctx(worldChat),
    );
    expect(duringWorld.status).toBe(409);
    expect(((await duringWorld.json()) as { error: { message: string } }).error.message).toContain("catching up");
    releaseWorld();
    await worldHeld;
  });

  // Slice 4: a same-requestId resubmit replays the recorded response (one advance, one beat);
  // a fresh requestId applies again.
  it("replays a same-requestId advance_time and applies a fresh one", async () => {
    const chat = await freshChat();
    const origin = await clock();

    const first = await simCommand(
      jsonReq(`/api/chats/${chat}/sim-command`, { kind: "advance_time", minutes: 30, requestId: "adv-1" }),
      ctx(chat),
    );
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { status: string; toStorySecond: number };
    expect(firstBody.status).toBe("advanced");
    expect(firstBody.toStorySecond).toBe(origin + 30 * 60);
    expect(await clock()).toBe(origin + 30 * 60);

    // Same requestId + payload → verbatim replay, no second advance, no second beat.
    const replay = await simCommand(
      jsonReq(`/api/chats/${chat}/sim-command`, { kind: "advance_time", minutes: 30, requestId: "adv-1" }),
      ctx(chat),
    );
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(firstBody);
    expect(await clock()).toBe(origin + 30 * 60);
    expect(await beatsOfKind(chat, "time_skipped")).toBe(1);

    // A fresh requestId is a genuine new action — it advances again.
    const fresh = await simCommand(
      jsonReq(`/api/chats/${chat}/sim-command`, { kind: "advance_time", minutes: 30, requestId: "adv-2" }),
      ctx(chat),
    );
    expect(fresh.status).toBe(200);
    expect(await clock()).toBe(origin + 60 * 60);
    expect(await beatsOfKind(chat, "time_skipped")).toBe(2);
  });

  it("replays a same-requestId travel (one journey, one beat)", async () => {
    const chat = await freshChat();
    const first = await simCommand(
      jsonReq(`/api/chats/${chat}/sim-command`, { kind: "travel", toZoneId: ROLLOUT_ZONES.square, requestId: "trav-1" }),
      ctx(chat),
    );
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { status: string };
    expect(firstBody.status).toBe("traveled");
    expect(await maraZone()).toBe(ROLLOUT_ZONES.square);

    const replay = await simCommand(
      jsonReq(`/api/chats/${chat}/sim-command`, { kind: "travel", toZoneId: ROLLOUT_ZONES.square, requestId: "trav-1" }),
      ctx(chat),
    );
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(firstBody);
    expect(await beatsOfKind(chat, "traveled")).toBe(1);
    expect(await maraZone()).toBe(ROLLOUT_ZONES.square);
  });

  it("rejects a reused requestId carrying a different payload (idempotency_mismatch)", async () => {
    const chat = await freshChat();
    const origin = await clock();
    const first = await simCommand(
      jsonReq(`/api/chats/${chat}/sim-command`, { kind: "advance_time", minutes: 30, requestId: "mm-1" }),
      ctx(chat),
    );
    expect(first.status).toBe(200);
    expect(await clock()).toBe(origin + 30 * 60);

    const mismatch = await simCommand(
      jsonReq(`/api/chats/${chat}/sim-command`, { kind: "advance_time", minutes: 90, requestId: "mm-1" }),
      ctx(chat),
    );
    expect(mismatch.status).toBe(409);
    expect(((await mismatch.json()) as { error: { code: string } }).error.code).toBe("idempotency_mismatch");
    // The mismatched resubmit never executed — the clock only moved once.
    expect(await clock()).toBe(origin + 30 * 60);
  });

  // Crash-point: after the move committed but before the beat / completed-record — the retry
  // resumes through the cached move step and converges to one move / one beat / one response.
  it("resumes a mid-composition crash through the cached travel-move step", async () => {
    const chat = await freshChat();
    const requestId = "crash-move";
    const moveStepId = composeSimulationId("sim-command", [chat, requestId, "travel-move"]);
    // Simulate the crash: the move sub-command committed under its request-derived id, and the
    // `started` record was written, but the process died before the drain / beat / completed.
    const pre = await submitDurableMoveActor(moveEnvelope(chat, moveStepId, ROLLOUT_ZONES.square), {
      admitAtLockedVersion: true,
    });
    expect(pre.status).toBe("accepted");
    await db()
      .insert(simCommandRequests)
      .values({
        chatId: chat,
        requestId,
        kind: "travel",
        payloadHash: simulationHash({ kind: "travel", toZoneId: ROLLOUT_ZONES.square }),
        state: "started",
      });

    const retry = await simCommand(
      jsonReq(`/api/chats/${chat}/sim-command`, { kind: "travel", toZoneId: ROLLOUT_ZONES.square, requestId }),
      ctx(chat),
    );
    expect(retry.status).toBe(200);
    expect(((await retry.json()) as { status: string }).status).toBe("traveled");
    expect(await maraZone()).toBe(ROLLOUT_ZONES.square);
    expect(await beatsOfKind(chat, "traveled")).toBe(1);
    expect((await requestRow(chat, requestId))?.state).toBe("completed");
  });

  // Crash-point: after the move + drain + beat but before the completed-record — the retry
  // dedupes the beat at the insert and re-records, still exactly one beat.
  it("dedupes the beat at the insert when a crash lands after the beat", async () => {
    const chat = await freshChat();
    const requestId = "crash-beat";
    const moveStepId = composeSimulationId("sim-command", [chat, requestId, "travel-move"]);
    const pre = await submitDurableMoveActor(moveEnvelope(chat, moveStepId, ROLLOUT_ZONES.square), {
      admitAtLockedVersion: true,
    });
    expect(pre.status).toBe("accepted");
    // The drain ran and the beat was written under the deterministic id.
    await drainBranchTo(ROLLOUT_BRANCH_ID, await moveArrivalTarget(ROLLOUT_BRANCH_ID, ROLLOUT_ACTORS.mara));
    expect(await maraZone()).toBe(ROLLOUT_ZONES.square);
    await writeWorldBeat({
      chatId: chat,
      branchId: ROLLOUT_BRANCH_ID,
      kind: "traveled",
      destinationLabel: "the square",
      parted: false,
      dedupeId: composeSimulationId("world-beat", [chat, requestId]),
    });
    await db()
      .insert(simCommandRequests)
      .values({
        chatId: chat,
        requestId,
        kind: "travel",
        payloadHash: simulationHash({ kind: "travel", toZoneId: ROLLOUT_ZONES.square }),
        state: "started",
      });

    const retry = await simCommand(
      jsonReq(`/api/chats/${chat}/sim-command`, { kind: "travel", toZoneId: ROLLOUT_ZONES.square, requestId }),
      ctx(chat),
    );
    expect(retry.status).toBe(200);
    // The beat wrote once (deterministic id + ON CONFLICT DO NOTHING), never doubled.
    expect(await beatsOfKind(chat, "traveled")).toBe(1);
    expect((await requestRow(chat, requestId))?.state).toBe("completed");
  });

  // Crash-point for the ONE relative-target command: a crash-remnant advance_time re-derives its
  // absolute target from the ANCHORED start-clock, so the retry lands the same clock (never +2x).
  it("anchors a crash-remnant advance_time so it never double-advances", async () => {
    const chat = await freshChat();
    const requestId = "crash-adv";
    const origin = await clock();
    const target = origin + 30 * 60;
    // Simulate: the drain already advanced the clock to target, the beat was written, and a
    // `started` record captured the ORIGINAL start-clock — then the process died pre-record.
    await drainBranchTo(ROLLOUT_BRANCH_ID, target);
    expect(await clock()).toBe(target);
    await writeWorldBeat({
      chatId: chat,
      branchId: ROLLOUT_BRANCH_ID,
      kind: "time_skipped",
      dedupeId: composeSimulationId("world-beat", [chat, requestId]),
    });
    await db()
      .insert(simCommandRequests)
      .values({
        chatId: chat,
        requestId,
        kind: "advance_time",
        payloadHash: simulationHash({ kind: "advance_time", minutes: 30 }),
        preClockStorySecond: origin,
        state: "started",
      });

    const retry = await simCommand(
      jsonReq(`/api/chats/${chat}/sim-command`, { kind: "advance_time", minutes: 30, requestId }),
      ctx(chat),
    );
    expect(retry.status).toBe(200);
    expect(((await retry.json()) as { status: string }).status).toBe("advanced");
    // Anchored: the clock is exactly the original target, NOT target + another 30 minutes.
    expect(await clock()).toBe(target);
    expect(await beatsOfKind(chat, "time_skipped")).toBe(1);
  });

  // Resilience law (docs/resilience.md): a malformed requestId degrades to a server-minted id
  // (the command still runs) AND records the diagnostic code — fallback + code, never a 400.
  it("degrades a malformed requestId to a server id and records the diagnostic", async () => {
    const chat = await freshChat();
    const origin = await clock();
    const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    const res = await simCommand(
      jsonReq(`/api/chats/${chat}/sim-command`, { kind: "advance_time", minutes: 30, requestId: "bad id with spaces" }),
      ctx(chat),
    );
    // Fallback: the command still ran.
    expect(res.status).toBe(200);
    expect(((await res.json()) as { status: string }).status).toBe("advanced");
    expect(await clock()).toBe(origin + 30 * 60);
    // Diagnostic: the coded warning fired.
    expect(warnSpy.mock.calls.some((call) => call[0] === "engine.sim.command_request")).toBe(true);
    warnSpy.mockRestore();
  });
});
