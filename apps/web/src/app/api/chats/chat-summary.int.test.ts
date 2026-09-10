import { and, asc, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { characterChatMessages, characterChatState, characterChatSummaries, characters, db, jobs } from "@/server/db";

// Rolling chat-summary integration suite (re-keyed on the conversation). The DB-bound
// fold: processChatSummary, the watermark window, the enqueue guard, and the chat
// DELETE cascading the summary row. generateChecked is mocked so the fold has a
// deterministic recap without a provider (AI_FAKE keeps the reply stream in demo
// mode). Self-skips when the database is unreachable.

const authState = vi.hoisted(() => ({ user: { id: "", email: "", name: "Sum Int", role: "admin" as const } }));

vi.mock("@/server/auth", async () => (await import("@/server/test-support")).routeAuthModule(authState));

// Preserve the real ai barrel (streamCharacterChat still needs openrouter/isDemoMode),
// override only the structured-generation call the fold uses.
vi.mock("@/server/ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/ai")>();
  return { ...actual, generateChecked: vi.fn() };
});

import { generateChecked } from "@/server/ai";
import { resetRateLimits } from "@/server/api";
import {
  chatExchangeLockKey,
  chatSummaryLockKey,
  enqueueChatSummary,
  loadChatSummary,
  loadVerbatimWindow,
  planChatFold,
  processChatSummary,
  tryKeyedLock,
  withKeyedLock,
} from "@/server/engine";
import {
  apiRequest,
  bindAuthUser,
  endTestPool,
  expectApiError,
  expectJson,
  probeIntegrationDb,
  purgeOwnerRows,
  routeCtx,
  seedTestUser,
} from "@/server/test-support";
import { POST as chatsCreate } from "./route";
import { DELETE as chatDelete } from "./[chatId]/route";
import { DELETE as msgDelete, PATCH as msgPatch } from "./[chatId]/messages/[messageId]/route";

const ready = await probeIntegrationDb("chat-summary.int.test", "character_chat_summaries");

const ids = { chat: "", character: "" };

/** Seed n alternating messages with explicit, strictly-increasing createdAt (a bulk insert shares one now()). */
async function seed(chatId: string, n: number, baseMs = 1_700_000_000_000): Promise<void> {
  const values = Array.from({ length: n }, (_, i) => ({
    chatId,
    role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
    content: `msg-${i}`,
    createdAt: new Date(baseMs + i * 1000),
  }));
  await db().insert(characterChatMessages).values(values);
}

async function chatSummaryJobs(chatId: string) {
  return db()
    .select({ id: jobs.id, status: jobs.status })
    .from(jobs)
    .where(and(eq(jobs.type, "chat_summary"), sql`${jobs.payload} ->> 'chatId' = ${chatId}`));
}

beforeAll(async () => {
  if (!ready) return;
  const user = await seedTestUser("sum-int", { name: "Sum Int", role: "admin" });
  bindAuthUser(authState, user);
  const [character] = await db().insert(characters).values({ ownerId: user.id, name: "Mara", profile: {} }).returning();
  if (!character) throw new Error("failed to seed character");
  ids.character = character.id;
  // The fold resolves the (v1 single) participant for its prompt, so the chat is
  // created through the real POST /api/chats handler (chat + participant rows).
  const res = await chatsCreate(
    apiRequest("/api/chats", { body: { characterIds: [character.id], memory: "fresh" } }),
    routeCtx(),
  );
  ids.chat = (await expectJson<{ id: string }>(res, 201)).id;
});

beforeEach(async () => {
  if (!ready) return;
  // Every repair case below drives a real route handler, so the shared per-IP
  // window is reset the way the sibling chat suite does it.
  resetRateLimits();
  await db().delete(characterChatMessages).where(eq(characterChatMessages.chatId, ids.chat));
  await db().delete(characterChatSummaries).where(eq(characterChatSummaries.chatId, ids.chat));
  await db().delete(characterChatState).where(eq(characterChatState.chatId, ids.chat));
  await db().delete(jobs).where(sql`${jobs.payload} ->> 'chatId' = ${ids.chat}`);
  vi.mocked(generateChecked).mockReset();
});

afterAll(async () => {
  if (!ready) return;
  await db().delete(jobs).where(sql`${jobs.payload} ->> 'chatId' = ${ids.chat}`);
  await purgeOwnerRows([authState.user.id]);
  await endTestPool();
});

describe.runIf(ready)("processChatSummary — the fold", () => {
  it("folds the oldest exchanges, advances the watermark, and trims the verbatim window", async () => {
    vi.mocked(generateChecked).mockResolvedValue({ value: { summary: "ROLLED-UP RECAP" }, degraded: false });
    await seed(ids.chat, 80); // 40 exchanges, all unsummarized

    await processChatSummary({ chatId: ids.chat });

    const fold = planChatFold(80); // 80 - 30 = 50 oldest messages folded
    expect(fold).toBe(50);

    const state = await loadChatSummary(ids.chat);
    expect(state?.summary).toBe("ROLLED-UP RECAP");
    expect(state?.watermark).not.toBeNull();
    expect(state?.coveredExchanges).toBe(25); // floor(50 / 2)
    expect(generateChecked).toHaveBeenCalledTimes(1);

    // The window is exactly the messages after the watermark — the newest 30.
    const window = await loadVerbatimWindow(ids.chat, state?.watermark ?? null);
    expect(window).toHaveLength(80 - 50);
    expect(window[0]?.content).toBe("msg-50");
    expect(window.at(-1)?.content).toBe("msg-79");
  });

  it("degrades to a no-op (no row, watermark unmoved) when the fold fails", async () => {
    vi.mocked(generateChecked).mockResolvedValue({ value: { summary: "" }, degraded: true });
    await seed(ids.chat, 80);

    await processChatSummary({ chatId: ids.chat });

    expect(await loadChatSummary(ids.chat)).toBeNull();
    // Window is unchanged — the full last-40 verbatim ceiling (= today's behavior).
    const window = await loadVerbatimWindow(ids.chat, null);
    expect(window).toHaveLength(80);
  });

  it("no-ops below the trigger without calling the model", async () => {
    vi.mocked(generateChecked).mockResolvedValue({ value: { summary: "unused" }, degraded: false });
    await seed(ids.chat, 60); // < 70 (the trigger)

    await processChatSummary({ chatId: ids.chat });

    expect(await loadChatSummary(ids.chat)).toBeNull();
    expect(generateChecked).not.toHaveBeenCalled();
  });
});

describe.runIf(ready)("enqueueChatSummary — the guard", () => {
  it("does not enqueue a second fold while one is already queued for the chat", async () => {
    // A queued job inserted directly (no runner kick), so the guard has something to see.
    await db()
      .insert(jobs)
      .values({ type: "chat_summary", status: "queued", payload: { chatId: ids.chat } });

    await enqueueChatSummary({ chatId: ids.chat });

    expect(await chatSummaryJobs(ids.chat)).toHaveLength(1);
  });
});

/** The transcript in its own (createdAt, id) order — the seam the watermark is compared against. */
async function transcript(chatId: string) {
  return db()
    .select({ id: characterChatMessages.id, role: characterChatMessages.role, content: characterChatMessages.content })
    .from(characterChatMessages)
    .where(eq(characterChatMessages.chatId, chatId))
    .orderBy(asc(characterChatMessages.createdAt), asc(characterChatMessages.id));
}

/** The `continuity` block both message routes return. */
interface Continuity {
  summary: "rebuilt" | "unaffected" | "failed";
  memory: "reextracted" | "reconciled" | "unaffected" | "failed";
  voiceExemplarsRemoved: number;
  voice: "scrubbed" | "unaffected" | "failed";
  diagnostics: string[];
}

const patchMsgReq = (chatId: string, messageId: string, content: string) =>
  apiRequest(`/api/chats/${chatId}/messages/${messageId}`, { method: "PATCH", body: { content } });
const delMsgReq = (chatId: string, messageId: string) =>
  apiRequest(`/api/chats/${chatId}/messages/${messageId}`, { method: "DELETE" });
const msgCtx = (chatId: string, messageId: string) => routeCtx({ chatId, messageId });

/** Seed 80 messages and fold once, leaving a summary that quotes `msg-3`. */
async function foldOnce(): Promise<void> {
  vi.mocked(generateChecked).mockResolvedValue({ value: { summary: "RECAP: msg-3 mattered" }, degraded: false });
  await seed(ids.chat, 80);
  await processChatSummary({ chatId: ids.chat });
  const state = await loadChatSummary(ids.chat);
  expect(state?.summary).toContain("msg-3");
  expect(state?.watermark).not.toBeNull();
  vi.mocked(generateChecked).mockClear();
}

describe.runIf(ready)("PATCH/DELETE /api/chats/:chatId/messages/:messageId — continuity repair", () => {
  it("re-folds the summary when an edited assistant line is covered by the watermark", async () => {
    await foldOnce();
    vi.mocked(generateChecked).mockResolvedValue({ value: { summary: "REBUILT RECAP" }, degraded: false });
    const covered = (await transcript(ids.chat))[3]!; // msg-3, an assistant line inside the folded chunk

    const res = await msgPatch(patchMsgReq(ids.chat, covered.id, "msg-3 rewritten"), msgCtx(ids.chat, covered.id));
    const body = await expectJson<{ id: string; continuity: Continuity }>(res, 200);

    expect(body.continuity.summary).toBe("rebuilt");
    expect(body.continuity.diagnostics).toContain("chat_continuity.summary.rebuilt");
    expect(generateChecked).toHaveBeenCalled(); // the rebuild's own fold
    const after = await loadChatSummary(ids.chat);
    expect(after?.summary).toBe("REBUILT RECAP");
    expect(after?.summary).not.toContain("msg-3"); // the old wording is unreachable through the summary
  });

  it("re-folds for a covered USER line too (summary repair is not assistant-only)", async () => {
    await foldOnce();
    vi.mocked(generateChecked).mockResolvedValue({ value: { summary: "REBUILT RECAP" }, degraded: false });
    const covered = (await transcript(ids.chat))[2]!; // msg-2, a user line
    expect(covered.role).toBe("user");

    const res = await msgPatch(patchMsgReq(ids.chat, covered.id, "msg-2 rewritten"), msgCtx(ids.chat, covered.id));
    const body = await expectJson<{ id: string; continuity: Continuity }>(res, 200);

    expect(body.continuity.summary).toBe("rebuilt");
    expect(body.continuity.memory).toBe("unaffected"); // memory is anchored on assistant ids
    expect(body.continuity.voice).toBe("unaffected");
    expect((await loadChatSummary(ids.chat))?.summary).toBe("REBUILT RECAP");
  });

  it("makes no model call when the edited line is after the watermark", async () => {
    await foldOnce();
    const recent = (await transcript(ids.chat))[79]!; // the newest line — verbatim, never folded

    const res = await msgPatch(patchMsgReq(ids.chat, recent.id, "msg-79 rewritten"), msgCtx(ids.chat, recent.id));
    const body = await expectJson<{ id: string; continuity: Continuity }>(res, 200);

    expect(body.continuity.summary).toBe("unaffected");
    expect(generateChecked).not.toHaveBeenCalled();
    expect((await loadChatSummary(ids.chat))?.summary).toContain("msg-3"); // untouched
  });

  it("waits for an in-flight fold before deciding coverage, so a chunk folded mid-edit is re-folded", async () => {
    // Nothing folded yet: read on its own, the watermark is null and EVERY line
    // looks verbatim — which is exactly what a fold in flight is about to change.
    await seed(ids.chat, 80);
    const rows = await db()
      .select({ id: characterChatMessages.id, createdAt: characterChatMessages.createdAt })
      .from(characterChatMessages)
      .where(eq(characterChatMessages.chatId, ids.chat))
      .orderBy(asc(characterChatMessages.createdAt), asc(characterChatMessages.id));
    const covered = rows[3]!; // inside the 50-message chunk a first fold takes
    const chunkEnd = rows[49]!; // that chunk's last row — the watermark the fold will publish

    // The detached fold: it has read its (pre-edit) chunk and is awaiting the model,
    // holding the summary lock the whole time.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const held = withKeyedLock(chatSummaryLockKey(ids.chat), () => gate);

    const pending = msgPatch(patchMsgReq(ids.chat, covered.id, "msg-3 rewritten"), msgCtx(ids.chat, covered.id));
    // The repair may NOT answer while that fold is unsettled: its coverage decision
    // has to queue on the summary lock. Deciding here reads the not-yet-advanced
    // watermark and answers "unaffected" for a line the fold is about to summarize.
    const answeredMidFold = await Promise.race([
      pending.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 400)),
    ]);
    expect(answeredMidFold).toBe(false);

    // The fold's model call returns and it persists its PRE-edit chunk, advancing
    // the watermark past the line that was just rewritten.
    await db().insert(characterChatSummaries).values({
      chatId: ids.chat,
      summary: "RECAP: msg-3 mattered",
      watermarkAt: chunkEnd.createdAt,
      watermarkId: chunkEnd.id,
      coveredExchanges: 25,
    });
    vi.mocked(generateChecked).mockResolvedValue({ value: { summary: "REBUILT RECAP" }, degraded: false });
    release();
    await held;

    const body = await expectJson<{ id: string; continuity: Continuity }>(await pending, 200);
    expect(body.continuity.summary).toBe("rebuilt");
    expect(body.continuity.diagnostics).toContain("chat_continuity.summary.rebuilt");
    expect(generateChecked).toHaveBeenCalled(); // the rebuild's own fold
    const after = await loadChatSummary(ids.chat);
    expect(after?.summary).toBe("REBUILT RECAP");
    expect(after?.summary).not.toContain("msg-3"); // the fold's stale chunk did not outlive the edit
  });

  it("re-folds when a covered line is deleted", async () => {
    await foldOnce();
    vi.mocked(generateChecked).mockResolvedValue({ value: { summary: "REBUILT RECAP" }, degraded: false });
    const covered = (await transcript(ids.chat))[4]!;

    const res = await msgDelete(delMsgReq(ids.chat, covered.id), msgCtx(ids.chat, covered.id));
    const body = await expectJson<{ deleted: true; continuity: Continuity }>(res, 200);

    expect(body.deleted).toBe(true);
    expect(body.continuity.summary).toBe("rebuilt");
    expect((await loadChatSummary(ids.chat))?.summary).toBe("REBUILT RECAP");
    expect((await transcript(ids.chat)).some((m) => m.id === covered.id)).toBe(false);
  });

  it("re-folds when the watermark line ITSELF is deleted (the tuple tie is inclusive)", async () => {
    await foldOnce();
    const watermark = (await loadChatSummary(ids.chat))?.watermark ?? null;
    expect(watermark).not.toBeNull();
    vi.mocked(generateChecked).mockResolvedValue({ value: { summary: "REBUILT RECAP" }, degraded: false });

    const res = await msgDelete(delMsgReq(ids.chat, watermark!.id), msgCtx(ids.chat, watermark!.id));
    const body = await expectJson<{ deleted: true; continuity: Continuity }>(res, 200);

    expect(body.continuity.summary).toBe("rebuilt");
    expect((await loadChatSummary(ids.chat))?.summary).toBe("REBUILT RECAP");
  });

  it("leaves an empty summary and a null watermark when the rebuild's fold degrades", async () => {
    await foldOnce();
    // Every fold from here on degrades: the rebuild resets the row first, so the
    // honest end state is no summary at all rather than the stale recap.
    vi.mocked(generateChecked).mockResolvedValue({ value: { summary: "" }, degraded: true });
    const covered = (await transcript(ids.chat))[2]!;

    const res = await msgPatch(patchMsgReq(ids.chat, covered.id, "msg-2 rewritten"), msgCtx(ids.chat, covered.id));
    const body = await expectJson<{ id: string; continuity: Continuity }>(res, 200);

    expect(body.continuity.summary).toBe("rebuilt");
    expect(body.continuity.diagnostics).toContain("chat_continuity.summary.rebuilt");
    const after = await loadChatSummary(ids.chat);
    expect(after?.summary).toBe("");
    expect(after?.watermark).toBeNull(); // no stale prose, and every line is verbatim again
  });

  it("drops the edited line's voice exemplars from the live ring and the rollback snapshot", async () => {
    const OLD = "I have never once said what I meant, and you know it.";
    await db()
      .insert(characterChatMessages)
      .values({ chatId: ids.chat, role: "user", content: "say something true", createdAt: new Date(1_700_000_000_000) });
    const [reply] = await db()
      .insert(characterChatMessages)
      .values({ chatId: ids.chat, role: "assistant", content: OLD, createdAt: new Date(1_700_000_001_000) })
      .returning({ id: characterChatMessages.id });
    const ring = [
      { line: "I have never once said what I meant", atClockMinutes: 10, sourceMessageId: reply!.id },
      // Legacy entry (written before provenance existed): its line occurs verbatim in the old content.
      { line: "and you know it", atClockMinutes: 12, sourceMessageId: null },
      { line: "Bring the umbrella.", atClockMinutes: 14, sourceMessageId: "some-other-message" },
    ];
    await db()
      .insert(characterChatState)
      .values({
        chatId: ids.chat,
        characterId: ids.character,
        voiceExemplars: ring,
        preExchangeState: { voiceExemplars: ring },
      });

    const res = await msgPatch(patchMsgReq(ids.chat, reply!.id, "A cleaner line."), msgCtx(ids.chat, reply!.id));
    const body = await expectJson<{ id: string; continuity: Continuity }>(res, 200);

    expect(body.continuity.voice).toBe("scrubbed");
    expect(body.continuity.voiceExemplarsRemoved).toBe(2);
    expect(body.continuity.diagnostics).toContain("chat_continuity.voice.scrubbed");

    const [row] = await db()
      .select({ voiceExemplars: characterChatState.voiceExemplars, preExchangeState: characterChatState.preExchangeState })
      .from(characterChatState)
      .where(and(eq(characterChatState.chatId, ids.chat), eq(characterChatState.characterId, ids.character)));
    const live = row?.voiceExemplars as { line: string }[];
    const snapshot = (row?.preExchangeState as { voiceExemplars: { line: string }[] }).voiceExemplars;
    expect(live.map((e) => e.line)).toEqual(["Bring the umbrella."]);
    expect(snapshot.map((e) => e.line)).toEqual(["Bring the umbrella."]); // "another take" cannot resurrect it
  });

  it("409s chat_busy while the exchange lock is held, without touching the transcript", async () => {
    await seed(ids.chat, 2);
    const target = (await transcript(ids.chat))[0]!;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const held = tryKeyedLock(chatExchangeLockKey(ids.chat), () => gate);
    expect(held).not.toBeNull();
    try {
      const res = await msgPatch(patchMsgReq(ids.chat, target.id, "rewritten mid-stream"), msgCtx(ids.chat, target.id));
      await expectApiError(res, 409, "chat_busy");
      expect((await transcript(ids.chat))[0]?.content).toBe("msg-0");
    } finally {
      release();
      await held;
    }
  });
});

describe.runIf(ready)("DELETE /api/chats/:chatId — cascades the running summary", () => {
  it("drops the summary row alongside the conversation", async () => {
    await seed(ids.chat, 4);
    await db().insert(characterChatSummaries).values({
      chatId: ids.chat,
      summary: "a recap to be cleared",
      watermarkAt: new Date(1_700_000_000_000),
      watermarkId: "wm-placeholder",
      coveredExchanges: 2,
    });

    const res = await chatDelete(
      apiRequest(`/api/chats/${ids.chat}`, { method: "DELETE" }),
      routeCtx({ chatId: ids.chat }),
    );
    expect(res.status).toBe(200);
    expect(await loadChatSummary(ids.chat)).toBeNull();
  });
});
