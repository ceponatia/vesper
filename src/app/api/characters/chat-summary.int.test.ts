import { and, eq, sql } from "drizzle-orm";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { characterChatMessages, characterChatSummaries, characters, db, jobs, users } from "@/server/db";

// Rolling chat-summary integration suite (docs/developer-notes/character-chat-summary.plan.md).
// The DB-bound fold: processChatSummary, the watermark window, the enqueue guard,
// and DELETE clearing the summary row. generateChecked is mocked so the fold has
// a deterministic recap without a provider (AI_FAKE keeps the reply stream in
// demo mode). Self-skips when the database is unreachable.

process.env.AI_FAKE = "1";

const authState = vi.hoisted(() => ({ user: { id: "", email: "", name: "Sum Int", role: "admin" as const } }));

vi.mock("@/server/auth", () => ({
  USER_COOKIE: "vesper_user",
  getCurrentUser: async () => authState.user,
  ensureDefaultUser: async () => authState.user,
  listUsers: async () => [authState.user],
}));

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
import { DELETE as chatDelete } from "./[id]/chat/route";

async function probe(): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      db().execute(sql`select 1 from character_chat_summaries limit 1`),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("connect timeout")), 4000);
      }),
    ]);
    return true;
  } catch (err) {
    process.stderr.write(`[chat-summary.int.test] skipping: database unreachable: ${err instanceof Error ? err.message : String(err)}\n`);
    return false;
  } finally {
    clearTimeout(timer);
  }
}

const ready = await probe();
const ids = { character: "" };

/** Seed n alternating messages with explicit, strictly-increasing createdAt (a bulk insert shares one now()). */
async function seed(characterId: string, n: number, baseMs = 1_700_000_000_000): Promise<void> {
  const values = Array.from({ length: n }, (_, i) => ({
    ownerId: authState.user.id,
    characterId,
    role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
    content: `msg-${i}`,
    createdAt: new Date(baseMs + i * 1000),
  }));
  await db().insert(characterChatMessages).values(values);
}

async function chatSummaryJobs(characterId: string) {
  return db()
    .select({ id: jobs.id, status: jobs.status })
    .from(jobs)
    .where(and(eq(jobs.type, "chat_summary"), sql`${jobs.payload} ->> 'characterId' = ${characterId}`));
}

beforeAll(async () => {
  if (!ready) return;
  const stamp = Date.now();
  const [user] = await db()
    .insert(users)
    .values({ email: `sum-int-${stamp}@test.local`, name: "Sum Int", role: "admin" })
    .returning();
  if (!user) throw new Error("failed to create test user");
  authState.user = { ...authState.user, id: user.id, email: user.email };
  const [character] = await db().insert(characters).values({ ownerId: user.id, name: "Mara", profile: {} }).returning();
  if (!character) throw new Error("failed to seed character");
  ids.character = character.id;
});

beforeEach(async () => {
  if (!ready) return;
  await db().delete(characterChatMessages).where(eq(characterChatMessages.characterId, ids.character));
  await db().delete(characterChatSummaries).where(eq(characterChatSummaries.characterId, ids.character));
  await db().delete(jobs).where(sql`${jobs.payload} ->> 'characterId' = ${ids.character}`);
  vi.mocked(generateChecked).mockReset();
});

afterAll(async () => {
  if (!ready) return;
  await db().delete(characterChatMessages).where(eq(characterChatMessages.characterId, ids.character));
  await db().delete(characterChatSummaries).where(eq(characterChatSummaries.characterId, ids.character));
  await db().delete(jobs).where(sql`${jobs.payload} ->> 'characterId' = ${ids.character}`);
  await db().delete(characters).where(eq(characters.ownerId, authState.user.id));
  await db().delete(users).where(eq(users.id, authState.user.id));
  await globalThis.__vesperPool?.end();
});

describe("processChatSummary — the fold", () => {
  it("folds the oldest exchanges, advances the watermark, and trims the verbatim window", async (t) => {
    if (!ready) return t.skip();
    vi.mocked(generateChecked).mockResolvedValue({ value: { summary: "ROLLED-UP RECAP" }, degraded: false });
    await seed(ids.character, 80); // 40 exchanges, all unsummarized

    await processChatSummary({ ownerId: authState.user.id, characterId: ids.character });

    const fold = planChatFold(80); // 80 - 30 = 50 oldest messages folded
    expect(fold).toBe(50);

    const state = await loadChatSummary(authState.user.id, ids.character);
    expect(state?.summary).toBe("ROLLED-UP RECAP");
    expect(state?.watermark).not.toBeNull();
    expect(state?.coveredExchanges).toBe(25); // floor(50 / 2)
    expect(generateChecked).toHaveBeenCalledTimes(1);

    // The window is exactly the messages after the watermark — the newest 30.
    const window = await loadVerbatimWindow(authState.user.id, ids.character, state?.watermark ?? null);
    expect(window).toHaveLength(80 - 50);
    expect(window[0]?.content).toBe("msg-50");
    expect(window.at(-1)?.content).toBe("msg-79");
  });

  it("degrades to a no-op (no row, watermark unmoved) when the fold fails", async (t) => {
    if (!ready) return t.skip();
    vi.mocked(generateChecked).mockResolvedValue({ value: { summary: "" }, degraded: true });
    await seed(ids.character, 80);

    await processChatSummary({ ownerId: authState.user.id, characterId: ids.character });

    expect(await loadChatSummary(authState.user.id, ids.character)).toBeNull();
    // Window is unchanged — the full last-40 verbatim ceiling (= today's behavior).
    const window = await loadVerbatimWindow(authState.user.id, ids.character, null);
    expect(window).toHaveLength(80);
  });

  it("no-ops below the trigger without calling the model", async (t) => {
    if (!ready) return t.skip();
    vi.mocked(generateChecked).mockResolvedValue({ value: { summary: "unused" }, degraded: false });
    await seed(ids.character, 60); // < 70 (the trigger)

    await processChatSummary({ ownerId: authState.user.id, characterId: ids.character });

    expect(await loadChatSummary(authState.user.id, ids.character)).toBeNull();
    expect(generateChecked).not.toHaveBeenCalled();
  });
});

describe("enqueueChatSummary — the guard", () => {
  it("does not enqueue a second fold while one is already queued for the chat", async (t) => {
    if (!ready) return t.skip();
    // A queued job inserted directly (no runner kick), so the guard has something to see.
    await db()
      .insert(jobs)
      .values({ sessionId: null, type: "chat_summary", status: "queued", payload: { ownerId: authState.user.id, characterId: ids.character } });

    await enqueueChatSummary({ ownerId: authState.user.id, characterId: ids.character });

    expect(await chatSummaryJobs(ids.character)).toHaveLength(1);
  });
});

describe("DELETE /chat — clears the running summary", () => {
  it("drops the summary row alongside the messages", async (t) => {
    if (!ready) return t.skip();
    await seed(ids.character, 4);
    await db().insert(characterChatSummaries).values({
      ownerId: authState.user.id,
      characterId: ids.character,
      summary: "a recap to be cleared",
      watermarkAt: new Date(1_700_000_000_000),
      watermarkId: "wm-placeholder",
      coveredExchanges: 2,
    });

    const res = await chatDelete(new NextRequest(`http://t/api/characters/${ids.character}/chat`, { method: "DELETE" }), {
      params: Promise.resolve({ id: ids.character }),
    });
    expect(res.status).toBe(200);
    expect(await loadChatSummary(authState.user.id, ids.character)).toBeNull();
  });
});
