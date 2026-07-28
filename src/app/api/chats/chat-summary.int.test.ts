import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { characterChatMessages, characterChatSummaries, characters, db, jobs } from "@/server/db";

// Rolling chat-summary integration suite (docs/developer-notes/character-chat-summary.plan.md,
// re-keyed on the conversation — character-chat-standalone.spec.md §1.2). The DB-bound
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
import {
  enqueueChatSummary,
  loadChatSummary,
  loadVerbatimWindow,
  planChatFold,
  processChatSummary,
} from "@/server/engine";
import {
  apiRequest,
  bindAuthUser,
  endTestPool,
  expectJson,
  probeIntegrationDb,
  purgeOwnerRows,
  routeCtx,
  seedTestUser,
} from "@/server/test-support";
import { POST as chatsCreate } from "./route";
import { DELETE as chatDelete } from "./[chatId]/route";

const ready = await probeIntegrationDb("chat-summary.int.test", "character_chat_summaries");

const ids = { chat: "" };

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
  await db().delete(characterChatMessages).where(eq(characterChatMessages.chatId, ids.chat));
  await db().delete(characterChatSummaries).where(eq(characterChatSummaries.chatId, ids.chat));
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
