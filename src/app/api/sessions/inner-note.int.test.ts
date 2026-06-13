import { and, eq, sql } from "drizzle-orm";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  characters,
  db,
  events,
  facts,
  jobs,
  locations,
  sessionParticipants,
  sessions,
  users,
  worldCast,
  worldLocations,
  worlds,
} from "@/server/db";

// Inner-note route + job suite (docs/testing.md §api): the handler is invoked
// directly with mocked auth; the enqueued inner_note job drains through the
// real in-process runner (demo mode ⇒ the degraded verbatim path, the same
// path a dead model takes — docs/resilience.md §6). Self-skips when the
// database is unreachable.

const authState = vi.hoisted(() => ({
  user: { id: "", email: "", name: "Brian", role: "admin" as "admin" | "user" },
}));

vi.mock("@/server/auth", () => ({
  USER_COOKIE: "vesper_user",
  getCurrentUser: async () => authState.user,
  ensureDefaultUser: async () => authState.user,
  listUsers: async () => [authState.user],
}));

import { createSessionFromWorld } from "@/server/engine";
import { POST as innerNoteRoute } from "./[id]/participants/[participantId]/inner-note/route";

async function probe(): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      db().execute(sql`select 1 from sessions limit 1`),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("connect timeout")), 4000);
      }),
    ]);
    return true;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[inner-note.int.test] skipping: database unreachable or unmigrated: ${reason}\n`);
    return false;
  } finally {
    clearTimeout(timer);
  }
}

const ready = await probe();
let ownerId = "";
let worldId = "";

function post(url: string, body?: unknown): NextRequest {
  return new NextRequest(url, {
    method: "POST",
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}
function ctx<P>(params: P): { params: Promise<P> } {
  return { params: Promise.resolve(params) };
}
async function json(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

async function submitNote(sessionId: string, participantId: string, text: string): Promise<Response> {
  return innerNoteRoute(
    post(`http://test/api/sessions/${sessionId}/participants/${participantId}/inner-note`, { text }),
    ctx({ id: sessionId, participantId }),
  );
}

async function waitForJob(jobId: string, timeoutMs = 20_000): Promise<typeof jobs.$inferSelect> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const [row] = await db().select().from(jobs).where(eq(jobs.id, jobId)).limit(1);
    if (row && row.status !== "queued" && row.status !== "running") return row;
    if (Date.now() > deadline) throw new Error(`inner_note job never settled: ${JSON.stringify(row)}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function spawn(title: string): Promise<{ sessionId: string; npcId: string; playerId: string }> {
  const created = await createSessionFromWorld({ worldId, userId: ownerId, title, embodied: true });
  if (!created) throw new Error("session spawn failed");
  const participants = await db()
    .select({ id: sessionParticipants.id, isUser: sessionParticipants.isUser })
    .from(sessionParticipants)
    .where(eq(sessionParticipants.sessionId, created.sessionId));
  const npc = participants.find((p) => !p.isUser);
  const player = participants.find((p) => p.isUser);
  if (!npc || !player) throw new Error("spawn produced no NPC or player participant");
  return { sessionId: created.sessionId, npcId: npc.id, playerId: player.id };
}

beforeAll(async () => {
  if (!ready) return;
  const [user] = await db()
    .insert(users)
    .values({ email: `inner-note-int-${Date.now()}@test.local`, name: "Brian", role: "admin" })
    .returning({ id: users.id });
  if (!user) throw new Error("user insert failed");
  ownerId = user.id;
  authState.user.id = ownerId;

  const [tearoom] = await db()
    .insert(locations)
    .values({ ownerId, name: "Tearoom", description: "A quiet tearoom." })
    .returning({ id: locations.id });
  if (!tearoom) throw new Error("location insert failed");

  const [fatima] = await db()
    .insert(characters)
    .values({ ownerId, name: "Fatima", profile: { bio: "Fatima runs the tearoom." } })
    .returning({ id: characters.id });
  if (!fatima) throw new Error("character insert failed");

  const [world] = await db()
    .insert(worlds)
    .values({ ownerId, name: "Inner Note World", lore: { synopsis: "A tearoom." } })
    .returning({ id: worlds.id });
  if (!world) throw new Error("world insert failed");
  worldId = world.id;

  const [wlTearoom] = await db()
    .insert(worldLocations)
    .values({ worldId, locationId: tearoom.id })
    .returning({ id: worldLocations.id });
  if (!wlTearoom) throw new Error("world location insert failed");
  await db()
    .insert(worldCast)
    .values({ worldId, characterId: fatima.id, role: "companion", startWorldLocationId: wlTearoom.id });
});

afterAll(async () => {
  if (ready && ownerId) {
    await db().delete(sessions).where(eq(sessions.ownerId, ownerId));
    await db().delete(worlds).where(eq(worlds.ownerId, ownerId));
    await db().delete(characters).where(eq(characters.ownerId, ownerId));
    await db().delete(locations).where(eq(locations.ownerId, ownerId));
    await db().delete(users).where(eq(users.id, ownerId));
  }
  await globalThis.__vesperPool?.end();
  globalThis.__vesperPool = undefined;
});

const NOTE =
  "Fatima knows she is much older than Brian and their cultures differ. She's flattered by his bashful flirting but privately finds the age gap odd.";

describe.skipIf(!ready)("inner-note route + job (demo mode)", () => {
  it("enqueues the job, stores the interior fact, and stages next-turn guidance", async () => {
    const { sessionId, npcId } = await spawn("Inner note flow");

    const res = await submitNote(sessionId, npcId, NOTE);
    expect(res.status).toBe(202);
    const body = await json(res);
    const jobId = String(body["jobId"]);
    expect(jobId.length).toBeGreaterThan(0);

    // The job row landed on the session queue with the new type…
    const [jobRow] = await db().select().from(jobs).where(eq(jobs.id, jobId)).limit(1);
    expect(jobRow?.type).toBe("inner_note");
    expect(jobRow?.sessionId).toBe(sessionId);

    // …and the in-process runner drains it.
    const settled = await waitForJob(jobId);
    expect(settled.status).toBe("done");

    // Fact: bound to the NPC, canon, witnessed by the NPC alone, embedded.
    const factRows = await db().select().from(facts).where(eq(facts.sessionId, sessionId));
    expect(factRows).toHaveLength(1);
    const fact = factRows[0];
    expect(fact?.subjectName).toBe("fatima"); // stored lowercased (docs/memory.md)
    expect(fact?.subjectId).toBe(npcId);
    expect(fact?.kind).toBe("knowledge"); // demo mode ⇒ degraded verbatim fact
    expect(fact?.text).toBe(NOTE);
    expect(fact?.canon).toBe(true);
    expect(fact?.witnessedBy).toEqual([npcId]);
    expect(fact?.status).toBe("active");
    expect(fact?.embedding).not.toBeNull();
    expect(fact?.embedder).toBe("pseudo");

    // Guidance landed in the brief so the very next turn reflects it.
    const [sessionRow] = await db().select({ brief: sessions.brief }).from(sessions).where(eq(sessions.id, sessionId)).limit(1);
    const brief = sessionRow?.brief as { characterNotes?: string[] };
    expect(brief.characterNotes).toContain(`Author's note — Fatima: ${NOTE}`);

    // Degradation convention (docs/resilience.md §8): the demo/degraded path
    // persisted its diagnostic code alongside the fallback behavior above.
    const eventRows = await db()
      .select()
      .from(events)
      .where(and(eq(events.sessionId, sessionId), eq(events.type, "inner_note")));
    expect(eventRows).toHaveLength(1);
    const payload = eventRows[0]?.payload as { degraded?: boolean; diagnostics?: Array<{ code: string }> };
    expect(payload.degraded).toBe(true);
    expect(payload.diagnostics?.map((d) => d.code)).toContain("inner_note.extraction.degraded");
  });

  it("a second note appends to characterNotes rather than clobbering", async () => {
    const { sessionId, npcId } = await spawn("Inner note append");

    const first = await submitNote(sessionId, npcId, "Fatima secretly misses the coast.");
    await waitForJob(String((await json(first))["jobId"]));
    const second = await submitNote(sessionId, npcId, "Fatima trusts Brian a little more now.");
    await waitForJob(String((await json(second))["jobId"]));

    const [sessionRow] = await db().select({ brief: sessions.brief }).from(sessions).where(eq(sessions.id, sessionId)).limit(1);
    const notes = (sessionRow?.brief as { characterNotes?: string[] }).characterNotes ?? [];
    expect(notes).toEqual([
      "Author's note — Fatima: Fatima secretly misses the coast.",
      "Author's note — Fatima: Fatima trusts Brian a little more now.",
    ]);

    const factRows = await db().select({ id: facts.id }).from(facts).where(eq(facts.sessionId, sessionId));
    expect(factRows).toHaveLength(2);
  });

  it("rejects the player participant with 400 and enqueues nothing", async () => {
    const { sessionId, playerId } = await spawn("Inner note player");

    const res = await submitNote(sessionId, playerId, NOTE);
    expect(res.status).toBe(400);
    const body = await json(res);
    expect((body["error"] as Record<string, unknown>)["code"]).toBe("player_participant");

    const jobRows = await db().select({ id: jobs.id }).from(jobs).where(eq(jobs.sessionId, sessionId));
    expect(jobRows).toHaveLength(0);
  });

  it("rejects an unknown participant (404) and an empty note (400)", async () => {
    const { sessionId, npcId } = await spawn("Inner note validation");

    const unknown = await submitNote(sessionId, "p_missing", NOTE);
    expect(unknown.status).toBe(404);

    const empty = await submitNote(sessionId, npcId, "   ");
    expect(empty.status).toBe(400);
    expect((((await json(empty))["error"]) as Record<string, unknown>)["code"]).toBe("invalid_body");
  });
});
