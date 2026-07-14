import { eq, inArray, sql } from "drizzle-orm";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { newId } from "@/lib/ids";
import { characterChats, characters, chatParticipants, db, episodes, events, facts, images, users } from "@/server/db";

// Admin chat-inspector integration suite (character-chat-standalone.spec.md §6.1):
// the /api/admin/chat-inspector/[chatId] route family invoked directly with mocked
// auth against DATABASE_URL. AI_FAKE forces demo mode, so every embed is the
// deterministic pseudo embedder — no provider key or network. The mocked user is
// role "admin", so the role gate (404 for non-admins — asserted below) stays open.
// Self-skips when the database is unreachable.

process.env.AI_FAKE = "1";

const authState = vi.hoisted(() => ({
  user: { id: "", email: "", name: "Inspector Int", role: "admin" as "admin" | "user" },
}));

vi.mock("@/server/auth", () => ({
  USER_COOKIE: "vesper_user",
  getCurrentUser: async () => authState.user,
  ensureDefaultUser: async () => authState.user,
  listUsers: async () => [authState.user],
}));

import { recordAgentFailure } from "@/server/ai";
import { POST as chatsCreate } from "../../chats/route";
import { GET as inspectorGet } from "./[chatId]/route";
import { GET as failuresGet } from "./[chatId]/agent-failures/route";
import { GET as promptGet } from "./[chatId]/prompt/route";
import { POST as factCreate } from "./[chatId]/facts/route";
import { PATCH as factPatch } from "./[chatId]/facts/[factId]/route";
import { DELETE as episodeDelete, PATCH as episodePatch } from "./[chatId]/episodes/[episodeId]/route";
import { GET as scoreGet } from "./[chatId]/episodes/score/route";
import { PATCH as summaryPatch } from "./[chatId]/summary/route";

async function probe(): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      db().execute(sql`select 1 from character_chats limit 1`),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("connect timeout")), 4000);
      }),
    ]);
    return true;
  } catch (err) {
    process.stderr.write(
      `[chat-inspector.int.test] skipping: database unreachable: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return false;
  } finally {
    clearTimeout(timer);
  }
}

const ready = await probe();
const collectionCtx = { params: Promise.resolve({}) };
const ctx = (chatId: string) => ({ params: Promise.resolve({ chatId }) });
const factCtx = (chatId: string, factId: string) => ({ params: Promise.resolve({ chatId, factId }) });
const episodeCtx = (chatId: string, episodeId: string) => ({ params: Promise.resolve({ chatId, episodeId }) });

function jsonReq(path: string, method: string, body: unknown): NextRequest {
  return new NextRequest(`http://t${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
const getReq = (path: string) => new NextRequest(`http://t${path}`);
const delReq = (path: string) => new NextRequest(`http://t${path}`, { method: "DELETE" });

/** Create a conversation through the real POST /api/chats handler. */
async function createChat(characterId: string): Promise<{ id: string; memoryGroupId: string }> {
  const res = await chatsCreate(jsonReq("/api/chats", "POST", { characterIds: [characterId], memory: "fresh" }), collectionCtx);
  if (res.status !== 201) throw new Error(`chat create failed: ${res.status}`);
  return (await res.json()) as { id: string; memoryGroupId: string };
}

interface OverviewFact {
  id: string;
  origin: string;
  pinned: boolean;
  status: string;
  subjectName: string;
  confidence: number;
  supersededById: string | null;
  text: string;
}

async function overviewFor(chatId: string) {
  const res = await inspectorGet(getReq(`/api/admin/chat-inspector/${chatId}`), ctx(chatId));
  expect(res.status).toBe(200);
  return (await res.json()) as {
    facts: OverviewFact[];
    episodes: { id: string; turnNumber: number; summary: string; embedded: boolean }[];
    summary: { summary: string; watermarkAt: string | null; coveredExchanges: number } | null;
    character: { id: string; name: string };
  };
}

const ids = { character: "", chat: "", memoryGroupId: "", otherUser: "", otherCharacter: "", otherChat: "" };
/** Memory groups this suite wrote facts/episodes into (cleaned in afterAll — no FK cascade). */
const plantedGroups: string[] = [];

beforeAll(async () => {
  if (!ready) return;
  const stamp = Date.now();
  const [user] = await db()
    .insert(users)
    .values({ email: `inspector-int-${stamp}@test.local`, name: "Inspector Int", role: "admin" })
    .returning();
  const [other] = await db().insert(users).values({ email: `inspector-int-other-${stamp}@test.local`, name: "Other" }).returning();
  if (!user || !other) throw new Error("failed to create test users");
  authState.user = { ...authState.user, id: user.id, email: user.email };
  ids.otherUser = other.id;

  const [character] = await db().insert(characters).values({ ownerId: user.id, name: "Mara", profile: {} }).returning();
  const [otherCharacter] = await db().insert(characters).values({ ownerId: other.id, name: "NotYours", profile: {} }).returning();
  if (!character || !otherCharacter) throw new Error("failed to seed characters");
  ids.character = character.id;
  ids.otherCharacter = otherCharacter.id;

  const chat = await createChat(ids.character);
  ids.chat = chat.id;
  ids.memoryGroupId = chat.memoryGroupId;
  plantedGroups.push(chat.memoryGroupId);

  // The other user's conversation is seeded directly — the mocked auth is pinned
  // to the main user, so the create handler can't act as them.
  const [otherChat] = await db().insert(characterChats).values({ ownerId: other.id }).returning({ id: characterChats.id });
  if (!otherChat) throw new Error("failed to seed foreign chat");
  await db().insert(chatParticipants).values({ chatId: otherChat.id, characterId: otherCharacter.id, memoryGroupId: newId() });
  ids.otherChat = otherChat.id;
});

afterAll(async () => {
  if (!ready) return;
  // Facts/episodes have no FK to chats (purge is app-level in deleteChat), so
  // rows written through this suite's handlers need explicit cleanup.
  if (plantedGroups.length) {
    await db().delete(facts).where(inArray(facts.chatMemoryGroupId, plantedGroups));
    await db().delete(episodes).where(inArray(episodes.chatMemoryGroupId, plantedGroups));
  }
  // Agent-failure events are chat-scoped only in their PAYLOAD (the chat lane has no session
  // id), so nothing cascades them — without this they'd survive the suite and inflate the
  // next run's global tally with failures that never happened.
  await db()
    .delete(events)
    .where(sql`${events.type} = 'agent_failure' and ${events.payload} ->> 'chatId' in (${ids.chat}, ${ids.otherChat})`);
  // images.owner_id has no ON DELETE cascade, so clear test assets before users;
  // chats own the transcript/state/summary cascades and users FK them (no cascade).
  await db().delete(images).where(eq(images.ownerId, authState.user.id));
  await db().delete(images).where(eq(images.ownerId, ids.otherUser));
  await db().delete(characterChats).where(eq(characterChats.ownerId, authState.user.id));
  await db().delete(characterChats).where(eq(characterChats.ownerId, ids.otherUser));
  await db().delete(characters).where(eq(characters.ownerId, authState.user.id));
  await db().delete(characters).where(eq(characters.ownerId, ids.otherUser));
  await db().delete(users).where(eq(users.id, authState.user.id));
  await db().delete(users).where(eq(users.id, ids.otherUser));
  await globalThis.__vesperPool?.end();
});

/** The dev fact minted in the first test, exercised by the toggle/retract tests after it. */
let devFactId = "";

describe("POST /api/admin/chat-inspector/:chatId/facts (spec §6.1)", () => {
  it("creates a dev fact that the overview lists with origin 'dev', confidence 1, subject defaulted", async (t) => {
    if (!ready) return t.skip();
    const res = await factCreate(
      jsonReq(`/api/admin/chat-inspector/${ids.chat}/facts`, "POST", {
        text: "the player always brings mara tea",
        pinned: true,
      }),
      ctx(ids.chat),
    );
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    expect(id).toBeTruthy();
    devFactId = id;

    const overview = await overviewFor(ids.chat);
    const fact = overview.facts.find((f) => f.id === id);
    expect(fact).toBeDefined();
    expect(fact?.origin).toBe("dev");
    expect(fact?.pinned).toBe(true);
    expect(fact?.confidence).toBe(1);
    expect(fact?.subjectName).toBe("mara"); // defaulted to the character, lowercased by addFacts
    expect(overview.character).toEqual({ id: ids.character, name: "Mara" });
  });
});

describe("PATCH /api/admin/chat-inspector/:chatId/facts/:factId", () => {
  it("round-trips the pinned toggle", async (t) => {
    if (!ready) return t.skip();
    const off = await factPatch(
      jsonReq(`/api/admin/chat-inspector/${ids.chat}/facts/${devFactId}`, "PATCH", { pinned: false }),
      factCtx(ids.chat, devFactId),
    );
    expect(off.status).toBe(200);
    expect(((await off.json()) as { fact: { pinned: boolean } }).fact.pinned).toBe(false);

    const on = await factPatch(
      jsonReq(`/api/admin/chat-inspector/${ids.chat}/facts/${devFactId}`, "PATCH", { pinned: true }),
      factCtx(ids.chat, devFactId),
    );
    expect(on.status).toBe(200);
    expect(((await on.json()) as { fact: { pinned: boolean } }).fact.pinned).toBe(true);

    const overview = await overviewFor(ids.chat);
    expect(overview.facts.find((f) => f.id === devFactId)?.pinned).toBe(true);
  });

  it("retracts, then restores — restore also clears supersedence marks", async (t) => {
    if (!ready) return t.skip();
    const retract = await factPatch(
      jsonReq(`/api/admin/chat-inspector/${ids.chat}/facts/${devFactId}`, "PATCH", { status: "retracted" }),
      factCtx(ids.chat, devFactId),
    );
    expect(retract.status).toBe(200);
    expect((await overviewFor(ids.chat)).facts.find((f) => f.id === devFactId)?.status).toBe("retracted");

    // Plant supersedence marks directly so restore has something to clear.
    await db()
      .update(facts)
      .set({ status: "superseded", supersededById: "some-newer-fact", supersededAt: new Date() })
      .where(eq(facts.id, devFactId));

    const restore = await factPatch(
      jsonReq(`/api/admin/chat-inspector/${ids.chat}/facts/${devFactId}`, "PATCH", { status: "active" }),
      factCtx(ids.chat, devFactId),
    );
    expect(restore.status).toBe(200);
    const restored = ((await restore.json()) as { fact: OverviewFact }).fact;
    expect(restored.status).toBe("active");
    expect(restored.supersededById).toBeNull();

    const overview = await overviewFor(ids.chat);
    const fact = overview.facts.find((f) => f.id === devFactId);
    expect(fact?.status).toBe("active");
    expect(fact?.supersededById).toBeNull();
  });

  it("edits fact text through the re-embed path and reports no degrade in demo mode", async (t) => {
    if (!ready) return t.skip();
    const res = await factPatch(
      jsonReq(`/api/admin/chat-inspector/${ids.chat}/facts/${devFactId}`, "PATCH", {
        text: "the player switched from tea to coffee",
      }),
      factCtx(ids.chat, devFactId),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { fact: OverviewFact; embedDegraded: boolean };
    expect(body.fact.text).toBe("the player switched from tea to coffee");
    expect(body.embedDegraded).toBe(false); // pseudo embedder never fails
  });
});

describe("PATCH + DELETE /api/admin/chat-inspector/:chatId/episodes/:episodeId", () => {
  it("edits an episode summary (re-embedding it), scores it against a query, then hard-deletes it", async (t) => {
    if (!ready) return t.skip();
    const [row] = await db()
      .insert(episodes)
      .values({ chatMemoryGroupId: ids.memoryGroupId, turnNumber: 1, summary: "she asked about the weather" })
      .returning({ id: episodes.id });
    if (!row) throw new Error("failed to seed episode");

    const res = await episodePatch(
      jsonReq(`/api/admin/chat-inspector/${ids.chat}/episodes/${row.id}`, "PATCH", {
        summary: "she confessed her fear of storms",
      }),
      episodeCtx(ids.chat, row.id),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { episode: { id: string; summary: string; embedded: boolean }; embedDegraded: boolean };
    expect(body.episode.summary).toBe("she confessed her fear of storms");
    expect(body.episode.embedded).toBe(true); // the edit re-embedded (pseudo embedder)
    expect(body.embedDegraded).toBe(false);
    expect((await overviewFor(ids.chat)).episodes.find((e) => e.id === row.id)?.summary).toBe(
      "she confessed her fear of storms",
    );

    // The re-embedded row is scoreable against a test query (embedder-matched).
    const score = await scoreGet(
      getReq(`/api/admin/chat-inspector/${ids.chat}/episodes/score?q=storms`),
      ctx(ids.chat),
    );
    expect(score.status).toBe(200);
    const scored = (await score.json()) as { scores: { id: string; score: number }[]; degraded: boolean };
    expect(scored.degraded).toBe(false);
    expect(scored.scores.some((s) => s.id === row.id && typeof s.score === "number")).toBe(true);

    const del = await episodeDelete(
      delReq(`/api/admin/chat-inspector/${ids.chat}/episodes/${row.id}`),
      episodeCtx(ids.chat, row.id),
    );
    expect(del.status).toBe(200);
    expect((await overviewFor(ids.chat)).episodes.some((e) => e.id === row.id)).toBe(false);
  });
});

describe("PATCH /api/admin/chat-inspector/:chatId/summary", () => {
  it("upserts the rolling summary without touching the watermark, and the overview round-trips it", async (t) => {
    if (!ready) return t.skip();
    const res = await summaryPatch(
      jsonReq(`/api/admin/chat-inspector/${ids.chat}/summary`, "PATCH", { summary: "A quiet evening of confessions." }),
      ctx(ids.chat),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { summary: string; watermarkAt: string | null; coveredExchanges: number };
    expect(body.summary).toBe("A quiet evening of confessions.");
    expect(body.watermarkAt).toBeNull(); // never touched by the dev edit
    expect(body.coveredExchanges).toBe(0);

    const overview = await overviewFor(ids.chat);
    expect(overview.summary?.summary).toBe("A quiet evening of confessions.");
    expect(overview.summary?.watermarkAt).toBeNull();
  });
});

describe("GET /api/admin/chat-inspector/:chatId/prompt", () => {
  it("rebuilds the narrator prompt preview", async (t) => {
    if (!ready) return t.skip();
    const res = await promptGet(getReq(`/api/admin/chat-inspector/${ids.chat}/prompt`), ctx(ids.chat));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      prefix: string;
      tail: string;
      memory: { facts: string[]; episodes: string[] };
      memoryQueries: string[];
    };
    expect(body.prefix).toContain("Mara"); // the character's own prompt
    expect(typeof body.tail).toBe("string");
    expect(Array.isArray(body.memoryQueries)).toBe(true);
  });
});

describe("ownership (never 403 — a foreign chat is invisible)", () => {
  it("404s the family for a chat the user does not own", async (t) => {
    if (!ready) return t.skip();
    const get = await inspectorGet(getReq(`/api/admin/chat-inspector/${ids.otherChat}`), ctx(ids.otherChat));
    expect(get.status).toBe(404);

    const create = await factCreate(
      jsonReq(`/api/admin/chat-inspector/${ids.otherChat}/facts`, "POST", { text: "planted into someone else's memory" }),
      ctx(ids.otherChat),
    );
    expect(create.status).toBe(404);
  });
});

describe("role gate (admin-only — 404 for non-admins, even on their own chat)", () => {
  it("404s the overview and a write for role 'user', then reopens for 'admin'", async (t) => {
    if (!ready) return t.skip();
    authState.user = { ...authState.user, role: "user" };
    try {
      const get = await inspectorGet(getReq(`/api/admin/chat-inspector/${ids.chat}`), ctx(ids.chat));
      expect(get.status).toBe(404);
      const create = await factCreate(
        jsonReq(`/api/admin/chat-inspector/${ids.chat}/facts`, "POST", { text: "should never land" }),
        ctx(ids.chat),
      );
      expect(create.status).toBe(404);
    } finally {
      authState.user = { ...authState.user, role: "admin" };
    }
    const reopened = await inspectorGet(getReq(`/api/admin/chat-inspector/${ids.chat}`), ctx(ids.chat));
    expect(reopened.status).toBe(200);
  });
});

/**
 * Agent health (contracts/turns/agent-failure.ts): the whole loop — a leg failure recorded
 * through `recordAgentFailure` must come back as a tallied row on the inspector route, with
 * its suspected cause. A silent leg failure is exactly what this surface exists to catch.
 */
describe("agent-failure telemetry (recorded → tallied → readable)", () => {
  it("reports a recorded failure for this chat, tallied by leg and cause", async (t) => {
    if (!ready) return t.skip();
    recordAgentFailure({
      legId: "chat_continuity",
      chatId: ids.chat,
      messageId: "msg-int-1",
      kind: "timeout",
      timeoutMs: 6000,
      modelId: "some/agent-model",
      promptChars: 30_000,
      maxOutputTokens: 400,
    });
    // Fire-and-forget by design (a failed record must never cost a turn), so the write is
    // not awaited by the caller — wait for it here before reading it back.
    await vi.waitFor(async () => {
      const res = await failuresGet(getReq(`/api/admin/chat-inspector/${ids.chat}/agent-failures`), ctx(ids.chat));
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        days: number;
        chat: { total: number; recent: { legId: string; cause: string; chatId: string | null }[]; byLeg: { key: string; count: number }[] };
      };
      expect(body.chat.total).toBeGreaterThanOrEqual(1);
      const mine = body.chat.recent.find((f) => f.legId === "chat_continuity");
      expect(mine).toBeDefined();
      // The classifier ran on the way in: a 30k-char prompt is what blew the budget.
      expect(mine?.cause).toBe("prompt_too_large");
      expect(body.chat.byLeg.some((r) => r.key === "chat_continuity")).toBe(true);
    });
  });

  it("does not attribute another chat's failures to this one", async (t) => {
    if (!ready) return t.skip();
    recordAgentFailure({ legId: "chat_state.pulse", chatId: ids.otherChat, kind: "api_error", providerCode: "rate_limited" });
    await vi.waitFor(async () => {
      const res = await failuresGet(getReq(`/api/admin/chat-inspector/${ids.chat}/agent-failures`), ctx(ids.chat));
      const body = (await res.json()) as {
        chat: { recent: { legId: string }[] };
        global: { total: number; byCause: { key: string; count: number }[] };
      };
      // The other chat's pulse failure is absent HERE…
      expect(body.chat.recent.some((f) => f.legId === "chat_state.pulse")).toBe(false);
      // …but present in the all-conversations tally, which is the point of having both.
      expect(body.global.byCause.some((r) => r.key === "rate_limited")).toBe(true);
    });
  });

  it("404s for a non-admin", async (t) => {
    if (!ready) return t.skip();
    authState.user = { ...authState.user, role: "user" };
    try {
      const res = await failuresGet(getReq(`/api/admin/chat-inspector/${ids.chat}/agent-failures`), ctx(ids.chat));
      expect(res.status).toBe(404);
    } finally {
      authState.user = { ...authState.user, role: "admin" };
    }
  });
});
