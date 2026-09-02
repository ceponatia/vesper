import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { newId } from "@/lib/ids";
import { deleteChat } from "@/server/engine";
import { logEvent } from "@/server/events";
import { characterChats, db, events } from "@/server/db";
import { endTestPool, probeIntegrationDb, purgeOwnerRows, seedTestUser } from "@/server/test-support";
import { EVENT_RETENTION_DAYS, eventsRetentionPass } from "./events";

/**
 * The two halves of the telemetry lifecycle that only a real Postgres can prove
 * (issue #195): the `events.chat_id` foreign key actually cascades, and the
 * bounded 30-day delete selects by age and nothing else.
 *
 * Defects this kills: a `chat_id` written without the `ON DELETE CASCADE` (or a
 * logger that never writes the column), which leaves a deleted conversation's
 * telemetry behind forever; and a retention predicate with the comparison
 * inverted or the cutoff mis-scaled, which either deletes live rows or deletes
 * nothing at all. Neither raises an error — both are silent.
 *
 * Self-skips when the database is unreachable; strict integration mode
 * (`pnpm test:int:strict`) fails instead.
 */

const ready = await probeIntegrationDb("retention events.int.test", "events");

const DAY_MS = 24 * 60 * 60 * 1000;

let ownerId = "";

beforeAll(async () => {
  if (!ready) return;
  ownerId = (await seedTestUser("retention-events-int")).id;
});

afterAll(async () => {
  await purgeOwnerRows([ownerId]);
  await endTestPool();
});

/** A conversation with nothing in it — every other chat column defaults. */
async function newChatRow(): Promise<string> {
  const [row] = await db().insert(characterChats).values({ ownerId }).returning({ id: characterChats.id });
  if (!row) throw new Error("[retention events.int.test] chat insert returned no row");
  return row.id;
}

describe.skipIf(!ready)("chat-scoped events", () => {
  it("go with the conversation when it is deleted", async () => {
    const chatId = await newChatRow();
    await logEvent("retrieval", { kind: "facts", hitIds: [] }, { chatId, content: { query: "harbor" } });

    const before = await db().select({ id: events.id }).from(events).where(eq(events.chatId, chatId));
    expect(before).toHaveLength(1);

    await deleteChat(chatId, ownerId);

    const after = await db().select({ id: events.id }).from(events).where(eq(events.chatId, chatId));
    expect(after).toEqual([]);
  });
});

describe.skipIf(!ready)("the retention pass", () => {
  it("removes rows past the retention window and leaves newer and non-chat rows alone", async () => {
    const chatId = await newChatRow();

    // A clock far enough in the past that the cutoff it implies precedes every
    // real row in the database: this pass is table-wide, so the fixtures must be
    // the ONLY rows it can match, or a shared local database makes the assertion
    // depend on whatever else happens to be sitting in `events`.
    const now = new Date("2000-02-01T00:00:00.000Z");
    const expiredAt = new Date(now.getTime() - (EVENT_RETENTION_DAYS + 1) * DAY_MS);
    const freshAt = new Date(now.getTime() - (EVENT_RETENTION_DAYS - 1) * DAY_MS);

    const expiredId = newId();
    const freshId = newId();
    const nonChatId = newId();
    await db()
      .insert(events)
      .values([
        { id: expiredId, type: "retrieval", payload: {}, chatId, createdAt: expiredAt },
        { id: freshId, type: "retrieval", payload: {}, chatId, createdAt: freshAt },
        { id: nonChatId, type: "image.avatar", payload: {}, chatId: null, createdAt: freshAt },
      ]);

    const deleted = await eventsRetentionPass.run(now);
    expect(deleted).toBe(1);

    const survivors = await db()
      .select({ id: events.id })
      .from(events)
      .where(inArray(events.id, [expiredId, freshId, nonChatId]));
    expect(survivors.map((row) => row.id).sort()).toEqual([freshId, nonChatId].sort());

    await db().delete(events).where(inArray(events.id, [freshId, nonChatId]));
  });
});
