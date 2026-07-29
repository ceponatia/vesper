import { inArray, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import {
  emptyVisualMemoryState,
  recognitionVisualMemoryFixture,
  DiagnosticCollector,
  type VisualMemoryState,
} from "@/contracts";
import { newId } from "@/lib/ids";
import { chatVisualMemory, db } from "@/server/db";
import { endTestPool, probeIntegrationDb } from "@/server/test-support";
import {
  loadChatVisualMemory,
  saveChatVisualMemory,
  CHAT_VISUAL_MEMORY_UNREADABLE,
} from "./visual-memory-store";

/**
 * The visual-memory store, through a real database (slice 7).
 *
 * What only Postgres can prove, and what the pure adapter suite therefore does
 * not attempt:
 *
 * - the two-generation shuffle happens ATOMICALLY in the upsert — a new exchange
 *   pushes `features` down into `features_before`, and a retake of the same
 *   exchange leaves that older generation exactly where it is, however many times
 *   it is re-saved;
 * - so a retake LOADS the pre-exchange memory and cannot double-count;
 * - two viewpoints in one memory group are two rows, and neither read can see the
 *   other (observer isolation, as a storage fact rather than a code convention);
 * - a corrupt jsonb blob heals to "this observer has noticed nothing" with its
 *   boundary diagnostic, and the next commit re-materializes the column.
 *
 * The rows here are keyed by minted ids and carry no FK (memory groups are not a
 * table), so the suite owns its own teardown.
 */

const ready = await probeIntegrationDb("chat-visual-memory.int.test", "chat_visual_memory");

const SUBJECT_ID = "subject_visual_memory_int";
const groupIds: string[] = [];

/** A fresh memory group, tracked for teardown. */
function newGroupId(): string {
  const id = newId();
  groupIds.push(id);
  return id;
}

/** One recognizable feature, remembered — the shape the recognition layer writes. */
function remembered(featureKey: string, overrides: { noticeCount?: number; mentionCount?: number } = {}): VisualMemoryState {
  return recognitionVisualMemoryFixture([
    {
      featureKey,
      subjectId: SUBJECT_ID,
      noticeCount: overrides.noticeCount ?? 1,
      mentionCount: overrides.mentionCount ?? 0,
    },
  ]);
}

afterAll(async () => {
  if (ready && groupIds.length > 0) {
    await db().delete(chatVisualMemory).where(inArray(chatVisualMemory.memoryGroupId, groupIds));
  }
  await endTestPool();
});

describe.runIf(ready)("an observer who has never looked", () => {
  it("reads as an empty memory rather than an error", async () => {
    const memory = await loadChatVisualMemory({
      memoryGroupId: newGroupId(),
      viewpointId: newId(),
      subjectId: SUBJECT_ID,
      promptingMessageId: newId(),
    });

    expect(memory).toEqual(emptyVisualMemoryState());
  });
});

describe.runIf(ready)("load → save → the next exchange", () => {
  it("round-trips through jsonb and advances the generation", async () => {
    const key = { memoryGroupId: newGroupId(), viewpointId: newId(), subjectId: SUBJECT_ID };
    const first = "msg_first";
    const second = "msg_second";
    const afterFirst = remembered("feature.a", { noticeCount: 1 });

    await saveChatVisualMemory({ ...key, promptingMessageId: first, next: afterFirst });
    // A NEW exchange reads the live generation — what the last one committed.
    expect(await loadChatVisualMemory({ ...key, promptingMessageId: second })).toEqual(afterFirst);

    const afterSecond = remembered("feature.a", { noticeCount: 2, mentionCount: 1 });
    await saveChatVisualMemory({ ...key, promptingMessageId: second, next: afterSecond });
    expect(await loadChatVisualMemory({ ...key, promptingMessageId: "msg_third" })).toEqual(afterSecond);

    // …and the generation it advanced FROM is the one the retake would need.
    const [row] = await db()
      .select({ featuresBefore: chatVisualMemory.featuresBefore })
      .from(chatVisualMemory)
      .where(
        sql`memory_group_id = ${key.memoryGroupId} and viewpoint_id = ${key.viewpointId} and subject_id = ${key.subjectId}`,
      );
    expect(row?.featuresBefore).toEqual(afterFirst);
  });
});

describe.runIf(ready)("a retake of the same exchange", () => {
  it("loads the PRE-exchange memory and never double-counts, however often it is re-saved", async () => {
    const key = { memoryGroupId: newGroupId(), viewpointId: newId(), subjectId: SUBJECT_ID };
    const settled = "msg_settled";
    const retaken = "msg_retaken";
    const before = remembered("feature.a", { noticeCount: 1 });
    const after = remembered("feature.a", { noticeCount: 2, mentionCount: 1 });

    await saveChatVisualMemory({ ...key, promptingMessageId: settled, next: before });
    await saveChatVisualMemory({ ...key, promptingMessageId: retaken, next: after });

    // Take two of the SAME exchange sees exactly what take one saw.
    expect(await loadChatVisualMemory({ ...key, promptingMessageId: retaken })).toEqual(before);

    // Take two commits its own (identical, because the read was identical) result.
    await saveChatVisualMemory({ ...key, promptingMessageId: retaken, next: after });
    expect(await loadChatVisualMemory({ ...key, promptingMessageId: retaken })).toEqual(before);
    // Take three, four, five: the older generation never moves.
    await saveChatVisualMemory({ ...key, promptingMessageId: retaken, next: after });
    expect(await loadChatVisualMemory({ ...key, promptingMessageId: retaken })).toEqual(before);
    // And the live generation is still the one take N committed — not a stack.
    expect(await loadChatVisualMemory({ ...key, promptingMessageId: "msg_next" })).toEqual(after);
  });

  it("recomputes from an empty memory when the retaken exchange is the one that created the row", async () => {
    const key = { memoryGroupId: newGroupId(), viewpointId: newId(), subjectId: SUBJECT_ID };
    const first = "msg_only";

    await saveChatVisualMemory({ ...key, promptingMessageId: first, next: remembered("feature.a") });

    expect(await loadChatVisualMemory({ ...key, promptingMessageId: first })).toEqual(emptyVisualMemoryState());
  });
});

describe.runIf(ready)("observer isolation", () => {
  it("keeps two viewpoints in one memory group entirely separate", async () => {
    const memoryGroupId = newGroupId();
    const mine = { memoryGroupId, viewpointId: newId(), subjectId: SUBJECT_ID };
    const theirs = { memoryGroupId, viewpointId: newId(), subjectId: SUBJECT_ID };
    const seen = remembered("feature.a", { noticeCount: 3 });

    await saveChatVisualMemory({ ...mine, promptingMessageId: "msg_a", next: seen });

    expect(await loadChatVisualMemory({ ...mine, promptingMessageId: "msg_b" })).toEqual(seen);
    expect(await loadChatVisualMemory({ ...theirs, promptingMessageId: "msg_b" })).toEqual(
      emptyVisualMemoryState(),
    );
  });

  it("keeps one viewpoint's two memory groups separate — a fresh chat starts as strangers", async () => {
    const viewpointId = newId();
    const continued = { memoryGroupId: newGroupId(), viewpointId, subjectId: SUBJECT_ID };
    const fresh = { memoryGroupId: newGroupId(), viewpointId, subjectId: SUBJECT_ID };
    const seen = remembered("feature.a", { noticeCount: 2 });

    await saveChatVisualMemory({ ...continued, promptingMessageId: "msg_a", next: seen });

    expect(await loadChatVisualMemory({ ...continued, promptingMessageId: "msg_b" })).toEqual(seen);
    expect(await loadChatVisualMemory({ ...fresh, promptingMessageId: "msg_b" })).toEqual(
      emptyVisualMemoryState(),
    );
  });
});

describe.runIf(ready)("a corrupt blob costs one exchange's memory, never the turn", () => {
  it("heals to nothing-noticed with its boundary diagnostic, then re-materializes", async () => {
    const key = { memoryGroupId: newGroupId(), viewpointId: newId(), subjectId: SUBJECT_ID };
    await saveChatVisualMemory({ ...key, promptingMessageId: "msg_a", next: remembered("feature.a") });
    await db().execute(
      sql`update ${chatVisualMemory} set features = '"nothing to see here"'::jsonb
          where memory_group_id = ${key.memoryGroupId} and viewpoint_id = ${key.viewpointId}
            and subject_id = ${key.subjectId}`,
    );

    const sink = new DiagnosticCollector();
    expect(await loadChatVisualMemory({ ...key, promptingMessageId: "msg_b", sink })).toEqual(
      emptyVisualMemoryState(),
    );
    expect(sink.items.map((d) => d.code)).toContain(CHAT_VISUAL_MEMORY_UNREADABLE);

    const healed = remembered("feature.a", { noticeCount: 1 });
    await saveChatVisualMemory({ ...key, promptingMessageId: "msg_b", next: healed });
    expect(await loadChatVisualMemory({ ...key, promptingMessageId: "msg_c" })).toEqual(healed);
  });
});
