import { and, eq } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { characterChatMessages, characterChats, db, simBranches, simItemHoldings } from "@/server/db";

// R3 slices 1–2 (engine.rollout.plan.md) — the sim routes under /chat/: the
// gate (409 for unrouted chats), one full turn through prepare → render
// (AI_FAKE demo fallback; zero live calls) landing in the transcript, and
// typed player commands with §14.4 public-face refusals. Self-skips without
// a database.

const authState = vi.hoisted(() => ({
  user: { id: "", email: "", name: "Sim Routes Int", role: "user" as const },
}));

vi.mock("@/server/auth", async () => (await import("@/server/test-support")).routeAuthModule(authState));

import {
  advanceBranchStoryTime,
  ROLLOUT_ACTORS,
  ROLLOUT_BRANCH_ID,
  ROLLOUT_KEEPSAKE_ID,
  ROLLOUT_REST_ACTION_ID,
  ROLLOUT_ZONES,
  readDurableSpaceBranch,
} from "@/server/engine";
import { log } from "@/server/log";
import {
  apiRequest,
  drainStream,
  dropRoutedSimChat,
  emptyRoutedSimChat,
  expectJson,
  newSimChat,
  probeIntegrationDb,
  routeCtx,
  routeSimChat,
  seedRoutedSimChat,
} from "@/server/test-support";
import { POST as chatsCreate } from "./route";
import { POST as chatSend } from "./[chatId]/route";
import { POST as simCommand } from "./[chatId]/sim-command/route";
import { POST as simTurn } from "./[chatId]/sim-turn/route";
import { GET as stateGet } from "./[chatId]/state/route";
import { POST as legacyTimeSkip } from "./[chatId]/time-skip/route";

const ready = await probeIntegrationDb("sim-routes.int.test", "character_chats");

const ctx = (chatId: string) => routeCtx({ chatId });
const jsonReq = (path: string, body: unknown): NextRequest => apiRequest(path, { body });

let fixture = emptyRoutedSimChat(chatsCreate);

beforeAll(async () => {
  if (!ready) return;
  fixture = await seedRoutedSimChat({ slug: "sim-routes", authState, chatsCreate });
});

afterAll(async () => {
  if (!ready || !fixture.userId) return;
  await dropRoutedSimChat(fixture);
});

describe.runIf(ready)("R3 sim routes under /chat/", () => {
  it("gates unrouted chats, runs a full turn into the transcript, and admits typed commands", async () => {
    const chat = fixture.chatId;
    // Unrouted: the gate holds.
    const gated = await simTurn(jsonReq(`/api/chats/${chat}/sim-turn`, { message: "hello" }), ctx(chat));
    expect(gated.status).toBe(409);

    // Route the chat to the successor view lane with the Mara/Ana mapping.
    const flipped = await routeSimChat({
      chatId: chat,
      byUserId: fixture.userId,
      authority: "successor_narrative_view",
    });
    expect(flipped.after.authority).toBe("successor_narrative_view");

    // One full turn: player line + narrated assistant line in the transcript.
    const turn = await simTurn(
      jsonReq(`/api/chats/${chat}/sim-turn`, { message: "I look around the kitchen." }),
      ctx(chat),
    );
    const turnBody = await expectJson<{ prose: string; degraded: boolean; cutId: string }>(turn, 200);
    expect(turnBody.degraded).toBe(true); // AI_FAKE: the deterministic fallback rendered
    expect(turnBody.prose.length).toBeGreaterThan(0);
    const messages = await db()
      .select({ role: characterChatMessages.role, meta: characterChatMessages.meta })
      .from(characterChatMessages)
      .where(eq(characterChatMessages.chatId, chat));
    expect(messages.filter((row) => row.role === "user")).toHaveLength(1);
    const assistant = messages.filter((row) => row.role === "assistant");
    expect(assistant).toHaveLength(1);
    expect(assistant[0]?.meta).toMatchObject({ simTurn: true, cutId: turnBody.cutId });

    // The ADMISSION WIRING: the ordinary send endpoint — the one the chat UI
    // (mobile included) actually calls — forks the same message into the
    // successor lane for a routed chat, returning plain text and landing
    // both lines in the transcript.
    const uiSend = await chatSend(
      jsonReq(`/api/chats/${chat}`, { kind: "send", content: "I stretch and glance out the window." }),
      ctx(chat),
    );
    expect(uiSend.status).toBe(200);
    expect(uiSend.headers.get("content-type")).toContain("text/plain");
    const uiProse = await drainStream(uiSend);
    expect(uiProse.length).toBeGreaterThan(0);
    const afterUiSend = await db()
      .select({ role: characterChatMessages.role })
      .from(characterChatMessages)
      .where(eq(characterChatMessages.chatId, chat));
    expect(afterUiSend.filter((row) => row.role === "user")).toHaveLength(2);
    expect(afterUiSend.filter((row) => row.role === "assistant")).toHaveLength(2);

    // A SECOND chat mapped to the same actor pair must FIND the standing
    // scene, not fight the claim law for a chat-scoped new one (the R3
    // live-session bug: every send was refused participant_already_engaged
    // and the player's line silently vanished).
    const chat2 = await newSimChat(fixture, { authority: "successor_narrative_view" });
    const secondChatSend = await chatSend(
      jsonReq(`/api/chats/${chat2}`, { kind: "send", content: "I wave from the doorway." }),
      ctx(chat2),
    );
    expect(secondChatSend.status).toBe(200);
    expect((await drainStream(secondChatSend)).replace(/\u200B/g, "").length).toBeGreaterThan(0);
    const chat2Messages = await db()
      .select({ role: characterChatMessages.role })
      .from(characterChatMessages)
      .where(eq(characterChatMessages.chatId, chat2));
    expect(chat2Messages.filter((row) => row.role === "user")).toHaveLength(1);
    expect(chat2Messages.filter((row) => row.role === "assistant")).toHaveLength(1);

    // give_item: not-held is the §14.4 public face at 200 (the card reads the
    // refusal body, matching travel); the held keepsake transfers.
    const notHeld = await simCommand(
      jsonReq(`/api/chats/${chat}/sim-command`, { kind: "give_item", itemId: "rollout-item-loaf" }),
      ctx(chat),
    );
    expect(await expectJson(notHeld, 200)).toMatchObject({ status: "rejected", code: "not_held" });
    const gave = await simCommand(
      jsonReq(`/api/chats/${chat}/sim-command`, { kind: "give_item", itemId: ROLLOUT_KEEPSAKE_ID }),
      ctx(chat),
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
    const ended = await simCommand(jsonReq(`/api/chats/${chat}/sim-command`, { kind: "end_scene" }), ctx(chat));
    expect(ended.status).toBe(200);

    // Ending the scene must not strand the pair: the next send opens a FRESH
    // engagement (the head-scoped open command) instead of deduping into the
    // ended one — and ending THAT scene resolves the live engagement, not a
    // chat-derived id.
    const reopened = await simTurn(
      jsonReq(`/api/chats/${chat}/sim-turn`, { message: "Wait — one more thing." }),
      ctx(chat),
    );
    expect(reopened.status).toBe(200);
    const reEnded = await simCommand(jsonReq(`/api/chats/${chat}/sim-command`, { kind: "end_scene" }), ctx(chat));
    expect(reEnded.status).toBe(200);

    const rested = await simCommand(
      jsonReq(`/api/chats/${chat}/sim-command`, { kind: "start_activity", actionDefinitionId: ROLLOUT_REST_ACTION_ID }),
      ctx(chat),
    );
    expect(rested.status).toBe(200);
    const blocked = await simCommand(
      jsonReq(`/api/chats/${chat}/sim-command`, { kind: "move", toZoneId: ROLLOUT_ZONES.square }),
      ctx(chat),
    );
    const blockedBody = await expectJson<{ status: string; code: string; publicReason?: string }>(blocked, 409);
    expect(blockedBody).toMatchObject({ status: "rejected", code: "activity_conflict" });
    expect(blockedBody.publicReason?.length ?? 0).toBeGreaterThan(0);

    // A refused scene open (rest holds full attention) keeps the player's
    // line and records the public-faced failure for the client popup —
    // never a silent delete (the vanishing-message half of the R3 bug).
    const before = await db()
      .select({ role: characterChatMessages.role })
      .from(characterChatMessages)
      .where(eq(characterChatMessages.chatId, chat));
    const refusedSend = await chatSend(
      jsonReq(`/api/chats/${chat}`, { kind: "send", content: "Are you asleep?" }),
      ctx(chat),
    );
    expect(refusedSend.status).toBe(200);
    expect((await drainStream(refusedSend)).replace(/\u200B/g, "")).toBe("");
    const after = await db()
      .select({ role: characterChatMessages.role })
      .from(characterChatMessages)
      .where(eq(characterChatMessages.chatId, chat));
    expect(after.filter((row) => row.role === "user")).toHaveLength(before.filter((row) => row.role === "user").length + 1);
    expect(after.filter((row) => row.role === "assistant")).toHaveLength(before.filter((row) => row.role === "assistant").length);
    const [chatRow] = await db()
      .select({ lastReplyFailure: characterChats.lastReplyFailure })
      .from(characterChats)
      .where(eq(characterChats.id, chat));
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
      jsonReq(`/api/chats/${chat}/sim-command`, { kind: "advance_time", minutes: 720 }),
      ctx(chat),
    );
    const advancedBody = await expectJson<{ status: string; toStorySecond: number }>(advanced, 200);
    expect(advancedBody.status).toBe("advanced");
    expect(advancedBody.toStorySecond).toBe(beforeAdvance.storySecond + 720 * 60);
    const stateRes = await stateGet(apiRequest(`/api/chats/${chat}/state`), ctx(chat));
    const stateBody = await expectJson<{ simClock: { storySecond: number } | null }>(stateRes, 200);
    expect(stateBody.simClock?.storySecond).toBe(advancedBody.toStorySecond);
    const afterSkipSend = await chatSend(
      jsonReq(`/api/chats/${chat}`, { kind: "send", content: "That was a good rest." }),
      ctx(chat),
    );
    expect(afterSkipSend.status).toBe(200);
    expect((await drainStream(afterSkipSend)).replace(/\u200B/g, "").length).toBeGreaterThan(0);

    // The legacy time-skip lane is closed for a routed chat — lanes stay separate.
    const legacySkip = await legacyTimeSkip(
      jsonReq(`/api/chats/${chat}/time-skip`, { amount: "hours" }),
      ctx(chat),
    );
    expect(legacySkip.status).toBe(409);
  });

  // sim-read-seam-guards.plan.md slice 4 (folded C16) — the composed choreography
  // the turn-loop read consolidation (slice 3) must preserve byte-for-byte:
  // walk-with-me → co-present render at the destination, a natural-language
  // departure → solo render at the arrival, and a primary-absent solo turn that
  // still advances time. Positions + render kind (a committed cutId vs. the empty
  // solo cutId) + the choreography's world beats pin the behavior. AI_FAKE renders
  // the deterministic fallback, so there are zero live model calls.
  it("composes walk-with-me, a natural-language departure, and a solo turn end to end", async () => {
    // A fresh chat mapped to the SAME branch + Mara/Ana pair. The case above left
    // both at home, co-present, pre-bedtime — the starting state this needs (only
    // these commands move the pair; Ana's routine is meal/sleep, never travel).
    const chat = await newSimChat(fixture, { authority: "successor_narrative_view" });

    const zoneOf = (space: Awaited<ReturnType<typeof readDurableSpaceBranch>>, actorId: string): string | null => {
      const locus = space.loci.find((l) => l.actorId === actorId);
      return locus?.kind === "at" ? locus.zoneId : null;
    };
    const contentsOf = async (): Promise<string[]> =>
      (
        await db()
          .select({ content: characterChatMessages.content })
          .from(characterChatMessages)
          .where(eq(characterChatMessages.chatId, chat))
      ).map((row) => row.content);

    // Precondition: the pair is co-present at home.
    const start = await readDurableSpaceBranch(ROLLOUT_BRANCH_ID);
    expect(zoneOf(start, ROLLOUT_ACTORS.mara)).toBe(ROLLOUT_ZONES.home);
    expect(zoneOf(start, ROLLOUT_ACTORS.ana)).toBe(ROLLOUT_ZONES.home);

    // 1) WALK-WITH-ME: an admitted accompany the co-present primary ACCEPTS. Both
    //    travel home → square; co-presence restored there ⇒ the CO-PRESENT cut (a
    //    real committed cutId), and a `together` beat lands in the transcript.
    const together = await simTurn(
      jsonReq(`/api/chats/${chat}/sim-turn`, { message: "We walk to the town square together." }),
      ctx(chat),
    );
    const togetherBody = await expectJson<{ cutId: string; prose: string }>(together, 200);
    expect(togetherBody.cutId.length).toBeGreaterThan(0); // co-present render, not solo
    const afterAccompany = await readDurableSpaceBranch(ROLLOUT_BRANCH_ID);
    expect(zoneOf(afterAccompany, ROLLOUT_ACTORS.mara)).toBe(ROLLOUT_ZONES.square);
    expect(zoneOf(afterAccompany, ROLLOUT_ACTORS.ana)).toBe(ROLLOUT_ZONES.square);
    expect((await contentsOf()).some((line) => line.includes("together"))).toBe(true);

    // 2) NATURAL-LANGUAGE DEPARTURE: an admitted move while the scene stands ends it
    //    as a CHOICE, walks Mara square → home ALONE (Ana stays), and renders through
    //    the SOLO cut (empty cutId) behind a `parted` traveled beat.
    const depart = await simTurn(
      jsonReq(`/api/chats/${chat}/sim-turn`, { message: "I walk back home." }),
      ctx(chat),
    );
    const departBody = await expectJson<{ cutId: string; prose: string }>(depart, 200);
    expect(departBody.cutId).toBe(""); // the departure choreography renders via the solo path
    const afterDeparture = await readDurableSpaceBranch(ROLLOUT_BRANCH_ID);
    expect(zoneOf(afterDeparture, ROLLOUT_ACTORS.mara)).toBe(ROLLOUT_ZONES.home);
    expect(zoneOf(afterDeparture, ROLLOUT_ACTORS.ana)).toBe(ROLLOUT_ZONES.square);
    expect((await contentsOf()).some((line) => line.includes("take your leave"))).toBe(true);

    // 3) SOLO TURN (primary absent): Mara@home, Ana@square. A non-command line runs
    //    the dual-block solo cut and STILL advances the span (time is the medium).
    const [beforeSolo] = await db()
      .select({ storySecond: simBranches.storySecond })
      .from(simBranches)
      .where(eq(simBranches.id, ROLLOUT_BRANCH_ID));
    const solo = await simTurn(
      jsonReq(`/api/chats/${chat}/sim-turn`, { message: "I tidy up and put the kettle on." }),
      ctx(chat),
    );
    const soloBody = await expectJson<{ cutId: string; prose: string }>(solo, 200);
    expect(soloBody.cutId).toBe(""); // solo render
    expect(soloBody.prose.length).toBeGreaterThan(0);
    const [afterSolo] = await db()
      .select({ storySecond: simBranches.storySecond })
      .from(simBranches)
      .where(eq(simBranches.id, ROLLOUT_BRANCH_ID));
    expect(afterSolo?.storySecond ?? 0).toBeGreaterThan(beforeSolo?.storySecond ?? 0);
  });

  // command-integrity.plan.md slice 2 (A2). Ruling A2-1 — the world's clock wins, on the
  // SOLO path. The two tests above leave Mara@home and Ana@square (not co-present), so a
  // fresh send here runs the solo turn. Its span advance is now tolerant (`at_least`): a
  // concurrent skip that overtook the span is a LEGAL race, not a degrade. Before A2 the
  // race threw inside the solo advance, got caught, and recorded the `simLoadWarn` degrade.
  it("A2: a solo turn overtaken by a concurrent drain lands and logs no degrade warning", async () => {
    const chat = await newSimChat(fixture, { authority: "successor_narrative_view" });

    const [nowClock] = await db()
      .select({ storySecond: simBranches.storySecond })
      .from(simBranches)
      .where(eq(simBranches.id, ROLLOUT_BRANCH_ID));
    // A drain target well past the solo turn's 60s span, so the race overtakes it.
    const farTarget = (nowClock?.storySecond ?? 0) + 3_600;

    const warnSpy = vi.spyOn(log, "warn");
    try {
      // The solo turn and the overtaking drain run concurrently. With A2 the turn always
      // lands (the advance clamps, never throws); before A2 the race threw and was logged.
      const [, turn] = await Promise.all([
        advanceBranchStoryTime(ROLLOUT_BRANCH_ID, farTarget, { workerId: "w-a2-solo-drain" }),
        simTurn(jsonReq(`/api/chats/${chat}/sim-turn`, { message: "I sweep the floor." }), ctx(chat)),
      ]);
      expect(turn.status).toBe(200);

      // The pure clock race no longer records the `simLoadWarn` degrade diagnostic.
      const soloAdvanceWarn = warnSpy.mock.calls.some(
        (call) => call[1] === "solo story-time advance degraded",
      );
      expect(soloAdvanceWarn).toBe(false);
    } finally {
      warnSpy.mockRestore();
    }
  });
});
