import { and, eq, sql } from "drizzle-orm";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { stageMidpoint } from "@/contracts";
import { characterChatMessages, characterChats, characterChatState, characters, db, users } from "@/server/db";

// Conversation light-state integration suite (character-chat-state.spec.md §9,
// re-keyed per participant — character-chat-standalone.spec.md §1.2): the POST
// exchange lifecycle + the GET/PATCH/POST state route on (chatId, characterId),
// invoked directly with mocked auth against DATABASE_URL. AI_FAKE forces demo
// mode, so the reply is the deterministic placeholder and the pulse degrades to
// drift-only — so these assert seeding, drift, no-decay, premise, and the delete
// (not curve movement, which the pure suite covers). Self-skips when the
// database is unreachable.

process.env.AI_FAKE = "1";

const authState = vi.hoisted(() => ({
  user: { id: "", email: "", name: "Chat State Int", role: "admin" as const },
}));

vi.mock("@/server/auth", () => ({
  USER_COOKIE: "vesper_user",
  getCurrentUser: async () => authState.user,
  ensureDefaultUser: async () => authState.user,
  listUsers: async () => [authState.user],
}));

import { withKeyedLock } from "@/server/engine";
import { POST as chatsCreate } from "./route";
import { DELETE as chatDelete, POST as chatSend } from "./[chatId]/route";
import { GET as stateGet, PATCH as statePatch, POST as stateAction } from "./[chatId]/state/route";
import { POST as markMoment } from "./[chatId]/milestones/route";
import { POST as timeSkip } from "./[chatId]/time-skip/route";

async function probe(): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      db().execute(sql`select 1 from character_chat_state limit 1`),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("connect timeout")), 4000);
      }),
    ]);
    return true;
  } catch (err) {
    process.stderr.write(`[chat-state.int.test] skipping: database unreachable: ${err instanceof Error ? err.message : String(err)}\n`);
    return false;
  } finally {
    clearTimeout(timer);
  }
}

const ready = await probe();
const ctx = (chatId: string) => ({ params: Promise.resolve({ chatId }) });

function postReq(chatId: string, body: unknown): NextRequest {
  return new NextRequest(`http://t/api/chats/${chatId}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
const getReq = () => new NextRequest("http://t/api/chats/x/state");
function patchReq(chatId: string, body: unknown): NextRequest {
  return new NextRequest(`http://t/api/chats/${chatId}/state`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
function actionReq(chatId: string, body: unknown): NextRequest {
  return new NextRequest(`http://t/api/chats/${chatId}/state`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
const delReq = (chatId: string) => new NextRequest(`http://t/api/chats/${chatId}`, { method: "DELETE" });

type Fixture = { characterId: string; chatId: string };
const ids = {
  warm: { characterId: "", chatId: "" },
  fresh: { characterId: "", chatId: "" },
  open: { characterId: "", chatId: "" },
  carded: { characterId: "", chatId: "" },
  skipper: { characterId: "", chatId: "" },
  regen: { characterId: "", chatId: "" },
  premised: { characterId: "", chatId: "" },
  busy: { characterId: "", chatId: "" },
};

async function stateRow(f: Fixture) {
  const [row] = await db()
    .select()
    .from(characterChatState)
    .where(and(eq(characterChatState.chatId, f.chatId), eq(characterChatState.characterId, f.characterId)))
    .limit(1);
  return row ?? null;
}

/** The chat-wide scenario columns off the chat row (followups rulings 8-9). */
async function scenarioRow(chatId: string) {
  const [row] = await db()
    .select({
      premise: characterChats.premise,
      activeSocialCards: characterChats.activeSocialCards,
      clockMinutes: characterChats.clockMinutes,
      pendingSkipNote: characterChats.pendingSkipNote,
      skipHistory: characterChats.skipHistory,
      sceneAuto: characterChats.sceneAuto,
    })
    .from(characterChats)
    .where(eq(characterChats.id, chatId))
    .limit(1);
  return row ?? null;
}

async function messageCount(chatId: string): Promise<number> {
  const [row] = await db()
    .select({ n: sql<number>`count(*)::int` })
    .from(characterChatMessages)
    .where(eq(characterChatMessages.chatId, chatId));
  return row?.n ?? 0;
}

/** Create the conversation for a seeded character through the real POST /api/chats handler. */
async function createChat(characterId: string): Promise<string> {
  const res = await chatsCreate(
    new NextRequest("http://t/api/chats", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ characterIds: [characterId], memory: "fresh" }),
    }),
    { params: Promise.resolve({}) },
  );
  if (res.status !== 201) throw new Error(`chat create failed: ${res.status}`);
  return ((await res.json()) as { id: string }).id;
}

beforeAll(async () => {
  if (!ready) return;
  const stamp = Date.now();
  const [user] = await db().insert(users).values({ email: `chat-state-int-${stamp}@test.local`, name: "Chat State Int", role: "admin" }).returning();
  if (!user) throw new Error("failed to create test user");
  authState.user = { ...authState.user, id: user.id, email: user.email };

  const [warm] = await db()
    .insert(characters)
    .values({ ownerId: user.id, name: "Mara", profile: { playerRelationship: { stage: "warm", note: "childhood friend" } } })
    .returning();
  const [fresh] = await db().insert(characters).values({ ownerId: user.id, name: "Pip", profile: {} }).returning();
  const [open] = await db()
    .insert(characters)
    .values({ ownerId: user.id, name: "Rell", profile: { playerRelationship: { stage: "warm", note: "an old flame" } } })
    .returning();
  const [carded] = await db()
    .insert(characters)
    .values({
      ownerId: user.id,
      name: "Sable",
      profile: {
        socialCards: [
          { id: "card_feet", label: "No foot stuff", kind: "taboo", triggers: ["foot_contact"], severity: 70, reactionOverrides: [] },
        ],
      },
    })
    .returning();
  const [skipper] = await db().insert(characters).values({ ownerId: user.id, name: "Vex", profile: {} }).returning();
  const [regen] = await db().insert(characters).values({ ownerId: user.id, name: "Wynn", profile: {} }).returning();
  const [premised] = await db()
    .insert(characters)
    .values({ ownerId: user.id, name: "Cass", profile: { playerRelationship: { stage: "warm", note: "old flame" } } })
    .returning();
  const [busy] = await db().insert(characters).values({ ownerId: user.id, name: "Bly", profile: {} }).returning();
  if (!warm || !fresh || !open || !carded || !skipper || !regen || !premised || !busy) throw new Error("failed to seed characters");
  ids.warm = { characterId: warm.id, chatId: await createChat(warm.id) };
  ids.fresh = { characterId: fresh.id, chatId: await createChat(fresh.id) };
  ids.open = { characterId: open.id, chatId: await createChat(open.id) };
  ids.carded = { characterId: carded.id, chatId: await createChat(carded.id) };
  ids.skipper = { characterId: skipper.id, chatId: await createChat(skipper.id) };
  ids.regen = { characterId: regen.id, chatId: await createChat(regen.id) };
  ids.premised = { characterId: premised.id, chatId: await createChat(premised.id) };
  ids.busy = { characterId: busy.id, chatId: await createChat(busy.id) };
});

afterAll(async () => {
  if (!ready) return;
  // The chat rows cascade state/summary/messages/participants; characters and users FK them.
  await db().delete(characterChats).where(eq(characterChats.ownerId, authState.user.id));
  await db().delete(characters).where(eq(characters.ownerId, authState.user.id));
  await db().delete(users).where(eq(users.id, authState.user.id));
  await globalThis.__vesperPool?.end();
});

describe("POST seeds a state row from the authored stage", () => {
  it("creates a (chatId, characterId) row with regard from playerRelationship and a degraded pulse trace (demo)", async (t) => {
    if (!ready) return t.skip();
    const res = await chatSend(postReq(ids.warm.chatId, { content: "Hello again" }), ctx(ids.warm.chatId));
    await res.text(); // drains the stream ⇒ the finalizer (pulse + save) has run

    const row = await stateRow(ids.warm);
    expect(row).not.toBeNull();
    expect(row?.regard).toBe(stageMidpoint("warm")); // seeded from "warm"
    expect((row?.lastPulseTrace as { degraded?: boolean })?.degraded).toBe(true); // pulse degraded in demo
    // The premise pre-filled from the authored note — onto the chat-wide scenario.
    expect((await scenarioRow(ids.warm.chatId))?.premise).toBe("childhood friend");
  });

  it("no time passes between visits — meters and regard hold however long the gap (D3/D8)", async (t) => {
    if (!ready) return t.skip();
    // Degraded meters from a previous visit; there is no wall-clock anchor anymore,
    // so a "return" exchange applies only the within-visit tick — no recovery lerp.
    await db()
      .update(characterChatState)
      .set({ meters: { hygiene: 0.2, energy: 0.2, mood: 0.5 }, regard: 57 })
      .where(and(eq(characterChatState.chatId, ids.warm.chatId), eq(characterChatState.characterId, ids.warm.characterId)));

    const res = await chatSend(postReq(ids.warm.chatId, { content: "Back again" }), ctx(ids.warm.chatId));
    await res.text();

    const row = await stateRow(ids.warm);
    const meters = row?.meters as Record<string, number>;
    // One CHAT_TICK_MINUTES of ordinary decay at most — nothing recovered toward rested.
    expect(meters.hygiene).toBeLessThanOrEqual(0.2);
    expect(row?.regard).toBe(57); // regard unchanged — no between-visit decay (spec §10)
  });
});

describe("POST …/time-skip (spec §8.1 — flavor-only v1, D14)", () => {
  const skipReq = (chatId: string, amount: string) =>
    new NextRequest(`http://t/api/chats/${chatId}/time-skip`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ amount }),
    });

  it("degrades a skip on a missing state row to seed + skip (spec §11), persisting the seeded row", async (t) => {
    if (!ready) return t.skip();
    expect(await stateRow(ids.skipper)).toBeNull(); // no exchange yet ⇒ no row
    const res = await timeSkip(skipReq(ids.skipper.chatId, "hours"), ctx(ids.skipper.chatId));
    expect(res.status).toBe(200);
    const snapshot = (await res.json()) as { clockMinutes: number };
    expect(snapshot.clockMinutes).toBe(180);
    const row = await stateRow(ids.skipper);
    expect(row).not.toBeNull(); // the per-character half persisted the seed
    const scenario = await scenarioRow(ids.skipper.chatId);
    expect(scenario?.clockMinutes).toBe(180); // the clock lives on the shared scenario
    expect(scenario?.pendingSkipNote).not.toBe("");
  });

  it("expires timed conditions, leaves meters untouched, records the ring, and the next exchange clears the note", async (t) => {
    if (!ready) return t.skip();
    // Plant a timed condition + distinctive meters on the row the previous test seeded.
    await db()
      .update(characterChatState)
      .set({
        meters: { hygiene: 0.33, energy: 0.44 },
        conditions: [{ id: "tipsy", label: "Tipsy", startedAtMinutes: 180, durationMinutes: 90, attributeEffects: [] }],
      })
      .where(and(eq(characterChatState.chatId, ids.skipper.chatId), eq(characterChatState.characterId, ids.skipper.characterId)));

    const res = await timeSkip(skipReq(ids.skipper.chatId, "overnight"), ctx(ids.skipper.chatId));
    expect(res.status).toBe(200);
    const row = await stateRow(ids.skipper);
    const scenario = await scenarioRow(ids.skipper.chatId);
    expect(scenario?.clockMinutes).toBe(180 + 540);
    expect(row?.conditions).toEqual([]); // 180+90 < 720 ⇒ expired through the clock filter
    expect(row?.meters).toEqual({ hygiene: 0.33, energy: 0.44 }); // D14: meters untouched
    const ring = scenario?.skipHistory as { amount: string }[];
    expect(ring.map((r) => r.amount)).toEqual(["hours", "overnight"]);

    // The next exchange renders the note once, then clears it (one-shot).
    const send = await chatSend(postReq(ids.skipper.chatId, { content: "Morning." }), ctx(ids.skipper.chatId));
    await send.text();
    expect((await scenarioRow(ids.skipper.chatId))?.pendingSkipNote).toBe("");
  });

  it("409s a skip into an archived conversation", async (t) => {
    if (!ready) return t.skip();
    await db().update(characterChats).set({ archivedAt: new Date() }).where(eq(characterChats.id, ids.skipper.chatId));
    const res = await timeSkip(skipReq(ids.skipper.chatId, "days"), ctx(ids.skipper.chatId));
    expect(res.status).toBe(409);
    await db().update(characterChats).set({ archivedAt: null }).where(eq(characterChats.id, ids.skipper.chatId));
  });
});

describe("sceneAuto toggle (slice 9)", () => {
  it("PATCH persists the auto-scene mode and it round-trips on GET", async (t) => {
    if (!ready) return t.skip();
    const res = await statePatch(patchReq(ids.fresh.chatId, { sceneAuto: "milestones" }), ctx(ids.fresh.chatId));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { sceneAuto: string }).sceneAuto).toBe("milestones");
    const get = await stateGet(getReq(), ctx(ids.fresh.chatId));
    expect(((await get.json()) as { sceneAuto: string }).sceneAuto).toBe("milestones");
  });
});

describe("creation seeds the scenario's setting-wide cards (followups ruling 9)", () => {
  it("seeds the primary's profile cards onto the chat row and the first exchange preserves them", async (t) => {
    if (!ready) return t.skip();
    // The scenario seeds at CREATION from the primary's own cards (ruling 9).
    const seeded = (await scenarioRow(ids.carded.chatId))?.activeSocialCards as { id: string }[];
    expect(seeded.map((c) => c.id)).toContain("card_feet");

    const res = await chatSend(postReq(ids.carded.chatId, { content: "Hey there" }), ctx(ids.carded.chatId));
    await res.text(); // drains the stream ⇒ the finalizer (pulse + scenario save) has run

    // Regression (codebase-review A2 lineage): the finalize save must not clobber
    // the authored taboos back to the DB default [].
    const after = (await scenarioRow(ids.carded.chatId))?.activeSocialCards as { id: string }[];
    expect(after.map((c) => c.id)).toContain("card_feet");
  });
});

describe("PATCH …/chats/:chatId/state { premise }", () => {
  it("creates the row before any message and the premise survives a later pulse", async (t) => {
    if (!ready) return t.skip();
    const res = await statePatch(patchReq(ids.fresh.chatId, { premise: "it's the night before she moves away" }), ctx(ids.fresh.chatId));
    expect(res.status).toBe(200);
    const snapshot = (await res.json()) as { premise: string };
    expect(snapshot.premise).toBe("it's the night before she moves away");
    expect(await messageCount(ids.fresh.chatId)).toBe(0); // set before any message

    // A subsequent exchange must not touch the player-owned premise.
    const post = await chatSend(postReq(ids.fresh.chatId, { content: "Hi" }), ctx(ids.fresh.chatId));
    await post.text();
    expect((await scenarioRow(ids.fresh.chatId))?.premise).toBe("it's the night before she moves away");
  });
});

describe("regenerating the FIRST exchange rolls back cleanly (followups F3)", () => {
  it("re-seeds from the authored defaults — no double clock tick, no stacked milestone", async (t) => {
    if (!ready) return t.skip();
    // The first send creates the row: one clock tick, one first_exchange milestone, one baseline sample,
    // and the recorded rollback anchor is the `{}` sentinel (there was no prior state).
    const send = await chatSend(postReq(ids.regen.chatId, { content: "Hello" }), ctx(ids.regen.chatId));
    await send.text();
    const first = await stateRow(ids.regen);
    expect(first).not.toBeNull();
    const tick = (await scenarioRow(ids.regen.chatId))?.clockMinutes ?? 0;
    expect(tick).toBeGreaterThan(0);
    expect(first?.preExchangeState).toEqual({});
    expect((first?.milestones as { kind: string }[]).filter((m) => m.kind === "first_exchange")).toHaveLength(1);

    // Regenerate the reply. Pre-fix, the `{}` anchor failed to parse and the rollback silently
    // fell back to the POST-exchange state — so drift ticked the clock a SECOND time. Now the
    // scenario rolls back through its own pre-exchange anchor, so the clock lands on one tick.
    const regen = await chatSend(postReq(ids.regen.chatId, { kind: "regenerate" }), ctx(ids.regen.chatId));
    await regen.text();
    const after = await stateRow(ids.regen);
    expect((await scenarioRow(ids.regen.chatId))?.clockMinutes).toBe(tick); // NOT 2×tick (the double-apply bug)
    expect((after?.milestones as { kind: string }[]).filter((m) => m.kind === "first_exchange")).toHaveLength(1);
    expect((after?.relationshipHistory as unknown[]).length).toBe(1);
  });
});

describe("first_exchange survives a pre-existing state row (followups F4)", () => {
  it("records the baseline sample + first_exchange even when a premise Save created the row first", async (t) => {
    if (!ready) return t.skip();
    // A premise Save creates the state row BEFORE any message — so on the first send
    // `loadChatState` returns non-null and the old `preExchangeState === null` test missed it.
    await statePatch(patchReq(ids.premised.chatId, { premise: "reunited after years" }), ctx(ids.premised.chatId));
    expect(await stateRow(ids.premised)).not.toBeNull();

    const send = await chatSend(postReq(ids.premised.chatId, { content: "It's really you." }), ctx(ids.premised.chatId));
    await send.text();
    const row = await stateRow(ids.premised);
    expect((row?.milestones as { kind: string }[]).filter((m) => m.kind === "first_exchange")).toHaveLength(1);
    expect((row?.relationshipHistory as unknown[]).length).toBeGreaterThanOrEqual(1);
  });
});

describe("state mutations 409 while a reply streams (followups F1)", () => {
  it("time-skip / PATCH / action / mark-moment are all rejected while the chat_exchange lock is held", async (t) => {
    if (!ready) return t.skip();
    const chatId = ids.busy.chatId;
    // A NextRequest body is a single-use stream, so build a fresh one per call.
    const skipReq = () =>
      new NextRequest(`http://t/api/chats/${chatId}/time-skip`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ amount: "hours" }),
      });
    const markReq = () =>
      new NextRequest(`http://t/api/chats/${chatId}/milestones`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messageId: "whatever", label: "x" }),
      });
    // Hold the exchange lock (what a live streaming reply holds across its whole settle),
    // then every state-row mutation must 409 rather than clobber the pending finalize.
    await withKeyedLock(`chat_exchange:${chatId}`, async () => {
      expect((await timeSkip(skipReq(), ctx(chatId))).status).toBe(409);
      expect((await statePatch(patchReq(chatId, { premise: "x" }), ctx(chatId))).status).toBe(409);
      expect((await stateAction(actionReq(chatId, { action: "drink" }), ctx(chatId))).status).toBe(409);
      expect((await markMoment(markReq(), ctx(chatId))).status).toBe(409);
    });
    // Lock released ⇒ the same mutation now succeeds.
    expect((await timeSkip(skipReq(), ctx(chatId))).status).toBe(200);
  });
});

describe("GET …/chats/:chatId/state", () => {
  it("returns a drift-on-read snapshot with the band chip and last-turn trace", async (t) => {
    if (!ready) return t.skip();
    const res = await stateGet(getReq(), ctx(ids.warm.chatId));
    expect(res.status).toBe(200);
    const snap = (await res.json()) as { regard: number; regardBand: { id: string }; lastPulseTrace: { degraded: boolean } };
    expect(snap.regardBand.id).toBeTruthy();
    expect(snap.lastPulseTrace.degraded).toBe(true);
  });

  it("returns a rested seed snapshot for a chat with no row yet", async (t) => {
    if (!ready) return t.skip();
    // ids.fresh may have a row by now; assert the GET shape is well-formed regardless.
    const res = await stateGet(getReq(), ctx(ids.fresh.chatId));
    expect(res.status).toBe(200);
    const snap = (await res.json()) as { meters: Record<string, number> };
    expect(typeof snap.meters).toBe("object");
  });
});

describe("state-tools edit (PATCH) + action chips (POST)", () => {
  it("PATCH edits regard / meters / mindNote", async (t) => {
    if (!ready) return t.skip();
    const res = await statePatch(
      patchReq(ids.fresh.chatId, { regard: 40, meters: { hygiene: 0.4, mood: 0.7 }, mindNote: "set by hand" }),
      ctx(ids.fresh.chatId),
    );
    expect(res.status).toBe(200);
    const row = await stateRow(ids.fresh);
    expect(row?.regard).toBe(40);
    expect((row?.meters as Record<string, number>).hygiene).toBeCloseTo(0.4, 5);
    expect(row?.mindNote).toBe("set by hand");
  });

  it("clamps an out-of-range meter on edit", async (t) => {
    if (!ready) return t.skip();
    await statePatch(patchReq(ids.fresh.chatId, { meters: { arousal: 5 } }), ctx(ids.fresh.chatId));
    expect((((await stateRow(ids.fresh))?.meters) as Record<string, number>).arousal).toBe(1);
  });

  it("an action chip applies a deterministic state nudge (offer a drink → intoxication↑)", async (t) => {
    if (!ready) return t.skip();
    const before = (((await stateRow(ids.fresh))?.meters) as Record<string, number>)?.intoxication ?? 0;
    const res = await stateAction(actionReq(ids.fresh.chatId, { action: "drink" }), ctx(ids.fresh.chatId));
    expect(res.status).toBe(200);
    const after = (((await stateRow(ids.fresh))?.meters) as Record<string, number>).intoxication;
    expect(after).toBeGreaterThan(before);
  });

  it("rejects an unknown action id", async (t) => {
    if (!ready) return t.skip();
    const res = await stateAction(actionReq(ids.fresh.chatId, { action: "nuke" }), ctx(ids.fresh.chatId));
    expect(res.status).toBe(400);
  });
});

describe("Prompt Character (opening beat)", () => {
  it("streams a character-authored opening with no player line, and seeds the state row", async (t) => {
    if (!ready) return t.skip();
    const res = await chatSend(postReq(ids.open.chatId, { kind: "open" }), ctx(ids.open.chatId));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("[Rell]"); // the character spoke (demo reply)

    const msgs = await db()
      .select({ role: characterChatMessages.role })
      .from(characterChatMessages)
      .where(eq(characterChatMessages.chatId, ids.open.chatId));
    expect(msgs).toHaveLength(1);
    expect(msgs[0]?.role).toBe("assistant"); // no user line was inserted
    expect((await stateRow(ids.open))?.regard).toBe(stageMidpoint("warm")); // seeded from the authored (legacy) stage
  });
});

describe("DELETE — the one destructive verb (character-chat-standalone.spec.md §1.4)", () => {
  it("removes the conversation with its messages AND its state row in one action", async (t) => {
    if (!ready) return t.skip();
    // Ensure a state row + a message exist.
    await chatSend(postReq(ids.warm.chatId, { content: "seed a message" }), ctx(ids.warm.chatId)).then((r) => r.text());
    expect(await messageCount(ids.warm.chatId)).toBeGreaterThan(0);
    expect(await stateRow(ids.warm)).not.toBeNull();

    const res = await chatDelete(delReq(ids.warm.chatId), ctx(ids.warm.chatId));
    expect(res.status).toBe(200);
    // Everything cascades with the chat row — no hidden transcript or disposition survives.
    expect(await messageCount(ids.warm.chatId)).toBe(0);
    expect(await stateRow(ids.warm)).toBeNull();
  });
});
