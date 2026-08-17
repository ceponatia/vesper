import { inArray, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import {
  emptyVisualCueState,
  observeVisualCues,
  DiagnosticCollector,
  type VisualCueState,
} from "@/contracts";
import { newId } from "@/lib/ids";
import { chatVisualCues, db } from "@/server/db";
import { endTestPool, probeIntegrationDb } from "@/server/test-support";
import { loadChatVisualCues, saveChatVisualCues, CHAT_VISUAL_CUES_UNREADABLE } from "./visual-cue-store";

/**
 * The narrator cue store, through a real database (visual-state.plan.md slice 7).
 *
 * The same two-generation law `chat-visual-memory.int.test.ts` proves, on the
 * record that answers repetition and first visibility for the families
 * recognition memory does not hold. It matters MORE here than it does there:
 * the cue state carries a cut counter, so a retake that advanced it twice would
 * make every tracked family read as newly revealed on the following cut —
 * the exact repetition this record exists to prevent.
 *
 * What only Postgres can prove:
 *
 * - the generation shuffle is ATOMIC in the upsert — a new exchange pushes
 *   `cues` down into `cues_before`, and a retake of the same exchange leaves
 *   that older generation where it is, however many times it is re-saved;
 * - so a retake LOADS the pre-exchange state and cannot double-advance;
 * - two observers in one memory group are two rows that cannot see each other;
 * - a corrupt jsonb blob heals to "nothing seen yet" with its boundary
 *   diagnostic, and the next commit re-materializes the column.
 *
 * The rows carry no FK (memory groups are not a table), so the suite owns its
 * own teardown.
 */

const ready = await probeIntegrationDb("chat-visual-cues.int.test", "chat_visual_cues");

const SUBJECT_ID = "subject_visual_cues_int";
const SLEEVE = "recognition.garment_presentation.garment_part:g1:sleeve_left";
const groupIds: string[] = [];

function newGroupId(): string {
  const id = newId();
  groupIds.push(id);
  return id;
}

/** One family seen at one cut — the shape the narrator selection returns. */
function seen(previous: VisualCueState, atMinutes: number, fingerprint = "fp_rolled"): VisualCueState {
  return observeVisualCues(previous, {
    atMinutes,
    observations: [{ repeatKey: SLEEVE, familyFingerprint: fingerprint }],
  });
}

afterAll(async () => {
  if (ready && groupIds.length > 0) {
    await db().delete(chatVisualCues).where(inArray(chatVisualCues.memoryGroupId, groupIds));
  }
  await endTestPool();
});

describe.runIf(ready)("an observer who has never looked", () => {
  it("reads as an empty cue state rather than an error", async () => {
    const state = await loadChatVisualCues({
      memoryGroupId: newGroupId(),
      viewpointId: "vp_a",
      subjectId: SUBJECT_ID,
      promptingMessageId: "msg_first",
    });
    expect(state).toEqual(emptyVisualCueState());
  });
});

describe.runIf(ready)("the two generations", () => {
  it("hands a NEW exchange the last committed state", async () => {
    const key = { memoryGroupId: newGroupId(), viewpointId: "vp_a", subjectId: SUBJECT_ID };
    const first = seen(emptyVisualCueState(), 10);
    await saveChatVisualCues({ ...key, promptingMessageId: "msg_one", next: first });
    expect(await loadChatVisualCues({ ...key, promptingMessageId: "msg_two" })).toEqual(first);
  });

  it("hands a RETAKE the state the exchange advanced FROM, however often it re-saves", async () => {
    const key = { memoryGroupId: newGroupId(), viewpointId: "vp_a", subjectId: SUBJECT_ID };
    const before = seen(emptyVisualCueState(), 10);
    await saveChatVisualCues({ ...key, promptingMessageId: "msg_settled", next: before });

    const take = async (): Promise<VisualCueState> => {
      const loaded = await loadChatVisualCues({ ...key, promptingMessageId: "msg_retaken" });
      const next = seen(loaded, 20);
      await saveChatVisualCues({ ...key, promptingMessageId: "msg_retaken", next });
      return next;
    };
    // Three takes of one exchange all recompute from the identical starting
    // state and all land on the same counter — the retake law as a storage fact.
    const results = [await take(), await take(), await take()];
    for (const result of results) expect(result.sequence).toBe(before.sequence + 1);
    expect(new Set(results.map((state) => JSON.stringify(state))).size).toBe(1);
    // And the next NEW exchange sees the settled result, not the rollback copy.
    expect(await loadChatVisualCues({ ...key, promptingMessageId: "msg_next" })).toEqual(results[0]);
  });

  it("recomputes from nothing when the retaken exchange is the one that created the row", async () => {
    const key = { memoryGroupId: newGroupId(), viewpointId: "vp_a", subjectId: SUBJECT_ID };
    await saveChatVisualCues({ ...key, promptingMessageId: "msg_first", next: seen(emptyVisualCueState(), 10) });
    expect(await loadChatVisualCues({ ...key, promptingMessageId: "msg_first" })).toEqual(emptyVisualCueState());
  });
});

describe.runIf(ready)("isolation", () => {
  it("keeps two observers in one memory group in separate rows", async () => {
    const memoryGroupId = newGroupId();
    const mine = { memoryGroupId, viewpointId: "vp_mine", subjectId: SUBJECT_ID };
    const theirs = { memoryGroupId, viewpointId: "vp_theirs", subjectId: SUBJECT_ID };
    const state = seen(emptyVisualCueState(), 10);
    await saveChatVisualCues({ ...mine, promptingMessageId: "msg_a", next: state });

    expect(await loadChatVisualCues({ ...mine, promptingMessageId: "msg_b" })).toEqual(state);
    expect(await loadChatVisualCues({ ...theirs, promptingMessageId: "msg_b" })).toEqual(emptyVisualCueState());
  });

  it("starts a fresh memory group as a narrator who has seen nothing", async () => {
    const continued = { memoryGroupId: newGroupId(), viewpointId: "vp_a", subjectId: SUBJECT_ID };
    const fresh = { memoryGroupId: newGroupId(), viewpointId: "vp_a", subjectId: SUBJECT_ID };
    await saveChatVisualCues({ ...continued, promptingMessageId: "msg_a", next: seen(emptyVisualCueState(), 10) });
    expect((await loadChatVisualCues({ ...fresh, promptingMessageId: "msg_b" })).sequence).toBe(0);
  });
});

describe.runIf(ready)("degradation", () => {
  it("heals a corrupt blob to nothing seen yet, says so, and re-materializes on the next commit", async () => {
    const key = { memoryGroupId: newGroupId(), viewpointId: "vp_a", subjectId: SUBJECT_ID };
    await saveChatVisualCues({ ...key, promptingMessageId: "msg_a", next: seen(emptyVisualCueState(), 10) });
    await db()
      .update(chatVisualCues)
      .set({ cues: sql`'"wrecked"'::jsonb` })
      .where(sql`memory_group_id = ${key.memoryGroupId}`);

    const sink = new DiagnosticCollector();
    expect(await loadChatVisualCues({ ...key, promptingMessageId: "msg_b", sink })).toEqual(emptyVisualCueState());
    expect(sink.items.some((entry) => entry.code === CHAT_VISUAL_CUES_UNREADABLE)).toBe(true);

    const healed = seen(emptyVisualCueState(), 30);
    await saveChatVisualCues({ ...key, promptingMessageId: "msg_b", next: healed });
    expect(await loadChatVisualCues({ ...key, promptingMessageId: "msg_c" })).toEqual(healed);
  });
});
