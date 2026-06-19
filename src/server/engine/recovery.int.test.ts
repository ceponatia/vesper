import { eq, inArray, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { db, jobs, sessions, turns, users, worlds } from "@/server/db";
import { sweepAbandonedSessions } from "./recovery";

/**
 * Recovery sweep (instrumentation.ts boot hook): a session wedged by a process
 * restart — its post-turn job orphaned `running`, its turn stuck `processing` —
 * must self-heal on the periodic sweep, while a live (fresh-heartbeat) session
 * is never clobbered.
 */

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
  } catch {
    process.stderr.write("[recovery.int.test] skipping: database unreachable or unmigrated\n");
    return false;
  } finally {
    clearTimeout(timer);
  }
}

const ready = await probe();
const STALE = new Date(Date.now() - 5 * 60_000); // well past HEARTBEAT_STALE_MS (60s)
const ownerIds: string[] = [];
const worldIds: string[] = [];

async function makeSession(status: "processing", heartbeat: Date, sessionUpdatedAt: Date) {
  const [user] = await db()
    .insert(users)
    .values({ email: `recovery-int-${Math.round(heartbeat.getTime())}-${ownerIds.length}@test.local`, name: "Recovery Int" })
    .returning();
  if (!user) throw new Error("user insert failed");
  ownerIds.push(user.id);
  const [world] = await db().insert(worlds).values({ ownerId: user.id, name: "Recovery World" }).returning();
  if (!world) throw new Error("world insert failed");
  worldIds.push(world.id);
  const [session] = await db()
    .insert(sessions)
    .values({ ownerId: user.id, worldId: world.id, title: "Wedged", status, updatedAt: sessionUpdatedAt })
    .returning();
  if (!session) throw new Error("session insert failed");
  const [turn] = await db()
    .insert(turns)
    .values({ sessionId: session.id, number: 1, input: "hello", status: "processing", heartbeatAt: heartbeat })
    .returning();
  if (!turn) throw new Error("turn insert failed");
  const [job] = await db()
    .insert(jobs)
    .values({ sessionId: session.id, type: "post_turn", status: "running", startedAt: heartbeat, heartbeatAt: heartbeat })
    .returning();
  if (!job) throw new Error("job insert failed");
  return { sessionId: session.id, turnId: turn.id, jobId: job.id };
}

afterAll(async () => {
  if (!ready) return;
  if (ownerIds.length > 0) {
    await db().delete(sessions).where(inArray(sessions.ownerId, ownerIds));
    await db().delete(worlds).where(inArray(worlds.id, worldIds));
    await db().delete(users).where(inArray(users.id, ownerIds));
  }
  await globalThis.__vesperPool?.end();
});

describe.skipIf(!ready)("sweepAbandonedSessions", () => {
  it("heals a session wedged by a restart and leaves a live one alone", async () => {
    // Wedged: stale turn heartbeat + stale session row + orphaned running job.
    const wedged = await makeSession("processing", STALE, STALE);
    // Live: fresh heartbeat + fresh session row — a turn genuinely in progress.
    const fresh = await makeSession("processing", new Date(), new Date());

    const recovered = await sweepAbandonedSessions();
    expect(recovered).toBeGreaterThanOrEqual(1);

    const [wedgedSession] = await db().select({ status: sessions.status }).from(sessions).where(eq(sessions.id, wedged.sessionId));
    const [wedgedJob] = await db().select({ status: jobs.status }).from(jobs).where(eq(jobs.id, wedged.jobId));
    const [wedgedTurn] = await db().select({ status: turns.status }).from(turns).where(eq(turns.id, wedged.turnId));
    expect(wedgedSession?.status).toBe("ready"); // un-wedged
    expect(wedgedJob?.status).toBe("failed"); // orphaned job recovered
    expect(wedgedTurn?.status).toBe("failed"); // abandoned turn failed

    const [freshSession] = await db().select({ status: sessions.status }).from(sessions).where(eq(sessions.id, fresh.sessionId));
    expect(freshSession?.status).toBe("processing"); // live work untouched
  });
});
