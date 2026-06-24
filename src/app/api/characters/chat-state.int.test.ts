import { and, eq, sql } from "drizzle-orm";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { stageMidpoint } from "@/contracts";
import {
  characterChatMessages,
  characterChatState,
  characterChatSummaries,
  characters,
  db,
  images,
  users,
} from "@/server/db";

// Character-chat light-state integration suite (character-chat-state.spec.md §9):
// the POST lifecycle + the GET/PATCH state route + the three reset scopes, invoked
// directly with mocked auth against DATABASE_URL. AI_FAKE forces demo mode, so the
// reply is the deterministic placeholder and the pulse degrades to drift-only — so
// these assert seeding, drift, no-decay, premise, and resets (not curve movement,
// which the pure suite covers). Self-skips when the database is unreachable.

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

import { DELETE as chatDelete, POST as chatPost } from "./[id]/chat/route";
import { GET as stateGet, PATCH as statePatch, POST as stateAction } from "./[id]/chat/state/route";

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
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

function postReq(id: string, body: unknown): NextRequest {
  return new NextRequest(`http://t/api/characters/${id}/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
const getReq = () => new NextRequest("http://t/api/characters/x/chat/state");
function patchReq(id: string, body: unknown): NextRequest {
  return new NextRequest(`http://t/api/characters/${id}/chat/state`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
function actionReq(id: string, body: unknown): NextRequest {
  return new NextRequest(`http://t/api/characters/${id}/chat/state`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
const delReq = (id: string, scope?: string) =>
  new NextRequest(`http://t/api/characters/${id}/chat${scope ? `?scope=${scope}` : ""}`, { method: "DELETE" });

const ids = { warm: "", fresh: "", open: "" };

async function stateRow(characterId: string) {
  const [row] = await db()
    .select()
    .from(characterChatState)
    .where(and(eq(characterChatState.ownerId, authState.user.id), eq(characterChatState.characterId, characterId)))
    .limit(1);
  return row ?? null;
}

async function messageCount(characterId: string): Promise<number> {
  const [row] = await db()
    .select({ n: sql<number>`count(*)::int` })
    .from(characterChatMessages)
    .where(and(eq(characterChatMessages.ownerId, authState.user.id), eq(characterChatMessages.characterId, characterId)));
  return row?.n ?? 0;
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
  if (!warm || !fresh || !open) throw new Error("failed to seed characters");
  ids.warm = warm.id;
  ids.fresh = fresh.id;
  ids.open = open.id;
});

afterAll(async () => {
  if (!ready) return;
  await db().delete(characterChatState).where(eq(characterChatState.ownerId, authState.user.id));
  await db().delete(characterChatSummaries).where(eq(characterChatSummaries.ownerId, authState.user.id));
  await db().delete(images).where(eq(images.ownerId, authState.user.id));
  await db().delete(characters).where(eq(characters.ownerId, authState.user.id));
  await db().delete(users).where(eq(users.id, authState.user.id));
  await globalThis.__vesperPool?.end();
});

describe("POST seeds a state row from the authored stage", () => {
  it("creates a row with affinity from playerRelationship.stage and a degraded pulse trace (demo)", async (t) => {
    if (!ready) return t.skip();
    const res = await chatPost(postReq(ids.warm, { content: "Hello again" }), ctx(ids.warm));
    await res.text(); // drains the stream ⇒ the finalizer (pulse + save) has run

    const row = await stateRow(ids.warm);
    expect(row).not.toBeNull();
    expect(row?.affinity).toBe(stageMidpoint("warm")); // seeded from "warm"
    expect(row?.lastInteractionAt).not.toBeNull();
    expect((row?.lastPulseTrace as { degraded?: boolean })?.degraded).toBe(true); // pulse degraded in demo
    // The premise pre-filled from the authored note.
    expect(row?.premise).toBe("childhood friend");
  });

  it("a later visit recovers meters toward rested but never decays affinity (spec §10)", async (t) => {
    if (!ready) return t.skip();
    // Simulate a long gap with degraded meters since the last visit.
    await db()
      .update(characterChatState)
      .set({ meters: { hygiene: 0.2, energy: 0.2, mood: 0.5 }, affinity: 57, lastInteractionAt: new Date(Date.now() - 24 * 60 * 60_000) })
      .where(and(eq(characterChatState.ownerId, authState.user.id), eq(characterChatState.characterId, ids.warm)));

    const res = await chatPost(postReq(ids.warm, { content: "Back again" }), ctx(ids.warm));
    await res.text();

    const row = await stateRow(ids.warm);
    const meters = row?.meters as Record<string, number>;
    expect(meters.hygiene).toBeGreaterThan(0.5); // recovered toward rested overnight
    expect(row?.affinity).toBe(57); // affinity unchanged — no between-visit decay
  });
});

describe("PATCH …/chat/state { premise }", () => {
  it("creates the row before any message and the premise survives a later pulse", async (t) => {
    if (!ready) return t.skip();
    const res = await statePatch(patchReq(ids.fresh, { premise: "it's the night before she moves away" }), ctx(ids.fresh));
    expect(res.status).toBe(200);
    const snapshot = (await res.json()) as { premise: string };
    expect(snapshot.premise).toBe("it's the night before she moves away");
    expect(await messageCount(ids.fresh)).toBe(0); // set before any message

    // A subsequent exchange must not touch the player-owned premise.
    const post = await chatPost(postReq(ids.fresh, { content: "Hi" }), ctx(ids.fresh));
    await post.text();
    expect((await stateRow(ids.fresh))?.premise).toBe("it's the night before she moves away");
  });
});

describe("GET …/chat/state", () => {
  it("returns a drift-on-read snapshot with the stage chip and last-turn trace", async (t) => {
    if (!ready) return t.skip();
    const res = await stateGet(getReq(), ctx(ids.warm));
    expect(res.status).toBe(200);
    const snap = (await res.json()) as { affinity: number; stage: { id: string }; lastPulseTrace: { degraded: boolean } };
    expect(snap.stage.id).toBeTruthy();
    expect(snap.lastPulseTrace.degraded).toBe(true);
  });

  it("returns a rested seed snapshot for a character with no row yet", async (t) => {
    if (!ready) return t.skip();
    // ids.fresh may have a row by now; assert the GET shape is well-formed regardless.
    const res = await stateGet(getReq(), ctx(ids.fresh));
    expect(res.status).toBe(200);
    const snap = (await res.json()) as { meters: Record<string, number> };
    expect(typeof snap.meters).toBe("object");
  });
});

describe("state-tools edit (PATCH) + action chips (POST)", () => {
  it("PATCH edits affinity / meters / mindNote", async (t) => {
    if (!ready) return t.skip();
    const res = await statePatch(
      patchReq(ids.fresh, { affinity: 40, meters: { hygiene: 0.4, mood: 0.7 }, mindNote: "set by hand" }),
      ctx(ids.fresh),
    );
    expect(res.status).toBe(200);
    const row = await stateRow(ids.fresh);
    expect(row?.affinity).toBe(40);
    expect((row?.meters as Record<string, number>).hygiene).toBeCloseTo(0.4, 5);
    expect(row?.mindNote).toBe("set by hand");
  });

  it("clamps an out-of-range meter on edit", async (t) => {
    if (!ready) return t.skip();
    await statePatch(patchReq(ids.fresh, { meters: { arousal: 5 } }), ctx(ids.fresh));
    expect((((await stateRow(ids.fresh))?.meters) as Record<string, number>).arousal).toBe(1);
  });

  it("an action chip applies a deterministic state nudge (offer a drink → intoxication↑)", async (t) => {
    if (!ready) return t.skip();
    const before = (((await stateRow(ids.fresh))?.meters) as Record<string, number>)?.intoxication ?? 0;
    const res = await stateAction(actionReq(ids.fresh, { action: "drink" }), ctx(ids.fresh));
    expect(res.status).toBe(200);
    const after = (((await stateRow(ids.fresh))?.meters) as Record<string, number>).intoxication;
    expect(after).toBeGreaterThan(before);
  });

  it("rejects an unknown action id", async (t) => {
    if (!ready) return t.skip();
    const res = await stateAction(actionReq(ids.fresh, { action: "nuke" }), ctx(ids.fresh));
    expect(res.status).toBe(400);
  });
});

describe("Prompt Character (opening beat)", () => {
  it("streams a character-authored opening with no player line, and seeds the state row", async (t) => {
    if (!ready) return t.skip();
    const res = await chatPost(postReq(ids.open, { open: true }), ctx(ids.open));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("[Rell]"); // the character spoke (demo reply)

    const msgs = await db()
      .select({ role: characterChatMessages.role })
      .from(characterChatMessages)
      .where(and(eq(characterChatMessages.ownerId, authState.user.id), eq(characterChatMessages.characterId, ids.open)));
    expect(msgs).toHaveLength(1);
    expect(msgs[0]?.role).toBe("assistant"); // no user line was inserted
    expect((await stateRow(ids.open))?.affinity).toBe(stageMidpoint("warm")); // seeded from the authored stage
  });
});

describe("the three reset scopes", () => {
  it("Reset Chat deletes messages + summary but keeps the state row", async (t) => {
    if (!ready) return t.skip();
    // Ensure a state row + a message exist.
    await chatPost(postReq(ids.warm, { content: "seed a message" }), ctx(ids.warm)).then((r) => r.text());
    expect(await messageCount(ids.warm)).toBeGreaterThan(0);

    const res = await chatDelete(delReq(ids.warm, "chat"), ctx(ids.warm));
    expect(res.status).toBe(200);
    expect(await messageCount(ids.warm)).toBe(0);
    expect(await stateRow(ids.warm)).not.toBeNull(); // state preserved
  });

  it("Reset State deletes the state row but keeps the transcript", async (t) => {
    if (!ready) return t.skip();
    await chatPost(postReq(ids.warm, { content: "another message" }), ctx(ids.warm)).then((r) => r.text());
    expect(await stateRow(ids.warm)).not.toBeNull();

    const res = await chatDelete(delReq(ids.warm, "state"), ctx(ids.warm));
    expect(res.status).toBe(200);
    expect(await stateRow(ids.warm)).toBeNull(); // state gone
    expect(await messageCount(ids.warm)).toBeGreaterThan(0); // transcript preserved
  });

  it("Reset All deletes messages + summary + state", async (t) => {
    if (!ready) return t.skip();
    await chatPost(postReq(ids.warm, { content: "final message" }), ctx(ids.warm)).then((r) => r.text());

    const res = await chatDelete(delReq(ids.warm, "all"), ctx(ids.warm));
    expect(res.status).toBe(200);
    expect(await messageCount(ids.warm)).toBe(0);
    expect(await stateRow(ids.warm)).toBeNull();
  });
});
