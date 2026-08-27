import { and, eq, sql } from "drizzle-orm";
import {
  diag,
  emptyVisualMemoryState,
  visualMemoryStateSchema,
  type DiagnosticSink,
  type VisualMemoryState,
} from "@/contracts";
import { parseOr } from "@/lib/parse";
import { chatVisualMemory, db } from "../db";

/**
 * OBSERVER VISUAL MEMORY, PERSISTED.
 *
 * The one IO module of the recognition seam. Everything above it — projection,
 * candidates, salience, mention policy, cue prose — is pure; this file owns the
 * row, its trust boundary, and the single trick that makes retakes correct.
 *
 * ## The two-generation row
 *
 * A `chat_visual_memory` row carries what the observer knows (`features`), what
 * they knew before the last applied exchange (`features_before`), and which
 * exchange applied it (`applied_message_id`). The ruling this implements is
 * "retakes reuse captured notice/mention results rather than advancing memory a
 * second time", and without an event ledger the chat lane needs somewhere to
 * remember the pre-exchange value. So:
 *
 * ```text
 * a NEW exchange   applied_message_id ≠ prompting id
 *                  → read `features`         → write features_before := features
 * a RETAKE         applied_message_id = prompting id
 *                  → read `features_before`  → leave features_before alone
 * ```
 *
 * Both branches then set `features := next`. The second, third and fourth take of
 * one exchange therefore all recompute from the identical starting memory and all
 * land on the same counts — the acceptance test "retake does not double-increment
 * notice or mention counts", expressed as a storage invariant rather than as
 * caller discipline. The prompting message id is the SAME guard the state and
 * scenario rollback anchors take (`finalizeChatState`'s `promptMessageId`), so
 * the three roll back to one boundary.
 *
 * ## Isolation
 *
 * The primary key is (memory group, viewpoint, subject). Two observers in one
 * memory group, or one observer across two groups, are different rows — there is
 * no query here that could merge them, which is the isolation guarantee stated
 * once, in the schema.
 *
 * ## Degradation
 *
 * A corrupt blob is one chatty exchange, never a lost turn: `parseOr` heals it to
 * "this observer has noticed nothing" with a boundary diagnostic, and the next
 * commit re-materializes the column.
 */

/** The stored blob was not even an object — nothing could be recovered from it. */
export const CHAT_VISUAL_MEMORY_UNREADABLE = "chat.visual_memory.unreadable";

/** The boundary path both generations report under. */
const VISUAL_MEMORY_PATH = "chat_visual_memory.features";

/** Which generation of the row an exchange reads and preserves. */
export type VisualMemoryGeneration = "features" | "features_before";

/** The row identity — one observer, one subject, one continuity. */
export interface ChatVisualMemoryKey {
  readonly memoryGroupId: string;
  readonly viewpointId: string;
  readonly subjectId: string;
}

/** Just enough of the stored row to decide which generation is current. */
export interface ChatVisualMemoryGenerationRow {
  readonly appliedMessageId: string | null;
}

/**
 * The generation decision, PURE — extracted so the retake law is testable without
 * a database, and so the load path and the write path can never disagree about
 * which exchange a row belongs to.
 *
 * A missing row, and a row from any other exchange, both read `features`: there
 * is nothing to roll back to. Only a row whose `applied_message_id` is THIS
 * exchange means "we already applied once", which is exactly a retake.
 */
export function visualMemoryGenerationFor(
  row: ChatVisualMemoryGenerationRow | null | undefined,
  promptingMessageId: string,
): VisualMemoryGeneration {
  if (!row || row.appliedMessageId === null) return "features";
  return row.appliedMessageId === promptingMessageId ? "features_before" : "features";
}

export interface LoadChatVisualMemoryInput extends ChatVisualMemoryKey {
  /** The exchange's rollback guard — `promptMessageId ?? assistantMessageId`. */
  readonly promptingMessageId: string;
  readonly sink?: DiagnosticSink;
}

/**
 * This observer's memory of this subject, as of BEFORE the exchange being run.
 *
 * No row is not an error: an observer who has never looked has noticed nothing,
 * which is the same value a corrupt blob heals to.
 */
export async function loadChatVisualMemory(input: LoadChatVisualMemoryInput): Promise<VisualMemoryState> {
  const [row] = await db()
    .select({
      features: chatVisualMemory.features,
      featuresBefore: chatVisualMemory.featuresBefore,
      appliedMessageId: chatVisualMemory.appliedMessageId,
    })
    .from(chatVisualMemory)
    .where(
      and(
        eq(chatVisualMemory.memoryGroupId, input.memoryGroupId),
        eq(chatVisualMemory.viewpointId, input.viewpointId),
        eq(chatVisualMemory.subjectId, input.subjectId),
      ),
    )
    .limit(1);
  if (!row) return emptyVisualMemoryState();

  const generation = visualMemoryGenerationFor(row, input.promptingMessageId);
  const raw = generation === "features_before" ? row.featuresBefore : row.features;
  // `visualMemoryStateSchema` heals field by field and catches at the root, so
  // `parseOr` cannot fail — which would leave a blob that carries no features at
  // all (a string, an array, a number) silently indistinguishable from an empty
  // memory. Naming that case is the difference between "nothing noticed yet" and
  // "something wrote garbage here", and only the second is worth a log line.
  if (raw !== null && raw !== undefined && (typeof raw !== "object" || Array.isArray(raw))) {
    input.sink?.push(
      diag("warn", CHAT_VISUAL_MEMORY_UNREADABLE, "Stored visual memory is not an object", {
        path: VISUAL_MEMORY_PATH,
        context: { generation, subjectId: input.subjectId },
      }),
    );
  }
  return parseOr(visualMemoryStateSchema, raw ?? {}, emptyVisualMemoryState(), input.sink, VISUAL_MEMORY_PATH);
}

export interface SaveChatVisualMemoryInput extends ChatVisualMemoryKey {
  /** The same guard the load used — the two must agree or the retake law breaks. */
  readonly promptingMessageId: string;
  readonly next: VisualMemoryState;
}

/**
 * Commit this exchange's memory, shuffling generations in ONE statement.
 *
 * The `case` is the whole point of doing it in SQL: a read-modify-write would
 * need its own transaction to stay correct under a concurrent settle, while
 * `insert … on conflict do update` lets Postgres compare the stored
 * `applied_message_id` with the incoming one atomically. `excluded` is the row we
 * proposed; the table-qualified reference is the row already there.
 */
export async function saveChatVisualMemory(input: SaveChatVisualMemoryInput): Promise<void> {
  await db()
    .insert(chatVisualMemory)
    .values({
      memoryGroupId: input.memoryGroupId,
      viewpointId: input.viewpointId,
      subjectId: input.subjectId,
      features: input.next,
      // A first write has no earlier generation: a retake of the exchange that
      // created the row correctly recomputes from "noticed nothing".
      featuresBefore: null,
      appliedMessageId: input.promptingMessageId,
    })
    .onConflictDoUpdate({
      target: [chatVisualMemory.memoryGroupId, chatVisualMemory.viewpointId, chatVisualMemory.subjectId],
      set: {
        features: sql`excluded.features`,
        featuresBefore: sql`case
          when ${chatVisualMemory}.applied_message_id is distinct from excluded.applied_message_id
          then ${chatVisualMemory}.features
          else ${chatVisualMemory}.features_before
        end`,
        appliedMessageId: sql`excluded.applied_message_id`,
        updatedAt: sql`now()`,
      },
    });
}
